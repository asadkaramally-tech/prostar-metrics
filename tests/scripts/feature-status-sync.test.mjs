import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AUTHORITATIVE_FEATURE_IDS,
  PLAN_SHA256,
  parseAuthoritativePlan,
  preserveMutableField,
  resolveExecutionStatus,
} from "../../scripts/lib/feature-status-sync.mjs";

test("VERIFIED DONE is downgraded unless the complete shared release validator passed", () => {
  assert.equal(resolveExecutionStatus({
    baselineStatus: "VERIFIED DONE",
    existingStatus: "VERIFIED DONE",
    releaseEvidenceValidated: false,
  }), "PARTIAL");
  assert.equal(resolveExecutionStatus({
    baselineStatus: "PARTIAL",
    existingStatus: "VERIFIED DONE",
    releaseEvidenceValidated: true,
  }), "VERIFIED DONE");
});

test("owner removals remain authoritative without release evidence", () => {
  assert.equal(resolveExecutionStatus({
    baselineStatus: "REMOVED BY OWNER DECISION",
    existingStatus: "VERIFIED DONE",
    releaseEvidenceValidated: false,
  }), "REMOVED BY OWNER DECISION");
});

test("sync invokes the shared complete validator and has no local artifact heuristic", async () => {
  const source = await readFile(
    new URL("../../scripts/sync-feature-status.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /validateReleaseEvidence\(\{/);
  assert.match(source, /skipPlanSynchronizationCheck: true/);
  assert.doesNotMatch(source, /hasMatchingEvidenceArtifact|evidenceArtifactExists/);
});

test("mutable release artifact hashes survive synchronization", () => {
  const existing = {
    evidenceArtifactPath: "docs/prostar-metrics/verification/G-5/Q-01/evidence.json",
    evidenceArtifactSha256: "a".repeat(64),
    buildSourceSha256: "b".repeat(64),
  };
  assert.equal(
    preserveMutableField(existing, "evidenceArtifactSha256", null),
    existing.evidenceArtifactSha256,
  );
  assert.equal(preserveMutableField(undefined, "buildSourceSha256", null), null);
});

test("authoritative plan parser locks the current hash and exact 98-ID order", async () => {
  const plan = await readFile(
    new URL("../../docs/prostar-metrics/execution-plan.md", import.meta.url),
    "utf8",
  );
  const rows = parseAuthoritativePlan(plan);
  assert.equal(PLAN_SHA256.length, 64);
  assert.equal(rows.length, 98);
  assert.deepEqual(rows.map((row) => row.id), AUTHORITATIVE_FEATURE_IDS);
  assert.throws(
    () => parseAuthoritativePlan(`${plan}\ntruncated-or-mutated\n`),
    /execution plan hash mismatch/i,
  );
});
