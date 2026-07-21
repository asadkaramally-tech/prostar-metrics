import pg from "pg";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { forbiddenInvoiceArDimensionPaths } from "./lib/api-dimension-policy.mjs";
import { verifiedPostgresClientConfig } from "./postgres-tls.mjs";

const { Client } = pg;
const DASHBOARD_FAMILIES = ["quotes", "jobs", "technicians", "commissions", "materials"];
const SOURCE_RECONCILIATION_FAMILIES = ["quotes", "jobs", "technicians"];
const REQUIRED_BACKFILL_FAMILIES = [
  "quotes",
  "jobs",
  "employees",
  "quote_nested",
  "job_nested",
  "timesheets",
  "jobs_from_timesheets",
  "schedules",
];
const REQUIRED_INCREMENTAL_WATERMARKS = ["quote_logs", "job_logs", "schedule_logs"];
const REQUIRED_SEMANTIC_CONTRACT_CHECKS = [
  "technicianUtilization",
  "costCenterCategories",
  "invoiceRuntime",
  "apiDimensions",
  "productionOwners",
  "quoteConversionEvidence",
  "materials",
];
const PRODUCTION_OWNER_EMAILS = [
  "asad@prostarmechanical.com",
  "laila@prostarmechanical.com",
];
const PRODUCTION_ACCESS_ROLES = new Set(["admin", "finance"]);
const SERVING_START_MONTH = "2023-01-01";
const migrationDirectory = resolve(import.meta.dirname, "../infra/db/migrations");
export const checkedInMigrations = Object.freeze(
  readdirSync(migrationDirectory)
    .filter((filename) => /^\d{3}_.+\.sql$/.test(filename))
    .sort()
    .map((filename) => Object.freeze({
      filename,
      sha256: createHash("sha256").update(readFileSync(resolve(migrationDirectory, filename))).digest("hex"),
    })),
);
export const checkedInMigrationFiles = Object.freeze(checkedInMigrations.map(({ filename }) => filename));
export const checkedInMigrationHashes = Object.freeze(Object.fromEntries(
  checkedInMigrations.map(({ filename, sha256 }) => [filename, sha256]),
));
const mandatoryTrustMigrations = new Map([
  ["027_profit_capacity_completeness_gate.sql", "migration_027_missing"],
  ["028_exact_profit_capacity_backfill_ledger.sql", "migration_028_missing"],
  ["029_nested_traversal_generation.sql", "migration_029_missing"],
  ["031_platform_data_trust_contract.sql", "migration_031_missing"],
]);

const queries = {
  migrations: `select filename, sha256, applied_at::text from metrics.schema_migrations order by filename`,
  backfillStatus: `
    select status::text, count(*)::int as units,
           coalesce(sum(actual_requests), 0)::int as requests_used
      from metrics.backfill_source_month_ledger
     group by status order by status`,
  backfillSources: `
    select source_family, status::text, count(*)::int as units,
           min(month_start)::text as first_month, max(month_start)::text as last_month
      from metrics.backfill_source_month_ledger
     group by source_family, status order by source_family, status`,
  ingestionQueue: `
    select entity_type::text, status::text, count(*)::int as jobs,
           max(updated_at)::text as latest_update
      from metrics.ingestion_jobs
     group by entity_type, status order by entity_type, status`,
  ingestionFailures: `
    select id, entity_type::text, idempotency_key, attempts, status::text,
           dead_lettered_at::text,
           left(last_error, 300) as last_error, updated_at::text
      from metrics.ingestion_jobs
     where status = 'failed'
        or dead_lettered_at is not null
        or (status in ('queued', 'running') and last_error is not null)
     order by updated_at desc, id desc limit 100`,
  invoiceRuntime: `
    select
      (select count(*)::int from metrics.ingestion_jobs
        where entity_type::text in ('invoices', 'customer_invoice_logs')
          and status::text in ('queued', 'running', 'failed')) active_ingestion_jobs,
      (select count(*)::int from metrics.ingestion_runs
        where entity_type::text in ('invoices', 'customer_invoice_logs')
          and status::text in ('running', 'failed')) active_ingestion_runs,
      (select count(*)::int from metrics.backfill_source_month_ledger
        where source_family = 'invoices'
          and (required_for_completion or status::text in (
            'planned', 'queued', 'running', 'reconciliation_pending', 'dead_lettered'
          ))) active_backfill_units`,
  appRoles: `
    select lower(trim(email)) email, role::text
      from metrics.app_roles
     where active = true
     order by lower(trim(email)), role`,
  queueBlockers: `
    select id, entity_type::text, status::text, priority, idempotency_key,
           attempts, created_at::text, next_attempt_at::text,
           round(extract(epoch from (now() - created_at)) / 60)::int as age_minutes,
           left(last_error, 200) as last_error
      from metrics.ingestion_jobs
     where status in ('queued', 'running')
     order by priority, id
     limit 150`,
  rollupQueue: `
    select metric_family, status::text, count(*)::int as jobs,
           min(period_start)::text as first_period, max(period_start)::text as last_period
      from metrics.rollup_rebuild_queue
     group by metric_family, status order by metric_family, status`,
  readModels: `
    select metric_family, count(*)::int as models,
           min(period_start)::text as first_period, max(period_start)::text as last_period,
           count(*) filter (where status <> 'ready' or suspect_reason is not null)::int as non_ready
      from metrics.dashboard_read_models
     where superseded_at is null
     group by metric_family order by metric_family`,
  readModelInventory: `
    select metric_family, period_grain, period_start::text, dimensions_json,
           status::text, source_hash, suspect_reason
      from metrics.dashboard_read_models
     where superseded_at is null
       and period_start >= date '2023-01-01'
       and period_start <= date_trunc('month', current_timestamp at time zone 'America/Los_Angeles')::date
     order by metric_family, period_start, dimensions_json`,
  reconciliationLatest: `
    select scope, status::text, count(*)::int as periods,
           min(period_start)::text as first_period, max(period_start)::text as last_period,
           max(checked_at)::text as latest_check
     from metrics.authoritative_reconciliation_results
     group by scope, status order by scope, status`,
  reconciliationMatrix: `
    select scope, period_start::text, status::text, checked_at::text,
           generation::text, complete_traversal, source_manifest_generations
      from metrics.authoritative_reconciliation_checks
     where scope in ('quotes', 'jobs', 'technicians', 'commissions')
       and period_start >= date '2023-01-01'
       and period_start <= date_trunc('month', current_timestamp at time zone 'America/Los_Angeles')::date
     order by scope, period_start`,
  watermarks: `
    select entity, status::text, count(*)::int as windows,
           max(last_success_at)::text as latest_success,
           max(updated_at) filter (where status = 'failed')::text as latest_failure
      from metrics.ingestion_watermarks
     group by entity, status order by entity, status`,
  watermarkEvidence: `
    select distinct on (coalesce(source_family, entity))
           coalesce(source_family, entity) as source_family, window_key, status::text,
           last_success_at::text, expected_through::text,
           complete_window, gap_detected, page_cursor
      from metrics.ingestion_watermarks
     where coalesce(source_family, entity) in ('quote_logs', 'job_logs', 'schedule_logs')
       and window_key = 'incremental'
     order by coalesce(source_family, entity), updated_at desc`,
  backfillCoverage: `
    select l.source_family, l.month_start::text, l.required_for_completion,
           l.status::text, l.reconciliation_status::text, l.continuation_token,
           m.manifest_status::text, m.as_of_watermark::text,
           m.completed_at::text as manifest_completed_at,
           m.continuation_token as manifest_continuation_token,
           m.violations,
           source.coverage_status::text as source_coverage_status,
           source.reconciliation_status::text as source_reconciliation_status,
           source.continuation_token as source_continuation_token,
           source.manifest_generation::text as source_manifest_generation,
           source.reconciliation_generation::text as source_reconciliation_generation,
           source.expected_page_count as source_expected_page_count,
           source.completed_page_count as source_completed_page_count,
           source.reconciled_at::text as source_reconciled_at
      from metrics.backfill_source_month_ledger l
      left join metrics.backfill_traversal_manifests m on m.work_unit_id = l.id
      left join metrics.source_period_manifests source
        on source.source_family = l.source_family
       and source.period_start = l.month_start
       and source.period_end = (l.month_end_exclusive - 1)
     where l.required_for_completion
       and l.month_start >= date '2023-01-01'
       and l.month_start <= date_trunc('month', current_timestamp at time zone 'America/Los_Angeles')::date
     order by l.source_family, l.month_start`,
  profitCapacityCompleteness: `
    select completed_jobs_total::int, completed_jobs_missing::int,
           active_completed_cost_centers_total::int,
           active_completed_cost_centers_missing::int,
           people_total::int, people_missing::int
      from metrics.simpro_profit_capacity_completeness`,
  exactProfitCapacityBackfill: `
    select count(*)::int as targets,
           count(*) filter (where status in ('succeeded', 'source_deleted'))::int as terminal,
           count(*) filter (where status = 'succeeded')::int as succeeded,
           count(*) filter (where status = 'source_deleted')::int as source_deleted,
           count(*) filter (where status = 'queued')::int as queued,
           count(*) filter (where status = 'running')::int as running,
           count(*) filter (where status = 'failed')::int as failed
      from metrics.profit_capacity_exact_backfill_targets
     where contract = 'simpro-profit-capacity-028-exact'`,
  commissions: `
    select
      (select count(*) from metrics.commission_periods)::int as periods,
      (select count(*) from metrics.commission_calculation_runs)::int as runs,
      (select count(*) from metrics.commission_exports)::int as exports,
      (select max(period_start)::text from metrics.commission_periods) as latest_period,
      (select max(created_at)::text from metrics.commission_calculation_runs) as latest_run`,
  commissionRoster: `
    select employee_id::text, display_name, included, effective_start::text,
           effective_end::text, notes
      from metrics.commission_roster
     order by effective_start, employee_id`,
  currentCommissionRun: `
    select p.period_start::text, p.period_end::text, p.status::text,
           p.revision, p.edit_revision, p.config_revision, p.current_run_id::text,
           p.calculation_stale, r.revision as run_revision,
           r.completed_jobs, r.total_work_value::text, r.pool_amount::text,
           r.payroll_total::text, r.created_at::text,
           jsonb_array_length(coalesce(r.employee_results, '[]'::jsonb)) as employee_results,
           jsonb_array_length(coalesce(r.diagnostics_json, '[]'::jsonb)) as diagnostic_count,
           coalesce((
             select jsonb_agg(distinct diagnostic ->> 'code')
               from jsonb_array_elements(coalesce(r.diagnostics_json, '[]'::jsonb)) diagnostic
           ), '[]'::jsonb) as diagnostic_codes
      from metrics.commission_periods p
      left join metrics.commission_calculation_runs r on r.id = p.current_run_id
     order by p.period_start desc, p.revision desc
     limit 3`,
  commissionRunCoverage: `
    with current_periods as (
      select distinct on (period_start) *
        from metrics.commission_periods
       where period_start >= date '2023-01-01'
         and period_start <= date_trunc('month', current_timestamp at time zone 'America/Los_Angeles')::date
       order by period_start, revision desc, id desc
    )
    select p.period_start::text, p.current_run_id::text, p.calculation_stale,
           p.config_revision, r.revision as run_revision, r.config_revision as run_config_revision,
           r.run_status::text, r.source_complete,
           metrics.commission_source_evidence_complete(r.source_evidence) as evidence_complete
      from current_periods p
      left join metrics.commission_calculation_runs r on r.id = p.current_run_id
     order by p.period_start`,
  outOfScopeReadModels: `
    select metric_family, period_start::text, status::text, rebuilt_at::text,
           superseded_at::text, suspect_reason
      from metrics.dashboard_read_models
     where superseded_at is null
       and (
         period_start < date '2023-01-01'
         or period_start > date_trunc('month', current_timestamp at time zone 'America/Los_Angeles')::date
       )
     order by period_start, metric_family`,
  outOfScopeRollups: `
    select id::text, metric_family, period_start::text, status::text,
           attempts, reason, error_message
      from metrics.rollup_rebuild_queue
     where status in ('queued', 'running', 'failed')
       and (
         period_start < date '2023-01-01'
         or period_start > date_trunc('month', current_timestamp at time zone 'America/Los_Angeles')::date
       )
     order by period_start, id`,
  verificationFixtures: `
    select id::text, entity_type::text, idempotency_key, status::text,
           attempts, last_error
      from metrics.ingestion_jobs
     where status in ('queued', 'running', 'failed')
       and idempotency_key like '%wp02-%'
     order by id`,
  commissionPeriodInventory: `
    select id::text, period_start::text, period_end::text, status::text,
           revision, edit_revision, current_run_id::text,
           calculation_stale, created_by, created_at::text
      from metrics.commission_periods
     order by period_start, revision`,
};

async function main() {
  const connectionString = process.env.AZURE_POSTGRES_CONNECTION_STRING;
  if (!connectionString) throw new Error("AZURE_POSTGRES_CONNECTION_STRING is required");
  const client = new Client({
    ...await verifiedPostgresClientConfig(connectionString),
    connectionTimeoutMillis: 15_000,
    query_timeout: 30_000,
  });

  await client.connect();
  try {
    const output = {};
    for (const [name, sql] of Object.entries(queries)) {
      output[name] = (await client.query(sql)).rows;
    }
    const report = {
      capturedAt: new Date().toISOString(),
      authorizationEnvironment: auditAuthorizationEnvironment(process.env),
      ...output,
    };
    if (process.argv.includes("--strict")) report.semanticValidation = runSemanticValidation();
    console.log(JSON.stringify(process.argv.includes("--summary") ? summarize(report) : report, null, 2));
    if (process.argv.includes("--strict") && strictAuditFailures(report).length > 0) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

export function summarize(report) {
  const lastMigration = report.migrations.at(-1) ?? null;
  return {
    capturedAt: report.capturedAt,
    lastMigration: lastMigration && {
      filename: lastMigration.filename,
      ...(lastMigration.applied_at === undefined ? {} : { applied_at: lastMigration.applied_at }),
    },
    backfill: report.backfillStatus,
    ingestion: report.ingestionQueue.filter((row) => row.status !== "succeeded" || row.entity_type.endsWith("_nested")),
    ingestionFailures: report.ingestionFailures,
    invoiceRuntime: report.invoiceRuntime,
    rollups: report.rollupQueue,
    readModels: report.readModels,
    reconciliation: report.reconciliationLatest,
    watermarks: report.watermarks,
    profitCapacityCompleteness: report.profitCapacityCompleteness,
    commissions: report.commissions,
    currentCommissionRun: report.currentCommissionRun,
    outOfScopeReadModels: report.outOfScopeReadModels.length,
    outOfScopeRollups: report.outOfScopeRollups.length,
    verificationFixtures: report.verificationFixtures.length,
  };
}

export function strictAuditFailures(report) {
  const failures = [];
  const months = servedMonths(report.capturedAt);
  const migrations = evidenceRows(report, "migrations", failures, true);
  failures.push(...migrationAuditFailures(migrations));

  const completeness = evidenceRows(report, "profitCapacityCompleteness", failures, true)[0] ?? null;
  if (!completeness) failures.push({ type: "migration_027_completeness_unavailable" });
  for (const field of ["completed_jobs_missing", "active_completed_cost_centers_missing", "people_missing"]) {
    const count = strictNumber(completeness?.[field]);
    if (count !== 0) failures.push({ type: "migration_027_completeness_gap", field, count });
  }

  const invoiceRuntime = evidenceRows(report, "invoiceRuntime", failures, true)[0] ?? null;
  for (const field of ["active_ingestion_jobs", "active_ingestion_runs", "active_backfill_units"]) {
    const count = strictNumber(invoiceRuntime?.[field]);
    if (count !== 0) failures.push({ type: "active_invoice_runtime", field, count });
  }

  const authorizationEnvironment = report?.authorizationEnvironment;
  if (!authorizationEnvironment || typeof authorizationEnvironment !== "object" || Array.isArray(authorizationEnvironment)) {
    failures.push({ type: "audit_evidence_unavailable", field: "authorizationEnvironment" });
  } else {
    if (authorizationEnvironment.auth_mode !== "easy-auth") {
      failures.push({ type: "production_auth_mode", expected: "easy-auth", actual: authorizationEnvironment.auth_mode ?? null });
    }
    for (const field of ["admin_emails", "finance_emails"]) {
      if (!sameStringSet(authorizationEnvironment[field], PRODUCTION_OWNER_EMAILS)) {
        failures.push({ type: "production_owner_environment", field, expected: PRODUCTION_OWNER_EMAILS, actual: authorizationEnvironment[field] ?? null });
      }
    }
    for (const field of ["operator_emails", "viewer_emails"]) {
      if (!sameStringSet(authorizationEnvironment[field], [])) {
        failures.push({ type: "production_owner_environment", field, expected: [], actual: authorizationEnvironment[field] ?? null });
      }
    }
  }

  const appRoles = evidenceRows(report, "appRoles", failures, true);
  const appRoleOwners = uniqueSorted(appRoles.map((row) => normalizeEmail(row.email)).filter(Boolean));
  if (!sameStringSet(appRoleOwners, PRODUCTION_OWNER_EMAILS)) {
    failures.push({ type: "production_owner_app_roles", expected: PRODUCTION_OWNER_EMAILS, actual: appRoleOwners });
  }
  for (const owner of PRODUCTION_OWNER_EMAILS) {
    const roles = appRoles
      .filter((row) => normalizeEmail(row.email) === owner)
      .map((row) => String(row.role ?? "").trim().toLowerCase());
    if (!roles.some((role) => PRODUCTION_ACCESS_ROLES.has(role))) {
      failures.push({ type: "production_owner_app_role_access", owner, roles });
    }
  }

  const exactBackfill = evidenceRows(report, "exactProfitCapacityBackfill", failures, true)[0] ?? null;
  if (exactBackfill) {
    const targets = strictNumber(exactBackfill.targets);
    const terminal = strictNumber(exactBackfill.terminal);
    const succeeded = strictNumber(exactBackfill.succeeded);
    const sourceDeleted = strictNumber(exactBackfill.source_deleted);
    if (
      targets === null
      || terminal === null
      || succeeded === null
      || sourceDeleted === null
      || terminal !== targets
      || succeeded + sourceDeleted !== targets
    ) {
      failures.push({ type: "migration_028_non_terminal_targets", targets, terminal });
    }
    for (const status of ["queued", "running", "failed"]) {
      const count = strictNumber(exactBackfill[status]);
      if (count !== 0) failures.push({ type: "migration_028_target_blocker", status, count });
    }
  }

  for (const row of evidenceRows(report, "readModels", failures, true)) {
    const count = Number(row.non_ready ?? 0);
    if (count > 0) failures.push({ type: "non_ready_read_models", metricFamily: row.metric_family, count });
  }

  validateMatrix({
    rows: evidenceRows(report, "readModelInventory", failures, true),
    expectedGroups: DASHBOARD_FAMILIES,
    months,
    groupField: "metric_family",
    missingType: "read_model_missing",
    duplicateType: "read_model_duplicate",
    failures,
    validateRow(row) {
      if (row.period_grain !== "month" || row.status !== "ready" || !row.source_hash || row.suspect_reason !== null) {
        failures.push({ type: "read_model_not_ready", metricFamily: row.metric_family, periodStart: row.period_start });
      }
      for (const path of forbiddenInvoiceArDimensionPaths(row.dimensions_json)) {
        failures.push({
          type: "forbidden_invoice_ar_api_dimension",
          metricFamily: row.metric_family,
          periodStart: row.period_start,
          path,
        });
      }
    },
    rejectUnexpected: true,
  });

  validateMatrix({
    rows: evidenceRows(report, "reconciliationMatrix", failures, true),
    expectedGroups: SOURCE_RECONCILIATION_FAMILIES,
    months,
    groupField: "scope",
    missingType: "latest_reconciliation_missing",
    duplicateType: "latest_reconciliation_duplicate",
    failures,
    validateRow(row) {
      if (row.status !== "matched") {
        failures.push({ type: "latest_reconciliation_failure", scope: row.scope, status: row.status, count: 1, periodStart: row.period_start });
      }
      const generation = strictNumber(row.generation);
      const generationMap = row.source_manifest_generations;
      const generationValues = generationMap && typeof generationMap === "object" && !Array.isArray(generationMap)
        ? Object.values(generationMap)
        : [];
      if (
        row.complete_traversal !== true
        || generation === null
        || !Number.isInteger(generation)
        || generation <= 0
        || generationValues.length === 0
        || generationValues.some((value) => {
          const sourceGeneration = strictNumber(value);
          return sourceGeneration === null
            || !Number.isInteger(sourceGeneration)
            || sourceGeneration <= 0;
        })
      ) {
        failures.push({
          type: "latest_reconciliation_generation_untrusted",
          scope: row.scope,
          periodStart: row.period_start,
        });
      }
    },
  });

  validateMatrix({
    rows: evidenceRows(report, "backfillCoverage", failures, true),
    expectedGroups: REQUIRED_BACKFILL_FAMILIES,
    months,
    groupField: "source_family",
    missingType: "backfill_coverage_missing",
    duplicateType: "backfill_coverage_duplicate",
    failures,
    validateRow(row) {
      const currentMonth = row.month_start === months.at(-1);
      const authoritativeManifestStatus = row.manifest_status === "completed"
        || (currentMonth && row.manifest_status === "provisional");
      const authoritative = row.required_for_completion === true
        && row.status === "completed"
        && row.reconciliation_status === "matched"
        && row.continuation_token === null
        && authoritativeManifestStatus
        && Boolean(row.as_of_watermark)
        && Boolean(row.manifest_completed_at)
        && row.manifest_continuation_token === null
        && Array.isArray(row.violations)
        && row.violations.length === 0
        && row.source_coverage_status === "complete"
        && row.source_reconciliation_status === "matched"
        && row.source_continuation_token === null
        && Number.isInteger(strictNumber(row.source_manifest_generation))
        && strictNumber(row.source_manifest_generation) > 0
        && strictNumber(row.source_reconciliation_generation) === strictNumber(row.source_manifest_generation)
        && Number.isInteger(strictNumber(row.source_expected_page_count))
        && strictNumber(row.source_expected_page_count) > 0
        && strictNumber(row.source_completed_page_count) === strictNumber(row.source_expected_page_count)
        && Boolean(row.source_reconciled_at);
      if (!authoritative) {
        failures.push({ type: "backfill_coverage_incomplete", sourceFamily: row.source_family, periodStart: row.month_start });
      }
    },
    validateUnexpectedRows: true,
  });

  const watermarkRows = evidenceRows(report, "watermarkEvidence", failures, true);
  const watermarksByFamily = new Map(watermarkRows.map((row) => [row.source_family, row]));
  for (const sourceFamily of REQUIRED_INCREMENTAL_WATERMARKS) {
    const row = watermarksByFamily.get(sourceFamily);
    if (!row) {
      failures.push({ type: "authoritative_watermark_missing", sourceFamily });
    } else if (
      row.window_key !== "incremental"
      || row.status !== "succeeded"
      || row.complete_window !== true
      || row.gap_detected !== false
      || !row.last_success_at
      || !row.expected_through
      || row.page_cursor !== null
    ) {
      failures.push({ type: "authoritative_watermark_incomplete", sourceFamily });
    }
  }

  validateMatrix({
    rows: evidenceRows(report, "commissionRunCoverage", failures, true),
    expectedGroups: ["commissions"],
    months,
    groupField: () => "commissions",
    missingType: "current_commission_run_missing",
    duplicateType: "current_commission_run_duplicate",
    failures,
    validateRow(row) {
      if (
        !row.current_run_id
        || row.calculation_stale !== false
        || row.run_status !== "succeeded"
        || row.source_complete !== true
        || row.evidence_complete !== true
        || strictNumber(row.run_config_revision) !== strictNumber(row.config_revision)
      ) {
        failures.push({ type: "current_commission_run_incomplete", periodStart: row.period_start });
      }
    },
  });

  for (const row of evidenceRows(report, "ingestionFailures", failures)) {
    failures.push({ type: "ingestion_queue_failure", id: row.id, entityType: row.entity_type, status: row.status });
  }
  for (const row of evidenceRows(report, "queueBlockers", failures)) {
    failures.push({ type: "ingestion_queue_active", id: row.id, entityType: row.entity_type, status: row.status });
  }
  for (const row of evidenceRows(report, "rollupQueue", failures)) {
    if (row.status === "failed" && Number(row.jobs ?? 0) > 0) {
      failures.push({ type: "rollup_queue_failure", metricFamily: row.metric_family, count: Number(row.jobs) });
    }
    if (["queued", "running"].includes(row.status) && Number(row.jobs ?? 0) > 0) {
      failures.push({ type: "rollup_queue_active", metricFamily: row.metric_family, status: row.status, count: Number(row.jobs) });
    }
  }
  for (const row of evidenceRows(report, "backfillSources", failures)) {
    if (["planned", "queued", "running", "reconciliation_pending", "dead_lettered"].includes(row.status) && Number(row.units ?? 0) > 0) {
      failures.push({ type: "backfill_queue_blocker", sourceFamily: row.source_family, status: row.status, count: Number(row.units) });
    }
  }

  for (const row of evidenceRows(report, "reconciliationLatest", failures, true)) {
    if (row.status !== "matched" && Number(row.periods ?? 0) > 0) {
      failures.push({ type: "latest_reconciliation_failure", scope: row.scope, status: row.status, count: Number(row.periods) });
    }
  }

  for (const row of evidenceRows(report, "outOfScopeReadModels", failures)) {
    failures.push({ type: "active_out_of_scope_read_model", metricFamily: row.metric_family, periodStart: row.period_start });
  }
  for (const row of evidenceRows(report, "outOfScopeRollups", failures)) {
    failures.push({ type: "active_out_of_scope_rollup", id: row.id, metricFamily: row.metric_family, periodStart: row.period_start });
  }
  for (const row of evidenceRows(report, "verificationFixtures", failures)) {
    failures.push({ type: "active_verification_fixture", id: row.id, entityType: row.entity_type });
  }

  const semantic = report?.semanticValidation;
  if (!semantic || semantic.status !== "matched" || strictNumber(semantic.mismatchCount) !== 0) {
    failures.push({ type: "semantic_validation_failure", status: semantic?.status ?? "unavailable", mismatchCount: strictNumber(semantic?.mismatchCount) });
  }
  for (const check of REQUIRED_SEMANTIC_CONTRACT_CHECKS) {
    const result = semantic?.contractChecks?.[check];
    if (!result || result.status !== "matched" || strictNumber(result.mismatchCount) !== 0) {
      failures.push({
        type: "semantic_contract_check_failure",
        check,
        status: result?.status ?? "unavailable",
        mismatchCount: strictNumber(result?.mismatchCount),
      });
    }
  }
  return failures;
}

export function migrationAuditFailures(migrations, checkedIn = checkedInMigrations) {
  const failures = [];
  const expected = checkedIn.map((entry) => typeof entry === "string"
    ? { filename: entry, sha256: checkedInMigrationHashes[entry] ?? null }
    : entry);
  const expectedByFilename = new Map(expected.map((entry) => [entry.filename, entry.sha256]));
  const rowsByFilename = new Map();
  for (const row of migrations) {
    const filename = typeof row?.filename === "string" ? row.filename : null;
    if (!filename) {
      failures.push({ type: "invalid_applied_migration_row", row });
      continue;
    }
    rowsByFilename.set(filename, [...(rowsByFilename.get(filename) ?? []), row]);
    if (!expectedByFilename.has(filename)) {
      failures.push({ type: "unexpected_applied_migration", filename });
    }
  }

  for (const [filename, type] of mandatoryTrustMigrations) {
    if (!rowsByFilename.has(filename)) failures.push({ type, filename });
  }
  for (const { filename, sha256 } of expected) {
    const rows = rowsByFilename.get(filename) ?? [];
    if (rows.length === 0) {
      if (!mandatoryTrustMigrations.has(filename)) {
        failures.push({ type: "checked_in_migration_missing", filename });
      }
      continue;
    }
    if (rows.length > 1) {
      failures.push({ type: "duplicate_applied_migration", filename, count: rows.length });
    }
    if (!sha256 || rows.some((row) => row.sha256 !== sha256)) {
      failures.push({
        type: "migration_hash_mismatch",
        filename,
        expectedSha256: sha256,
        actualSha256: rows.map((row) => row.sha256 ?? null),
      });
    }
  }
  const expectedLatest = expected.at(-1)?.filename ?? null;
  const appliedLatest = migrations
    .map((row) => row?.filename)
    .filter((filename) => typeof filename === "string")
    .sort()
    .at(-1) ?? null;
  if (appliedLatest !== expectedLatest) {
    failures.push({ type: "migration_head_mismatch", expectedLatest, appliedLatest });
  }
  return failures;
}

function evidenceRows(report, field, failures, requireNonEmpty = false) {
  if (!Array.isArray(report?.[field])) {
    failures.push({ type: "audit_evidence_unavailable", field });
    return [];
  }
  if (requireNonEmpty && report[field].length === 0) {
    failures.push({ type: "audit_evidence_empty", field });
  }
  return report[field];
}

function validateMatrix({
  rows,
  expectedGroups,
  months,
  groupField,
  missingType,
  duplicateType,
  failures,
  validateRow,
  rejectUnexpected = false,
  validateUnexpectedRows = false,
}) {
  const expectedGroupSet = new Set(expectedGroups);
  const expectedMonthSet = new Set(months);
  const keyed = new Map();
  for (const row of rows) {
    const group = typeof groupField === "function" ? groupField(row) : row[groupField];
    const month = row.period_start ?? row.month_start;
    if (!expectedGroupSet.has(group) || !expectedMonthSet.has(month)) {
      if (rejectUnexpected) failures.push({ type: "unexpected_read_model", metricFamily: group, periodStart: month });
      if (validateUnexpectedRows && expectedMonthSet.has(month)) validateRow(row);
      continue;
    }
    const key = `${group}:${month}`;
    keyed.set(key, [...(keyed.get(key) ?? []), row]);
  }
  for (const group of expectedGroups) {
    for (const month of months) {
      const matches = keyed.get(`${group}:${month}`) ?? [];
      if (matches.length === 0) failures.push({ type: missingType, group, periodStart: month });
      if (matches.length > 1) failures.push({ type: duplicateType, group, periodStart: month, count: matches.length });
      for (const row of matches) validateRow(row);
    }
  }
}

export function auditAuthorizationEnvironment(env) {
  return {
    auth_mode: env.METRICS_AUTH_MODE ?? null,
    admin_emails: csvEmails(env.METRICS_ADMIN_EMAILS),
    finance_emails: csvEmails(env.METRICS_FINANCE_EMAILS),
    operator_emails: csvEmails(env.METRICS_OPERATOR_EMAILS),
    viewer_emails: csvEmails(env.METRICS_VIEWER_EMAILS),
  };
}

function csvEmails(value) {
  return uniqueSorted(String(value ?? "").split(",").map(normalizeEmail).filter(Boolean));
}

function normalizeEmail(value) {
  return String(value ?? "").trim().toLowerCase();
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function sameStringSet(actual, expected) {
  return Array.isArray(actual)
    && JSON.stringify(uniqueSorted(actual.map(String))) === JSON.stringify(uniqueSorted(expected.map(String)));
}

function strictNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function servedMonths(capturedAt) {
  const captured = new Date(capturedAt);
  if (Number.isNaN(captured.getTime())) return [];
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(captured);
  const through = `${parts.find((part) => part.type === "year")?.value}-${parts.find((part) => part.type === "month")?.value}-01`;
  const months = [];
  for (let value = SERVING_START_MONTH; value <= through;) {
    months.push(value);
    const date = new Date(`${value}T00:00:00.000Z`);
    date.setUTCMonth(date.getUTCMonth() + 1);
    value = date.toISOString().slice(0, 7) + "-01";
  }
  return months;
}

function runSemanticValidation() {
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/validate-dashboard-read-models.ts"], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = result.stdout?.trim() ?? "";
  try {
    return JSON.parse(stdout);
  } catch {
    return {
      status: "unavailable",
      mismatchCount: null,
      error: result.stderr?.trim() || stdout || `semantic validator exited ${result.status}`,
    };
  }
}

function isMainModule() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
