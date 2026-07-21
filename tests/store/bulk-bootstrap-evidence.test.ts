import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  bulkEvidencePageSha256,
  bulkEvidenceRequestSha256,
  publishVerifiedBulkBootstrapEvidence,
  type BulkBootstrapEvidenceQuery,
  type BulkBootstrapEvidenceUnit,
} from "../../src/lib/store/bulk-bootstrap-evidence";
import { exactSourceIdHash, sortExactSourceIds } from "../../src/lib/store/exact-source-identities";
import {
  buildSourcePeriodManifestEvidence,
  upsertSourcePeriodManifest,
} from "../../src/lib/store/source-period-manifests";
import type { BackfillSourceFamily } from "../../src/lib/backfill/plan";
import {
  buildEvidenceUnits,
  REQUIRED_BULK_EVIDENCE_FAMILIES,
  resolveBulkEvidenceFamilies,
} from "../../scripts/publish-bulk-bootstrap-evidence";

const migrationDirectory = new URL("../../infra/db/migrations/", import.meta.url);
const historicalNestedRepairMigration = new URL(
  "../../infra/db/migrations/049_cancel_historically_superseded_job_nested_refreshes.sql",
  import.meta.url,
);

test("bulk evidence CLI can select only required or optional families", () => {
  assert.deepEqual(resolveBulkEvidenceFamilies(["--required-only"]), REQUIRED_BULK_EVIDENCE_FAMILIES);
  assert.deepEqual(resolveBulkEvidenceFamilies(["--optional-only"]), ["mobile_status"]);
  assert.deepEqual(resolveBulkEvidenceFamilies([]), [...REQUIRED_BULK_EVIDENCE_FAMILIES, "mobile_status"]);
  assert.throws(
    () => resolveBulkEvidenceFamilies(["--required-only", "--optional-only"]),
    /cannot be combined/,
  );
});

test("publishes nonempty verified artifact evidence into the existing backfill system", async () => {
  const db = await migratedDatabase();
  try {
    await seedLedger(db, "jobs", "2026-06-01");
    const unit = evidenceUnit({
      sourceFamily: "jobs",
      periodStart: "2026-06-01",
      exactIds: [102, 101],
      sourceValue: 125.5,
    });

    const result = await publishVerifiedBulkBootstrapEvidence([unit], pgliteQuery(db));
    assert.deepEqual(result, {
      manifestSha256: unit.manifestSha256,
      batchEvidenceSha256: result.batchEvidenceSha256,
      publishedUnits: 1,
      completedUnits: 1,
      partialUnits: 0,
      unavailableUnits: 0,
      pageCount: 1,
      reconciliationCount: 1,
      idempotent: false,
    });
    assert.match(result.batchEvidenceSha256, /^[a-f0-9]{64}$/);

    const published = await db.query<{
      ledger_status: string;
      ledger_reconciliation: string;
      manifest_status: string;
      generation: number;
      synthetic: boolean;
      source_method: string;
      fabricated_api_response: string;
      reconciliation_status: string;
      coverage_status: string;
      source_id_hash: string;
      normalized_id_hash: string;
      manifest_generation: number;
      reconciliation_generation: number;
      expected_page_count: number;
      completed_page_count: number;
      reconciled: boolean;
      exact_source_ids: unknown;
      audits: number;
      audit_manifest_sha: string;
      audit_units: number;
      audit_pages: number;
    }>(`
      select
        l.status as ledger_status,
        l.reconciliation_status as ledger_reconciliation,
        m.manifest_status,
        m.generation,
        p.synthetic,
        p.source_method,
        p.request_query->'_bulkArtifactEvidence'->>'fabricatedApiResponse' as fabricated_api_response,
        r.status as reconciliation_status,
        sp.coverage_status,
        sp.source_id_hash,
        sp.normalized_id_hash,
        sp.manifest_generation::int,
        sp.reconciliation_generation::int,
        sp.expected_page_count,
        sp.completed_page_count,
        sp.reconciled_at is not null as reconciled,
        sp.evidence_json->'exactSourceIds' as exact_source_ids,
        (select count(*)::int from metrics.audit_events where action = 'bulk_bootstrap_evidence_published') as audits,
        (select after_value->>'manifestSha256' from metrics.audit_events where action = 'bulk_bootstrap_evidence_published') as audit_manifest_sha,
        (select (after_value->>'publishedUnits')::int from metrics.audit_events where action = 'bulk_bootstrap_evidence_published') as audit_units,
        (select (after_value->>'pageCount')::int from metrics.audit_events where action = 'bulk_bootstrap_evidence_published') as audit_pages
      from metrics.backfill_source_month_ledger l
      join metrics.backfill_traversal_manifests m on m.work_unit_id = l.id
      join metrics.backfill_traversal_pages p on p.work_unit_id = l.id and p.generation = m.generation
      join metrics.backfill_reconciliation_results r on r.work_unit_id = l.id
      join metrics.source_period_manifests sp
        on sp.source_family = l.source_family and sp.period_start = l.month_start
      where l.source_family = 'jobs' and l.month_start = '2026-06-01'
    `);
    assert.deepEqual(published.rows[0], {
      ledger_status: "completed",
      ledger_reconciliation: "matched",
      manifest_status: "completed",
      generation: 1,
      synthetic: true,
      source_method: "checksum_verified_full_universe_artifact_projection:listJobs",
      fabricated_api_response: "false",
      reconciliation_status: "matched",
      coverage_status: "complete",
      source_id_hash: sha(JSON.stringify(["101", "102"])),
      normalized_id_hash: sha(JSON.stringify(["101", "102"])),
      manifest_generation: 1,
      reconciliation_generation: 1,
      expected_page_count: 1,
      completed_page_count: 1,
      reconciled: true,
      exact_source_ids: ["101", "102"],
      audits: 1,
      audit_manifest_sha: unit.manifestSha256,
      audit_units: 1,
      audit_pages: 1,
    });
  } finally {
    await db.close();
  }
});

test("historical checksum-backed bulk authority cannot be downgraded by a later partial manifest", async () => {
  const db = await migratedDatabase();
  try {
    await seedLedger(db, "job_nested", "2024-03-01");
    const unit = evidenceUnit({
      sourceFamily: "job_nested",
      periodStart: "2024-03-01",
      exactIds: [314],
    });
    await publishVerifiedBulkBootstrapEvidence([unit], pgliteQuery(db));

    const partial = buildSourcePeriodManifestEvidence({
      sourceFamily: "job_nested",
      periodStart: "2024-03-01",
      periodEnd: "2024-03-31",
      listedIds: [314],
      detailIds: [],
      normalizedIds: [],
      authoritativeListComplete: true,
      listRequestCount: 1,
      manifestGeneration: 2,
      reconciliationStatus: "pending",
      evidenceAsOf: "2026-07-21T19:00:00.000Z",
    });
    const upsert = await upsertSourcePeriodManifest(partial, pgliteQuery(db));
    assert.equal(upsert.rowCount, 0);

    const preserved = await db.query<{
      coverage_status: string;
      reconciliation_status: string;
      generation: number;
      authority: string;
      exact_source_ids: unknown;
    }>(`
      select coverage_status, reconciliation_status, manifest_generation::int as generation,
             evidence_json->>'authority' as authority,
             evidence_json->'exactSourceIds' as exact_source_ids
        from metrics.source_period_manifests
       where source_family = 'job_nested' and period_start = '2024-03-01'
    `);
    assert.deepEqual(preserved.rows[0], {
      coverage_status: "complete",
      reconciliation_status: "matched",
      generation: 1,
      authority: "checksum_verified_full_universe_artifact_projection",
      exact_source_ids: ["314"],
    });
  } finally {
    await db.close();
  }
});

test("historical authority migration cancels only queued reconciliation job nested refreshes", async () => {
  const db = await migratedDatabase();
  try {
    await seedLedger(db, "job_nested", "2024-03-01");
    await publishVerifiedBulkBootstrapEvidence([
      evidenceUnit({ sourceFamily: "job_nested", periodStart: "2024-03-01", exactIds: [314, 315, 316] }),
    ], pgliteQuery(db));
    // This is the production failure mode: a later partial reconciliation has
    // replaced the mutable source-period projection. The immutable traversal
    // page and active bulk root remain the repair authority.
    await db.exec(`
      update metrics.source_period_manifests
         set coverage_status = 'partial', reconciliation_status = 'pending',
             evidence_json = '{"authoritativeSource":"project_nested_traversals"}'::jsonb
       where source_family = 'job_nested' and period_start = '2024-03-01';
      insert into metrics.raw_simpro_snapshots (
        entity_type, entity_id, source_path, source_hash, payload, source_version,
        complete_traversal, parent_identity
      ) values
        ('jobs', '314', 'simpro:/jobs/?display=all', 'bulk-root-314', '{}'::jsonb,
         'bulk-bootstrap:project-manifest', true, '{"projectType":"job","projectId":"314"}'::jsonb),
        ('jobs', '315', 'simpro:/jobs/?display=all', 'bulk-root-315', '{}'::jsonb,
         'bulk-bootstrap:project-manifest', true, '{"projectType":"job","projectId":"315"}'::jsonb);
    `);
    await db.exec(`
      insert into metrics.ingestion_jobs (
        entity_type, operation, idempotency_key, priority, request_budget, params, status
      ) values
        ('job_nested', 'bounded_refresh', 'historical-reconciliation', 50, 100,
         '{"entityId":314,"boundedWork":{"origin":"reconciliation"}}'::jsonb, 'queued'),
        ('job_nested', 'bounded_refresh', 'manual-override', 50, 100,
         '{"entityId":315,"boundedWork":{"origin":"manual"}}'::jsonb, 'queued'),
        ('job_nested', 'bounded_refresh', 'active-reconciliation', 50, 100,
         '{"entityId":314,"boundedWork":{"origin":"reconciliation"}}'::jsonb, 'running'),
        ('job_nested', 'bounded_refresh', 'no-raw-reconciliation', 50, 100,
         '{"entityId":316,"boundedWork":{"origin":"reconciliation"}}'::jsonb, 'queued'),
        ('job_nested', 'bounded_refresh', 'uncovered-reconciliation', 50, 100,
         '{"entityId":999,"boundedWork":{"origin":"reconciliation"}}'::jsonb, 'queued');
    `);

    await db.exec(await readFile(historicalNestedRepairMigration, "utf8"));
    const queues = await db.query<{ idempotency_key: string; status: string; last_error: string | null }>(`
      select idempotency_key, status::text, last_error
        from metrics.ingestion_jobs
       order by idempotency_key
    `);
    assert.deepEqual(queues.rows, [
      { idempotency_key: "active-reconciliation", status: "running", last_error: null },
      { idempotency_key: "historical-reconciliation", status: "cancelled", last_error: "Superseded by completed checksum-verified historical job_nested bulk authority" },
      { idempotency_key: "manual-override", status: "queued", last_error: null },
      { idempotency_key: "no-raw-reconciliation", status: "queued", last_error: null },
      { idempotency_key: "uncovered-reconciliation", status: "queued", last_error: null },
    ]);
    const audit = await db.query<{ cancelled_jobs: number }>(`
      select (after_value->>'cancelledJobs')::integer as cancelled_jobs
        from metrics.audit_events
       where action = 'historical_job_nested_refresh_cancelled'
    `);
    assert.deepEqual(audit.rows, [{ cancelled_jobs: 1 }]);
  } finally {
    await db.close();
  }
});

test("compound exact IDs use one numeric-aware order and permutation-stable hash", async () => {
  const db = await migratedDatabase();
  try {
    await seedLedger(db, "timesheets", "2026-06-01");
    const ids = ["10:ts", "2:ts", "2:alpha"];
    const unit = evidenceUnit({
      sourceFamily: "timesheets",
      periodStart: "2026-06-01",
      exactIds: ids,
      sourceValue: 0,
      detailCoverageRequired: false,
    });
    await publishVerifiedBulkBootstrapEvidence([unit], pgliteQuery(db));

    const row = await db.query<{ source_id_hash: string; exact_ids: unknown }>(`
      select sp.source_id_hash, p.exact_ids
        from metrics.source_period_manifests sp
        join metrics.backfill_source_month_ledger l
          on l.source_family = sp.source_family and l.month_start = sp.period_start
        join metrics.backfill_traversal_pages p on p.work_unit_id = l.id
       where sp.source_family = 'timesheets' and sp.period_start = '2026-06-01'
    `);
    assert.deepEqual(sortExactSourceIds(ids), ["2:alpha", "2:ts", "10:ts"]);
    assert.equal(row.rows[0]?.source_id_hash, exactSourceIdHash(["2:alpha", "10:ts", "2:ts"]));
    assert.deepEqual(row.rows[0]?.exact_ids, ["2:alpha", "2:ts", "10:ts"]);
  } finally {
    await db.close();
  }
});

test("exact completion requires finite numeric totals while preserving real zero", async () => {
  const query: BulkBootstrapEvidenceQuery = async () => {
    throw new Error("database must not be reached");
  };
  for (const value of [null, " ", true, Number.NaN, Number.POSITIVE_INFINITY] as unknown[]) {
    const unit = evidenceUnit({ sourceFamily: "jobs", periodStart: "2026-06-01", exactIds: [], sourceValue: 0 });
    (unit as unknown as Record<string, unknown>).sourceValue = value;
    (unit as unknown as Record<string, unknown>).normalizedValue = value;
    await assert.rejects(
      publishVerifiedBulkBootstrapEvidence([unit], query),
      /finite number|source and normalized values must both be finite numbers/,
    );
  }

  const db = await migratedDatabase();
  try {
    await seedLedger(db, "jobs", "2026-06-01");
    const zero = evidenceUnit({ sourceFamily: "jobs", periodStart: "2026-06-01", exactIds: [], sourceValue: 0 });
    const result = await publishVerifiedBulkBootstrapEvidence([zero], pgliteQuery(db));
    assert.equal(result.completedUnits, 1);
  } finally {
    await db.close();
  }
});

test("changed immutable evidence increments past stale generations and replaces all authority fields", async () => {
  const db = await migratedDatabase();
  try {
    await seedLedger(db, "jobs", "2026-06-01");
    const first = evidenceUnit({
      sourceFamily: "jobs",
      periodStart: "2026-06-01",
      exactIds: [101],
      sourceValue: 10,
    });
    await publishVerifiedBulkBootstrapEvidence([first], pgliteQuery(db));
    await db.exec(`
      update metrics.source_period_manifests
         set reconciliation_generation = 9,
             expected_page_count = 0,
             completed_page_count = 0,
             reconciled_at = null,
             evidence_json = '{"stale":true}'::jsonb
       where source_family = 'jobs' and period_start = '2026-06-01';
    `);

    const changed = evidenceUnit({
      sourceFamily: "jobs",
      periodStart: "2026-06-01",
      exactIds: [102],
      sourceValue: 20,
    });
    changed.artifactSha256 = "e".repeat(64);
    changed.manifestSha256 = "f".repeat(64);
    changed.evidenceAsOf = "2026-07-11T18:00:00.000Z";
    await publishVerifiedBulkBootstrapEvidence([changed], pgliteQuery(db));

    const state = await db.query<{
      traversal_generation: number;
      manifest_generation: number;
      reconciliation_generation: number;
      expected_page_count: number;
      completed_page_count: number;
      coverage_status: string;
      reconciliation_status: string;
      reconciled: boolean;
      exact_source_ids: unknown;
      source_id_hash: string;
    }>(`
      select m.generation::int traversal_generation,
             sp.manifest_generation::int,
             sp.reconciliation_generation::int,
             sp.expected_page_count,
             sp.completed_page_count,
             sp.coverage_status,
             sp.reconciliation_status,
             sp.reconciled_at is not null reconciled,
             sp.evidence_json->'exactSourceIds' exact_source_ids,
             sp.source_id_hash
        from metrics.backfill_source_month_ledger l
        join metrics.backfill_traversal_manifests m on m.work_unit_id = l.id
        join metrics.source_period_manifests sp
          on sp.source_family = l.source_family and sp.period_start = l.month_start
       where l.source_family = 'jobs' and l.month_start = '2026-06-01'
    `);
    assert.deepEqual(state.rows[0], {
      traversal_generation: 10,
      manifest_generation: 10,
      reconciliation_generation: 10,
      expected_page_count: 1,
      completed_page_count: 1,
      coverage_status: "complete",
      reconciliation_status: "matched",
      reconciled: true,
      exact_source_ids: ["102"],
      source_id_hash: exactSourceIdHash(["102"]),
    });
  } finally {
    await db.close();
  }
});

test("rejects retired invoice evidence and fabricated derived page methods before querying", async () => {
  const query: BulkBootstrapEvidenceQuery = async () => {
    throw new Error("database must not be reached");
  };
  const invoice = evidenceUnit({ sourceFamily: "jobs", periodStart: "2026-06-01", exactIds: [], sourceValue: 0 });
  (invoice as unknown as { sourceFamily: string }).sourceFamily = "invoices";
  await assert.rejects(
    publishVerifiedBulkBootstrapEvidence([invoice], query),
    /Unsupported source family: invoices/,
  );

  const fabricated = evidenceUnit({ sourceFamily: "jobs", periodStart: "2026-06-01", exactIds: [], sourceValue: 0 });
  fabricated.pages[0]!.sourceMethod = "derivedJobDependency";
  await assert.rejects(
    publishVerifiedBulkBootstrapEvidence([fabricated], query),
    /must be immutable listJobs list-response evidence/,
  );
});

test("generator output publishes every required family with canonical list methods and distinct provenance", async () => {
  const source = (family: string, marker: string) => Object.freeze({
    family,
    sha256: marker.repeat(64),
    rows: Object.freeze([]),
    exactIds: Object.freeze([]),
    activityPeriodIds: Object.freeze({}),
    secondaryPeriodIds: Object.freeze({}),
  });
  const project = Object.freeze({
    manifestSha256: "a".repeat(64),
    manifest: Object.freeze({ completedAt: "2026-07-10T18:00:00.000Z" }),
    sources: Object.freeze({
      jobs: source("jobs", "b"),
      quotes: source("quotes", "c"),
    }),
  });
  const operational = Object.freeze({
    manifestSha256: "d".repeat(64),
    manifest: Object.freeze({
      completedAt: "2026-07-10T19:00:00.000Z",
      asOfDate: "2026-07-10",
    }),
    sources: Object.freeze({
      employees: source("employees", "e"),
      timesheets: source("timesheets", "f"),
      schedules: source("schedules", "1"),
      mobile_status: source("mobile_status", "2"),
    }),
  });
  const generated = await buildEvidenceUnits(
    project as never,
    operational as never,
    [...REQUIRED_BULK_EVIDENCE_FAMILIES],
  );
  const units = generated.filter((unit) => unit.periodStart === "2023-01-01");
  assert.deepEqual(
    units.map((unit) => unit.sourceFamily).sort(),
    [...REQUIRED_BULK_EVIDENCE_FAMILIES].sort(),
  );

  const db = await migratedDatabase();
  try {
    for (const family of REQUIRED_BULK_EVIDENCE_FAMILIES) await seedLedger(db, family, "2023-01-01");
    const result = await publishVerifiedBulkBootstrapEvidence(units, pgliteQuery(db));
    assert.equal(result.completedUnits, REQUIRED_BULK_EVIDENCE_FAMILIES.length);

    const pages = await db.query<{
      source_family: string;
      source_method: string;
      request_identity: string;
      provenance: string;
      original_source_method: string;
    }>(`
      select l.source_family, p.source_method,
             p.request_query->'_bulkArtifactEvidence'->>'requestIdentity' request_identity,
             p.request_query->'_bulkArtifactEvidence'->>'provenance' provenance,
             p.request_query->'_bulkArtifactEvidence'->>'originalSourceMethod' original_source_method
        from metrics.backfill_source_month_ledger l
        join metrics.backfill_traversal_manifests m on m.work_unit_id = l.id
        join metrics.backfill_traversal_pages p
          on p.work_unit_id = l.id and p.generation = m.generation
       where l.month_start = '2023-01-01'
       order by l.source_family
    `);
    const expectedMethods: Record<string, string> = {
      employees: "listEmployees",
      job_nested: "listJobs",
      jobs: "listJobs",
      jobs_from_timesheets: "listEmployeeTimesheets",
      quote_nested: "listQuotes",
      quotes: "listQuotes",
      schedules: "listSchedules",
      timesheets: "listEmployeeTimesheets",
    };
    assert.equal(pages.rows.length, REQUIRED_BULK_EVIDENCE_FAMILIES.length);
    assert.equal(new Set(pages.rows.map((row) => row.request_identity)).size, pages.rows.length);
    for (const row of pages.rows) {
      const method = expectedMethods[row.source_family];
      assert.equal(row.original_source_method, method);
      assert.equal(row.source_method, `checksum_verified_full_universe_artifact_projection:${method}`);
      assert.equal(row.provenance, "checksum_verified_full_universe_artifact_projection");
    }
  } finally {
    await db.close();
  }
});

test("publishes an authoritative empty month only with terminal checksum evidence", async () => {
  const db = await migratedDatabase();
  try {
    await seedLedger(db, "jobs", "2026-05-01");
    const unit = evidenceUnit({ sourceFamily: "jobs", periodStart: "2026-05-01", exactIds: [] });

    await publishVerifiedBulkBootstrapEvidence([unit], pgliteQuery(db));

    const proof = await db.query<{
      manifest_status: string;
      record_count: number;
      row_count: number;
      authoritative: string;
      full_universe: string;
      ledger_status: string;
      expected_page_count: number;
      completed_page_count: number;
      artifact_page_count: number;
    }>(`
      select m.manifest_status, m.record_count, p.row_count,
             m.empty_proof->>'authoritative' as authoritative,
             m.empty_proof->>'fullUniverseArtifact' as full_universe,
             l.status as ledger_status,
             sp.expected_page_count,
             sp.completed_page_count,
             jsonb_array_length(sp.evidence_json->'artifactPages') artifact_page_count
        from metrics.backfill_source_month_ledger l
        join metrics.backfill_traversal_manifests m on m.work_unit_id = l.id
        join metrics.backfill_traversal_pages p on p.work_unit_id = l.id and p.generation = m.generation
        join metrics.source_period_manifests sp
          on sp.source_family = l.source_family and sp.period_start = l.month_start
       where l.source_family = 'jobs' and l.month_start = '2026-05-01'
    `);
    assert.deepEqual(proof.rows[0], {
      manifest_status: "completed",
      record_count: 0,
      row_count: 0,
      authoritative: "true",
      full_universe: "true",
      ledger_status: "completed",
      expected_page_count: 1,
      completed_page_count: 1,
      artifact_page_count: 1,
    });
  } finally {
    await db.close();
  }
});

test("publishes the current Pacific month as provisional with open-quote discovery", async () => {
  const db = await migratedDatabase();
  try {
    const current = await db.query<{ month_start: string }>(
      `select date_trunc('month', now() at time zone 'America/Los_Angeles')::date::text as month_start`,
    );
    const periodStart = current.rows[0].month_start;
    await seedLedger(db, "quotes", periodStart);
    const unit = evidenceUnit({
      sourceFamily: "quotes",
      periodStart,
      exactIds: [7001],
      currentMonth: true,
      openQuoteDiscovery: {
        required: true,
        status: "complete",
        discoveryIdentity: "verified-open-quote-universe",
      },
    });

    await publishVerifiedBulkBootstrapEvidence([unit], pgliteQuery(db));

    const currentEvidence = await db.query<{
      manifest_status: string;
      open_status: string;
      ledger_status: string;
      ledger_reconciliation: string;
      coverage_status: string;
      mutable_period: boolean;
      mutable_checkpoint: string;
    }>(`
      select m.manifest_status,
             m.open_quote_discovery->>'status' as open_status,
             l.status as ledger_status,
             l.reconciliation_status as ledger_reconciliation,
             sp.coverage_status,
             sp.mutable_period,
             sp.evidence_json->>'mutableCheckpoint' as mutable_checkpoint
        from metrics.backfill_source_month_ledger l
        join metrics.backfill_traversal_manifests m on m.work_unit_id = l.id
        join metrics.source_period_manifests sp
          on sp.source_family = l.source_family and sp.period_start = l.month_start
       where l.source_family = 'quotes' and l.month_start = $1::date
    `, [periodStart]);
    assert.deepEqual(currentEvidence.rows[0], {
      manifest_status: "provisional",
      open_status: "complete",
      ledger_status: "completed",
      ledger_reconciliation: "matched",
      coverage_status: "complete",
      mutable_period: true,
      mutable_checkpoint: "true",
    });
  } finally {
    await db.close();
  }
});

test("rejects an unmarked exact-ID mismatch without publishing any evidence", async () => {
  const db = await migratedDatabase();
  try {
    await seedLedger(db, "employees", "2026-04-01");
    const unit = evidenceUnit({ sourceFamily: "employees", periodStart: "2026-04-01", exactIds: [44] });
    unit.normalizedSourceIds = [];

    await assert.rejects(
      publishVerifiedBulkBootstrapEvidence([unit], pgliteQuery(db)),
      /Bulk evidence mismatch.*normalized IDs do not equal exact source IDs/,
    );

    const writes = await db.query<{
      pages: number;
      manifests: number;
      reconciliations: number;
      source_periods: number;
      audits: number;
      ledger_status: string;
      ledger_reconciliation: string;
    }>(`
      select
        (select count(*)::int from metrics.backfill_traversal_pages) as pages,
        (select count(*)::int from metrics.backfill_traversal_manifests) as manifests,
        (select count(*)::int from metrics.backfill_reconciliation_results) as reconciliations,
        (select count(*)::int from metrics.source_period_manifests) as source_periods,
        (select count(*)::int from metrics.audit_events where action = 'bulk_bootstrap_evidence_published') as audits,
        l.status as ledger_status,
        l.reconciliation_status as ledger_reconciliation
      from metrics.backfill_source_month_ledger l
      where l.source_family = 'employees' and l.month_start = '2026-04-01'
    `);
    assert.deepEqual(writes.rows[0], {
      pages: 0,
      manifests: 0,
      reconciliations: 0,
      source_periods: 0,
      audits: 0,
      ledger_status: "planned",
      ledger_reconciliation: "pending",
    });
  } finally {
    await db.close();
  }
});

test("is idempotent for a rerun of the same verified manifest batch", async () => {
  const db = await migratedDatabase();
  try {
    await seedLedger(db, "schedules", "2026-03-01");
    await seedExistingTraversal(db, "schedules", "2026-03-01");
    const unit = evidenceUnit({ sourceFamily: "schedules", periodStart: "2026-03-01", exactIds: [81, 82] });
    const query = pgliteQuery(db);

    const first = await publishVerifiedBulkBootstrapEvidence([unit], query);
    const second = await publishVerifiedBulkBootstrapEvidence([unit], query);
    assert.equal(first.idempotent, false);
    assert.equal(second.idempotent, true);
    assert.equal(second.batchEvidenceSha256, first.batchEvidenceSha256);

    const counts = await db.query<{
      pages: number;
      generation: number;
      reconciliations: number;
      source_periods: number;
      audits: number;
    }>(`
      select
        (select count(*)::int from metrics.backfill_traversal_pages) as pages,
        (select generation from metrics.backfill_traversal_manifests limit 1) as generation,
        (select count(*)::int from metrics.backfill_reconciliation_results) as reconciliations,
        (select count(*)::int from metrics.source_period_manifests) as source_periods,
        (select count(*)::int from metrics.audit_events where action = 'bulk_bootstrap_evidence_published') as audits
    `);
    assert.deepEqual(counts.rows[0], {
      pages: 2,
      generation: 2,
      reconciliations: 1,
      source_periods: 1,
      audits: 1,
    });
  } finally {
    await db.close();
  }
});

test("allows a verified optional-family batch to extend an already published manifest", async () => {
  const db = await migratedDatabase();
  try {
    await seedLedger(db, "jobs", "2026-03-01");
    await seedLedger(db, "mobile_status", "2026-03-01", false);
    const jobs = evidenceUnit({
      sourceFamily: "jobs",
      periodStart: "2026-03-01",
      exactIds: [101],
    });
    const mobile = evidenceUnit({
      sourceFamily: "mobile_status",
      periodStart: "2026-03-01",
      exactIds: [901],
      detailCoverageRequired: false,
    });
    mobile.manifestSha256 = jobs.manifestSha256;
    const query = pgliteQuery(db);

    const required = await publishVerifiedBulkBootstrapEvidence([jobs], query);
    const optional = await publishVerifiedBulkBootstrapEvidence([mobile], query);
    const repeatedOptional = await publishVerifiedBulkBootstrapEvidence([mobile], query);

    assert.equal(required.idempotent, false);
    assert.equal(optional.idempotent, false);
    assert.notEqual(optional.batchEvidenceSha256, required.batchEvidenceSha256);
    assert.equal(repeatedOptional.idempotent, true);
    assert.equal(repeatedOptional.batchEvidenceSha256, optional.batchEvidenceSha256);

    const result = await db.query<{ families: number; audits: number }>(`
      select
        (select count(*)::int from metrics.source_period_manifests
          where source_family in ('jobs', 'mobile_status')) as families,
        (select count(*)::int from metrics.audit_events
          where action = 'bulk_bootstrap_evidence_published') as audits
    `);
    assert.deepEqual(result.rows[0], { families: 2, audits: 2 });
    const generations = await db.query<{ source_family: string; generation: number }>(`
      select source_family, manifest_generation::int generation
        from metrics.source_period_manifests
       where source_family in ('jobs', 'mobile_status')
       order by source_family
    `);
    assert.deepEqual(generations.rows, [
      { source_family: "jobs", generation: 1 },
      { source_family: "mobile_status", generation: 1 },
    ]);
  } finally {
    await db.close();
  }
});

test("an unavailable publication fails closed and never writes source facts", async () => {
  const db = await migratedDatabase();
  try {
    await seedLedger(db, "mobile_status", "2026-02-01", false);
    const before = await factCounts(db);
    const unit = evidenceUnit({
      sourceFamily: "mobile_status",
      periodStart: "2026-02-01",
      exactIds: [],
      detailCoverageRequired: false,
      state: "unavailable",
      stateReason: "The verified artifact declares this historical source unavailable.",
    });

    await publishVerifiedBulkBootstrapEvidence([unit], pgliteQuery(db));

    assert.deepEqual(await factCounts(db), before);
    const closed = await db.query<{
      ledger_status: string;
      ledger_reconciliation: string;
      manifest_status: string;
      reconciliation_status: string;
      coverage_status: string;
    }>(`
      select l.status as ledger_status,
             l.reconciliation_status as ledger_reconciliation,
             m.manifest_status,
             r.status as reconciliation_status,
             sp.coverage_status
        from metrics.backfill_source_month_ledger l
        join metrics.backfill_traversal_manifests m on m.work_unit_id = l.id
        join metrics.backfill_reconciliation_results r on r.work_unit_id = l.id
        join metrics.source_period_manifests sp
          on sp.source_family = l.source_family and sp.period_start = l.month_start
       where l.source_family = 'mobile_status' and l.month_start = '2026-02-01'
    `);
    assert.deepEqual(closed.rows[0], {
      ledger_status: "planned",
      ledger_reconciliation: "unavailable",
      manifest_status: "unavailable",
      reconciliation_status: "unavailable",
      coverage_status: "partial",
    });
  } finally {
    await db.close();
  }
});

async function migratedDatabase() {
  const db = new PGlite();
  const migrations = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
  for (const migration of migrations) {
    await db.exec(await readFile(new URL(migration, migrationDirectory), "utf8"));
  }
  return db;
}

async function seedLedger(
  db: PGlite,
  sourceFamily: BackfillSourceFamily,
  monthStart: string,
  requiredForCompletion = true,
) {
  await db.query(`
    insert into metrics.backfill_source_month_ledger (
      source_family, month_start, month_end_exclusive, execution_mode,
      required_for_completion, status, expected_pages, expected_records,
      estimated_nested_requests, estimated_requests, daily_request_ceiling,
      approved_by, approved_at, plan_hash
    ) values (
      $1, $2::date, $3::date, $4, $5, 'planned', 1, 0, 0, 1, 10000,
      'test@example.test', now(), repeat('a', 64)
    )
  `, [
    sourceFamily,
    monthStart,
    addMonths(monthStart, 1),
    sourceFamily === "mobile_status" ? "coverage_only" : "ingest",
    requiredForCompletion,
  ]);
}

async function seedExistingTraversal(db: PGlite, sourceFamily: BackfillSourceFamily, monthStart: string) {
  const ledger = await db.query<{ id: number }>(`
    select id from metrics.backfill_source_month_ledger
     where source_family = $1 and month_start = $2::date
  `, [sourceFamily, monthStart]);
  const workUnitId = ledger.rows[0].id;
  await db.query(`
    insert into metrics.backfill_traversal_pages (
      work_unit_id, generation, ordinal, target_key, source_method, page_number,
      page_size, row_count, exact_ids, request_query, terminal, response_hash,
      synthetic, observed_at
    ) values (
      $1, 1, 1, 'prior-target', 'listSchedules', 1,
      250, 1, '["70"]'::jsonb, '{"source":"prior traversal"}'::jsonb,
      true, $2, false, '2026-04-01T00:00:00.000Z'
    )
  `, [workUnitId, sha("prior-page")]);
  await db.query(`
    insert into metrics.backfill_traversal_manifests (
      work_unit_id, generation, contract_version, manifest_status, filter_contract,
      as_of_watermark, observed_boundary, required_target_keys, completed_target_keys,
      exact_source_ids, listed_source_ids, detailed_source_ids, page_count, record_count
    ) values (
      $1, 1, 1, 'collecting', '{"source":"prior traversal"}'::jsonb,
      '2026-04-01T00:00:00.000Z', '{}'::jsonb, '["prior-target"]'::jsonb,
      '["prior-target"]'::jsonb, '["70"]'::jsonb, '["70"]'::jsonb,
      '["70"]'::jsonb, 1, 1
    )
  `, [workUnitId]);
}

function evidenceUnit(params: {
  sourceFamily: BackfillSourceFamily;
  periodStart: string;
  exactIds: Array<string | number>;
  sourceValue?: number | null;
  currentMonth?: boolean;
  detailCoverageRequired?: boolean;
  openQuoteDiscovery?: Record<string, unknown>;
  state?: "partial" | "unavailable";
  stateReason?: string;
}): BulkBootstrapEvidenceUnit {
  const periodEnd = inclusiveMonthEnd(params.periodStart);
  const sourceValue = Object.hasOwn(params, "sourceValue") ? params.sourceValue! : 0;
  const pageIdentity = `${params.sourceFamily}:${params.periodStart}:page:1`;
  const exactIds = sortExactSourceIds(params.exactIds.map(String));
  const requestQuery = { StartDate: params.periodStart, EndDate: periodEnd, orderby: "ID" };
  return {
    sourceFamily: params.sourceFamily,
    periodStart: params.periodStart,
    periodEnd,
    exactSourceIds: params.exactIds,
    listedSourceIds: params.exactIds,
    detailedSourceIds: params.exactIds,
    normalizedSourceIds: params.exactIds,
    sourceValue,
    normalizedValue: sourceValue,
    pages: [{
      targetKey: `${params.sourceFamily}:${params.periodStart}:full-universe`,
      sourceMethod: sourceMethod(params.sourceFamily),
      requestIdentity: `${params.sourceFamily}:${params.periodStart}:request:1`,
      requestSha256: bulkEvidenceRequestSha256(requestQuery),
      pageIdentity,
      pageSha256: bulkEvidencePageSha256(pageIdentity, exactIds),
      pageNumber: 1,
      pageSize: Math.max(250, params.exactIds.length),
      rowCount: params.exactIds.length,
      exactIds: params.exactIds,
      requestQuery,
      terminal: true,
      continuationPage: null,
      observedMinDate: params.exactIds.length > 0 ? params.periodStart : null,
      observedMaxDate: params.exactIds.length > 0 ? periodEnd : null,
    }],
    artifactSha256: sha(`artifact:${params.sourceFamily}:${params.periodStart}`),
    manifestSha256: sha(`manifest:${params.sourceFamily}:${params.periodStart}`),
    evidenceAsOf: "2026-07-10T18:00:00.000Z",
    currentMonth: params.currentMonth ?? false,
    detailCoverageRequired: params.detailCoverageRequired ?? true,
    openQuoteDiscovery: params.openQuoteDiscovery,
    state: params.state,
    stateReason: params.stateReason,
  };
}

function sourceMethod(sourceFamily: BackfillSourceFamily) {
  const methods: Record<BackfillSourceFamily, string> = {
    quotes: "listQuotes",
    quote_nested: "listQuotes",
    jobs: "listJobs",
    job_nested: "listJobs",
    employees: "listEmployees",
    timesheets: "listEmployeeTimesheets",
    jobs_from_timesheets: "listEmployeeTimesheets",
    schedules: "listSchedules",
    mobile_status: "listMobileStatus",
  };
  return methods[sourceFamily];
}

async function factCounts(db: PGlite) {
  const result = await db.query<Record<string, number>>(`
    select
      (select count(*)::int from metrics.raw_simpro_snapshots) as raw_snapshots,
      (select count(*)::int from metrics.source_entities_raw) as source_entities,
      (select count(*)::int from metrics.metrics_quotes) as quotes,
      (select count(*)::int from metrics.metrics_quote_cost_centers) as quote_cost_centers,
      (select count(*)::int from metrics.metrics_quote_labor) as quote_labor,
      (select count(*)::int from metrics.metrics_quote_items) as quote_items,
      (select count(*)::int from metrics.metrics_jobs) as jobs,
      (select count(*)::int from metrics.metrics_job_cost_centers) as job_cost_centers,
      (select count(*)::int from metrics.metrics_job_labor) as job_labor,
      (select count(*)::int from metrics.metrics_job_items) as job_items,
      (select count(*)::int from metrics.metrics_employee_timesheets) as timesheets,
      (select count(*)::int from metrics.metrics_schedules) as schedules,
      (select count(*)::int from metrics.metrics_schedule_blocks) as schedule_blocks,
      (select count(*)::int from metrics.metrics_mobile_status_logs) as mobile_status
  `);
  return result.rows[0];
}

function pgliteQuery(db: PGlite): BulkBootstrapEvidenceQuery {
  return async <T>(sql: string, values: unknown[] = []) => {
    const result = await db.query<T>(sql, values as never[]);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  };
}

function inclusiveMonthEnd(monthStart: string) {
  const end = new Date(`${addMonths(monthStart, 1)}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() - 1);
  return end.toISOString().slice(0, 10);
}

function addMonths(value: string, months: number) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
}

function sha(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
