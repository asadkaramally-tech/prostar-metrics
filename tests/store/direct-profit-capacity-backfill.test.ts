import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { parseDirectBackfillArgs } from "../../workers/backfill-simpro-profit-capacity-direct";
import {
  assertTargetIdentity,
  acquireSingleton,
  applySourceDeletedTarget,
  claimExactTargetBatch,
  completeExactTarget,
  heartbeatSingleton,
  lockOwnedExactTarget,
  persistTargetSnapshot,
  releaseExactTargetBatch,
  releaseSingleton,
  seedExactTargets,
  type ExactBackfillTarget,
} from "../../src/lib/store/direct-profit-capacity-backfill";

function target(overrides: Partial<ExactBackfillTarget> = {}): ExactBackfillTarget {
  return {
    id: "1", target_type: "cost_center", target_key: "10:20:30", job_id: "10",
    section_id: "20", cost_center_id: "30", employee_id: null, period_start: "2026-06-01",
    source_snapshot_id: null, ...overrides,
  };
}

test("direct backfill parser fails closed and reserves an Azure closeout window", () => {
  assert.deepEqual(
    parseDirectBackfillArgs(["--max-requests", "5000", "--runtime-minutes", "17", "--concurrency", "5", "--actor", "owner@example.com"]),
    { maxRequests: 5000, runtimeMinutes: 17, concurrency: 5, actorEmail: "owner@example.com", retryFailed: false, confirmation: undefined },
  );
  assert.throws(() => parseDirectBackfillArgs(["--unknown"]), /Unknown argument/);
  assert.throws(() => parseDirectBackfillArgs(["--runtime-minutes", "18", "--actor", "x"]), /1 through 17/);
  assert.throws(() => parseDirectBackfillArgs(["--concurrency", "6", "--actor", "x"]), /1 through 5/);
  assert.throws(() => parseDirectBackfillArgs(["--retry-failed", "--actor", "x"]), /requires --confirm/);
  assert.equal(
    parseDirectBackfillArgs(["--retry-failed", "--confirm", "RETRY-SIMPRO-PROFIT-CAPACITY-028", "--actor", "x"]).retryFailed,
    true,
  );
});

test("response identity is exact for job, employee, and cost-center parents", () => {
  assert.doesNotThrow(() => assertTargetIdentity(target(), { ID: 30, Job: { ID: 10 }, Section: { ID: 20 } }));
  assert.doesNotThrow(() => assertTargetIdentity(target({ target_type: "job", target_key: "10", cost_center_id: null, section_id: null }), { ID: 10 }));
  assert.doesNotThrow(() => assertTargetIdentity(target({ target_type: "employee", target_key: "40", job_id: null, cost_center_id: null, section_id: null, employee_id: "40" }), { ID: 40 }));
  assert.throws(() => assertTargetIdentity(target(), { ID: 31, Job: { ID: 10 } }), /identity mismatch/);
  assert.throws(() => assertTargetIdentity(target(), { ID: 30, Job: { ID: 11 } }), /job mismatch/);
});

test("seeding freezes all three migration-027 gap classes before normalization", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const query = async <T>(sql: string, values?: unknown[]) => {
    calls.push({ sql, values });
    return { rows: [{ inserted: "12" }] as T[], rowCount: 1 };
  };
  assert.equal(await seedExactTargets(query), 12);
  assert.match(calls[0].sql, /not cost_center\.totals_authoritative/);
  assert.match(calls[0].sql, /capacity_normalized_at is null/);
  assert.match(calls[0].sql, /profit_capacity_normalized_at is null/);
  assert.match(calls[0].sql, /on conflict \(contract, target_type, target_key\) do nothing/);
});

test("claims use durable leases, skip locked rows, and process cost centers first", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const query = async <T>(sql: string, values?: unknown[]) => {
    calls.push({ sql, values });
    return { rows: [] as T[], rowCount: 0 };
  };
  await claimExactTargetBatch(query, "worker", 50);
  assert.match(calls[0].sql, /for update skip locked/);
  assert.match(calls[0].sql, /when 'cost_center' then 0/);
  assert.match(calls[0].sql, /lock_expires_at = now\(\) \+ interval '10 minutes'/);
});

test("singleton acquisition handles first, active, expired, released, and concurrent owners", async () => {
  const db = await exactLedgerDatabase();
  const query = pgliteQuery(db);
  try {
    assert.equal(await acquireSingleton(query, "worker-a"), true);
    assert.equal(await acquireSingleton(query, "worker-b"), false);
    await db.exec("update metrics.profit_capacity_exact_backfill_control set lock_expires_at = now() - interval '1 second'");
    assert.equal(await acquireSingleton(query, "worker-b"), true);
    await assert.rejects(heartbeatSingleton(query, "worker-a"), /Lost the exact backfill singleton lease/);
    await releaseSingleton(query, "worker-a");
    const stillOwned = await db.query<{ locked_by: string | null }>("select locked_by from metrics.profit_capacity_exact_backfill_control");
    assert.equal(stillOwned.rows[0]?.locked_by, "worker-b");
    await heartbeatSingleton(query, "worker-b");
    await releaseSingleton(query, "worker-b");

    const contenders = await Promise.all(["worker-c", "worker-d", "worker-e"].map((worker) => acquireSingleton(query, worker)));
    assert.equal(contenders.filter(Boolean).length, 1);
  } finally {
    await db.close();
  }
});

test("snapshot attachment is idempotent and stale target owners cannot attach or normalize", async () => {
  const db = await exactLedgerDatabase();
  const query = pgliteQuery(db);
  try {
    await db.exec(`
      insert into metrics.profit_capacity_exact_backfill_targets (
        id, contract, target_type, target_key, job_id, status, attempts, locked_by, lock_expires_at
      ) values (1, 'simpro-profit-capacity-028-exact', 'job', '10', 10, 'running', 1, 'worker-a', now() + interval '10 minutes')
    `);
    const jobTarget = target({
      target_type: "job", target_key: "10", job_id: "10", section_id: null,
      cost_center_id: null, employee_id: null, source_snapshot_id: null,
    });
    const first = await persistTargetSnapshot(query, jobTarget, { ID: 10, Name: "Job" }, "worker-a");
    const repeated = await persistTargetSnapshot(query, jobTarget, { Name: "Job", ID: 10 }, "worker-a");
    assert.equal(repeated.id, first.id);
    const rawCount = await db.query<{ count: number }>("select count(*)::int as count from metrics.raw_simpro_snapshots");
    assert.equal(rawCount.rows[0]?.count, 1);

    await db.exec("update metrics.profit_capacity_exact_backfill_targets set locked_by = 'worker-b' where id = 1");
    await assert.rejects(lockOwnedExactTarget(query, jobTarget, "worker-a"), /Lost target lease before normalizing/);
    await assert.rejects(
      persistTargetSnapshot(query, jobTarget, { ID: 10, Name: "Stale response" }, "worker-a"),
      /Lost target lease while persisting/,
    );
    const afterStale = await db.query<{ count: number }>("select count(*)::int as count from metrics.raw_simpro_snapshots");
    assert.equal(afterStale.rows[0]?.count, 1);
  } finally {
    await db.close();
  }
});

test("heartbeat failure cleanup releases an entire just-claimed batch", async () => {
  const db = await exactLedgerDatabase();
  const query = pgliteQuery(db);
  try {
    await db.exec(`
      insert into metrics.profit_capacity_exact_backfill_targets (
        contract, target_type, target_key, job_id, status, attempts, locked_by, lock_expires_at
      ) values
        ('simpro-profit-capacity-028-exact', 'job', '10', 10, 'running', 2, 'worker-a', now() + interval '10 minutes'),
        ('simpro-profit-capacity-028-exact', 'job', '11', 11, 'running', 2, 'worker-a', now() + interval '10 minutes')
    `);
    const rows = await db.query<{ id: string; target_key: string }>(
      "select id::text, target_key from metrics.profit_capacity_exact_backfill_targets order by id",
    );
    const targets = rows.rows.map((row) => target({ id: row.id, target_type: "job", target_key: row.target_key, job_id: row.target_key, section_id: null, cost_center_id: null }));
    await releaseExactTargetBatch(query, targets, "worker-a");
    const released = await db.query<{ status: string; attempts: number; locked_by: string | null }>(
      "select status, attempts, locked_by from metrics.profit_capacity_exact_backfill_targets order by id",
    );
    assert.deepEqual(released.rows, [
      { status: "queued", attempts: 1, locked_by: null },
      { status: "queued", attempts: 1, locked_by: null },
    ]);
  } finally {
    await db.close();
  }
});

test("source-deleted job normalization uses the caller transaction and rolls back with it", async () => {
  const db = await exactLedgerDatabase();
  const query = pgliteQuery(db);
  try {
    await db.exec("insert into metrics.metrics_jobs (job_id, completed_date, stage) values (10, '2026-06-15', 'Complete')");
    await db.exec("begin");
    try {
      const periods = await applySourceDeletedTarget(
        query,
        target({ target_type: "job", target_key: "10", job_id: "10", section_id: null, cost_center_id: null }),
      );
      assert.deepEqual(periods, [
        { scope: "jobs", periodStart: "2026-06-01" },
        { scope: "technicians", periodStart: "2026-06-01" },
        { scope: "commissions", periodStart: "2026-06-01" },
      ]);
      const inside = await db.query<{ deleted: boolean }>(
        "select source_deleted_at is not null as deleted from metrics.metrics_jobs where job_id = 10",
      );
      assert.equal(inside.rows[0]?.deleted, true);
    } finally {
      await db.exec("rollback");
    }
    const after = await db.query<{ deleted: boolean }>(
      "select source_deleted_at is not null as deleted from metrics.metrics_jobs where job_id = 10",
    );
    assert.equal(after.rows[0]?.deleted, false);
  } finally {
    await db.close();
  }
});

test("completion derives a follow-up from the conflict-locked rollup row", async () => {
  const db = await exactLedgerDatabase();
  const query = pgliteQuery(db);
  const dimensionsHash = createHash("sha256").update(JSON.stringify({})).digest("hex");
  const idempotencyKey = `jobs:month:2026-06-01:${dimensionsHash}`;
  try {
    const snapshot = await db.query<{ id: number }>(`
      insert into metrics.raw_simpro_snapshots (
        entity_type, entity_id, source_path, payload, source_hash, source_version
      ) values ('job_details', '10', '/jobs/10', '{"ID":10}'::jsonb, 'job-10', 'exact-backfill-028')
      returning id
    `);
    await db.exec(`
      insert into metrics.profit_capacity_exact_backfill_targets (
        id, contract, target_type, target_key, job_id, period_start, status,
        attempts, locked_by, lock_expires_at, source_snapshot_id
      ) values (
        1, 'simpro-profit-capacity-028-exact', 'job', '10', 10, '2026-06-01',
        'running', 1, 'exact-worker', now() + interval '10 minutes', ${snapshot.rows[0]!.id}
      )
    `);
    await db.query(
      `insert into metrics.rollup_rebuild_queue (
         metric_family, period_grain, period_start, dimensions_json, reason,
         idempotency_key, status, locked_by, locked_until
       ) values ('jobs', 'month', '2026-06-01', '{}'::jsonb, 'older rebuild', $1,
                 'running', 'rollup-worker', now() + interval '10 minutes')`,
      [idempotencyKey],
    );

    await completeExactTarget({
      query,
      target: target({ target_type: "job", target_key: "10", job_id: "10", section_id: null, cost_center_id: null }),
      workerId: "exact-worker",
      sourceSnapshotId: snapshot.rows[0]!.id,
      sourceDeleted: false,
      affectedPeriods: [{ scope: "jobs", periodStart: "2026-06-01" }],
    });

    const rows = await db.query<{ idempotency_key: string; status: string; locked_by: string | null }>(
      "select idempotency_key, status::text, locked_by from metrics.rollup_rebuild_queue order by id",
    );
    assert.deepEqual(rows.rows, [
      { idempotency_key: idempotencyKey, status: "running", locked_by: "rollup-worker" },
      { idempotency_key: `${idempotencyKey}:after-exact-target-1`, status: "queued", locked_by: null },
    ]);
  } finally {
    await db.close();
  }
});

async function exactLedgerDatabase() {
  const db = new PGlite();
  const migrationDirectory = new URL("../../infra/db/migrations/", import.meta.url);
  const migrations = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
  for (const migration of migrations) {
    await db.exec(await readFile(new URL(migration, migrationDirectory), "utf8"));
  }
  return db;
}

function pgliteQuery(db: PGlite) {
  return async <T = Record<string, unknown>>(sql: string, values?: unknown[]) => {
    const result = await db.query<T>(sql, values);
    return { rows: result.rows, rowCount: result.affectedRows ?? null };
  };
}
