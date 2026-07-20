import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../src/lib/simpro/normalize.ts", import.meta.url), "utf8");

test("quote ingestion locks, upserts source evidence, applies reviewed seeds, then classifies", () => {
  const block = source.slice(source.indexOf("async function normalizeQuote"), source.indexOf("async function normalizeJob"));
  const lockIndex = block.indexOf("await acquireQuoteClassificationAdvisoryLock(query)");
  const canonicalIndex = block.indexOf("insert into metrics.metrics_quotes");
  const snapshotIndex = block.indexOf("insert into metrics.quote_snapshots");
  const seedIndex = block.indexOf("await applyReviewedQuoteExclusionSeeds([quoteId], query)");
  const reclassifyIndex = block.indexOf("await reclassifyPersistedQuote(quoteId, query)");
  assert.ok(lockIndex >= 0 && lockIndex < canonicalIndex);
  assert.ok(canonicalIndex < snapshotIndex && snapshotIndex < seedIndex && seedIndex < reclassifyIndex);
  assert.match(block, /const linkedJobId = extractQuoteLinkedJobId\(payload\)/);
  assert.match(block, /pickName\(status\)/);
  assert.doesNotMatch(block, /outcome = excluded\.outcome/);
});

test("job normalization reclassifies only quotes reached through direct or inverse evidence", () => {
  const block = source.slice(source.indexOf("async function normalizeJob"), source.indexOf("async function normalizeEmployee"));
  assert.ok(block.indexOf("await acquireQuoteClassificationAdvisoryLock(query)") < block.indexOf("insert into metrics.metrics_jobs"));
  assert.doesNotMatch(block, /previousJobNo:/);
  assert.doesNotMatch(block, /nextJobNo:/);
  assert.match(block, /previousSourceQuoteId:/);
  assert.match(block, /nextSourceQuoteId: sourceQuoteId/);
  assert.match(block, /for \(const quoteId of quoteIdsToReclassify\)/);
  assert.match(block, /await reclassifyPersistedQuote\(quoteId, query\)/);
  assert.doesNotMatch(block, /set outcome\s*=/);
  assert.doesNotMatch(block, /set won\s*=/);
  assert.match(block, /source_deleted_at = null/);
});

test("quote and job canonical totals are sourced only from explicit Total.ExTax", () => {
  assert.match(source, /projectTotalExTax\(payload, "quote", quoteId\)/);
  assert.match(source, /projectTotalExTax\(payload, "job", jobId\)/);
  assert.match(source, /Object\.prototype\.hasOwnProperty\.call\(total, "ExTax"\)/);
});
