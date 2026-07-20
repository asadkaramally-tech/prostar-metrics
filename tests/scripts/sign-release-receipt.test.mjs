import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test, { after, before } from "node:test";

import { signReleaseReceipt } from "../../scripts/sign-release-receipt.mjs";
import {
  copyFixture,
  createReleaseFixture,
  fixtureHandoff,
  makeFixtureReceipt,
  reviewerAgent,
  writeJsonAt,
} from "./release-evidence-fixture.mjs";

let template;

before(async () => { template = await createReleaseFixture(); });
after(async () => { await template.cleanup(); });

test("browser validation receipt signs only the supplied validated-artifact result and exact hashes", async () => {
  const fixture = await copyFixture(template);
  try {
    const outputPath = "docs/prostar-metrics/verification/browser/new-validated-artifacts-receipt.json";
    let issuedSubject;
    const result = await signReleaseReceipt({
      root: fixture.root,
      kind: "browser",
      deploymentManifestPath: fixture.paths.deploymentManifestPath,
      e2eReportPath: fixture.paths.e2eReportPath,
      a11yReportPath: fixture.paths.a11yReportPath,
      producerResultPath: fixture.browserRunnerResultPath,
      outputPath,
      handoffBinding: fixtureHandoff("browser"),
      receiptIssuer: async ({ kind, expectedSubject, keyId }) => {
        issuedSubject = expectedSubject;
        return makeFixtureReceipt(kind, expectedSubject, keyId, "2026-07-13T19:51:00.000Z");
      },
    });
    assert.equal(result.outputPath, outputPath);
    assert.equal(issuedSubject.sessionId, fixture.e2e.sessionId);
    assert.equal(issuedSubject.rawArtifactHashes.length, 41);
    assert.equal(JSON.parse(await readFile(join(fixture.root, outputPath), "utf8")).subject.sessionId, fixture.e2e.sessionId);
  } finally {
    await fixture.cleanup();
  }
});

test("browser artifact validator rejects arbitrary hashes labeled as validation proof", async () => {
  const fixture = await copyFixture(template);
  try {
    const result = JSON.parse(await readFile(join(fixture.root, fixture.browserRunnerResultPath), "utf8"));
    result.artifacts[0].sha256 = "f".repeat(64);
    await writeJsonAt(fixture.root, fixture.browserRunnerResultPath, result);
    await assert.rejects(signReleaseReceipt({
      root: fixture.root,
      kind: "browser",
      deploymentManifestPath: fixture.paths.deploymentManifestPath,
      e2eReportPath: fixture.paths.e2eReportPath,
      a11yReportPath: fixture.paths.a11yReportPath,
      producerResultPath: fixture.browserRunnerResultPath,
      outputPath: "docs/prostar-metrics/verification/browser/forged-receipt.json",
      handoffBinding: fixtureHandoff("browser"),
      receiptIssuer: async () => { throw new Error("must not sign"); },
    }), /does not exactly match the supplied artifacts/);
  } finally {
    await fixture.cleanup();
  }
});

test("external review receipt validates report content without authenticating declared authorship", async () => {
  const fixture = await copyFixture(template);
  try {
    let subject;
    await signReleaseReceipt({
      root: fixture.root,
      kind: "reviewer",
      ...reviewerPaths(fixture),
      outputPath: "docs/prostar-metrics/verification/reviewer/new-receipt.json",
      agentPath: "019ffffffff-ffff-ffff-ffff-ffffffffffff",
      threadId: "019ffffffff-ffff-ffff-ffff-ffffffffffff",
      result: "SHIP",
      handoffBinding: fixtureHandoff("reviewer"),
      receiptIssuer: async ({ kind, expectedSubject, keyId }) => {
        subject = expectedSubject;
        return makeFixtureReceipt(kind, expectedSubject, keyId, "2026-07-13T20:31:00.000Z");
      },
    });
    assert.equal(subject.declaredReviewerTaskId, reviewerAgent);
    assert.equal(subject.decision, "SHIP");
    assert.equal(subject.authorship, "NOT_AUTHENTICATED");
    assert.equal(subject.validationType, "EXTERNAL_REPORT_CONTENT_ONLY");
  } finally {
    await fixture.cleanup();
  }
});

test("caller-supplied SHIP cannot override an external DO NOT SHIP report", async () => {
  const fixture = await copyFixture(template);
  try {
    const report = JSON.parse(await readFile(join(fixture.root, fixture.paths.reviewerReportPath), "utf8"));
    report.finalDecisionText = "DO NOT SHIP: unresolved release-trust findings remain.";
    await writeJsonAt(fixture.root, fixture.paths.reviewerReportPath, report);
    await assert.rejects(signReleaseReceipt({
      root: fixture.root,
      kind: "reviewer",
      ...reviewerPaths(fixture),
      outputPath: "docs/prostar-metrics/verification/reviewer/forged-receipt.json",
      agentPath: "019a1b2c-3d4e-5f60-a111-222233334444",
      threadId: "019b2c3d-4e5f-6071-b222-333344445555",
      result: "SHIP",
      handoffBinding: fixtureHandoff("reviewer"),
      receiptIssuer: async () => { throw new Error("must not sign"); },
    }), /decision is DO NOT SHIP/);
  } finally {
    await fixture.cleanup();
  }
});

function reviewerPaths(fixture) {
  return {
    deploymentManifestPath: fixture.paths.deploymentManifestPath,
    e2eReportPath: fixture.paths.e2eReportPath,
    a11yReportPath: fixture.paths.a11yReportPath,
    browserAttestationPath: fixture.browserAttestationPath,
    gateReportPath: fixture.paths.gateReportPath,
    gateRunnerReceiptPath: fixture.gateRunnerReceiptPath,
    reviewerReportPath: fixture.paths.reviewerReportPath,
  };
}
