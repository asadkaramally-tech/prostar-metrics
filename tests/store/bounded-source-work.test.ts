import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  BOUNDED_BACKFILL_SOURCES,
  BoundedSourceWorkConflictError,
  enqueueBoundedSourceWork,
  listBoundedSourceWorkRequests,
  parseBoundedSourceWork,
  type BoundedSourceWorkQuery,
} from "../../src/lib/store/bounded-source-work";

const now = new Date("2026-07-10T18:00:00.000Z");

test("bounded inputs exclude all invoice sources and enforce entity and three-month limits", () => {
  assert.equal(BOUNDED_BACKFILL_SOURCES.includes("invoices" as never), false);
  assert.equal(BOUNDED_BACKFILL_SOURCES.some((source) => source.includes("invoice")), false);

  assert.deepEqual(parseBoundedSourceWork({
    kind: "entity_refresh",
    entityType: "job",
    entityId: 42,
  }, now), {
    kind: "entity_refresh",
    entityType: "job",
    entityId: 42,
  });
  assert.throws(
    () => parseBoundedSourceWork({ kind: "entity_refresh", entityType: "invoice", entityId: 42 }, now),
    /entityType must be/,
  );
  assert.throws(
    () => parseBoundedSourceWork({ kind: "entity_refresh", entityType: "job", entityId: 0 }, now),
    /positive integer/,
  );

  assert.doesNotThrow(() => parseBoundedSourceWork({
    kind: "period_backfill",
    sourceFamily: "timesheets",
    periodStart: "2026-04-01",
    periodEnd: "2026-06-01",
  }, now));
  assert.throws(() => parseBoundedSourceWork({
    kind: "period_backfill",
    sourceFamily: "timesheets",
    periodStart: "2026-03-01",
    periodEnd: "2026-06-01",
  }, now), /at most 3 months/);
  assert.throws(() => parseBoundedSourceWork({
    kind: "period_backfill",
    sourceFamily: "invoices",
    periodStart: "2026-06-01",
    periodEnd: "2026-06-01",
  }, now), /not approved/);
  assert.throws(() => parseBoundedSourceWork({
    kind: "period_backfill",
    sourceFamily: "jobs",
    periodStart: "2026-08-01",
    periodEnd: "2026-08-01",
  }, now), /current business month/);
});

test("the reusable enqueue boundary revalidates direct callers before querying", async () => {
  let queries = 0;
  const query: BoundedSourceWorkQuery = async <T>() => {
    queries += 1;
    return { rows: [] as T[], rowCount: 0 };
  };

  await assert.rejects(enqueueBoundedSourceWork({
    work: {
      kind: "period_backfill",
      sourceFamily: "invoices",
      periodStart: "2026-06-01",
      periodEnd: "2026-06-01",
    } as never,
    requestedBy: "reconciliation-worker",
    reason: "Repair detected upstream drift",
    origin: "reconciliation",
  }, { query, requestId: "invalid-invoice", now }), /not approved/);
  await assert.rejects(enqueueBoundedSourceWork({
    work: {
      kind: "period_backfill",
      sourceFamily: "jobs",
      periodStart: "2026-03-01",
      periodEnd: "2026-06-01",
    },
    requestedBy: "reconciliation-worker",
    reason: "Repair detected upstream drift",
    origin: "reconciliation",
  }, { query, requestId: "invalid-window", now }), /at most 3 months/);
  assert.equal(queries, 0);
});

test("entity refresh is queued once, audited, and deduplicated while active", async () => {
  const db = await boundedWorkDatabase();
  const query = pgliteQuery(db);
  try {
    const first = await enqueueBoundedSourceWork({
      work: { kind: "entity_refresh", entityType: "job", entityId: 314 },
      requestedBy: "ASAD@PROSTARMECHANICAL.COM",
      reason: "Repair missing job detail",
    }, { query, requestId: "request-first", now });
    const duplicate = await enqueueBoundedSourceWork({
      work: { kind: "entity_refresh", entityType: "job", entityId: 314 },
      requestedBy: "laila@prostarmechanical.com",
      reason: "Confirm job detail refresh",
    }, { query, requestId: "request-second", now: new Date(now.getTime() + 1_000) });

    assert.equal(first.requestId, "request-first");
    assert.equal(first.status, "queued");
    assert.equal(first.duplicate, false);
    assert.equal(duplicate.requestId, "request-first");
    assert.equal(duplicate.duplicate, true);

    const queue = await db.query<{
      count: number;
      entity_type: string;
      operation: string;
      request_budget: number;
      entity_id: string;
    }>(`
      select count(*)::integer as count,
             max(entity_type::text) as entity_type,
             max(operation) as operation,
             max(request_budget)::integer as request_budget,
             max(params ->> 'entityId') as entity_id
        from metrics.ingestion_jobs
    `);
    assert.deepEqual(queue.rows[0], {
      count: 1,
      entity_type: "job_nested",
      operation: "bounded_refresh",
      request_budget: 100,
      entity_id: "314",
    });
    const audits = await db.query<{ count: number }>(`
      select count(*)::integer as count
        from metrics.audit_events
       where action = 'bounded_source_work_requested'
    `);
    assert.equal(audits.rows[0].count, 2);
  } finally {
    await db.close();
  }
});

test("reconciliation job refresh is superseded by exact historical checksum-backed nested authority", async () => {
  const db = await boundedWorkDatabase();
  const query = pgliteQuery(db);
  try {
    await seedHistoricalBulkJobNestedAuthority(db, 314);
    const reconciliation = await enqueueBoundedSourceWork({
      work: { kind: "entity_refresh", entityType: "job", entityId: 314 },
      requestedBy: "metrics-reconciliation-worker",
      reason: "Repair incomplete nested reconciliation evidence.",
      origin: "reconciliation",
    }, { query, requestId: "historical-authority", now });

    assert.equal(reconciliation.status, "superseded");
    assert.equal(reconciliation.duplicate, true);
    const suppressed = await db.query<{ queue_jobs: number; audits: number; authority: string }>(`
      select
        (select count(*)::integer from metrics.ingestion_jobs) as queue_jobs,
        (select count(*)::integer from metrics.audit_events
          where action = 'bounded_source_work_suppressed') as audits,
        (select after_value->>'authority' from metrics.audit_events
          where action = 'bounded_source_work_suppressed') as authority
    `);
    assert.deepEqual(suppressed.rows[0], {
      queue_jobs: 0,
      audits: 1,
      authority: "checksum_verified_full_universe_artifact_projection",
    });

    const manual = await enqueueBoundedSourceWork({
      work: { kind: "entity_refresh", entityType: "job", entityId: 314 },
      requestedBy: "asad@prostarmechanical.com",
      reason: "Operator requested a direct source verification.",
      origin: "manual",
    }, { query, requestId: "manual-override", now });
    assert.equal(manual.status, "queued");
  } finally {
    await db.close();
  }
});

test("manual completed backfill is an audited duplicate without reopening coverage", async () => {
  const db = await boundedWorkDatabase();
  const query = pgliteQuery(db);
  try {
    await seedCompletedBackfill(db, ["2026-05-01", "2026-06-01"]);
    const result = await enqueueBoundedSourceWork({
      work: {
        kind: "period_backfill",
        sourceFamily: "jobs",
        periodStart: "2026-05-01",
        periodEnd: "2026-06-01",
      },
      requestedBy: "asad@prostarmechanical.com",
      reason: "Verify completed historical jobs",
      origin: "manual",
    }, { query, requestId: "manual-complete", now });

    assert.equal(result.status, "succeeded");
    assert.equal(result.duplicate, true);
    const ledger = await db.query<{ statuses: string; pending: number }>(`
      select string_agg(status, ',' order by month_start) as statuses,
             count(*) filter (where reconciliation_status = 'pending')::integer as pending
        from metrics.backfill_source_month_ledger
    `);
    assert.deepEqual(ledger.rows[0], { statuses: "completed,completed", pending: 0 });
    const manifests = await db.query<{ generations: string }>(`
      select string_agg(generation::text, ',' order by work_unit_id) as generations
        from metrics.backfill_traversal_manifests
    `);
    assert.equal(manifests.rows[0].generations, "4,4");
  } finally {
    await db.close();
  }
});

test("reconciliation repair reopens completed units, resets manifests, then deduplicates", async () => {
  const db = await boundedWorkDatabase();
  const query = pgliteQuery(db);
  try {
    await seedCompletedBackfill(db, ["2026-05-01", "2026-06-01"]);
    const repair = await enqueueBoundedSourceWork({
      work: {
        kind: "period_backfill",
        sourceFamily: "jobs",
        periodStart: "2026-05-01",
        periodEnd: "2026-06-01",
      },
      requestedBy: "reconciliation-worker",
      reason: "Repair detected upstream drift",
      origin: "reconciliation",
    }, { query, requestId: "repair-first", now });
    const duplicate = await enqueueBoundedSourceWork({
      work: {
        kind: "period_backfill",
        sourceFamily: "jobs",
        periodStart: "2026-05-01",
        periodEnd: "2026-06-01",
      },
      requestedBy: "reconciliation-worker",
      reason: "Repair detected upstream drift",
      origin: "reconciliation",
    }, { query, requestId: "repair-second", now: new Date(now.getTime() + 1_000) });

    assert.equal(repair.status, "queued");
    assert.equal(repair.duplicate, false);
    assert.equal(duplicate.status, "queued");
    assert.equal(duplicate.duplicate, true);

    const ledger = await db.query<{ statuses: string; pending: number }>(`
      select string_agg(status, ',' order by month_start) as statuses,
             count(*) filter (where reconciliation_status = 'pending')::integer as pending
        from metrics.backfill_source_month_ledger
    `);
    assert.deepEqual(ledger.rows[0], { statuses: "queued,queued", pending: 2 });
    const manifests = await db.query<{
      generations: string;
      statuses: string;
      pages: number;
      reopened: number;
    }>(`
      select string_agg(generation::text, ',' order by work_unit_id) as generations,
             string_agg(manifest_status, ',' order by work_unit_id) as statuses,
             sum(page_count)::integer as pages,
             count(*) filter (where reopened_at is not null)::integer as reopened
        from metrics.backfill_traversal_manifests
    `);
    assert.deepEqual(manifests.rows[0], {
      generations: "5,5",
      statuses: "collecting,collecting",
      pages: 0,
      reopened: 2,
    });
  } finally {
    await db.close();
  }
});

test("period backfill refuses unplanned source-months and writes no audit", async () => {
  const db = await boundedWorkDatabase();
  const query = pgliteQuery(db);
  try {
    await assert.rejects(enqueueBoundedSourceWork({
      work: {
        kind: "period_backfill",
        sourceFamily: "jobs",
        periodStart: "2026-05-01",
        periodEnd: "2026-06-01",
      },
      requestedBy: "asad@prostarmechanical.com",
      reason: "Repair missing historical jobs",
    }, { query, requestId: "missing-plan", now }), BoundedSourceWorkConflictError);
    const audits = await db.query<{ count: number }>("select count(*)::integer as count from metrics.audit_events");
    assert.equal(audits.rows[0].count, 0);
  } finally {
    await db.close();
  }
});

test("queue history projects worker status from app-owned queues", async () => {
  const db = await boundedWorkDatabase();
  const query = pgliteQuery(db);
  try {
    await enqueueBoundedSourceWork({
      work: { kind: "entity_refresh", entityType: "employee", entityId: 9 },
      requestedBy: "laila@prostarmechanical.com",
      reason: "Refresh employee source record",
    }, { query, requestId: "employee-request", now });
    await db.exec("update metrics.ingestion_jobs set status = 'running', updated_at = now()");

    const requests = await listBoundedSourceWorkRequests(20, query);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].requestId, "employee-request");
    assert.equal(requests[0].status, "running");
    assert.equal(requests[0].targetLabel, "employee #9");
  } finally {
    await db.close();
  }
});

function pgliteQuery(db: PGlite): BoundedSourceWorkQuery {
  return (async <T>(sql: string, values: unknown[] = []) => {
    const result = await db.query<T>(sql, values as never[]);
    return { rows: result.rows, rowCount: result.rows.length };
  }) as BoundedSourceWorkQuery;
}

async function seedCompletedBackfill(db: PGlite, months: string[]) {
  for (let index = 0; index < months.length; index += 1) {
    const id = index + 1;
    await db.query(`
      insert into metrics.backfill_source_month_ledger (
        id, source_family, month_start, status, work_phase, reconciliation_status, completed_at
      ) values ($1, 'jobs', $2::date, 'completed', 'reconcile', 'matched', now())
    `, [id, months[index]]);
    await db.query(`
      insert into metrics.backfill_traversal_manifests (
        work_unit_id, generation, manifest_status, filter_contract, as_of_watermark,
        observed_boundary, required_target_keys, completed_target_keys, exact_source_ids,
        listed_source_ids, detailed_source_ids, page_count, record_count, completed_at
      ) values (
        $1, 4, 'completed', '{"sourceFamily":"jobs"}'::jsonb, now(), '{}'::jsonb,
        '["jobs:month"]'::jsonb, '["jobs:month"]'::jsonb, '["1"]'::jsonb,
        '["1"]'::jsonb, '["1"]'::jsonb, 1, 1, now()
      )
    `, [id]);
  }
}

async function seedHistoricalBulkJobNestedAuthority(db: PGlite, jobId: number) {
  const ledger = await db.query<{ id: number }>(`
    insert into metrics.backfill_source_month_ledger (
      source_family, month_start, month_end_exclusive, status, work_phase,
      reconciliation_status, completed_at
    ) values (
      'job_nested', '2024-03-01', '2024-04-01', 'completed', 'reconcile', 'matched', now()
    ) returning id
  `);
  const workUnitId = ledger.rows[0].id;
  await db.query(`
    insert into metrics.backfill_traversal_manifests (
      work_unit_id, generation, manifest_status, filter_contract, as_of_watermark,
      observed_boundary, required_target_keys, completed_target_keys, exact_source_ids,
      listed_source_ids, detailed_source_ids, page_count, record_count, completed_at
    ) values (
      $1, 7, 'completed', '{}'::jsonb, now(), '{}'::jsonb,
      '["jobs:month"]'::jsonb, '["jobs:month"]'::jsonb, jsonb_build_array($2::text),
      jsonb_build_array($2::text), jsonb_build_array($2::text), 1, 1, now()
    )
  `, [workUnitId, jobId]);
  await db.query(`
    insert into metrics.backfill_traversal_pages (
      work_unit_id, generation, source_method, exact_ids, request_query, synthetic
    ) values (
      $1, 7, 'checksum_verified_full_universe_artifact_projection:listJobs',
      jsonb_build_array($2::text),
      '{"_bulkArtifactEvidence":{"provenance":"checksum_verified_full_universe_artifact_projection","fabricatedApiResponse":false}}'::jsonb,
      true
    )
  `, [workUnitId, jobId]);
  await db.query(`
    insert into metrics.raw_simpro_snapshots (
      entity_type, entity_id, source_version, complete_traversal, source_deleted_at
    ) values ('jobs', $1::text, 'bulk-bootstrap:test-manifest', true, null)
  `, [jobId]);
  await db.query(`
    insert into metrics.source_period_manifests (
      source_family, period_start, period_end, coverage_status, reconciliation_status,
      evidence_json, manifest_generation, reconciliation_generation
    ) values (
      'job_nested', '2024-03-01', '2024-03-31', 'partial', 'pending',
      jsonb_build_object(
        'authoritativeSource', 'project_nested_traversals',
        'invalidProjectIds', jsonb_build_array($1::text)
      ),
      8, null
    )
  `, [jobId]);
}

async function boundedWorkDatabase() {
  const db = new PGlite();
  await db.exec(`
    create schema metrics;
    create type metrics.ingestion_job_status as enum ('queued', 'running', 'succeeded', 'failed', 'cancelled');
    create type metrics.ingestion_entity_type as enum (
      'quote_nested', 'job_nested', 'employees', 'schedules'
    );

    create table metrics.ingestion_jobs (
      id bigserial primary key,
      entity_type metrics.ingestion_entity_type not null,
      operation text not null default 'sync',
      status metrics.ingestion_job_status not null default 'queued',
      priority integer not null default 100,
      idempotency_key text not null,
      request_budget integer not null default 100,
      requests_used integer not null default 0,
      continuation_token jsonb,
      page_cursor jsonb,
      params jsonb not null default '{}'::jsonb,
      source_window_start timestamptz,
      source_window_end timestamptz,
      locked_by text,
      locked_at timestamptz,
      lock_expires_at timestamptz,
      heartbeat_at timestamptz,
      attempts integer not null default 0,
      next_attempt_at timestamptz not null default now(),
      last_error text,
      dead_lettered_at timestamptz,
      completed_at timestamptz,
      generation integer not null default 1,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (entity_type, idempotency_key)
    );

    create table metrics.audit_events (
      id bigserial primary key,
      actor_email text not null,
      action text not null,
      entity_type text not null,
      entity_id text not null,
      before_value jsonb,
      after_value jsonb,
      reason text,
      created_at timestamptz not null default now()
    );

    create table metrics.backfill_source_month_ledger (
      id bigserial primary key,
      source_family text not null,
      month_start date not null,
      month_end_exclusive date,
      status text not null default 'planned',
      work_phase text not null default 'ingest',
      reconciliation_status text not null default 'pending',
      retry_count integer not null default 0,
      next_attempt_at timestamptz not null default now(),
      locked_by text,
      locked_at timestamptz,
      lease_expires_at timestamptz,
      heartbeat_at timestamptz,
      reserved_capacity_date date,
      reserved_requests integer not null default 0,
      last_error text,
      dead_lettered_at timestamptz,
      started_at timestamptz,
      completed_at timestamptz,
      updated_at timestamptz not null default now(),
      unique (source_family, month_start)
    );

    create table metrics.source_period_manifests (
      source_family text not null,
      period_start date not null,
      period_end date not null,
      coverage_status text not null,
      reconciliation_status text not null,
      evidence_json jsonb not null default '{}'::jsonb,
      manifest_generation integer,
      reconciliation_generation integer,
      primary key (source_family, period_start)
    );

    create table metrics.backfill_traversal_pages (
      work_unit_id bigint not null references metrics.backfill_source_month_ledger(id),
      generation integer not null,
      source_method text not null,
      exact_ids jsonb not null,
      request_query jsonb not null,
      synthetic boolean not null
    );

    create table metrics.raw_simpro_snapshots (
      entity_type text not null,
      entity_id text not null,
      source_version text not null,
      complete_traversal boolean not null,
      source_deleted_at timestamptz
    );

    create table metrics.backfill_traversal_manifests (
      work_unit_id bigint primary key references metrics.backfill_source_month_ledger(id),
      generation integer not null default 1,
      manifest_status text not null default 'collecting',
      filter_contract jsonb not null default '{}'::jsonb,
      as_of_watermark timestamptz not null default now(),
      observed_boundary jsonb not null default '{}'::jsonb,
      required_target_keys jsonb not null default '[]'::jsonb,
      completed_target_keys jsonb not null default '[]'::jsonb,
      exact_source_ids jsonb not null default '[]'::jsonb,
      listed_source_ids jsonb not null default '[]'::jsonb,
      detailed_source_ids jsonb not null default '[]'::jsonb,
      exclusions jsonb not null default '[]'::jsonb,
      continuation_token jsonb,
      detail_coverage_required boolean not null default false,
      page_count integer not null default 0,
      record_count integer not null default 0,
      empty_proof jsonb,
      open_quote_discovery jsonb not null default '{"required":false,"status":"not_required"}'::jsonb,
      violations jsonb not null default '[]'::jsonb,
      completed_at timestamptz,
      reopened_at timestamptz,
      updated_at timestamptz not null default now()
    );
  `);
  return db;
}
