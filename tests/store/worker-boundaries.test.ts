import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();

test("ingestion only queues rollups and never executes commission calculations inline", () => {
  const worker = readFileSync(path.join(root, "workers/ingest-simpro.ts"), "utf8");
  const store = readFileSync(path.join(root, "src/lib/store/ingestion-jobs.ts"), "utf8");

  assert.match(store, /insert into metrics\.rollup_rebuild_queue/);
  assert.doesNotMatch(worker, /claimNextRollupRebuild/);
  assert.doesNotMatch(worker, /rebuildReadModelForJob/);
  assert.doesNotMatch(worker, /inline-rollup/);
});

test("rollup batches isolate failed periods and do not immediately reclaim the same job", () => {
  const worker = readFileSync(path.join(root, "workers/rebuild-rollups.ts"), "utf8");
  const store = readFileSync(path.join(root, "src/lib/store/read-model-rebuilds.ts"), "utf8");

  assert.match(worker, /attemptedJobIds/);
  assert.match(worker, /failures\.push/);
  assert.doesNotMatch(worker, /failRollupRebuild\(job\.id, error\);\s*throw error/);
  assert.match(store, /not \(id = any\(\$3::bigint\[\]\)\)/);
  assert.match(store, /period_start >= \$4::date/);
  assert.match(store, /period_start <= \$5::date/);
  assert.match(store, /status = 'running' and locked_until is not null and locked_until < now\(\) and attempts < 5/);
  assert.match(store, /attempts = 0/);
  assert.match(store, /lease\.locked_by = \$9/);
  assert.match(worker, /heartbeatRollupRebuild/);
  assert.match(worker, /failRollupRebuild\(job\.id, error, \{ lockedBy: job\.locked_by \}\)/);
  assert.match(worker, /args\.nightlyCommissions \? "commissions" : args\.scope/);
});

test("identical rollup payloads preserve their reconciled rebuild timestamp", () => {
  const store = readFileSync(path.join(root, "src/lib/store/read-model-rebuilds.ts"), "utf8");

  assert.match(store, /dashboard_read_models\.source_hash = excluded\.source_hash/);
  assert.match(store, /then metrics\.dashboard_read_models\.rebuilt_at/);
});

test("source completion and downstream publication share one atomic statement", () => {
  const worker = readFileSync(path.join(root, "workers/ingest-simpro.ts"), "utf8");
  const store = readFileSync(path.join(root, "src/lib/store/ingestion-jobs.ts"), "utf8");

  assert.doesNotMatch(worker, /for \(const candidate of result\.candidateRefreshes/);
  assert.doesNotMatch(worker, /for \(const affected of result\.affectedPeriods/);
  assert.match(store, /with completed_job as/);
  assert.match(store, /published_candidates as/);
  assert.match(store, /published_rollups as/);
  assert.match(store, /cross join completed_run/);
  assert.match(store, /eligible_candidates as/);
  assert.match(store, /c\.params->>'trigger'.*<> 'summary'/s);
  assert.match(store, /sourceModifiedAt/);
});

test("ingestion verifies lease and generation ownership before durable page writes", () => {
  const worker = readFileSync(path.join(root, "workers/ingest-simpro.ts"), "utf8");
  const store = readFileSync(path.join(root, "src/lib/store/ingestion-jobs.ts"), "utf8");

  // The worker must run a fenced heartbeat assertion before ingestEntityPage's
  // durable entity writes, not only after them.
  const fenceIndex = worker.indexOf("await heartbeatIngestionJob(job, workerId);");
  const writeIndex = worker.indexOf("await ingestEntityPage({");
  assert.ok(fenceIndex >= 0, "worker must assert lease ownership with a fenced heartbeat");
  assert.ok(writeIndex >= 0);
  assert.ok(fenceIndex < writeIndex, "ownership fence must precede durable page writes");

  // The heartbeat fence is only meaningful if expired-lease recovery bumps the
  // generation, so a superseded worker cannot keep proving stale ownership.
  const recovered = store.slice(store.indexOf("with recovered as"), store.indexOf("), next_job as"));
  assert.match(recovered, /generation = generation \+ 1/);
  assert.match(store, /and generation = \$3::integer/);
});

test("each claim is capped by both its job budget and the remaining worker run cap", () => {
  const worker = readFileSync(path.join(root, "workers/ingest-simpro.ts"), "utf8");

  assert.match(worker, /Math\.min\(job\.request_budget - job\.requests_used, 1000 - totalRequests\)/);
  assert.doesNotMatch(worker, /Math\.max\(1, Math\.min\(job\.request_budget/);
});
