import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const migration = readFileSync(
  path.join(process.cwd(), "infra/db/migrations/010_quarantine_production_verification_artifacts.sql"),
  "utf8",
);

test("artifact quarantine is bounded, audited, and preserves records", () => {
  assert.match(migration, /insert into metrics\.audit_events/);
  assert.match(migration, /period_start < date '2023-01-01'/);
  assert.match(migration, /period_start > date_trunc\('month', current_date\)::date/);
  assert.match(migration, /idempotency_key like '%wp02-%'/);
  assert.match(migration, /status = 'cancelled'::metrics\.rollup_rebuild_status/);
  assert.match(migration, /superseded_at = now\(\)/);
  assert.doesNotMatch(migration, /\bdelete\s+from\b/i);
  assert.doesNotMatch(migration, /\btruncate\b/i);
});
