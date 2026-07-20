import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { preferredCandidateFamily } from "../../src/lib/store/ingestion-claim-strategy";

test("generic candidate claims rotate across every detail family", () => {
  assert.deepEqual(
    Array.from({ length: 8 }, (_, index) => preferredCandidateFamily(index)),
    [
      "quote_nested", "job_nested", "schedules", "quote_nested",
      "job_nested", "schedules", "quote_nested", "job_nested",
    ],
  );
  assert.equal(Array.from({ length: 24 }, (_, index) => preferredCandidateFamily(index)).includes("invoices" as never), false);
});

test("ingestion worker falls back to the global queue only for generic drains", () => {
  const worker = readFileSync(path.join(process.cwd(), "workers/ingest-simpro.ts"), "utf8");
  assert.match(worker, /args\.entity \?\? preferredCandidateFamily\(index\)/);
  assert.match(worker, /preferredJob \?\? \(args\.entity/);
  assert.match(worker, /claimNextIngestionJob\(workerId, undefined, args\.idempotencySuffix\)/);
});

test("ingestion worker reuses one Simpro client and batches aggregate freshness evaluation", () => {
  const worker = readFileSync(path.join(process.cwd(), "workers/ingest-simpro.ts"), "utf8");
  assert.equal(worker.match(/new SimproEndpoints\(new SimproClient\(\)\)/g)?.length, 1);
  assert.doesNotMatch(worker, /refreshFreshnessPages\(job\.entity_type\)/);
  assert.doesNotMatch(worker, /markFreshnessBuilding\(job\.entity_type/);
  assert.match(worker, /successfulFreshness\.set\(job\.entity_type/);
  assert.match(worker, /for \(const entity of touchedEntities\) \{[\s\S]*?await refreshFreshnessPages\(entity\);\s+\}/);
});
