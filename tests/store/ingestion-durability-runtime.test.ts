import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  claimNextIngestionJob,
  completeIngestionJob,
  enqueueIngestionJob,
  failIngestionJob,
  heartbeatIngestionJob,
  type IngestionJob,
} from "../../src/lib/store/ingestion-jobs";

type IngestionQuery = NonNullable<Parameters<typeof enqueueIngestionJob>[1]>;

test("ingestion durability migration is twice-safe", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create schema metrics;
      create table metrics.ingestion_jobs (id bigserial primary key);
      create table metrics.ingestion_runs (id bigserial primary key)
    `);
    const migration = await readFile(
      new URL("../../infra/db/migrations/013_ingestion_durability.sql", import.meta.url),
      "utf8",
    );
    await db.exec(migration);
    await db.exec(migration);

    const columns = await db.query<{ job_generation: boolean; run_generation: boolean }>(`
      select
        exists (
          select 1 from information_schema.columns
           where table_schema='metrics' and table_name='ingestion_jobs' and column_name='generation'
        ) as job_generation,
        exists (
          select 1 from information_schema.columns
           where table_schema='metrics' and table_name='ingestion_runs' and column_name='job_generation'
        ) as run_generation
    `);
    assert.deepEqual(columns.rows[0], { job_generation: true, run_generation: true });
  } finally {
    await db.close();
  }
});

test("duplicate scheduled enqueues reopen one new generation", async () => {
  const db = await ingestionDatabase();
  const query = pgliteQuery(db);
  try {
    await db.exec(`
      insert into metrics.ingestion_jobs (
        entity_type, status, idempotency_key, requests_used, generation, completed_at
      ) values ('jobs', 'succeeded', 'jobs:2026-07-09', 19, 4, now())
    `);
    const scheduled = {
      entity: "jobs" as const,
      idempotencyKey: "jobs:2026-07-09",
      requestBudget: 100,
      params: { CompletedDate: "2026-07-09" },
    };

    await enqueueIngestionJob(scheduled, query);
    await enqueueIngestionJob(scheduled, query);

    const reopened = await db.query<{ count: number; status: string; generation: number; requests_used: number }>(`
      select count(*)::int as count, max(status::text) as status,
             max(generation)::int as generation, max(requests_used)::int as requests_used
        from metrics.ingestion_jobs
       where entity_type = 'jobs' and idempotency_key = 'jobs:2026-07-09'
    `);
    assert.deepEqual(reopened.rows[0], { count: 1, status: "queued", generation: 5, requests_used: 0 });

    await db.exec("update metrics.ingestion_jobs set status='succeeded', completed_at=now() where idempotency_key='jobs:2026-07-09'");
    await enqueueIngestionJob({ ...scheduled, preserveSucceeded: true }, query);
    const preserved = await db.query<{ status: string; generation: number }>(`
      select status::text as status, generation from metrics.ingestion_jobs where idempotency_key='jobs:2026-07-09'
    `);
    assert.deepEqual(preserved.rows[0], { status: "succeeded", generation: 5 });
  } finally {
    await db.close();
  }
});

test("claims finish older generations before reopened recurring slices", async () => {
  const db = await ingestionDatabase();
  const query = pgliteQuery(db);
  try {
    await db.exec(`
      insert into metrics.ingestion_jobs (entity_type, idempotency_key, generation)
      select 'quotes', 'quotes:old:' || value::text, 1 from generate_series(1, 60) value;
      insert into metrics.ingestion_jobs (entity_type, idempotency_key, generation)
      select 'quotes', 'quotes:reopened:' || value::text, 2 from generate_series(1, 30) value
    `);

    for (let index = 0; index < 60; index += 1) {
      const claimed = await claimNextIngestionJob(`worker-${index}`, "quotes", undefined, query);
      assert.equal(claimed?.generation, 1);
    }
    const next = await claimNextIngestionJob("worker-next", "quotes", undefined, query);
    assert.equal(next?.generation, 2);
  } finally {
    await db.close();
  }
});

test("concurrent claims remain distinct while preserving generation order", async () => {
  const db = await ingestionDatabase();
  const query = pgliteQuery(db);
  try {
    await db.exec(`
      insert into metrics.ingestion_jobs (entity_type, idempotency_key, generation)
      values ('jobs', 'jobs:first', 1), ('jobs', 'jobs:second', 1), ('jobs', 'jobs:reopened', 2)
    `);
    const [first, second] = await Promise.all([
      claimNextIngestionJob("worker-a", "jobs", undefined, query),
      claimNextIngestionJob("worker-b", "jobs", undefined, query),
    ]);
    assert.equal(first?.generation, 1);
    assert.equal(second?.generation, 1);
    assert.notEqual(first?.id, second?.id);
  } finally {
    await db.close();
  }
});

test("expired-lease recovery bumps the generation and fences the superseded writer", async () => {
  const db = await ingestionDatabase();
  const query = pgliteQuery(db);
  try {
    const staleJob = await runningJob(db);
    await db.exec(`
      update metrics.ingestion_jobs
         set locked_at = now() - interval '20 minutes',
             lock_expires_at = now() - interval '1 second',
             heartbeat_at = now() - interval '20 minutes'
       where id = 1
    `);

    // The recovery CTE and the claim run in one statement, so the freshly
    // requeued job only becomes claimable on the next call.
    const recoveryPass = await claimNextIngestionJob("worker-b", "jobs", undefined, query);
    const reclaimed = recoveryPass ?? await claimNextIngestionJob("worker-b", "jobs", undefined, query);
    assert.equal(reclaimed?.id, 1);
    assert.equal(reclaimed?.generation, staleJob.generation + 1);

    // The superseded writer's pre-write fence (fenced heartbeat) must reject
    // before any durable write, and its completion/failure must stay fenced.
    await assert.rejects(
      heartbeatIngestionJob(staleJob, "worker-a", query),
      /Lost ingestion lease for job 1 generation 3/,
    );
    await assert.rejects(completeIngestionJob({
      job: staleJob,
      workerId: "worker-a",
      runId: 1,
      requestCount: 5,
      snapshotCount: 10,
      normalizedCount: 10,
      continuationToken: null,
      candidateRefreshes: [],
      affectedPeriods: [],
    }, query), /Lost ingestion lease/);
    await assert.rejects(failIngestionJob({
      job: staleJob,
      workerId: "worker-a",
      runId: 1,
      requestCount: 5,
      error: new Error("superseded execution failed"),
    }, query), /Lost ingestion lease for job 1 generation 3/);

    const fenced = await db.query<{ status: string; generation: number; locked_by: string }>(`
      select status::text as status, generation, locked_by from metrics.ingestion_jobs where id = 1
    `);
    assert.deepEqual(fenced.rows[0], { status: "running", generation: 4, locked_by: "worker-b" });

    // The new owner remains fully operational under the bumped generation.
    if (!reclaimed) return;
    await heartbeatIngestionJob(reclaimed, "worker-b", query);
    await db.exec(`
      insert into metrics.ingestion_runs (id, job_id, entity_type, worker_id, job_generation)
      values (2, 1, 'jobs', 'worker-b', 4)
    `);
    const publication = await completeIngestionJob({
      job: reclaimed,
      workerId: "worker-b",
      runId: 2,
      requestCount: 1,
      snapshotCount: 1,
      normalizedCount: 1,
      continuationToken: null,
      candidateRefreshes: [],
      affectedPeriods: [],
    }, query);
    assert.deepEqual(publication, { candidate_count: 0, rollup_count: 0 });
    const completed = await db.query<{ status: string }>(
      "select status::text as status from metrics.ingestion_jobs where id = 1",
    );
    assert.equal(completed.rows[0]?.status, "succeeded");
  } finally {
    await db.close();
  }
});

test("stale-generation heartbeats cannot extend a newer lease when owner identity collides", async () => {
  const db = await ingestionDatabase();
  const query = pgliteQuery(db);
  try {
    const staleJob = await runningJob(db);
    await installNewGenerationLease(db);

    await assert.rejects(
      heartbeatIngestionJob(staleJob, "worker-a", query),
      /Lost ingestion lease for job 1 generation 3/,
    );

    const fenced = await db.query<{
      status: string;
      generation: number;
      locked_by: string;
      heartbeat_unchanged: boolean;
      expiry_unchanged: boolean;
    }>(`
      select status::text as status, generation, locked_by,
             heartbeat_at = timestamptz '2000-01-01T00:00:00Z' as heartbeat_unchanged,
             lock_expires_at = timestamptz '2099-01-01T00:00:00Z' as expiry_unchanged
        from metrics.ingestion_jobs
       where id = 1
    `);
    assert.deepEqual(fenced.rows[0], {
      status: "running",
      generation: 4,
      locked_by: "worker-a",
      heartbeat_unchanged: true,
      expiry_unchanged: true,
    });

    await heartbeatIngestionJob({ id: staleJob.id, generation: 4 }, "worker-a", query);
    const current = await db.query<{ heartbeat_advanced: boolean; expiry_replaced: boolean }>(`
      select heartbeat_at > timestamptz '2000-01-01T00:00:00Z' as heartbeat_advanced,
             lock_expires_at < timestamptz '2099-01-01T00:00:00Z' as expiry_replaced
        from metrics.ingestion_jobs
       where id = 1
    `);
    assert.deepEqual(current.rows[0], { heartbeat_advanced: true, expiry_replaced: true });
  } finally {
    await db.close();
  }
});

test("stale-generation completion cannot publish or complete a newer lease when owner identity collides", async () => {
  const db = await ingestionDatabase();
  const query = pgliteQuery(db);
  try {
    const staleJob = await runningJob(db);
    await installNewGenerationLease(db);

    await assert.rejects(completeIngestionJob({
      job: staleJob,
      workerId: "worker-a",
      runId: 1,
      requestCount: 5,
      snapshotCount: 250,
      normalizedCount: 200,
      continuationToken: null,
      candidateRefreshes: [{ entity: "job_nested", entityId: 44, sourceHash: "stale-row-hash" }],
      affectedPeriods: [{ scope: "jobs", periodStart: "2023-01-01" }],
    }, query), /Lost ingestion lease/);

    const state = await generationCollisionState(db);
    assert.deepEqual(state, {
      status: "running",
      generation: 4,
      locked_by: "worker-a",
      requests_used: 0,
      last_error: null,
      stale_run_status: "running",
      current_run_status: "running",
      candidate_count: 0,
      rollup_count: 0,
    });
  } finally {
    await db.close();
  }
});

test("stale-generation failure cannot fail a newer lease when owner identity collides", async () => {
  const db = await ingestionDatabase();
  const query = pgliteQuery(db);
  try {
    const staleJob = await runningJob(db);
    await installNewGenerationLease(db);

    await assert.rejects(failIngestionJob({
      job: staleJob,
      workerId: "worker-a",
      runId: 1,
      requestCount: 5,
      error: new Error("stale execution failed"),
    }, query), /Lost ingestion lease for job 1 generation 3/);

    const state = await generationCollisionState(db);
    assert.deepEqual(state, {
      status: "running",
      generation: 4,
      locked_by: "worker-a",
      requests_used: 0,
      last_error: null,
      stale_run_status: "running",
      current_run_status: "running",
      candidate_count: 0,
      rollup_count: 0,
    });
  } finally {
    await db.close();
  }
});

test("completion and failure reject a run from a different job generation", async () => {
  const db = await ingestionDatabase();
  const query = pgliteQuery(db);
  try {
    const job = await runningJob(db);
    await db.exec("update metrics.ingestion_runs set job_generation = 2 where id = 1");

    await assert.rejects(completeIngestionJob({
      job,
      workerId: "worker-a",
      runId: 1,
      requestCount: 1,
      snapshotCount: 1,
      normalizedCount: 1,
      continuationToken: null,
      candidateRefreshes: [],
      affectedPeriods: [],
    }, query), /Lost ingestion lease/);
    await assert.rejects(failIngestionJob({
      job,
      workerId: "worker-a",
      runId: 1,
      requestCount: 1,
      error: new Error("wrong generation"),
    }, query), /Lost ingestion lease/);

    const state = await db.query<{ job_status: string; run_status: string; job_generation: number }>(`
      select j.status::text as job_status, r.status::text as run_status, r.job_generation
        from metrics.ingestion_jobs j
        join metrics.ingestion_runs r on r.job_id = j.id
       where j.id = 1 and r.id = 1
    `);
    assert.deepEqual(state.rows[0], { job_status: "running", run_status: "running", job_generation: 2 });
  } finally {
    await db.close();
  }
});

test("current-generation failure preserves retry accounting and run failure", async () => {
  const db = await ingestionDatabase();
  const query = pgliteQuery(db);
  try {
    const job = await runningJob(db);
    await failIngestionJob({
      job,
      workerId: "worker-a",
      runId: 1,
      requestCount: 7,
      error: new Error("Simpro request failed"),
    }, query);

    const state = await db.query<{
      job_status: string;
      requests_used: number;
      locked_by: string | null;
      last_error: string;
      retry_scheduled: boolean;
      run_status: string;
      request_count: number;
      error_message: string;
    }>(`
      select j.status::text as job_status, j.requests_used, j.locked_by, j.last_error,
             j.next_attempt_at > now() as retry_scheduled,
             r.status::text as run_status, r.request_count, r.error_message
        from metrics.ingestion_jobs j
        join metrics.ingestion_runs r on r.job_id = j.id
       where j.id = 1 and r.id = 1
    `);
    assert.deepEqual(state.rows[0], {
      job_status: "queued",
      requests_used: 7,
      locked_by: null,
      last_error: "Simpro request failed",
      retry_scheduled: true,
      run_status: "failed",
      request_count: 7,
      error_message: "Simpro request failed",
    });
  } finally {
    await db.close();
  }
});

test("completion atomically publishes candidates and rollups", async () => {
  const db = await ingestionDatabase();
  const query = pgliteQuery(db);
  try {
    const job = await runningJob(db);
    const publication = await completeIngestionJob({
      job,
      workerId: "worker-a",
      runId: 1,
      requestCount: 1,
      snapshotCount: 250,
      normalizedCount: 0,
      continuationToken: null,
      candidateRefreshes: [{ entity: "job_nested", entityId: 44, sourceHash: "row-hash" }],
      affectedPeriods: [{ scope: "jobs", periodStart: "2023-01-01" }],
    }, query);

    assert.deepEqual(publication, { candidate_count: 1, rollup_count: 1 });
    const source = await db.query<{ status: string }>("select status::text as status from metrics.ingestion_jobs where id=1");
    const candidate = await db.query<{ status: string; params: Record<string, unknown> }>(`
      select status::text as status, params from metrics.ingestion_jobs where entity_type='job_nested'
    `);
    const run = await db.query<{ status: string; request_count: number; candidate_count: number }>(`
      select status::text as status, request_count, candidate_count from metrics.ingestion_runs where id=1
    `);
    const rollups = await db.query<{ count: number }>("select count(*)::int as count from metrics.rollup_rebuild_queue");

    assert.equal(source.rows[0]?.status, "succeeded");
    assert.deepEqual(candidate.rows[0], { status: "queued", params: { entityId: 44 } });
    assert.deepEqual(run.rows[0], { status: "succeeded", request_count: 1, candidate_count: 1 });
    assert.equal(rollups.rows[0]?.count, 1);
  } finally {
    await db.close();
  }
});

test("summary candidates do not reopen nested work without a newer Simpro modification", async () => {
  const db = await ingestionDatabase();
  const query = pgliteQuery(db);
  try {
    await db.exec(`
      insert into metrics.raw_simpro_snapshots (id, source_updated_at)
      values (1, timestamptz '2026-07-10T12:00:00Z');
      insert into metrics.metrics_jobs (job_id, source_snapshot_id)
      values (44, 1)
    `);
    const job = await runningJob(db);
    const publication = await completeIngestionJob({
      job,
      workerId: "worker-a",
      runId: 1,
      requestCount: 1,
      snapshotCount: 1,
      normalizedCount: 0,
      continuationToken: null,
      candidateRefreshes: [{
        entity: "job_nested",
        entityId: 44,
        sourceHash: "summary-hash",
        params: { trigger: "summary", sourceModifiedAt: "2026-07-10T12:00:00Z" },
      }],
      affectedPeriods: [],
    }, query);

    assert.deepEqual(publication, { candidate_count: 0, rollup_count: 0 });
    const candidates = await db.query<{ count: number }>(
      "select count(*)::int count from metrics.ingestion_jobs where entity_type='job_nested'",
    );
    assert.equal(candidates.rows[0].count, 0);
  } finally {
    await db.close();
  }
});

test("publication failure rolls source completion back", async () => {
  const db = await ingestionDatabase();
  const query = pgliteQuery(db);
  try {
    const job = await runningJob(db);
    await db.exec("alter table metrics.rollup_rebuild_queue add constraint reject_jobs check (metric_family <> 'jobs')");

    await assert.rejects(completeIngestionJob({
      job,
      workerId: "worker-a",
      runId: 1,
      requestCount: 1,
      snapshotCount: 250,
      normalizedCount: 0,
      continuationToken: null,
      candidateRefreshes: [{ entity: "job_nested", entityId: 44, sourceHash: "row-hash" }],
      affectedPeriods: [{ scope: "jobs", periodStart: "2023-01-01" }],
    }, query), /reject_jobs/);

    const source = await db.query<{ status: string }>("select status::text as status from metrics.ingestion_jobs where id=1");
    const run = await db.query<{ status: string }>("select status::text as status from metrics.ingestion_runs where id=1");
    const candidates = await db.query<{ count: number }>("select count(*)::int as count from metrics.ingestion_jobs where entity_type='job_nested'");
    assert.equal(source.rows[0]?.status, "running");
    assert.equal(run.rows[0]?.status, "running");
    assert.equal(candidates.rows[0]?.count, 0);
  } finally {
    await db.close();
  }
});

async function runningJob(db: PGlite): Promise<IngestionJob> {
  await db.exec(`
    insert into metrics.ingestion_jobs (
      id, entity_type, status, idempotency_key, locked_by, locked_at,
      lock_expires_at, heartbeat_at, generation
    ) values (1, 'jobs', 'running', 'jobs:source', 'worker-a', now(), now() + interval '10 minutes', now(), 3);
    insert into metrics.ingestion_runs (id, job_id, entity_type, worker_id, job_generation)
    values (1, 1, 'jobs', 'worker-a', 3);
    select setval('metrics.ingestion_jobs_id_seq', 1, true)
  `);
  return {
    id: 1,
    entity_type: "jobs",
    status: "running",
    priority: 100,
    idempotency_key: "jobs:source",
    request_budget: 250,
    requests_used: 0,
    continuation_token: null,
    params: {},
    attempts: 1,
    max_attempts: 5,
    generation: 3,
  };
}

async function installNewGenerationLease(db: PGlite) {
  await db.exec(`
    update metrics.ingestion_jobs
       set generation = 4,
           status = 'running',
           locked_by = 'worker-a',
           locked_at = now(),
           heartbeat_at = timestamptz '2000-01-01T00:00:00Z',
           lock_expires_at = timestamptz '2099-01-01T00:00:00Z'
     where id = 1;
    insert into metrics.ingestion_runs (id, job_id, entity_type, worker_id, job_generation)
    values (2, 1, 'jobs', 'worker-a', 4)
  `);
}

async function generationCollisionState(db: PGlite) {
  const result = await db.query<{
    status: string;
    generation: number;
    locked_by: string;
    requests_used: number;
    last_error: string | null;
    stale_run_status: string;
    current_run_status: string;
    candidate_count: number;
    rollup_count: number;
  }>(`
    select j.status::text as status, j.generation, j.locked_by, j.requests_used, j.last_error,
           (select status::text from metrics.ingestion_runs where id = 1) as stale_run_status,
           (select status::text from metrics.ingestion_runs where id = 2) as current_run_status,
           (select count(*)::int from metrics.ingestion_jobs where entity_type = 'job_nested') as candidate_count,
           (select count(*)::int from metrics.rollup_rebuild_queue) as rollup_count
      from metrics.ingestion_jobs j
     where j.id = 1
  `);
  return result.rows[0];
}

function pgliteQuery(db: PGlite): IngestionQuery {
  return (async <T>(sql: string, values: unknown[] = []) => {
    const result = await db.query<T>(sql, values as never[]);
    return { rows: result.rows, rowCount: result.rows.length };
  }) as IngestionQuery;
}

async function ingestionDatabase() {
  const db = new PGlite();
  await db.exec(`
    create schema metrics;
    create type metrics.ingestion_job_status as enum ('queued', 'running', 'succeeded', 'failed', 'cancelled');
    create type metrics.ingestion_entity_type as enum ('quotes', 'quote_nested', 'jobs', 'job_nested', 'employees', 'schedules', 'invoices');
    create type metrics.rollup_rebuild_status as enum ('queued', 'running', 'succeeded', 'failed', 'cancelled');

    create table metrics.ingestion_jobs (
      id bigserial primary key,
      entity_type metrics.ingestion_entity_type not null,
      status metrics.ingestion_job_status not null default 'queued',
      priority integer not null default 100,
      idempotency_key text not null,
      request_budget integer not null default 1000,
      requests_used integer not null default 0,
      continuation_token jsonb,
      params jsonb not null default '{}'::jsonb,
      locked_by text,
      locked_at timestamptz,
      lock_expires_at timestamptz,
      heartbeat_at timestamptz,
      page_cursor jsonb,
      attempts integer not null default 0,
      max_attempts integer not null default 5,
      next_attempt_at timestamptz not null default now(),
      last_error text,
      dead_lettered_at timestamptz,
      completed_at timestamptz,
      generation integer not null default 1,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (entity_type, idempotency_key)
    );

    create table metrics.ingestion_runs (
      id bigserial primary key,
      job_id bigint references metrics.ingestion_jobs(id),
      entity_type metrics.ingestion_entity_type not null,
      status metrics.ingestion_job_status not null default 'running',
      worker_id text not null,
      job_generation integer not null default 1,
      finished_at timestamptz,
      request_count integer not null default 0,
      snapshot_count integer not null default 0,
      normalized_count integer not null default 0,
      candidate_count integer not null default 0,
      continuation_token jsonb,
      page_cursor jsonb,
      error_message text
    );

    create table metrics.rollup_rebuild_queue (
      id bigserial primary key,
      metric_family text not null,
      period_grain text not null,
      period_start date not null,
      dimensions_json jsonb not null default '{}'::jsonb,
      reason text not null,
      status metrics.rollup_rebuild_status not null default 'queued',
      attempts integer not null default 0,
      locked_by text,
      locked_until timestamptz,
      idempotency_key text not null unique,
      created_at timestamptz not null default now(),
      finished_at timestamptz,
      error_message text
    );

    create table metrics.raw_simpro_snapshots (
      id bigserial primary key,
      source_updated_at timestamptz
    );

    create table metrics.metrics_quotes (
      quote_id bigint primary key,
      source_snapshot_id bigint references metrics.raw_simpro_snapshots(id),
      source_deleted_at timestamptz
    );

    create table metrics.metrics_jobs (
      job_id bigint primary key,
      source_snapshot_id bigint references metrics.raw_simpro_snapshots(id),
      source_deleted_at timestamptz
    )
  `);
  return db;
}
