import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import type { JobMetricsDashboardReadModel } from "../../src/lib/metrics/jobs";
import {
  getJobReconciliations,
  overlayJobReconciliations,
} from "../../src/lib/store/job-dashboard-read-model";
import type { PostgresQuery } from "../../src/lib/store/postgres";

const migrationDirectory = new URL("../../infra/db/migrations/", import.meta.url);

test("persisted Job history overlays current reconciliation evidence", () => {
  const model = {
    history: [
      { month: "2026-05", completedJobs: 2, sellValue: 100, provisional: false, reconciliation: { periodStart: "2026-05-01", status: "missing" } },
      { month: "2026-06", completedJobs: 3, sellValue: 200, provisional: false, reconciliation: { periodStart: "2026-06-01", status: "missing" } },
    ],
    warnings: ["2 history months do not have a recorded job reconciliation run."],
  } as JobMetricsDashboardReadModel;

  const result = overlayJobReconciliations(model, [{ periodStart: "2026-05-01", status: "matched" }]);

  assert.equal(result.history[0].reconciliation.status, "matched");
  assert.equal(result.history[1].reconciliation.status, "missing");
  assert.deepEqual(result.warnings, ["1 history months do not have a recorded job reconciliation run."]);
});

test("Job history reads only the migration 031 authoritative reconciliation contract", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../../src/lib/store/job-dashboard-read-model.ts", import.meta.url)),
    "utf8",
  );
  assert.match(source, /from metrics\.authoritative_reconciliation_results/);
  assert.doesNotMatch(source, /from metrics\.reconciliation_checks/);
  assert.doesNotMatch(source, /from metrics\.reconciliation_runs/);
  assert.match(source, /source_manifest_generations ->> 'jobs' = authority\.generation::text/);
  assert.match(source, /reconciliation_generation = authority\.generation/);
  assert.match(source, /coverage_status = 'complete'/);
  assert.match(source, /reconciliation_status = 'matched'/);
  assert.match(source, /expected_page_count > 0/);
  assert.match(source, /completed_page_count = .*expected_page_count/);
});

test("Job reconciliation history fails closed for incomplete generations and invalid page counts", async () => {
  const db = new PGlite();
  try {
    for (const migration of await loadMigrations()) await db.exec(migration.sql);
    await allowAdversarialManifestStatuses(db);
    await seedJobAuthority(db, "2026-01-01", { generation: 1 });
    await seedJobAuthority(db, "2026-02-01", { generation: 2, completeTraversal: false });
    await seedJobAuthority(db, "2026-03-01", { generation: null });
    await seedJobAuthority(db, "2026-04-01", { generation: 4, nestedReconciliationGeneration: 3 });
    await seedJobAuthority(db, "2026-05-01", { generation: 5, expectedPageCount: 0, completedPageCount: 0 });
    await seedJobAuthority(db, "2026-06-01", { generation: 6, expectedPageCount: null, completedPageCount: null });
    await seedJobAuthority(db, "2026-07-01", { generation: 7, expectedPageCount: -1, completedPageCount: -1 });
    await seedJobAuthority(db, "2026-08-01", { generation: 8, expectedPageCount: 1, completedPageCount: 2 });
    await seedJobAuthority(db, "2026-09-01", { generation: 9, expectedPageCount: 2, completedPageCount: 2 });
    await seedJobAuthority(db, "2026-10-01", { generation: 10, coverageStatus: "partial" });
    await seedJobAuthority(db, "2026-11-01", { generation: 11, reconciliationStatus: "pending" });
    await seedJobAuthority(db, "2026-12-01", { generation: 12, reconciliationStatus: "mismatch" });
    await seedJobAuthority(db, "2027-01-01", { generation: 13, coverageStatus: null });
    await seedJobAuthority(db, "2027-02-01", { generation: 14, reconciliationStatus: null });

    const rows = await getJobReconciliations("2026-01-01", "2027-02-28", pgliteQuery(db));
    assert.deepEqual(rows.map((row) => [row.periodStart, row.status]), [
      ["2026-01-01", "matched"],
      ["2026-09-01", "matched"],
    ]);
  } finally {
    await db.close();
  }
});

async function seedJobAuthority(db: PGlite, periodStart: string, options: {
  generation: number | null;
  completeTraversal?: boolean;
  nestedReconciliationGeneration?: number;
  expectedPageCount?: number | null;
  completedPageCount?: number | null;
  coverageStatus?: string | null;
  reconciliationStatus?: string | null;
}) {
  const periodEnd = monthEnd(periodStart);
  const generationMap = options.generation === null
    ? {}
    : { jobs: options.generation, job_nested: options.generation };
  await db.query(`
    insert into metrics.reconciliation_checks (
      scope, period_start, period_end, rollup_value, snapshot_value, status, detail,
      generation, complete_traversal, source_manifest_generations, checked_at
    ) values (
      'jobs', $1::date, $2::date, 100, 100, 'matched',
      '{"source":{"count":1,"total":100},"dashboard":{"count":1}}'::jsonb,
      $3, $4, $5::jsonb, '2026-07-01T00:00:00Z'
    )
  `, [
    periodStart,
    periodEnd,
    options.generation,
    options.completeTraversal ?? (options.generation !== null),
    JSON.stringify(generationMap),
  ]);
  for (const family of ["jobs", "job_nested"]) {
    const reconciliationGeneration = family === "job_nested"
      ? options.nestedReconciliationGeneration ?? options.generation
      : options.generation;
    await db.query(`
      insert into metrics.source_period_manifests (
        source_family, period_start, period_end, coverage_status, reconciliation_status,
        listed_count, detail_count, normalized_count, source_id_hash, normalized_id_hash,
        evidence_as_of, completed_at, manifest_generation, reconciliation_generation,
        expected_page_count, completed_page_count, reconciled_at
      ) values (
        $1, $2::date, $3::date, $6::text, $7::text, 1, 1, 1,
        repeat('a', 64), repeat('a', 64), '2026-06-30T00:00:00Z', '2026-06-30T00:00:00Z',
        $4, $5, $8, $9, '2026-06-30T00:00:00Z'
      )
    `, [
      family,
      periodStart,
      periodEnd,
      options.generation,
      reconciliationGeneration,
      options.coverageStatus === undefined ? "complete" : options.coverageStatus,
      options.reconciliationStatus === undefined ? "matched" : options.reconciliationStatus,
      options.expectedPageCount === undefined ? 1 : options.expectedPageCount,
      options.completedPageCount === undefined ? 1 : options.completedPageCount,
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

async function loadMigrations() {
  const files = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
  return Promise.all(files.map(async (name) => ({ name, sql: await readFile(new URL(name, migrationDirectory), "utf8") })));
}

function pgliteQuery(db: PGlite): PostgresQuery {
  return async <T = Record<string, unknown>>(text: string, values?: unknown[]) => {
    const result = await db.query<T>(text, values);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  };
}

function monthEnd(periodStart: string) {
  const value = new Date(`${periodStart}T00:00:00Z`);
  value.setUTCMonth(value.getUTCMonth() + 1);
  value.setUTCDate(0);
  return value.toISOString().slice(0, 10);
}
