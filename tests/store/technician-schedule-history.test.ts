import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { persistScheduleBlocks } from "../../src/lib/simpro/normalize-nested";
import { getHistoricalTechnicians, getServedTechnicianHistory } from "../../src/lib/store/technician-read-model-inputs";
import type { PostgresQuery } from "../../src/lib/store/postgres";

const migrationDirectory = new URL("../../infra/db/migrations/", import.meta.url);
const migrationName = "030_schedule_identity_reconciliation.sql";
const technicianReconciliationMigrationName = "032_technician_reconciliation_results.sql";
const sourceFamilies = [
  "jobs", "job_nested", "employees", "timesheets",
  "jobs_from_timesheets", "schedules", "mobile_status",
];

test("migration 030 is twice-safe and leaves legacy schedule identity honest", async () => {
  const db = new PGlite();
  try {
    const migrations = await loadMigrations();
    for (const migration of migrations.filter((entry) => entry.name < migrationName)) {
      await db.exec(migration.sql);
    }
    await db.exec(`
      insert into metrics.metrics_schedule_blocks (schedule_id, block_index)
      values (9001, 0)
    `);
    const migration = migrations.find((entry) => entry.name === migrationName);
    assert.ok(migration);
    await db.exec(migration.sql);
    await db.exec(migration.sql);

    const result = await db.query<{ work_order_id: string | null; cancelled: boolean }>(`
      select work_order_id::text, cancelled
        from metrics.metrics_schedule_blocks
       where schedule_id = 9001 and block_index = 0
    `);
    assert.deepEqual(result.rows[0], { work_order_id: null, cancelled: false });
  } finally {
    await db.close();
  }
});

test("schedule block upsert persists work-order identity and explicit cancellation", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create schema metrics;
      create table metrics.metrics_schedule_blocks (
        schedule_id bigint not null,
        block_index integer not null,
        staff_id bigint,
        reference_type text,
        reference_id bigint,
        schedule_rate_id bigint,
        planned_hours numeric,
        planned_start_at timestamptz,
        planned_end_at timestamptz,
        work_order_id bigint,
        cancelled boolean not null default false,
        source_snapshot_id bigint,
        source_hash text,
        traversal_generation bigint,
        source_deleted_at timestamptz,
        fetched_at timestamptz,
        primary key (schedule_id, block_index)
      )
    `);
    const query = pgliteQuery(db);
    await persistScheduleBlocks({
      scheduleId: 44,
      payload: {
        Staff: { ID: 9 },
        WorkOrder: { ID: 700 },
        Cancelled: false,
        Blocks: [{
          Hrs: 2,
          ISO8601StartTime: "2026-06-10T08:00:00-07:00",
          ISO8601EndTime: "2026-06-10T10:00:00-07:00",
          WorkOrder: { ID: 701 },
          Cancelled: true,
        }],
      },
      provenance: { sourceSnapshotId: null, sourceHash: "schedule-44", fetchedAt: "2026-06-10T18:00:00Z" },
      referenceType: "job",
      referenceId: 100,
      query,
    });

    const result = await db.query<{ work_order_id: string | null; cancelled: boolean }>(`
      select work_order_id::text, cancelled
        from metrics.metrics_schedule_blocks
       where schedule_id = 44 and block_index = 0
    `);
    assert.deepEqual(result.rows[0], { work_order_id: "701", cancelled: true });
  } finally {
    await db.close();
  }
});

test("migration 032 is twice-safe and does not invent technician reconciliation history", async () => {
  const db = new PGlite();
  try {
    const migrations = await loadMigrations();
    for (const migration of migrations.filter((entry) => entry.name < technicianReconciliationMigrationName)) {
      await db.exec(migration.sql);
    }
    const migration = migrations.find((entry) => entry.name === technicianReconciliationMigrationName);
    assert.ok(migration);
    await db.exec(migration.sql);
    await db.exec(migration.sql);
    const result = await db.query<{ rows: number }>(
      "select count(*)::integer as rows from metrics.technician_reconciliation_results",
    );
    assert.equal(result.rows[0]?.rows, 0);
  } finally {
    await db.close();
  }
});

test("technician history is employee-keyed, includes selected month, and fails closed without generation authority", async () => {
  const db = new PGlite();
  try {
    for (const migration of await loadMigrations()) await db.exec(migration.sql);
    for (const month of ["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01", "2026-06-01"]) {
      await seedHistoryModel(db, month);
    }
    await seedManifests(db, "2026-01-01", 1);
    await seedManifests(db, "2026-02-01", 2);
    await seedManifests(db, "2026-03-01", null);
    await seedManifests(db, "2026-04-01", 4, "mobile_status");
    await seedManifests(db, "2026-05-01", 5);
    await seedManifests(db, "2026-06-01", 6);
    await seedTechnicianReconciliation(db, "2026-01-01", { generation: 1 });
    await seedTechnicianReconciliation(db, "2026-02-01", { generation: 2, completeTraversal: false });
    await seedTechnicianReconciliation(db, "2026-03-01", { generation: null });
    await seedTechnicianReconciliation(db, "2026-04-01", { generation: 4 });
    await seedTechnicianReconciliation(db, "2026-05-01", { generation: 5, checkedAt: "2026-06-01T00:00:00Z" });
    await seedTechnicianReconciliation(db, "2026-06-01", { generation: 6 });

    const history = await getHistoricalTechnicians("2026-06-01", pgliteQuery(db));
    assert.deepEqual(history.map((row) => [row.periodStart, row.employeeId, row.reconciliation.status, row.reconciliation.reason]), [
      ["2026-01-01", "1", "matched", "matched"],
      ["2026-01-01", "2", "mismatch", "check_mismatch"],
      ["2026-02-01", "1", "missing", "check_missing"],
      ["2026-02-01", "2", "missing", "check_missing"],
      ["2026-03-01", "1", "missing", "source_manifest_missing"],
      ["2026-03-01", "2", "missing", "source_manifest_missing"],
      ["2026-04-01", "1", "missing", "source_manifest_mismatch"],
      ["2026-04-01", "2", "missing", "source_manifest_mismatch"],
      ["2026-05-01", "1", "missing", "stale"],
      ["2026-05-01", "2", "missing", "stale"],
      ["2026-06-01", "1", "matched", "matched"],
      ["2026-06-01", "2", "mismatch", "check_mismatch"],
    ]);
    assert.deepEqual(history[0].reconciliation, {
      status: "matched",
      reason: "matched",
      checkedAt: "2099-01-01 00:00:00+00",
      sourceCount: 0.25,
      servedCount: 0.25,
      sourceValue: 100,
      servedValue: 100,
      sourceHours: 2,
      servedHours: 2,
      sourceManifestCount: 7,
      expectedSourceManifestCount: 7,
    });
    assert.deepEqual(
      history[1].reconciliation,
      {
        status: "mismatch",
        reason: "check_mismatch",
        checkedAt: "2099-01-01 00:00:00+00",
        sourceCount: 0.75,
        servedCount: 0.5,
        sourceValue: 300,
        servedValue: 250,
        sourceHours: 6,
        servedHours: 5,
        sourceManifestCount: 7,
        expectedSourceManifestCount: 7,
      },
    );
    assert.notEqual(history[0].reconciliation.sourceValue, 400, "monthly value must not be copied into a technician cell");
    assert.ok(history.some((row) => row.periodStart === "2026-06-01"), "selected month must be loaded");
  } finally {
    await db.close();
  }
});

test("served technician history uses persisted read models without reconciliation joins", async () => {
  const db = new PGlite();
  try {
    for (const migration of await loadMigrations()) await db.exec(migration.sql);
    await seedHistoryModel(db, "2026-05-01");
    await seedHistoryModel(db, "2026-06-01");

    const history = await getServedTechnicianHistory("2026-06-01", pgliteQuery(db));

    assert.deepEqual(history.map((row) => [row.periodStart, row.employeeId, row.reconciliation.status, row.reconciliation.reason]), [
      ["2026-05-01", "1", "missing", "check_missing"],
      ["2026-05-01", "2", "missing", "check_missing"],
      ["2026-06-01", "1", "missing", "check_missing"],
      ["2026-06-01", "2", "missing", "check_missing"],
    ]);
    assert.ok(history.every((row) => row.reconciliation.sourceManifestCount === sourceFamilies.length));
  } finally {
    await db.close();
  }
});

test("technician history requires positive exact page completion for every source family", async () => {
  const db = new PGlite();
  try {
    for (const migration of await loadMigrations()) await db.exec(migration.sql);
    const cases = [
      { periodStart: "2025-08-01", generation: 7, expected: 2, completed: 2 },
      { periodStart: "2025-09-01", generation: 8, expected: 0, completed: 0 },
      { periodStart: "2025-10-01", generation: 9, expected: null, completed: null },
      { periodStart: "2025-11-01", generation: 10, expected: -1, completed: -1 },
      { periodStart: "2025-12-01", generation: 11, expected: 1, completed: 2 },
    ] as const;
    for (const fixture of cases) {
      await seedHistoryModel(db, fixture.periodStart);
      await seedManifests(db, fixture.periodStart, fixture.generation, undefined, {
        expected: fixture.expected,
        completed: fixture.completed,
      });
      await seedTechnicianReconciliation(db, fixture.periodStart, { generation: fixture.generation });
    }

    const history = await getHistoricalTechnicians("2025-12-01", pgliteQuery(db));
    const employeeOne = history.filter((row) => row.employeeId === "1");
    assert.deepEqual(
      employeeOne.map((row) => [row.periodStart, row.reconciliation.status, row.reconciliation.reason]),
      [
        ["2025-08-01", "matched", "matched"],
        ["2025-09-01", "missing", "source_manifest_mismatch"],
        ["2025-10-01", "missing", "source_manifest_mismatch"],
        ["2025-11-01", "missing", "source_manifest_mismatch"],
        ["2025-12-01", "missing", "source_manifest_mismatch"],
      ],
    );
  } finally {
    await db.close();
  }
});

test("technician history rejects partial, pending, mismatched, and null manifest statuses", async () => {
  const db = new PGlite();
  try {
    for (const migration of await loadMigrations()) await db.exec(migration.sql);
    await allowAdversarialManifestStatuses(db);
    const cases = [
      { periodStart: "2025-01-01", generation: 1, coverageStatus: "complete", reconciliationStatus: "matched" },
      { periodStart: "2025-02-01", generation: 2, coverageStatus: "partial", reconciliationStatus: "matched" },
      { periodStart: "2025-03-01", generation: 3, coverageStatus: "complete", reconciliationStatus: "pending" },
      { periodStart: "2025-04-01", generation: 4, coverageStatus: "complete", reconciliationStatus: "mismatch" },
      { periodStart: "2025-05-01", generation: 5, coverageStatus: null, reconciliationStatus: "matched" },
      { periodStart: "2025-06-01", generation: 6, coverageStatus: "complete", reconciliationStatus: null },
    ] as const;
    for (const fixture of cases) {
      await seedHistoryModel(db, fixture.periodStart);
      await seedManifests(db, fixture.periodStart, fixture.generation, undefined, {
        expected: 2,
        completed: 2,
        coverageStatus: fixture.coverageStatus,
        reconciliationStatus: fixture.reconciliationStatus,
      });
      await seedTechnicianReconciliation(db, fixture.periodStart, { generation: fixture.generation });
    }

    const history = await getHistoricalTechnicians("2025-06-01", pgliteQuery(db));
    const employeeOne = history.filter((row) => row.employeeId === "1");
    assert.deepEqual(
      employeeOne.map((row) => [row.periodStart, row.reconciliation.status, row.reconciliation.reason]),
      [
        ["2025-01-01", "matched", "matched"],
        ["2025-02-01", "missing", "source_manifest_mismatch"],
        ["2025-03-01", "missing", "source_manifest_mismatch"],
        ["2025-04-01", "missing", "source_manifest_mismatch"],
        ["2025-05-01", "missing", "source_manifest_mismatch"],
        ["2025-06-01", "missing", "source_manifest_mismatch"],
      ],
    );
  } finally {
    await db.close();
  }
});

async function loadMigrations() {
  const files = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
  return Promise.all(files.map(async (name) => ({ name, sql: await readFile(new URL(name, migrationDirectory), "utf8") })));
}

async function seedHistoryModel(db: PGlite, periodStart: string) {
  const periodEnd = monthEnd(periodStart);
  await db.query(`
    insert into metrics.dashboard_read_models (
      metric_family, period_grain, period_start, values_json, source_hash, rebuilt_at
    ) values ('technicians', 'month', $1::date, $2::jsonb, 'history-hash', '2026-07-01T00:00:00Z')
  `, [periodStart, JSON.stringify({
    periodEnd,
    technicians: [
      {
        employeeId: "1", displayName: "Alex Rivera", completedJobCredit: 0.25,
        allocatedSellValue: 100, allocatedGrossProfit: 25, actualJobHours: 2,
        productiveHours: 2, totalRecordedHours: 2, quotedHours: 1,
        laborEfficiencyActualHours: 2, scheduledVisits: 1, arrivalCoveredVisits: 1, onTimeVisits: 1,
      },
      {
        employeeId: "2", displayName: "Morgan Lee", completedJobCredit: 0.5,
        allocatedSellValue: 250, allocatedGrossProfit: 50, actualJobHours: 5,
        productiveHours: 4, totalRecordedHours: 5, quotedHours: 2,
        laborEfficiencyActualHours: 4, scheduledVisits: 1, arrivalCoveredVisits: 1, onTimeVisits: 0,
      },
    ],
  })]);
}

async function seedManifests(
  db: PGlite,
  periodStart: string,
  generation: number | null,
  mismatchedFamily?: string,
  manifest: {
    expected: number | null;
    completed: number | null;
    coverageStatus?: string | null;
    reconciliationStatus?: string | null;
  } = { expected: 1, completed: 1 },
) {
  for (const family of sourceFamilies) {
    const reconciliationGeneration = family === mismatchedFamily && generation !== null ? generation - 1 : generation;
    await db.query(`
      insert into metrics.source_period_manifests (
        source_family, period_start, period_end, coverage_status, reconciliation_status,
        listed_count, detail_count, normalized_count, source_id_hash, normalized_id_hash,
        evidence_as_of, completed_at, manifest_generation, reconciliation_generation,
        expected_page_count, completed_page_count, reconciled_at
      ) values (
        $1, $2::date, $3::date, $6::text, $7::text, 1, 1, 1, repeat('a', 64), repeat('a', 64),
        '2026-06-30T00:00:00Z', '2026-06-30T00:00:00Z', $4, $5, $8, $9, '2026-06-30T00:00:00Z'
      )
    `, [
      family,
      periodStart,
      monthEnd(periodStart),
      generation,
      reconciliationGeneration,
      manifest.coverageStatus === undefined ? "complete" : manifest.coverageStatus,
      manifest.reconciliationStatus === undefined ? "matched" : manifest.reconciliationStatus,
      manifest.expected,
      manifest.completed,
    ]);
  }
}

async function allowAdversarialManifestStatuses(db: PGlite) {
  await db.exec(`
    alter table metrics.source_period_manifests
      drop constraint if exists source_period_manifest_complete_check;
    alter table metrics.source_period_manifests
      alter column coverage_status drop not null,
      alter column reconciliation_status drop not null;
  `);
}

async function seedTechnicianReconciliation(db: PGlite, periodStart: string, options: {
  generation: number | null;
  completeTraversal?: boolean;
  checkedAt?: string;
}) {
  const checkedAt = options.checkedAt ?? "2099-01-01T00:00:00Z";
  const sourceManifestGenerations = options.generation === null
    ? {}
    : Object.fromEntries(sourceFamilies.map((family) => [family, options.generation]));
  const check = await db.query<{ id: string }>(`
    insert into metrics.reconciliation_checks (
      scope, period_start, period_end, rollup_value, snapshot_value, status, detail, checked_at,
      generation, complete_traversal, source_manifest_generations
    ) values (
      'technicians', $1::date, $2::date, 350, 400, 'mismatch', '{}'::jsonb, $3::timestamptz,
      $4, $5, $6::jsonb
    ) returning id::text
  `, [
    periodStart,
    monthEnd(periodStart),
    checkedAt,
    options.generation,
    options.completeTraversal ?? (options.generation !== null),
    JSON.stringify(sourceManifestGenerations),
  ]);
  const checkId = check.rows[0]?.id;
  assert.ok(checkId);
  for (const evidence of [
    { employeeId: "1", status: "matched", sourceCount: 0.25, servedCount: 0.25, sourceValue: 100, servedValue: 100, sourceHours: 2, servedHours: 2 },
    { employeeId: "2", status: "mismatch", sourceCount: 0.75, servedCount: 0.5, sourceValue: 300, servedValue: 250, sourceHours: 6, servedHours: 5 },
  ]) {
    await db.query(`
      insert into metrics.technician_reconciliation_results (
        reconciliation_check_id, period_start, period_end, employee_id, status,
        source_count, served_count, source_value, served_value, source_hours, served_hours,
        source_input_hash, read_model_source_hash, checked_at
      ) values ($1, $2::date, $3::date, $4, $5, $6, $7, $8, $9, $10, $11, repeat('a', 64), 'history-hash', $12::timestamptz)
    `, [checkId, periodStart, monthEnd(periodStart), evidence.employeeId, evidence.status,
      evidence.sourceCount, evidence.servedCount, evidence.sourceValue, evidence.servedValue,
      evidence.sourceHours, evidence.servedHours, checkedAt]);
  }
}

function monthEnd(periodStart: string) {
  const value = new Date(`${periodStart}T00:00:00Z`);
  value.setUTCMonth(value.getUTCMonth() + 1);
  value.setUTCDate(0);
  return value.toISOString().slice(0, 10);
}

function pgliteQuery(db: PGlite): PostgresQuery {
  return async <T = Record<string, unknown>>(text: string, values?: unknown[]) => {
    const result = await db.query<T>(text, values);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  };
}
