import assert from "node:assert/strict";
import test from "node:test";
import { buildSourcePeriodManifestEvidence } from "../../src/lib/store/source-period-manifests";

const base = {
  sourceFamily: "jobs",
  periodStart: "2026-06-01",
  periodEnd: "2026-06-30",
  listedIds: [3, 1, 2],
  detailIds: [1, 2, 3],
  normalizedIds: [2, 3, 1],
  authoritativeListComplete: true,
  listRequestCount: 30,
  reconciliationStatus: "matched" as const,
  evidenceAsOf: "2026-07-01T08:00:00.000Z",
};

test("a complete source-period manifest requires exact authoritative traversal evidence", () => {
  const manifest = buildSourcePeriodManifestEvidence(base);
  assert.equal(manifest.coverageStatus, "complete");
  assert.equal(manifest.listedCount, 3);
  assert.equal(manifest.sourceIdHash, manifest.normalizedIdHash);
  assert.equal(manifest.expectedPageCount, 30);
  assert.equal(manifest.completedPageCount, 30);
  assert.equal(manifest.manifestGeneration, manifest.reconciliationGeneration);
  assert.equal(manifest.reconciledAt, base.evidenceAsOf);
});

test("empty local and upstream sets cannot falsely pass without an actual list request", () => {
  const manifest = buildSourcePeriodManifestEvidence({
    ...base,
    listedIds: [],
    detailIds: [],
    normalizedIds: [],
    listRequestCount: 0,
  });
  assert.equal(manifest.coverageStatus, "partial");
});

test("continuations and missing details fail closed", () => {
  assert.equal(buildSourcePeriodManifestEvidence({
    ...base,
    continuationToken: { day: "2026-06-15", page: 2 },
  }).coverageStatus, "partial");

  const missing = buildSourcePeriodManifestEvidence({ ...base, detailIds: [1, 2] });
  assert.equal(missing.coverageStatus, "suspect");
  assert.deepEqual(missing.evidence.missingDetailIds, ["3"]);
});

test("a reconciliation mismatch can never produce complete coverage", () => {
  assert.equal(buildSourcePeriodManifestEvidence({
    ...base,
    reconciliationStatus: "mismatch",
  }).coverageStatus, "suspect");
});

test("page and reconciliation generations must match", () => {
  const manifest = buildSourcePeriodManifestEvidence({
    ...base,
    manifestGeneration: 8,
    reconciliationGeneration: 7,
  });
  assert.equal(manifest.coverageStatus, "partial");
});
