import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../../infra/db/migrations/021_cancel_prebootstrap_nested_queue.sql", import.meta.url),
  "utf8",
);
const outOfScopeMigration = readFileSync(
  new URL("../../infra/db/migrations/022_cancel_prebootstrap_out_of_scope_nested_queue.sql", import.meta.url),
  "utf8",
);
const historicalAuthorityMigration = readFileSync(
  new URL("../../infra/db/migrations/049_cancel_historically_superseded_job_nested_refreshes.sql", import.meta.url),
  "utf8",
);

test("prebootstrap cancellation is limited to queued, older, artifact-covered nested work", () => {
  assert.match(migration, /entity_type in \('quote_nested', 'job_nested'\)/);
  assert.match(migration, /q\.status = 'queued'/);
  assert.match(migration, /q\.created_at <= timestamptz '2026-07-10T16:40:52\.693Z'/);
  assert.match(migration, /fetched_at >= timestamptz '2026-07-10T16:40:52\.693Z'/);
  assert.match(migration, /762284c132d8ec064eb2a066c2097b9e9e3801e04251037056016cd766b40103/);
  assert.match(migration, /prebootstrap_nested_queue_cancelled/);
  assert.doesNotMatch(migration, /status\s*=\s*'running'/);
});

test("out-of-scope cancellation preserves active and post-export nested work", () => {
  assert.match(outOfScopeMigration, /entity_type in \('quote_nested', 'job_nested'\)/);
  assert.match(outOfScopeMigration, /q\.status = 'queued'/);
  assert.match(outOfScopeMigration, /q\.created_at <= timestamptz '2026-07-10T16:40:52\.693Z'/);
  assert.match(outOfScopeMigration, /durable change logs remain authoritative/);
  assert.match(outOfScopeMigration, /prebootstrap_out_of_scope_nested_queue_cancelled/);
  assert.doesNotMatch(outOfScopeMigration, /status\s*=\s*'running'/);
  assert.doesNotMatch(outOfScopeMigration, /created_at\s*>/);
});

test("historical job nested repair cancels only reconciliation work proven by exact checksum-backed authority", () => {
  assert.match(historicalAuthorityMigration, /q\.entity_type = 'job_nested'/);
  assert.match(historicalAuthorityMigration, /q\.operation = 'bounded_refresh'/);
  assert.match(historicalAuthorityMigration, /q\.status = 'queued'/);
  assert.match(historicalAuthorityMigration, /q\.params->'boundedWork'->>'origin' = 'reconciliation'/);
  assert.match(historicalAuthorityMigration, /ledger\.month_start < date_trunc\('month'/);
  assert.match(historicalAuthorityMigration, /traversal\.exact_source_ids @> jsonb_build_array/);
  assert.match(historicalAuthorityMigration, /page\.synthetic = true/);
  assert.match(historicalAuthorityMigration, /page\.request_query->'_bulkArtifactEvidence'->>'provenance'/);
  assert.match(historicalAuthorityMigration, /root\.source_version like 'bulk-bootstrap:%'/);
  assert.match(historicalAuthorityMigration, /root\.complete_traversal = true/);
  assert.match(historicalAuthorityMigration, /historical_job_nested_refresh_cancelled/);
  assert.doesNotMatch(historicalAuthorityMigration, /status\s*=\s*'running'/);
});
