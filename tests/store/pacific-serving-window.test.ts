import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const migration = readFileSync(
  path.join(process.cwd(), "infra/db/migrations/012_pacific_serving_window.sql"),
  "utf8",
);
const audit = readFileSync(path.join(process.cwd(), "scripts/audit-production-state.mjs"), "utf8");

test("database serving boundary uses Pacific time and canonical month starts", () => {
  assert.match(migration, /current_timestamp at time zone 'America\/Los_Angeles'/);
  assert.match(migration, /new\.period_start <> date_trunc\('month', new\.period_start\)::date/);
  assert.match(migration, /new\.period_start > pacific_current_month/);
});

test("production audit supports a compact Pacific-aligned summary", () => {
  assert.match(audit, /process\.argv\.includes\("--summary"\)/);
  assert.match(audit, /function summarize\(report\)/);
  assert.match(audit, /current_timestamp at time zone 'America\/Los_Angeles'/);
  assert.match(audit, /outOfScopeReadModels: report\.outOfScopeReadModels\.length/);
});
