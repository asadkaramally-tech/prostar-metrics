import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const storeSource = readFileSync(path.join(process.cwd(), "src/lib/store/today-read-model.ts"), "utf8");
const routeSource = readFileSync(path.join(process.cwd(), "src/app/api/today/route.ts"), "utf8");
const hotPathIndexesMigration = readFileSync(
  path.join(process.cwd(), "infra/db/migrations/043_hot_path_serving_indexes.sql"),
  "utf8",
);

test("today jobs SQL enforces CompletedDate plus Complete or Archived stage and never Status", () => {
  assert.match(storeSource, /j\.completed_date between \$1::date and \$2::date/);
  assert.match(storeSource, /lower\(trim\(j\.stage\)\) in \('complete', 'archived'\)/);
  assert.match(storeSource, /j\.source_deleted_at is null/);
  assert.doesNotMatch(storeSource, /status_name\s*=/i);
});

test("today quotes-sent SQL uses DateIssued scoped to the live month window", () => {
  assert.match(storeSource, /q\.date_issued between \$1::date and \$2::date/);
  assert.match(storeSource, /q\.source_deleted_at is null/);
});

test("team hours are work-date scoped to the MTD window across the recorded-work roster", () => {
  assert.match(storeSource, /t\.work_date between \$1::date and \$2::date/);
  assert.match(storeSource, /t\.work_date between \$3::date and \$2::date/);
  assert.match(storeSource, /\[currentRange\.start, currentRange\.end, priorMonthRange\.start\]/);
  assert.match(storeSource, /timesheets\.push\(\{ workDate: row\.work_date, hours \}\)/);
  assert.match(storeSource, /t\.source_deleted_at is null/);
});

test("today roster comes from positive work in the live month, not static position membership", () => {
  const rosterQuery = storeSource.slice(
    storeSource.indexOf("async function getRosterTimesheetDetail"),
    storeSource.indexOf("function monthRange"),
  );
  assert.match(rosterQuery, /from metrics\.metrics_employee_timesheets t/);
  assert.match(rosterQuery, /t\.work_date between \$1::date and \$2::date/);
  assert.match(rosterQuery, /t\.total_hours > 0/);
  assert.match(storeSource, /source: "recorded_work_month"/);
  assert.doesNotMatch(rosterQuery, /effective_technician_roster/);
  assert.doesNotMatch(rosterQuery, /is_field_technician/);
});

test("today payload carries jobs and quotes freshness and never fabricates on load failure", () => {
  assert.match(storeSource, /getPageFreshness\("jobs"/);
  assert.match(storeSource, /getPageFreshness\("quotes"/);
  assert.match(storeSource, /loadError: detail/);
  assert.match(storeSource, /jobs: \[\]/);
});

test("today API uses the jobs-route auth pattern and surfaces load failures as 503", () => {
  assert.match(routeSource, /assertRole\(await getCurrentUser\(\), \["admin", "finance"\]\)/);
  assert.match(routeSource, /\{ error: "Forbidden" \}, \{ status: 403 \}/);
  assert.match(routeSource, /model\.loadError \? 503 : 200/);
});

test("hot path migration indexes Today work-date roster reads", () => {
  assert.match(hotPathIndexesMigration, /metrics_employee_timesheets_work_date_employee_active_idx/);
  assert.match(hotPathIndexesMigration, /on metrics\.metrics_employee_timesheets \(work_date, employee_id, timesheet_id\)/);
  assert.match(hotPathIndexesMigration, /where source_deleted_at is null/);
});
