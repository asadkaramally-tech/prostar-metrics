import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const source = readFileSync(path.join(process.cwd(), "src/lib/store/job-dashboard-read-model.ts"), "utf8");

test("job read model selects and maps every migration-026 persisted field", () => {
  const jobColumns = [
    "net_profit_actual", "net_margin_actual",
    "materials_cost_actual", "materials_cost_estimate",
    "labor_cost_actual", "labor_cost_estimate",
    "labor_hours_actual", "labor_hours_estimate",
    "overhead_cost_actual", "overhead_cost_estimate",
    "total_resource_cost_actual", "total_resource_cost_estimate",
    "commission_cost_actual", "job_source_type", "job_source_id",
    "customer_name", "site_name",
  ];
  for (const column of jobColumns) {
    assert.ok(source.includes(`j.${column}`), `${column} must come from metrics_jobs`);
  }
  assert.match(source, /c\.configured_cost_center_name/);
  assert.match(source, /configuredCostCenterName: row\.configured_cost_center_name/);
});

test("job SQL enforces CompletedDate plus Complete or Archived stage and never Status", () => {
  assert.match(source, /j\.completed_date between \$1::date and \$2::date/);
  assert.match(source, /lower\(trim\(j\.stage\)\) in \('complete', 'archived'\)/);
  assert.doesNotMatch(source, /where[\s\S]{0,300}status_name/i);
});

test("missing migration-026 columns are tolerated only by the Node test runtime", () => {
  assert.match(source, /process\.env\.NODE_ENV === "test"/);
  assert.match(source, /code === "42703"/);
  assert.match(source, /if \(allowsMissingMigration026InTests\(error\)\) return \[\]/);
  assert.match(source, /if \(!isTestRuntime\) return false/);
});

test("job labor inputs preserve authoritative nested rows and all job timesheets", () => {
  assert.match(source, /labor\.quantity_hours::text, labor\.source_deleted_at::text/);
  assert.doesNotMatch(source, /labor\.source_deleted_at is null/);
  assert.match(source, /quoteLabor: quoteLabor\.get\(row\.job_id\) \?\? \[\]/);
  assert.doesNotMatch(source, /quotedHoursByJob/);

  assert.match(source, /lower\(trim\(coalesce\(t\.reference_type, ''\)\)\) = 'job'/);
  assert.match(source, /t\.work_date::text, t\.total_hours::text, t\.source_deleted_at::text/);
  assert.doesNotMatch(source, /t\.work_date between/);
  assert.match(source, /timesheets: timesheets\.get\(row\.job_id\) \?\? \[\]/);
});

test("persisted job dashboards must carry authoritative labor coverage and trend fields", () => {
  assert.match(source, /labor\?\.nestedQuoteLaborCoveredJobs !== undefined/);
  assert.match(source, /row\.laborVarianceHours !== undefined/);
});

test("persisted job dashboards must carry loss classification, quote-linked labor, follow-ups, and trend provenance", () => {
  assert.match(source, /lossBreakdown\?\.diagnosticFee !== undefined/);
  assert.match(source, /quoteLinkedLabor\?\.coveredJobs !== undefined/);
  assert.match(source, /directServiceFollowUps\?\.quoteEvidenceLoaded === true/,
    "persisted dashboards built without issued-quote evidence must be rejected, not served with zero follow-ups");
  assert.match(source, /directServiceFollowUps\.linkRule === FOLLOW_UP_LINK_RULE/,
    "persisted dashboards built with the old 189-era follow-up cohort must be rejected");
  assert.match(source, /directServiceFollowUps\.sameDayRule === FOLLOW_UP_SAME_DAY_RULE/,
    "persisted dashboards must carry the corrected same-day conversion rule");
  assert.match(source, /row\.avgJobValue !== undefined/);
  assert.match(source, /row\.provenance !== undefined/);
});

test("job read model loads site identity and DateIssued follow-up quotes from app-owned tables", () => {
  assert.match(source, /j\.site_id::text/);
  assert.match(source, /siteId: row\.site_id/);
  assert.match(source, /from metrics\.metrics_quotes q/);
  assert.match(source, /q\.date_issued is not null/);
  assert.match(source, /q\.site_id::text/);
  assert.match(source, /q\.source_deleted_at is null/);
  assert.match(source, /getIssuedQuoteInputs\(\)/);
  assert.match(source, /issuedQuotes,/);
});

test("persisted job dashboard serving does not block on a live reconciliation overlay", () => {
  const persistedBranch = source.match(
    /if \(!filters\.category && !filters\.costCenter && !filters\.technician\)[\s\S]*?catch \{/,
  )?.[0] ?? "";

  assert.match(persistedBranch, /getPersistedJobDashboard\(selectedMonth, params\.page\)/);
  assert.doesNotMatch(persistedBranch, /getJobReconciliations/);
});

test("persisted job dashboard slices drilldown records in PostgreSQL before returning", () => {
  assert.match(source, /jsonb_array_length\(dashboard #> '\{selected,records\}'\)/);
  assert.match(source, /jsonb_array_elements\(coalesce\(dashboard #> '\{selected,records\}', '\[\]'::jsonb\)\)/);
  assert.match(source, /jsonb_set\(\s*dashboard,\s*'\{selected,records\}'/);
  assert.match(source, /totalRecords: numericCount/);
});
