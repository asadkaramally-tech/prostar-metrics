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
