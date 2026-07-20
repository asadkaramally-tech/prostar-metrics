import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  publishBulkDashboardReconciliations,
  type BulkDashboardReconciliationQuery,
  type BulkDashboardReconciliationUnit,
} from "../../src/lib/store/bulk-dashboard-reconciliation";
import {
  bulkEvidencePageSha256,
  bulkEvidenceRequestSha256,
} from "../../src/lib/store/bulk-bootstrap-evidence";
import { exactSourceIdHash } from "../../src/lib/store/exact-source-identities";

const migrationDirectory = new URL("../../infra/db/migrations/", import.meta.url);
const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
const REBUILT_AT = "2026-07-01 12:00:00.123456+00";
const REBUILT_BY_JOB_ID = "42";

test("publishes matched monthly checks and queues one commission rebuild", async () => {
  const db = await migratedDatabase();
  try {
    await seedReadModels(db, "2026-06-01");
    await seedSourceManifests(db, "2026-06-01");
    const result = await publishBulkDashboardReconciliations(units(), pgliteQuery(db));
    assert.equal(result.periods, 1);
    assert.equal(result.checksPublished, 3);
    assert.equal(result.commissionRollupsQueued, 1);
    assert.equal(result.idempotent, false);

    const state = await db.query<{
      checks: number;
      matched: number;
      reconciled: number;
      queued: number;
      audits: number;
    }>(`
      select
        (select count(*)::int from metrics.reconciliation_checks) checks,
        (select count(*)::int from metrics.reconciliation_checks where status = 'matched') matched,
        (select count(*)::int from metrics.dashboard_read_models where last_reconciled_at is not null) reconciled,
        (select count(*)::int from metrics.rollup_rebuild_queue where metric_family = 'commissions' and status = 'queued') queued,
        (select count(*)::int from metrics.audit_events where action = 'bulk_dashboard_reconciliations_published') audits
    `);
    assert.deepEqual(state.rows[0], { checks: 3, matched: 3, reconciled: 3, queued: 1, audits: 1 });
    const authority = await db.query<{
      scope: string;
      generation: number;
      complete_traversal: boolean;
      source_manifest_generations: Record<string, number>;
    }>(`
      select scope, generation::int, complete_traversal, source_manifest_generations
        from metrics.reconciliation_checks order by scope
    `);
    assert.deepEqual(authority.rows, [
      {
        scope: "jobs",
        generation: 7,
        complete_traversal: true,
        source_manifest_generations: { jobs: 7, job_nested: 7 },
      },
      {
        scope: "quotes",
        generation: 7,
        complete_traversal: true,
        source_manifest_generations: { quotes: 7, quote_nested: 7 },
      },
      {
        scope: "technicians",
        generation: 7,
        complete_traversal: true,
        source_manifest_generations: {
          jobs: 7,
          job_nested: 7,
          employees: 7,
          timesheets: 7,
          jobs_from_timesheets: 7,
          schedules: 7,
          mobile_status: 7,
        },
      },
    ]);

    const repeated = await publishBulkDashboardReconciliations(units(), pgliteQuery(db));
    assert.equal(repeated.idempotent, true);
    const counts = await db.query<{ checks: number; queued: number; audits: number }>(`
      select
        (select count(*)::int from metrics.reconciliation_checks) checks,
        (select count(*)::int from metrics.rollup_rebuild_queue) queued,
        (select count(*)::int from metrics.audit_events where action = 'bulk_dashboard_reconciliations_published') audits
    `);
    assert.deepEqual(counts.rows[0], { checks: 3, queued: 1, audits: 1 });
  } finally {
    await db.close();
  }
});

test("rejects incomplete verification before any database write", async () => {
  const db = await migratedDatabase();
  try {
    const invalid = units();
    invalid[0]!.detail.verificationStatus = "mismatch" as "matched";
    await assert.rejects(
      publishBulkDashboardReconciliations(invalid, pgliteQuery(db)),
      /was not independently verified as matched/,
    );
    const checks = await db.query<{ count: number }>("select count(*)::int count from metrics.reconciliation_checks");
    assert.equal(checks.rows[0].count, 0);
  } finally {
    await db.close();
  }
});

test("rolls back every check when an active read model is missing", async () => {
  const db = await migratedDatabase();
  try {
    await seedReadModels(db, "2026-06-01", ["jobs", "quotes"]);
    await seedSourceManifests(db, "2026-06-01");
    await assert.rejects(
      publishBulkDashboardReconciliations(units(), pgliteQuery(db)),
      /technicians\/2026-06-01 dashboard read model changed after verification or is no longer active/,
    );
    const state = await db.query<{ checks: number; queued: number; audits: number }>(`
      select
        (select count(*)::int from metrics.reconciliation_checks) checks,
        (select count(*)::int from metrics.rollup_rebuild_queue) queued,
        (select count(*)::int from metrics.audit_events where action = 'bulk_dashboard_reconciliations_published') audits
    `);
    assert.deepEqual(state.rows[0], { checks: 0, queued: 0, audits: 0 });
  } finally {
    await db.close();
  }
});

test("rolls back publication when a captured read-model version drifts before compare-and-set", async () => {
  const db = await migratedDatabase();
  try {
    await seedReadModels(db, "2026-06-01");
    await seedSourceManifests(db, "2026-06-01");
    await db.query(
      `update metrics.dashboard_read_models
          set source_hash = 'changed-after-verification', rebuilt_at = '2026-07-01T13:00:00.000Z'
        where metric_family = 'quotes' and period_start = '2026-06-01'`,
    );

    await assert.rejects(
      publishBulkDashboardReconciliations(units(), pgliteQuery(db)),
      /quotes\/2026-06-01 dashboard read model changed after verification/,
    );
    const state = await db.query<{ checks: number; reconciled: number; queued: number; audits: number }>(`
      select
        (select count(*)::int from metrics.reconciliation_checks) checks,
        (select count(*)::int from metrics.dashboard_read_models where last_reconciled_at is not null) reconciled,
        (select count(*)::int from metrics.rollup_rebuild_queue) queued,
        (select count(*)::int from metrics.audit_events where action = 'bulk_dashboard_reconciliations_published') audits
    `);
    assert.deepEqual(state.rows[0], { checks: 0, reconciled: 0, queued: 0, audits: 0 });
  } finally {
    await db.close();
  }
});

test("rejects generationless source manifests without inserting checks", async () => {
  const db = await migratedDatabase();
  try {
    await seedReadModels(db, "2026-06-01");
    await seedSourceManifests(db, "2026-06-01");
    await db.exec(`
      update metrics.source_period_manifests
         set manifest_generation = null, reconciliation_generation = null
       where source_family = 'jobs' and period_start = '2026-06-01';
    `);
    await assert.rejects(
      publishBulkDashboardReconciliations(units(), pgliteQuery(db)),
      /jobs manifest_generation must be an integer of at least 1/,
    );
    await assertNoChecks(db);
  } finally {
    await db.close();
  }
});

test("rejects stale source-manifest reconciliation generations without inserting checks", async () => {
  const db = await migratedDatabase();
  try {
    await seedReadModels(db, "2026-06-01");
    await seedSourceManifests(db, "2026-06-01");
    await db.exec(`
      update metrics.source_period_manifests
         set reconciliation_generation = 6
       where source_family = 'quote_nested' and period_start = '2026-06-01';
    `);
    await assert.rejects(
      publishBulkDashboardReconciliations(units(), pgliteQuery(db)),
      /quote_nested source manifest is stale: manifest_generation=7, reconciliation_generation=6/,
    );
    await assertNoChecks(db);
  } finally {
    await db.close();
  }
});

test("rejects internally matched source manifests from different generations", async () => {
  const db = await migratedDatabase();
  try {
    await seedReadModels(db, "2026-06-01");
    await seedSourceManifests(db, "2026-06-01");
    await db.exec(`
      update metrics.source_period_manifests
         set manifest_generation = 8,
             reconciliation_generation = 8,
             evidence_json = jsonb_set(
               jsonb_set(evidence_json, '{manifestGeneration}', '8'::jsonb),
               '{reconciliationGeneration}', '8'::jsonb
             )
       where source_family = 'job_nested' and period_start = '2026-06-01';
      update metrics.backfill_traversal_pages page
         set generation = 8
        from metrics.backfill_source_month_ledger ledger
       where page.work_unit_id = ledger.id
         and ledger.source_family = 'job_nested'
         and ledger.month_start = '2026-06-01';
      update metrics.backfill_traversal_manifests traversal
         set generation = 8
        from metrics.backfill_source_month_ledger ledger
       where traversal.work_unit_id = ledger.id
         and ledger.source_family = 'job_nested'
         and ledger.month_start = '2026-06-01';
    `);
    await assert.rejects(
      publishBulkDashboardReconciliations(units(), pgliteQuery(db)),
      /jobs\/2026-06-01 source manifests do not share one reconciled generation/,
    );
    await assertNoChecks(db);
  } finally {
    await db.close();
  }
});

test("rejects zero-page source authority without inserting checks", async () => {
  const db = await migratedDatabase();
  try {
    await seedReadModels(db, "2026-06-01");
    await seedSourceManifests(db, "2026-06-01");
    await db.exec(`
      update metrics.source_period_manifests
         set expected_page_count = 0, completed_page_count = 0
       where source_family = 'employees' and period_start = '2026-06-01';
    `);
    await assert.rejects(
      publishBulkDashboardReconciliations(units(), pgliteQuery(db)),
      /employees expected_page_count must be an integer of at least 1/,
    );
    await assertNoChecks(db);
  } finally {
    await db.close();
  }
});

test("rejects missing nested source proof without inserting checks", async () => {
  const db = await migratedDatabase();
  try {
    await seedReadModels(db, "2026-06-01");
    await seedSourceManifests(db, "2026-06-01");
    await db.exec(`
      delete from metrics.source_period_manifests
       where source_family = 'job_nested' and period_start = '2026-06-01';
    `);
    await assert.rejects(
      publishBulkDashboardReconciliations(units(), pgliteQuery(db)),
      /missing required job_nested source-manifest proof/,
    );
    await assertNoChecks(db);
  } finally {
    await db.close();
  }
});

test("rejects a declared one-page traversal backed only by persisted page 999", async () => {
  const db = await migratedDatabase();
  try {
    await seedReadModels(db, "2026-06-01");
    await seedSourceManifests(db, "2026-06-01");
    await db.exec(`
      update metrics.backfill_traversal_pages page
         set page_number = 999
        from metrics.backfill_source_month_ledger ledger
       where page.work_unit_id = ledger.id
         and ledger.source_family = 'quote_nested'
         and ledger.month_start = '2026-06-01';
    `);
    await assert.rejects(
      publishBulkDashboardReconciliations(units(), pgliteQuery(db)),
      /persisted page.*does not match source-manifest artifact page evidence|must start at page 1/,
    );
    await assertNoChecks(db);
  } finally {
    await db.close();
  }
});

test("rejects a persisted request whose declared request hash was not recomputed", async () => {
  const db = await migratedDatabase();
  try {
    await seedReadModels(db, "2026-06-01");
    await seedSourceManifests(db, "2026-06-01");
    await db.exec(`
      update metrics.backfill_traversal_pages page
         set request_query = jsonb_set(request_query, '{EndDate}', '"2026-05-31"'::jsonb)
        from metrics.backfill_source_month_ledger ledger
       where page.work_unit_id = ledger.id
         and ledger.source_family = 'jobs'
         and ledger.month_start = '2026-06-01';
    `);
    await assert.rejects(
      publishBulkDashboardReconciliations(units(), pgliteQuery(db)),
      /request hash does not match its persisted request query/,
    );
    await assertNoChecks(db);
  } finally {
    await db.close();
  }
});

test("rejects self-consistent persisted page evidence whose exact IDs differ from its traversal manifest", async () => {
  const db = await migratedDatabase();
  try {
    await seedReadModels(db, "2026-06-01");
    await seedSourceManifests(db, "2026-06-01");
    const pageIdentity = "quotes:2026-06-01:page:1";
    const pageSha256 = bulkEvidencePageSha256(pageIdentity, ["2"]);
    await db.query(
      `update metrics.backfill_traversal_pages page
          set exact_ids = '["2"]'::jsonb,
              response_hash = $1,
              request_query = jsonb_set(
                request_query,
                '{_bulkArtifactEvidence,pageSha256}',
                to_jsonb($1::text)
              )
         from metrics.backfill_source_month_ledger ledger
        where page.work_unit_id = ledger.id
          and ledger.source_family = 'quotes'
          and ledger.month_start = '2026-06-01'`,
      [pageSha256],
    );
    await db.query(
      `update metrics.source_period_manifests
          set evidence_json = jsonb_set(
            jsonb_set(evidence_json, '{artifactPages,0,exactIds}', '["2"]'::jsonb),
            '{artifactPages,0,pageSha256}',
            to_jsonb($1::text)
          )
        where source_family = 'quotes' and period_start = '2026-06-01'`,
      [pageSha256],
    );
    await assert.rejects(
      publishBulkDashboardReconciliations(units(), pgliteQuery(db)),
      /persisted page exact IDs do not equal declared exact IDs/,
    );
    await assertNoChecks(db);
  } finally {
    await db.close();
  }
});

function units(): BulkDashboardReconciliationUnit[] {
  return (["jobs", "quotes", "technicians"] as const).map((scope) => ({
    scope,
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    rollupValue: scope === "technicians" ? 100 : 500,
    snapshotValue: scope === "technicians" ? 100 : 500,
    upstreamSampleValue: scope === "technicians" ? null : 500,
    readModelVersion: {
      metricFamily: scope,
      periodGrain: "month",
      periodStart: "2026-06-01",
      dimensionsJson: {},
      sourceHash: `${scope}-source-hash`,
      rebuiltAt: REBUILT_AT,
      rebuiltByJobId: REBUILT_BY_JOB_ID,
    },
    detail: {
      verificationStatus: "matched",
      projectManifestSha256: HASH,
      operationalManifestSha256: OTHER_HASH,
    },
  }));
}

async function seedReadModels(
  db: PGlite,
  periodStart: string,
  scopes: string[] = ["jobs", "quotes", "technicians"],
) {
  for (const scope of scopes) {
    await db.query(
      `insert into metrics.dashboard_read_models (
         metric_family, period_grain, period_start, dimensions_json, values_json, status,
         source_hash, rebuilt_at, rebuilt_by_job_id
       ) values ($1, 'month', $2::date, '{}'::jsonb, '{}'::jsonb, 'ready', $3, $4::timestamptz, $5::bigint)`,
      [scope, periodStart, `${scope}-source-hash`, REBUILT_AT, REBUILT_BY_JOB_ID],
    );
  }
}

async function seedSourceManifests(db: PGlite, periodStart: string) {
  const families = [
    "jobs",
    "job_nested",
    "quotes",
    "quote_nested",
    "employees",
    "timesheets",
    "jobs_from_timesheets",
    "schedules",
    "mobile_status",
  ];
  const methods: Record<string, string> = {
    jobs: "listJobs",
    job_nested: "listJobs",
    quotes: "listQuotes",
    quote_nested: "listQuotes",
    employees: "listEmployees",
    timesheets: "listEmployeeTimesheets",
    jobs_from_timesheets: "listEmployeeTimesheets",
    schedules: "listSchedules",
    mobile_status: "listMobileStatus",
  };
  const start = new Date(`${periodStart}T00:00:00.000Z`);
  const periodEnd = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  const idHash = exactSourceIdHash(["1"]);
  for (const family of families) {
    const targetKey = `${family}:${periodStart}:full-universe`;
    const requestIdentity = `${family}:${periodStart}:request:1`;
    const pageIdentity = `${family}:${periodStart}:page:1`;
    const requestQuery = { StartDate: periodStart, EndDate: periodEnd, display: "all", orderby: "ID" };
    const requestSha256 = bulkEvidenceRequestSha256(requestQuery);
    const pageSha256 = bulkEvidencePageSha256(pageIdentity, ["1"]);
    await db.query(
      `insert into metrics.backfill_source_month_ledger (
         source_family, month_start, month_end_exclusive, execution_mode,
         required_for_completion, status, expected_pages, expected_records,
         estimated_nested_requests, estimated_requests, daily_request_ceiling,
         approved_by, approved_at, plan_hash
       ) values (
         $1, $2::date, ($2::date + interval '1 month')::date, $3,
         true, 'planned', 1, 1, 0, 1, 10000,
         'test@example.test', now(), repeat('a', 64)
       )`,
      [family, periodStart, family === "mobile_status" ? "coverage_only" : "ingest"],
    );
    const ledger = await db.query<{ id: number }>(
      `select id from metrics.backfill_source_month_ledger
        where source_family = $1 and month_start = $2::date`,
      [family, periodStart],
    );
    const workUnitId = ledger.rows[0]!.id;
    const persistedRequestQuery = {
      ...requestQuery,
      _bulkArtifactEvidence: {
        provenance: "checksum_verified_full_universe_artifact_projection",
        declaration: "Projection from a checksum-verified full-universe artifact; not a fabricated API response.",
        fabricatedApiResponse: false,
        artifactSha256: HASH,
        manifestSha256: OTHER_HASH,
        requestIdentity,
        requestSha256,
        pageIdentity,
        pageSha256,
        originalSourceMethod: methods[family],
      },
    };
    await db.query(
      `insert into metrics.backfill_traversal_pages (
         work_unit_id, generation, ordinal, target_key, source_method, page_number,
         page_size, row_count, exact_ids, request_query, terminal, continuation_page,
         response_hash, synthetic, observed_at
       ) values (
         $1, 7, 1, $2, $3, 1, 250, 1, '["1"]'::jsonb, $4::jsonb,
         true, null, $5, true, '2026-07-01T12:00:00.000Z'
       )`,
      [
        workUnitId,
        targetKey,
        `checksum_verified_full_universe_artifact_projection:${methods[family]}`,
        JSON.stringify(persistedRequestQuery),
        pageSha256,
      ],
    );
    await db.query(
      `insert into metrics.backfill_traversal_manifests (
         work_unit_id, generation, contract_version, manifest_status, filter_contract,
         as_of_watermark, observed_boundary, required_target_keys, completed_target_keys,
         exact_source_ids, listed_source_ids, detailed_source_ids, continuation_token,
         detail_coverage_required, page_count, record_count, empty_proof,
         open_quote_discovery, violations, completed_at
       ) values (
         $1, 7, 1, 'completed', '{}'::jsonb,
         '2026-07-01T12:00:00.000Z', '{}'::jsonb, $2::jsonb, $2::jsonb,
         '["1"]'::jsonb, '["1"]'::jsonb, '["1"]'::jsonb, null,
         true, 1, 1, null,
         '{"required":false,"status":"not_required"}'::jsonb, '[]'::jsonb,
         '2026-07-01T12:00:00.000Z'
       )`,
      [workUnitId, JSON.stringify([targetKey])],
    );
    const evidence = {
      authority: "checksum_verified_full_universe_artifact_projection",
      manifestGeneration: 7,
      reconciliationGeneration: 7,
      expectedPageCount: 1,
      completedPageCount: 1,
      reconciledAt: "2026-07-01T12:00:00.000Z",
      manifestStatus: "completed",
      publicationState: "matched",
      exactSourceIdHash: idHash,
      normalizedIdHash: idHash,
      exactSourceIds: ["1"],
      listedSourceIds: ["1"],
      detailedSourceIds: ["1"],
      periodDetailIds: ["1"],
      normalizedSourceIds: ["1"],
      requiredTargetKeys: [targetKey],
      completedTargetKeys: [targetKey],
      artifactPages: [{
        targetKey,
        sourceMethod: methods[family],
        requestIdentity,
        requestSha256,
        pageIdentity,
        pageSha256,
        pageNumber: 1,
        rowCount: 1,
        exactIds: ["1"],
        terminal: true,
        continuationPage: null,
      }],
      artifactSha256: HASH,
      manifestSha256: OTHER_HASH,
      checksumVerifiedFullUniverseArtifact: true,
      fabricatedApiResponse: false,
    };
    await db.query(
      `insert into metrics.source_period_manifests (
         source_family, period_start, period_end, coverage_status, reconciliation_status,
         listed_count, detail_count, normalized_count, source_id_hash, normalized_id_hash,
         source_value, normalized_value, continuation_token, evidence_as_of, completed_at,
         evidence_json, manifest_generation, reconciliation_generation,
         expected_page_count, completed_page_count, reconciled_at
       ) values (
         $1, $2::date, $3::date, 'complete', 'matched',
         1, 1, 1, $4, $4, 1, 1, null,
         '2026-07-01T12:00:00.000Z', '2026-07-01T12:00:00.000Z',
         $5::jsonb, 7, 7, 1, 1, '2026-07-01T12:00:00.000Z'
       )`,
      [family, periodStart, periodEnd, idHash, JSON.stringify(evidence)],
    );
  }
}


async function assertNoChecks(db: PGlite) {
  const result = await db.query<{ count: number }>(
    "select count(*)::int count from metrics.reconciliation_checks",
  );
  assert.equal(result.rows[0]?.count, 0);
}

async function migratedDatabase() {
  const db = new PGlite();
  const files = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) await db.exec(await readFile(new URL(file, migrationDirectory), "utf8"));
  return db;
}

function pgliteQuery(db: PGlite): BulkDashboardReconciliationQuery {
  return async <T>(text: string, values?: unknown[]) => {
    const result = await db.query<T>(text, values);
    return { rows: result.rows, rowCount: result.affectedRows };
  };
}
