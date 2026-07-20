import assert from "node:assert/strict";
import test from "node:test";
import {
  checkedInMigrationFiles,
  checkedInMigrationHashes,
  checkedInMigrations,
  migrationAuditFailures,
  strictAuditFailures,
  summarize,
} from "../../scripts/audit-production-state.mjs";

const families = ["quotes", "jobs", "technicians", "commissions"];
const reconciliationFamilies = ["quotes", "jobs", "technicians"];
const backfillFamilies = [
  "quotes",
  "jobs",
  "employees",
  "quote_nested",
  "job_nested",
  "timesheets",
  "jobs_from_timesheets",
  "schedules",
];

function monthStarts(start, end) {
  const months = [];
  for (let value = start; value <= end;) {
    months.push(value);
    const date = new Date(`${value}T00:00:00.000Z`);
    date.setUTCMonth(date.getUTCMonth() + 1);
    value = `${date.toISOString().slice(0, 7)}-01`;
  }
  return months;
}

function healthyReport() {
  const months = monthStarts("2023-01-01", "2026-07-01");
  return {
    capturedAt: "2026-07-12T00:00:00.000Z",
    authorizationEnvironment: {
      auth_mode: "easy-auth",
      admin_emails: ["asad@prostarmechanical.com", "laila@prostarmechanical.com"],
      finance_emails: ["asad@prostarmechanical.com", "laila@prostarmechanical.com"],
      operator_emails: [],
      viewer_emails: [],
    },
    migrations: checkedInMigrations.map(({ filename, sha256 }) => ({ filename, sha256 })),
    backfillStatus: [{ status: "completed", units: months.length * backfillFamilies.length }],
    backfillSources: backfillFamilies.map((source_family) => ({ source_family, status: "completed", units: months.length })),
    backfillCoverage: backfillFamilies.flatMap((source_family) => months.map((month_start) => ({
      source_family,
      month_start,
      required_for_completion: true,
      status: "completed",
      reconciliation_status: "matched",
      continuation_token: null,
      manifest_status: "completed",
      as_of_watermark: `${month_start}T08:00:00.000Z`,
      manifest_completed_at: `${month_start}T09:00:00.000Z`,
      manifest_continuation_token: null,
      violations: [],
      source_coverage_status: "complete",
      source_reconciliation_status: "matched",
      source_continuation_token: null,
      source_manifest_generation: "7",
      source_reconciliation_generation: "7",
      source_expected_page_count: 1,
      source_completed_page_count: 1,
      source_reconciled_at: `${month_start}T09:00:00.000Z`,
    }))),
    ingestionQueue: [],
    ingestionFailures: [],
    invoiceRuntime: [{ active_ingestion_jobs: 0, active_ingestion_runs: 0, active_backfill_units: 0 }],
    appRoles: [
      { email: "asad@prostarmechanical.com", role: "admin" },
      { email: "laila@prostarmechanical.com", role: "finance" },
    ],
    queueBlockers: [],
    rollupQueue: [],
    readModels: families.map((metric_family) => ({
      metric_family,
      models: months.length,
      first_period: months[0],
      last_period: months.at(-1),
      non_ready: 0,
    })),
    readModelInventory: families.flatMap((metric_family) => months.map((period_start) => ({
      metric_family,
      period_grain: "month",
      period_start,
      dimensions_json: {},
      status: "ready",
      source_hash: `${metric_family}:${period_start}`,
      suspect_reason: null,
    }))),
    reconciliationLatest: reconciliationFamilies.map((scope) => ({ scope, status: "matched", periods: months.length })),
    reconciliationMatrix: reconciliationFamilies.flatMap((scope) => months.map((period_start, index) => {
      const generation = index + 1;
      const source_manifest_generations = scope === "quotes"
        ? { quotes: generation, quote_nested: generation }
        : scope === "jobs"
          ? { jobs: generation, job_nested: generation }
          : {
              jobs: generation,
              job_nested: generation,
              employees: generation,
              timesheets: generation,
              jobs_from_timesheets: generation,
              schedules: generation,
              mobile_status: generation,
            };
      return {
        scope,
        period_start,
        status: "matched",
        checked_at: "2026-07-12T00:00:00.000Z",
        generation: String(generation),
        complete_traversal: true,
        source_manifest_generations,
      };
    })),
    watermarks: [],
    watermarkEvidence: ["quote_logs", "job_logs", "schedule_logs"].map((source_family) => ({
      source_family,
      window_key: "incremental",
      status: "succeeded",
      last_success_at: "2026-07-12T00:00:00.000Z",
      expected_through: "2026-07-12T00:00:00.000Z",
      complete_window: true,
      gap_detected: false,
      page_cursor: null,
    })),
    profitCapacityCompleteness: [{
      completed_jobs_total: 10,
      completed_jobs_missing: 0,
      active_completed_cost_centers_total: 20,
      active_completed_cost_centers_missing: 0,
      people_total: 5,
      people_missing: 0,
    }],
    exactProfitCapacityBackfill: [{
      targets: 4,
      terminal: 4,
      succeeded: 3,
      source_deleted: 1,
      queued: 0,
      running: 0,
      failed: 0,
    }],
    commissions: [],
    currentCommissionRun: [],
    commissionRunCoverage: months.map((period_start, index) => ({
      period_start,
      current_run_id: String(index + 1),
      calculation_stale: false,
      config_revision: 1,
      run_revision: 1,
      run_config_revision: 1,
      run_status: "succeeded",
      source_complete: true,
      evidence_complete: true,
    })),
    outOfScopeReadModels: [],
    outOfScopeRollups: [],
    verificationFixtures: [],
    semanticValidation: {
      status: "matched",
      mismatchCount: 0,
      contractChecks: Object.fromEntries([
        "technicianUtilization",
        "costCenterCategories",
        "invoiceRuntime",
        "apiDimensions",
        "productionOwners",
        "quoteConversionEvidence",
      ].map((check) => [check, { status: "matched", mismatchCount: 0 }])),
    },
  };
}

function failureTypes(report) {
  return strictAuditFailures(report).map((failure) => failure.type);
}

test("strict production audit passes a healthy full evidence matrix", () => {
  assert.deepEqual(strictAuditFailures(healthyReport()), []);
});

test("strict production audit fails when any required evidence result is unavailable", () => {
  for (const field of [
    "migrations",
    "backfillSources",
    "backfillCoverage",
    "ingestionFailures",
    "invoiceRuntime",
    "appRoles",
    "queueBlockers",
    "rollupQueue",
    "readModels",
    "readModelInventory",
    "reconciliationLatest",
    "reconciliationMatrix",
    "watermarkEvidence",
    "profitCapacityCompleteness",
    "exactProfitCapacityBackfill",
    "commissionRunCoverage",
    "outOfScopeReadModels",
    "outOfScopeRollups",
    "verificationFixtures",
  ]) {
    const report = healthyReport();
    delete report[field];
    assert.ok(
      strictAuditFailures(report).some((failure) => failure.type === "audit_evidence_unavailable" && failure.field === field),
      field,
    );
  }

  const missingEnvironment = healthyReport();
  delete missingEnvironment.authorizationEnvironment;
  assert.ok(strictAuditFailures(missingEnvironment).some(
    (failure) => failure.type === "audit_evidence_unavailable" && failure.field === "authorizationEnvironment",
  ));
});

test("strict production audit rejects empty and partial dashboard family/month evidence", () => {
  const empty = healthyReport();
  empty.readModelInventory = [];
  assert.ok(failureTypes(empty).includes("audit_evidence_empty"));
  assert.ok(failureTypes(empty).includes("read_model_missing"));

  const partial = healthyReport();
  partial.readModelInventory = partial.readModelInventory.filter(
    (row) => !(row.metric_family === "quotes" && row.period_start === "2024-05-01"),
  );
  assert.ok(failureTypes(partial).includes("read_model_missing"));

  const extra = healthyReport();
  extra.readModelInventory.push({ ...extra.readModelInventory[0], metric_family: "sales" });
  assert.ok(failureTypes(extra).includes("unexpected_read_model"));
});

test("strict production audit rejects non-ready dashboard publication evidence", () => {
  const report = healthyReport();
  Object.assign(report.readModelInventory[0], { status: "suspect", source_hash: null, suspect_reason: "fixture" });
  assert.ok(failureTypes(report).includes("read_model_not_ready"));
});

test("strict production audit rejects invoice runtime and invoice or AR API dimensions", () => {
  const runtime = healthyReport();
  runtime.invoiceRuntime[0].active_ingestion_jobs = 1;
  runtime.invoiceRuntime[0].active_ingestion_runs = 1;
  runtime.invoiceRuntime[0].active_backfill_units = 1;
  assert.equal(failureTypes(runtime).filter((type) => type === "active_invoice_runtime").length, 3);

  const dimensions = healthyReport();
  dimensions.readModelInventory[0].dimensions_json = {
    customerInvoiceStatus: "sent",
    activeInvoice: true,
    accountReceivableStatus: "past_due",
    receivableAging: "30_days",
    arrivalStatus: "scheduled",
    targetArrivalWindow: "morning",
  };
  assert.equal(failureTypes(dimensions).filter((type) => type === "forbidden_invoice_ar_api_dimension").length, 4);
});

test("strict production audit rejects owner environment or app_roles beyond Asad and Laila", () => {
  const environment = healthyReport();
  environment.authorizationEnvironment.viewer_emails = ["third@prostarmechanical.com"];
  assert.ok(failureTypes(environment).includes("production_owner_environment"));

  const appRoles = healthyReport();
  appRoles.appRoles.push({ email: "third@prostarmechanical.com", role: "admin" });
  assert.ok(failureTypes(appRoles).includes("production_owner_app_roles"));

  const inaccessibleOwner = healthyReport();
  inaccessibleOwner.appRoles = inaccessibleOwner.appRoles.filter((row) => row.email !== "laila@prostarmechanical.com");
  assert.ok(failureTypes(inaccessibleOwner).includes("production_owner_app_role_access"));
});

test("strict production audit requires a latest matched reconciliation for every source-backed family/month", () => {
  const missing = healthyReport();
  missing.reconciliationMatrix.pop();
  assert.ok(failureTypes(missing).includes("latest_reconciliation_missing"));

  const mismatch = healthyReport();
  mismatch.reconciliationMatrix[0].status = "mismatch";
  assert.ok(failureTypes(mismatch).includes("latest_reconciliation_failure"));

  for (const mutation of [
    { generation: null },
    { complete_traversal: false },
    { source_manifest_generations: {} },
    { source_manifest_generations: { quotes: 2, quote_nested: 0 } },
  ]) {
    const untrusted = healthyReport();
    Object.assign(untrusted.reconciliationMatrix[0], mutation);
    assert.ok(
      failureTypes(untrusted).includes("latest_reconciliation_generation_untrusted"),
      JSON.stringify(mutation),
    );
  }

  const independentlyGenerated = healthyReport();
  const technician = independentlyGenerated.reconciliationMatrix.find((row) => row.scope === "technicians");
  technician.source_manifest_generations = {
    jobs: 12,
    job_nested: 12,
    employees: 10,
    timesheets: 10,
    jobs_from_timesheets: 10,
    schedules: 10,
    mobile_status: 10,
  };
  assert.equal(
    strictAuditFailures(independentlyGenerated).some(
      (failure) => failure.type === "latest_reconciliation_generation_untrusted",
    ),
    false,
  );
});

test("strict production audit requires migration 027 and exact zero completeness gaps", () => {
  const report = healthyReport();
  report.migrations = [];
  report.profitCapacityCompleteness[0].completed_jobs_missing = 2;
  report.profitCapacityCompleteness[0].active_completed_cost_centers_missing = null;
  report.profitCapacityCompleteness[0].people_missing = "unknown";

  const types = failureTypes(report);
  assert.ok(types.includes("migration_027_missing"));
  assert.equal(types.filter((type) => type === "migration_027_completeness_gap").length, 3);
});

test("strict production audit requires mandatory trust migrations and the checked-in migration head", () => {
  const missing = healthyReport();
  missing.migrations = missing.migrations.filter((row) => row.filename !== "031_platform_data_trust_contract.sql");
  const missingTypes = failureTypes(missing);
  assert.ok(missingTypes.includes("migration_031_missing"));

  const notLatest = healthyReport();
  notLatest.migrations.pop();
  assert.ok(failureTypes(notLatest).includes("migration_head_mismatch"));

  const missing028 = healthyReport();
  missing028.migrations = missing028.migrations.filter((row) => !row.filename.startsWith("028_"));
  assert.ok(failureTypes(missing028).includes("migration_028_missing"));
});

test("migration audit follows additive checked-in migrations without another hard-coded latest edit", () => {
  const addedMigration = "999_additive_regression_probe.sql";
  const checkedIn = [...checkedInMigrations, { filename: addedMigration, sha256: "f".repeat(64) }]
    .sort((left, right) => left.filename.localeCompare(right.filename));
  const applied = checkedIn.map(({ filename, sha256 }) => ({ filename, sha256 }));
  assert.deepEqual(migrationAuditFailures(applied, checkedIn), []);

  const withoutTrust = applied.filter((row) => row.filename !== "031_platform_data_trust_contract.sql");
  assert.ok(migrationAuditFailures(withoutTrust, checkedIn).some((failure) => failure.type === "migration_031_missing"));
});

test("migration audit rejects hash drift, missing rows, duplicate rows, and extra production rows", () => {
  for (const filename of [
    "019_seed_verified_commission_period_configs.sql",
    "025_upgrade_verified_commission_tier_config.sql",
    "036_commission_initialization_integrity.sql",
  ]) {
    const drifted = checkedInMigrations.map((entry) => ({ ...entry }));
    drifted.find((entry) => entry.filename === filename).sha256 = "0".repeat(64);
    assert.ok(migrationAuditFailures(drifted).some(
      (failure) => failure.type === "migration_hash_mismatch" && failure.filename === filename,
    ), filename);
    assert.match(checkedInMigrationHashes[filename], /^[0-9a-f]{64}$/);
  }

  const missing = checkedInMigrations.filter((entry) => entry.filename !== "019_seed_verified_commission_period_configs.sql");
  assert.ok(migrationAuditFailures(missing).some(
    (failure) => failure.type === "checked_in_migration_missing"
      && failure.filename === "019_seed_verified_commission_period_configs.sql",
  ));

  const duplicate = [...checkedInMigrations, checkedInMigrations[0]];
  assert.ok(migrationAuditFailures(duplicate).some((failure) => failure.type === "duplicate_applied_migration"));

  const extra = [...checkedInMigrations, { filename: "999_unchecked_production_row.sql", sha256: "a".repeat(64) }];
  assert.ok(migrationAuditFailures(extra).some(
    (failure) => failure.type === "unexpected_applied_migration" && failure.filename === "999_unchecked_production_row.sql",
  ));
});

test("strict production audit requires all exact backfill targets terminal", () => {

  for (const status of ["queued", "running", "failed"]) {
    const report = healthyReport();
    report.exactProfitCapacityBackfill[0][status] = 1;
    report.exactProfitCapacityBackfill[0].terminal = 3;
    const types = failureTypes(report);
    assert.ok(types.includes("migration_028_target_blocker"), status);
    assert.ok(types.includes("migration_028_non_terminal_targets"), status);
  }

  const inconsistentTerminalSplit = healthyReport();
  inconsistentTerminalSplit.exactProfitCapacityBackfill[0].succeeded = 2;
  assert.ok(failureTypes(inconsistentTerminalSplit).includes("migration_028_non_terminal_targets"));
});

test("strict production audit requires every backfill source/month and authoritative manifest watermark", () => {
  const missing = healthyReport();
  missing.backfillCoverage.pop();
  assert.ok(failureTypes(missing).includes("backfill_coverage_missing"));

  for (const mutation of [
    { status: "running" },
    { reconciliation_status: "pending" },
    { manifest_status: "provisional" },
    { as_of_watermark: null },
    { manifest_completed_at: null },
    { violations: ["gap"] },
    { source_manifest_generation: null },
    { source_reconciliation_generation: "6" },
    { source_expected_page_count: 0, source_completed_page_count: 0 },
    { source_reconciled_at: null },
  ]) {
    const report = healthyReport();
    Object.assign(report.backfillCoverage[0], mutation);
    assert.ok(failureTypes(report).includes("backfill_coverage_incomplete"), JSON.stringify(mutation));
  }

  const futureRequiredSource = healthyReport();
  futureRequiredSource.backfillCoverage.push({
    ...futureRequiredSource.backfillCoverage[0],
    source_family: "invoices",
    status: "running",
  });
  assert.ok(failureTypes(futureRequiredSource).includes("backfill_coverage_incomplete"));
});

test("strict production audit accepts only the current month as a complete matched provisional manifest", () => {
  const current = healthyReport();
  for (const row of current.backfillCoverage.filter((entry) => entry.month_start === "2026-07-01")) {
    row.manifest_status = "provisional";
  }
  assert.deepEqual(strictAuditFailures(current), []);

  const historical = healthyReport();
  historical.backfillCoverage.find((entry) => entry.month_start === "2026-06-01").manifest_status = "provisional";
  assert.ok(failureTypes(historical).includes("backfill_coverage_incomplete"));
});

test("strict production audit requires complete gap-free incremental watermarks", () => {
  const missing = healthyReport();
  missing.watermarkEvidence.pop();
  assert.ok(failureTypes(missing).includes("authoritative_watermark_missing"));

  const partial = healthyReport();
  Object.assign(partial.watermarkEvidence[0], { complete_window: false, gap_detected: true });
  assert.ok(failureTypes(partial).includes("authoritative_watermark_incomplete"));
});

test("strict production audit requires a current complete commission run for every served month", () => {
  const missing = healthyReport();
  missing.commissionRunCoverage.shift();
  assert.ok(failureTypes(missing).includes("current_commission_run_missing"));

  for (const mutation of [
    { current_run_id: null },
    { calculation_stale: true },
    { run_status: "failed" },
    { source_complete: false },
    { evidence_complete: false },
    { run_config_revision: 2 },
  ]) {
    const report = healthyReport();
    Object.assign(report.commissionRunCoverage[0], mutation);
    assert.ok(failureTypes(report).includes("current_commission_run_incomplete"), JSON.stringify(mutation));
  }
});

test("strict production audit rejects failed or active relevant queues", () => {
  const report = healthyReport();
  report.ingestionFailures = [{ id: 91, entity_type: "jobs", status: "failed" }];
  report.queueBlockers = [{ id: 92, entity_type: "quotes", status: "running" }];
  report.rollupQueue = [
    { metric_family: "technicians", status: "failed", jobs: 2 },
    { metric_family: "commissions", status: "queued", jobs: 1 },
  ];
  report.backfillSources.push({ source_family: "mobile_status", status: "running", units: 1 });

  const types = failureTypes(report);
  for (const type of [
    "ingestion_queue_failure",
    "ingestion_queue_active",
    "rollup_queue_failure",
    "rollup_queue_active",
    "backfill_queue_blocker",
  ]) assert.ok(types.includes(type), type);
});

test("strict production audit rejects active out-of-scope and verification fixture rows", () => {
  const report = healthyReport();
  report.outOfScopeReadModels = [{ metric_family: "jobs", period_start: "2022-12-01" }];
  report.outOfScopeRollups = [{ id: "3", metric_family: "quotes", period_start: "2027-01-01" }];
  report.verificationFixtures = [{ id: "4", entity_type: "jobs" }];

  const types = failureTypes(report);
  assert.ok(types.includes("active_out_of_scope_read_model"));
  assert.ok(types.includes("active_out_of_scope_rollup"));
  assert.ok(types.includes("active_verification_fixture"));
});

test("strict production audit requires the semantic validator and every named contract check", () => {
  const report = healthyReport();
  report.semanticValidation = { status: "mismatch", mismatchCount: 1 };
  assert.ok(failureTypes(report).includes("semantic_validation_failure"));
  assert.ok(failureTypes(report).includes("semantic_contract_check_failure"));

  delete report.semanticValidation;
  assert.ok(failureTypes(report).includes("semantic_validation_failure"));

  for (const check of [
    "technicianUtilization",
    "costCenterCategories",
    "invoiceRuntime",
    "apiDimensions",
    "productionOwners",
    "quoteConversionEvidence",
  ]) {
    const corrupted = healthyReport();
    corrupted.semanticValidation.contractChecks[check] = { status: "mismatch", mismatchCount: 1 };
    assert.ok(strictAuditFailures(corrupted).some(
      (failure) => failure.type === "semantic_contract_check_failure" && failure.check === check,
    ), check);
  }
});

test("summary output keeps the established top-level shape", () => {
  const summary = summarize(healthyReport());
  assert.equal(summary.capturedAt, "2026-07-12T00:00:00.000Z");
  assert.deepEqual(summary.lastMigration, { filename: checkedInMigrationFiles.at(-1) });
  assert.equal(summary.outOfScopeReadModels, 0);
  assert.equal(summary.outOfScopeRollups, 0);
  assert.equal(summary.verificationFixtures, 0);
  assert.equal(Object.hasOwn(summary, "strictFailures"), false);
  assert.equal(Object.hasOwn(summary, "semanticValidation"), false);
});
