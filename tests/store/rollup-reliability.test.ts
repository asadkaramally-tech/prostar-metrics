import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  claimNextRollupRebuild,
  completeRollupRebuild,
  enqueueRollupRebuild,
  failRollupRebuild,
  heartbeatRollupRebuild,
  type RollupRebuildQuery,
} from "../../src/lib/store/read-model-rebuilds";

type QueueState = {
  status: string;
  attempts: number;
  locked_by: string | null;
  error_message: string | null;
};

test("claim atomically recovers an expired running lease after a worker crash", async () => {
  const db = await createQueueDatabase();
  const query = pgliteQuery(db);
  try {
    const queued = await enqueueRollupRebuild({
      metricFamily: "jobs",
      periodStart: "2023-01-01",
      reason: "crash recovery test",
    }, query);
    assert.ok(queued);

    const crashedClaim = await claimNextRollupRebuild("worker-crashed", undefined, [], query);
    assert.equal(crashedClaim?.id, queued.id);
    assert.equal((await queueState(query, queued.id)).attempts, 1);

    const liveLeaseClaim = await claimNextRollupRebuild("worker-too-early", undefined, [], query);
    assert.equal(liveLeaseClaim, null);

    await query(
      `update metrics.rollup_rebuild_queue
          set locked_until = now() - interval '1 second'
        where id = $1`,
      [queued.id],
    );

    const competingClaims = await Promise.all([
      claimNextRollupRebuild("worker-recovery-a", undefined, [], query),
      claimNextRollupRebuild("worker-recovery-b", undefined, [], query),
    ]);
    const recovered = competingClaims.filter((job) => job !== null);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]?.id, queued.id);

    const recoveredState = await queueState(query, queued.id);
    assert.equal(recoveredState.status, "running");
    assert.equal(recoveredState.attempts, 2);
    assert.match(recoveredState.locked_by ?? "", /^worker-recovery-[ab]$/);
  } finally {
    await db.close();
  }
});

test("claim normalizes PostgreSQL bigint job ids before exposing the worker contract", async () => {
  const query: RollupRebuildQuery = async <T>() => ({
    rows: [{
      id: "42",
      metric_family: "jobs",
      period_grain: "month",
      period_start: "2026-06-01",
      dimensions_json: {},
      locked_by: "worker-bigint",
    } as T],
    rowCount: 1,
  });
  const claimed = await claimNextRollupRebuild("worker-bigint", "jobs", [], query);
  assert.equal(claimed?.id, 42);
  assert.equal(typeof claimed?.id, "number");
});

test("attempts count only consecutive failures in the current invalidation generation", async () => {
  const db = await createQueueDatabase();
  const query = pgliteQuery(db);
  try {
    let queueJobId: number | null = null;
    for (let generation = 1; generation <= 6; generation += 1) {
      const queued = await enqueueRollupRebuild({
        metricFamily: "quotes",
        periodStart: "2023-02-01",
        reason: `successful generation ${generation}`,
      }, query);
      assert.ok(queued);
      queueJobId = queued.id;
      assert.deepEqual(await queueState(query, queueJobId), {
        status: "queued",
        attempts: 0,
        locked_by: null,
        error_message: null,
      });

      const claimed = await claimNextRollupRebuild(`worker-success-${generation}`, "quotes", [], query);
      assert.equal(claimed?.id, queueJobId);
      assert.ok(claimed);
      await completeRollupRebuild(claimed, query);
      assert.equal((await queueState(query, queueJobId)).attempts, 0);
    }
    assert.ok(queueJobId !== null);

    await enqueueRollupRebuild({
      metricFamily: "quotes",
      periodStart: "2023-02-01",
      reason: "generation with one transient failure",
    }, query);
    const transientClaim = await claimNextRollupRebuild("worker-transient", "quotes", [], query);
    assert.equal(transientClaim?.id, queueJobId);
    await failRollupRebuild(queueJobId, new Error("temporary source timeout"), query);

    const transientState = await queueState(query, queueJobId);
    assert.equal(transientState.status, "queued");
    assert.equal(transientState.attempts, 1);

    await enqueueRollupRebuild({
      metricFamily: "quotes",
      periodStart: "2023-02-01",
      reason: "new invalidation after transient failure",
    }, query);
    assert.equal((await queueState(query, queueJobId)).attempts, 0);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const poisonClaim = await claimNextRollupRebuild(`worker-poison-${attempt}`, "quotes", [], query);
      assert.equal(poisonClaim?.id, queueJobId);
      await failRollupRebuild(queueJobId, new Error(`poison failure ${attempt}`), query);
    }
    const poisonState = await queueState(query, queueJobId);
    assert.equal(poisonState.status, "failed");
    assert.equal(poisonState.attempts, 5);
  } finally {
    await db.close();
  }
});

test("enqueue cancels stale failed and queued siblings for the same rollup scope", async () => {
  const db = await createQueueDatabase();
  const query = pgliteQuery(db);
  try {
    await query(
      `insert into metrics.rollup_rebuild_queue (
         metric_family, period_grain, period_start, dimensions_json, reason, status, idempotency_key, finished_at, error_message
       ) values
         ('commissions', 'month', '2023-04-01', '{}'::jsonb, 'old failed', 'failed', 'old-failed', now(), 'source_complete is false'),
         ('commissions', 'month', '2023-04-01', '{}'::jsonb, 'old queued', 'queued', 'old-queued', null, null)`,
    );

    const fresh = await enqueueRollupRebuild({
      metricFamily: "commissions",
      periodStart: "2023-04-01",
      reason: "fresh rebuild",
      idempotencyKey: "fresh",
    }, query);

    assert.ok(fresh);
    const states = await query<{ idempotency_key: string; status: string; error_message: string | null }>(
      `select idempotency_key, status::text, error_message
         from metrics.rollup_rebuild_queue
        order by idempotency_key`,
    );
    assert.deepEqual(states.rows.map((row) => [row.idempotency_key, row.status]), [
      ["fresh", "queued"],
      ["old-failed", "cancelled"],
      ["old-queued", "cancelled"],
    ]);
    assert.match(states.rows.find((row) => row.idempotency_key === "old-failed")?.error_message ?? "", /Superseded/);
  } finally {
    await db.close();
  }
});

test("stale rollup owners cannot complete or fail a replacement worker's lease", async () => {
  const db = await createQueueDatabase();
  const query = pgliteQuery(db);
  try {
    const queued = await enqueueRollupRebuild({
      metricFamily: "jobs",
      periodStart: "2023-03-01",
      reason: "owner fence test",
    }, query);
    assert.ok(queued);
    const claimed = await claimNextRollupRebuild("worker-current", "jobs", [], query);
    assert.equal(claimed?.locked_by, "worker-current");

    assert.ok(claimed);
    await assert.rejects(
      completeRollupRebuild({ ...claimed, locked_by: "worker-stale" }, query),
      /lost rollup lease.*completion/i,
    );
    assert.equal((await queueState(query, queued.id)).status, "running");
    await failRollupRebuild(queued.id, new Error("stale failure"), { query, lockedBy: "worker-stale" });
    assert.equal((await queueState(query, queued.id)).status, "running");

    await completeRollupRebuild(claimed, query);
    assert.equal((await queueState(query, queued.id)).status, "succeeded");
  } finally {
    await db.close();
  }
});

test("a successful rebuild cancels queued and failed siblings for the same period", async () => {
  const db = await createQueueDatabase();
  const query = pgliteQuery(db);
  try {
    await query(
      `insert into metrics.rollup_rebuild_queue (
         metric_family, period_grain, period_start, dimensions_json, reason,
         status, idempotency_key, error_message, finished_at
       ) values
         ('commissions', 'month', '2023-04-01', '{}'::jsonb, 'old failure',
          'failed', 'old-failed', 'zero eligible work', now()),
         ('commissions', 'month', '2023-04-01', '{}'::jsonb, 'duplicate invalidation',
          'queued', 'queued-duplicate', null, null),
         ('jobs', 'month', '2023-04-01', '{}'::jsonb, 'different target',
          'queued', 'different-target', null, null)`,
    );
    const queued = await enqueueRollupRebuild({
      metricFamily: "commissions",
      periodStart: "2023-04-01",
      reason: "replacement",
      idempotencyKey: "replacement-success",
    }, query);
    assert.ok(queued);
    const claimed = await claimNextRollupRebuild("worker-replacement", "commissions", [], query);
    assert.ok(claimed);
    await completeRollupRebuild(claimed, query);

    const statuses = await query<{ idempotency_key: string; status: string; error_message: string | null }>(
      "select idempotency_key, status::text, error_message from metrics.rollup_rebuild_queue order by id",
    );
    const byKey = new Map(statuses.rows.map((row) => [row.idempotency_key, row]));
    assert.equal(byKey.get("old-failed")?.status, "cancelled");
    assert.match(byKey.get("old-failed")?.error_message ?? "", /Superseded by a newer queued rebuild/);
    assert.equal(byKey.get("queued-duplicate")?.status, "cancelled");
    assert.equal(byKey.get("different-target")?.status, "queued");
    assert.equal(byKey.get("replacement-success")?.status, "succeeded");
  } finally {
    await db.close();
  }
});

test("heartbeat requires exact scope and cannot revive an expired or replaced lease", async () => {
  const db = await createQueueDatabase();
  const query = pgliteQuery(db);
  try {
    const queued = await enqueueRollupRebuild({
      metricFamily: "commissions",
      periodStart: "2023-05-01",
      reason: "heartbeat fence test",
    }, query);
    assert.ok(queued);
    const original = await claimNextRollupRebuild("worker-original", "commissions", [], query);
    assert.ok(original);

    await assert.rejects(
      heartbeatRollupRebuild({ ...original, dimensions_json: { forged: true } }, query),
      /lost rollup lease/i,
    );
    assert.equal((await queueState(query, queued.id)).locked_by, "worker-original");

    await query("update metrics.rollup_rebuild_queue set locked_until = clock_timestamp() - interval '1 second' where id = $1", [queued.id]);
    await assert.rejects(heartbeatRollupRebuild(original, query), /lost rollup lease/i);
    const expired = await query<{ live: boolean }>(
      "select locked_until > clock_timestamp() as live from metrics.rollup_rebuild_queue where id = $1",
      [queued.id],
    );
    assert.equal(expired.rows[0]?.live, false);

    const replacement = await claimNextRollupRebuild("worker-replacement", "commissions", [], query);
    assert.ok(replacement);
    await assert.rejects(heartbeatRollupRebuild(original, query), /lost rollup lease/i);
    await heartbeatRollupRebuild(replacement, query);
    assert.equal((await queueState(query, queued.id)).locked_by, "worker-replacement");
  } finally {
    await db.close();
  }
});

async function createQueueDatabase() {
  const db = new PGlite();
  await db.exec(`
    create schema metrics;
    create type metrics.rollup_rebuild_status as enum (
      'queued', 'running', 'succeeded', 'failed', 'cancelled'
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
  `);
  return db;
}

function pgliteQuery(db: PGlite): RollupRebuildQuery {
  return async <T = Record<string, unknown>>(sql: string, values: unknown[] = []) => {
    const result = await db.query<T>(sql, values);
    return { rows: result.rows };
  };
}

async function queueState(query: RollupRebuildQuery, jobId: number): Promise<QueueState> {
  const result = await query<QueueState>(
    `select status::text, attempts, locked_by, error_message
       from metrics.rollup_rebuild_queue
      where id = $1`,
    [jobId],
  );
  assert.ok(result.rows[0]);
  return result.rows[0];
}
