import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { isServedRollupPeriod } from "../../src/lib/store/read-model-rebuilds";

const migration = readFileSync(
  path.join(process.cwd(), "infra/db/migrations/011_enforce_serving_window.sql"),
  "utf8",
);

test("rollup serving window accepts only canonical 2023-current months", () => {
  const now = new Date("2026-07-09T12:00:00.000Z");
  assert.equal(isServedRollupPeriod("2023-01-01", now), true);
  assert.equal(isServedRollupPeriod("2026-07-01", now), true);
  assert.equal(isServedRollupPeriod("2022-12-01", now), false);
  assert.equal(isServedRollupPeriod("2026-08-01", now), false);
  assert.equal(isServedRollupPeriod("2026-07-02", now), false);
  assert.equal(isServedRollupPeriod("not-a-date", now), false);
});

test("database migration re-quarantines artifacts and rejects future violations", () => {
  assert.match(migration, /out_of_scope_read_model_resuperseded/);
  assert.match(migration, /out_of_scope_rollup_recancelled/);
  assert.match(migration, /create or replace function metrics\.enforce_dashboard_serving_period/);
  assert.match(migration, /enforce_rollup_serving_period/);
  assert.match(migration, /enforce_read_model_serving_period/);
  assert.match(migration, /enforce_commission_serving_period/);
  assert.doesNotMatch(migration, /\bdelete\s+from\b/i);
  assert.doesNotMatch(migration, /\btruncate\b/i);
});
