import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { buildSourcePeriodManifestEvidence } from "../../src/lib/store/source-period-manifests";
import {
  recordBackfillReconciliation,
  type BackfillReconciliationEvidence,
  type BackfillWorkUnit,
} from "../../src/lib/store/backfill-ledger";

type BackfillQuery = NonNullable<Parameters<typeof recordBackfillReconciliation>[1]>;
const migrationDirectory = new URL("../../infra/db/migrations/", import.meta.url);

test("backfill reconciliation atomically publishes serving evidence and rejects stale owners", async () => {
  const db = new PGlite();
  const query = pgliteQuery(db);
  try {
    const files = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
    for (const file of files) await db.exec(await readFile(new URL(file, migrationDirectory), "utf8"));
    await seedRunningUnit(db, 1, "worker-a");
    await seedTraversalManifest(db, 1);

    const workUnit = runningWorkUnit(1);
    const evidence = matchedEvidence(1);
    await recordBackfillReconciliation({ workUnit, workerId: "worker-a", evidence }, query);

    const completed = await db.query<{
      status: string;
      reconciliation_status: string;
      coverage_status: string;
      source_id_hash: string;
      manifest_generation: number;
      reconciliation_generation: number | null;
      expected_page_count: number;
      completed_page_count: number;
      reconciled_at: string | null;
    }>(`
      select l.status, l.reconciliation_status, m.coverage_status, m.source_id_hash,
             m.manifest_generation::int, m.reconciliation_generation::int,
             m.expected_page_count, m.completed_page_count, m.reconciled_at::text
        from metrics.backfill_source_month_ledger l
        join metrics.source_period_manifests m
          on m.source_family = l.source_family and m.period_start = l.month_start
       where l.id = 1
    `);
    assert.deepEqual(completed.rows[0], {
      status: "completed",
      reconciliation_status: "matched",
      coverage_status: "complete",
      source_id_hash: evidence.sourcePeriodManifest?.sourceIdHash,
      manifest_generation: 1,
      reconciliation_generation: 1,
      expected_page_count: 1,
      completed_page_count: 1,
      reconciled_at: "2026-07-09 12:00:00+00",
    });

    await seedRunningUnit(db, 2, "worker-b");
    await seedTraversalManifest(db, 2);
    const forged = matchedEvidence(2);
    forged.sourcePeriodManifest = {
      ...forged.sourcePeriodManifest!,
      reconciliationGeneration: null,
      reconciledAt: null,
    };
    await assert.rejects(
      recordBackfillReconciliation({
        workUnit: runningWorkUnit(2),
        workerId: "worker-b",
        evidence: forged,
      }, query),
      /exact authoritative manifest proof/,
    );
    await db.exec(`update metrics.backfill_traversal_manifests set generation = 2 where work_unit_id = 2`);
    await assert.rejects(
      recordBackfillReconciliation({
        workUnit: runningWorkUnit(2),
        workerId: "worker-b",
        evidence: matchedEvidence(2),
      }, query),
      /Lost backfill lease/,
    );
    await db.exec(`update metrics.backfill_traversal_manifests set generation = 1 where work_unit_id = 2`);
    await assert.rejects(
      recordBackfillReconciliation({
        workUnit: runningWorkUnit(2),
        workerId: "stale-worker",
        evidence: matchedEvidence(2),
      }, query),
      /Lost backfill lease/,
    );
    const staleWrites = await db.query<{ reconciliations: number; manifests: number }>(`
      select
        (select count(*)::int from metrics.backfill_reconciliation_results where work_unit_id = 2) as reconciliations,
        (select count(*)::int from metrics.source_period_manifests where source_family = 'jobs' and period_start = '2026-05-01') as manifests
    `);
    assert.deepEqual(staleWrites.rows[0], { reconciliations: 0, manifests: 0 });

    await db.exec(`
      update metrics.backfill_source_month_ledger
         set status = 'running', locked_by = 'worker-c', work_phase = 'reconcile',
             locked_at = now(), lease_expires_at = now() + interval '10 minutes',
             heartbeat_at = now(), reserved_capacity_date = current_date
       where id = 1
    `);
    await recordBackfillReconciliation({
      workUnit: runningWorkUnit(1),
      workerId: "worker-c",
      evidence: mismatchEvidence(1),
    }, query);
    const changed = await db.query<{
      coverage_status: string;
      reconciliation_status: string;
      manifest_generation: number;
      reconciliation_generation: number | null;
      reconciled_at: string | null;
    }>(`
      select coverage_status, reconciliation_status, manifest_generation::int,
             reconciliation_generation::int, reconciled_at::text
        from metrics.source_period_manifests
       where source_family = 'jobs' and period_start = '2026-06-01'
    `);
    assert.deepEqual(changed.rows[0], {
      coverage_status: "suspect",
      reconciliation_status: "mismatch",
      manifest_generation: 2,
      reconciliation_generation: null,
      reconciled_at: null,
    });
  } finally {
    await db.close();
  }
});

async function seedRunningUnit(db: PGlite, id: number, worker: string) {
  const monthStart = id === 1 ? "2026-06-01" : "2026-05-01";
  const monthEnd = id === 1 ? "2026-07-01" : "2026-06-01";
  await db.exec(`
    insert into metrics.backfill_capacity_days (
      capacity_date, daily_request_ceiling, current_requests, reconciliation_requests,
      backfill_requests, backfill_reserved_requests
    ) values (current_date, 10000, 0, 0, 0, 0)
    on conflict (capacity_date) do update set daily_request_ceiling = excluded.daily_request_ceiling
  `);
  await db.query(`
    insert into metrics.backfill_source_month_ledger (
      id, source_family, month_start, month_end_exclusive, status, work_phase,
      expected_pages, expected_records, estimated_nested_requests, estimated_requests,
      daily_request_ceiling, actual_requests, snapshot_count, normalized_count,
      locked_by, locked_at, lease_expires_at, heartbeat_at,
      reserved_capacity_date, reserved_requests, approved_by, approved_at, plan_hash
    ) values (
      $1, 'jobs', $2::date, $3::date, 'running', 'reconcile',
      1, 1, 0, 1, 10000, 1, 1, 1,
      $4, now(), now() + interval '10 minutes', now(),
      current_date, 0, 'test@example.test', now(), repeat('a', 64)
    )
  `, [id, monthStart, monthEnd, worker]);
}

async function seedTraversalManifest(db: PGlite, workUnitId: number) {
  await db.query(`
    insert into metrics.backfill_traversal_manifests (
      work_unit_id, contract_version, manifest_status, filter_contract, as_of_watermark,
      observed_boundary, required_target_keys, completed_target_keys, exact_source_ids,
      listed_source_ids, detailed_source_ids, page_count, record_count, completed_at
    ) values (
      $1, 1, 'completed', '{"CompletedDate":"2026-06"}', '2026-07-09T11:59:00Z',
      '{"effectiveEndInclusive":"2026-06-30"}', '["2026-06"]', '["2026-06"]',
      '["101"]', '["101"]', '["101"]', 1, 1, now()
    )
  `, [workUnitId]);
}

function runningWorkUnit(id: number): BackfillWorkUnit {
  return {
    id,
    source_family: "jobs",
    month_start: id === 1 ? "2026-06-01" : "2026-05-01",
    month_end_exclusive: id === 1 ? "2026-07-01" : "2026-06-01",
    execution_mode: "ingest",
    required_for_completion: true,
    depends_on: [],
    work_phase: "reconcile",
    status: "running",
    expected_pages: 1,
    expected_records: 1,
    estimated_nested_requests: 0,
    estimated_requests: 1,
    daily_request_ceiling: 10000,
    queue_priority: 100,
    request_slice_limit: 250,
    actual_requests: 1,
    snapshot_count: 1,
    normalized_count: 1,
    continuation_token: null,
    retry_count: 0,
    max_attempts: 5,
    reserved_capacity_date: "2026-07-09",
    reserved_requests: 0,
    claim_phase: "reconcile",
  };
}

function matchedEvidence(id: number): BackfillReconciliationEvidence {
  const periodStart = id === 1 ? "2026-06-01" : "2026-05-01";
  const periodEnd = id === 1 ? "2026-06-30" : "2026-05-31";
  return {
    status: "matched",
    sourceRecordCount: 1,
    normalizedRecordCount: 1,
    sourceMaxDate: periodEnd,
    missingSourceIds: [],
    extraNormalizedIds: [],
    repairPlans: [],
    detail: { basis: "runtime test" },
    sourcePeriodManifest: buildSourcePeriodManifestEvidence({
      sourceFamily: "jobs",
      periodStart,
      periodEnd,
      listedIds: ["101"],
      detailIds: ["101"],
      normalizedIds: ["101"],
      authoritativeListComplete: true,
      listRequestCount: 1,
      reconciliationStatus: "matched",
      evidenceAsOf: "2026-07-09T12:00:00.000Z",
    }),
  };
}

function mismatchEvidence(id: number): BackfillReconciliationEvidence {
  const matched = matchedEvidence(id);
  return {
    ...matched,
    status: "mismatch",
    normalizedRecordCount: 0,
    missingSourceIds: ["101"],
    sourcePeriodManifest: buildSourcePeriodManifestEvidence({
      sourceFamily: "jobs",
      periodStart: matched.sourcePeriodManifest!.periodStart,
      periodEnd: matched.sourcePeriodManifest!.periodEnd,
      listedIds: ["101"],
      detailIds: ["101"],
      normalizedIds: [],
      authoritativeListComplete: true,
      listRequestCount: 1,
      manifestGeneration: 2,
      reconciliationStatus: "mismatch",
      evidenceAsOf: "2026-07-09T12:01:00.000Z",
    }),
  };
}

function pgliteQuery(db: PGlite): BackfillQuery {
  return (async <T>(sql: string, values: unknown[] = []) => {
    const result = await db.query<T>(sql, values as never[]);
    return { rows: result.rows, rowCount: result.rows.length };
  }) as BackfillQuery;
}
