import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const source = readFileSync(path.join(process.cwd(), "src/lib/store/technician-read-model-inputs.ts"), "utf8");
const commissionRebuildSource = readFileSync(path.join(process.cwd(), "src/lib/store/commission-rebuild.ts"), "utf8");
const joinIndexesMigration = readFileSync(
  path.join(process.cwd(), "infra/db/migrations/044_technician_rollup_join_indexes.sql"),
  "utf8",
);

test("technician inputs read migration-026 capacity and job economics fields", () => {
  for (const field of [
    "r.date_of_hire",
    "r.archived",
    "p.availability_json",
    "j.net_profit_actual",
    "j.job_source_type",
    "j.job_source_id",
    "j.labor_hours_estimate",
  ]) assert.match(source, new RegExp(field.replaceAll(".", "\\.")));
});

test("recurring labor and activity IDs are explicit in technician inputs", () => {
  assert.match(source, /job_source_type = 'Recurring'.*labor_hours_estimate/s);
  assert.match(source, /reference_type\?\.trim\(\)\.toLowerCase\(\) === "activity" \? row\.reference_id : null/);
  assert.doesNotMatch(source, /termination|terminated_at|archive_date/i);
});

test("technician population is whoever recorded work in the month, not commission eligibility", () => {
  // Owner rule (2026-07-16): the month's roster is simply the people who
  // recorded work in that month. Position never gates membership.
  assert.match(source, /from metrics\.effective_technician_roster r/);
  assert.match(source, /where roster\.has_in_period_work/);
  // In-period work is established from the employee's own dated timesheets.
  assert.match(source, /t\.work_date between \$1::date and \$2::date/);
  assert.match(source, /t\.total_hours > 0/);
  const rosterQuery = source.slice(
    source.lastIndexOf("async function getEffectiveTechnicianRosterRows"),
    source.indexOf("export function mapEffectiveTechnicianRosterRows"),
  );
  assert.ok(rosterQuery.length > 0);
  // Neither commission eligibility nor position may decide who is shown.
  assert.doesNotMatch(rosterQuery, /commission_roster/);
  assert.doesNotMatch(rosterQuery, /is_field_technician and/);
});

test("commission rebuild roster uses the same in-period technician membership, not the stale seeded commission roster", () => {
  const sourceJobsQuery = source.slice(
    source.indexOf("export async function getCommissionSourceJobs"),
    source.indexOf("export function mapCommissionSourceJobRows"),
  );
  assert.ok(sourceJobsQuery.length > 0);
  assert.match(sourceJobsQuery, /from metrics\.effective_technician_roster r/);
  assert.match(sourceJobsQuery, /metrics\.metrics_employee_timesheets t/);
  assert.doesNotMatch(sourceJobsQuery, /from metrics\.commission_roster/);

  const rosterQuery = commissionRebuildSource.slice(
    commissionRebuildSource.indexOf("async function getRoster"),
    commissionRebuildSource.indexOf("async function getEffectiveOverrides"),
  );
  assert.ok(rosterQuery.length > 0);
  assert.match(rosterQuery, /from metrics\.effective_technician_roster r/);
  assert.match(rosterQuery, /r\.person_id::text as id/);
  assert.match(rosterQuery, /metrics\.metrics_employee_timesheets t/);
  assert.match(rosterQuery, /t\.work_date between \$1::date and \$2::date/);
  assert.match(rosterQuery, /t\.total_hours > 0/);
  assert.doesNotMatch(rosterQuery, /from metrics\.commission_roster/);
});

test("allocation evidence preserves source timesheet identity and work dates", () => {
  assert.match(source, /in_period_hours/);
  assert.match(source, /'timesheetId', t\.timesheet_id/);
  assert.match(source, /'workDate', t\.work_date::text/);
});

test("technician job inputs bound timesheet and quote-labor aggregation to completed jobs", () => {
  const jobQuery = source.slice(
    source.indexOf("export async function getTechnicianJobs"),
    source.indexOf("export async function getCommissionSourceJobs"),
  );
  assert.match(jobQuery, /with completed_jobs as materialized/);
  assert.match(jobQuery, /from completed_jobs j/);
  assert.match(jobQuery, /j\.source_quote_id::text as quote_id/);
  assert.match(jobQuery, /join completed_jobs j on j\.job_id = t\.reference_id/);
  assert.match(jobQuery, /join completed_jobs j on j\.source_quote_id = labor\.quote_id/);
});

test("technician rollup join indexes match the bounded input query predicates", () => {
  assert.match(joinIndexesMigration, /metrics_employee_timesheets_job_reference_active_idx/);
  assert.match(joinIndexesMigration, /on metrics\.metrics_employee_timesheets \(reference_id, employee_id, timesheet_id\)/);
  assert.match(joinIndexesMigration, /lower\(trim\(coalesce\(reference_type, ''\)\)\) = 'job'/);
  assert.match(joinIndexesMigration, /metrics_quote_labor_active_quote_idx/);
  assert.match(joinIndexesMigration, /where source_deleted_at is null/);
});
