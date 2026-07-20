import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = fs.readFileSync(path.join(root, "src/lib/store/ingestion-jobs.ts"), "utf8");
const maintenance = fs.readFileSync(path.join(root, "workers/queue-maintenance.ts"), "utf8");

test("successful ingestion slices clear retry and obsolete failure state", () => {
  assert.match(source, /attempts = 0,/);
  assert.match(source, /last_error = null,/);
  assert.match(source, /dead_lettered_at = null,/);
});

test("explicitly requeued terminal jobs receive a fresh bounded retry cycle", () => {
  assert.match(source, /when metrics\.ingestion_jobs\.status in \('failed', 'cancelled'\) then 0/);
  assert.match(source, /when metrics\.ingestion_jobs\.status in \('failed', 'cancelled'\) then now\(\)/);
});

test("scheduled success reopens as one new generation while candidate replays preserve success", () => {
  assert.match(source, /then metrics\.ingestion_jobs\.generation \+ 1/);
  assert.match(source, /metrics\.ingestion_jobs\.status = 'succeeded' and not \$7::boolean/);
  assert.match(source, /on conflict \(entity_type, idempotency_key\) do update set/);
  assert.match(source, /job_generation/);
});

test("legacy queue maintenance is dry-run unless execution is explicit", () => {
  assert.match(maintenance, /QUEUE_MAINTENANCE_EXECUTE !== "true"/);
  assert.match(maintenance, /arg === "--execute"/);
});
