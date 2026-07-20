import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test, { after, before } from "node:test";

import { publishReleaseEvidence } from "../../scripts/publish-release-evidence.mjs";
import {
  copyFixture,
  createReleaseFixture,
  hash,
  validationNow,
  writeAt,
  writeJsonAt,
} from "./release-evidence-fixture.mjs";

let template;

before(async () => { template = await createReleaseFixture(); });
after(async () => { await template.cleanup(); });

test("publishes a checker-valid 95-feature release atomically and idempotently", async () => {
  const fixture = await copyFixture(template);
  try {
    const expected = {
      verified: 95,
      removed: 3,
      ledgerPath: "docs/prostar-metrics/feature-status.json",
      productionVerifiedAt: validationNow.toISOString(),
    };
    assert.deepEqual(await publish(fixture), expected);
    const ledgerPath = join(fixture.root, expected.ledgerPath);
    const firstLedger = await readFile(ledgerPath);
    const document = JSON.parse(firstLedger);
    assert.equal(document.features.filter((feature) => feature.executionStatus === "VERIFIED DONE").length, 95);
    assert.equal(document.features.filter((feature) => feature.executionStatus === "REMOVED BY OWNER DECISION").length, 3);
    assert.equal(new Set(document.features.filter((feature) => feature.executionStatus === "VERIFIED DONE")
      .map((feature) => feature.evidenceArtifactPath)).size, 95);
    for (const feature of document.features.filter((candidate) => candidate.executionStatus === "VERIFIED DONE")) {
      assert.equal(hash(await readFile(join(fixture.root, feature.evidenceArtifactPath))), feature.evidenceArtifactSha256);
    }
    assert.deepEqual(await publish(fixture), expected);
    assert.deepEqual(await readFile(ledgerPath), firstLedger);
  } finally {
    await fixture.cleanup();
  }
});

test("rejects a handwritten gate PASS with a substituted command", async () => {
  const fixture = await copyFixture(template);
  try {
    const report = JSON.parse(await readFile(join(fixture.root, fixture.paths.gateReportPath), "utf8"));
    report.runs[0].argv = ["node", "-e", "console.log('PASS')"];
    report.runs[0].redactedArgv = report.runs[0].argv;
    await writeJsonAt(fixture.root, fixture.paths.gateReportPath, report);
    await assert.rejects(publish(fixture), /unit gate run argv is not the exact required command/);
  } finally {
    await fixture.cleanup();
  }
});

test("rejects raw gate output changed after the immutable runner completed", async () => {
  const fixture = await copyFixture(template);
  try {
    const report = JSON.parse(await readFile(join(fixture.root, fixture.paths.gateReportPath), "utf8"));
    await writeAt(fixture.root, report.runs[0].stdout.path, "handwritten PASS\n");
    await assert.rejects(publish(fixture), /unit stdout raw log hash mismatch/);
  } finally {
    await fixture.cleanup();
  }
});

test("rejects a forged external review validation receipt", async () => {
  const fixture = await copyFixture(template);
  try {
    const path = fixture.paths.reviewerAttestationPath;
    const receipt = JSON.parse(await readFile(join(fixture.root, path), "utf8"));
    const forgedSignature = Buffer.alloc(256, 9);
    receipt.signature = forgedSignature.toString("base64url");
    receipt.receiptId = `akv:${hash(forgedSignature)}`;
    await writeJsonAt(fixture.root, path, receipt);
    await assert.rejects(publish(fixture), /reviewer receipt signature is not valid/i);
  } finally {
    await fixture.cleanup();
  }
});

test("rejects an external review report created before trusted gates completed", async () => {
  const fixture = await copyFixture(template);
  try {
    const path = fixture.paths.reviewerReportPath;
    const report = JSON.parse(await readFile(join(fixture.root, path), "utf8"));
    report.timestamp = "2026-07-13T20:10:00.000Z";
    await writeJsonAt(fixture.root, path, report);
    await assert.rejects(publish(fixture), /externally supplied review report timestamp must be after its prerequisite evidence/);
  } finally {
    await fixture.cleanup();
  }
});

test("rolls back every newly written feature artifact after partial promotion failure", async () => {
  const fixture = await copyFixture(template);
  try {
    const ledgerPath = join(fixture.root, "docs/prostar-metrics/feature-status.json");
    const originalLedger = await readFile(ledgerPath);
    await assert.rejects(publish(fixture, {
      beforePromote({ index, kind }) {
        if (kind === "feature" && index === 3) throw new Error("injected write failure");
      },
    }), /injected write failure/);
    assert.deepEqual(await readFile(ledgerPath), originalLedger);
    const releaseDirectory = join(
      fixture.root,
      `docs/prostar-metrics/verification/releases/${fixture.deployment.deployedRevision}`,
    );
    assert.deepEqual(await listFiles(releaseDirectory), []);
  } finally {
    await fixture.cleanup();
  }
});

async function publish(fixture, overrides = {}) {
  return publishReleaseEvidence({
    root: fixture.root,
    ...fixture.paths,
    liveVerifier: fixture.liveVerifier,
    receiptVerifiers: fixture.receiptVerifiers,
    now: validationNow,
    ...overrides,
  });
}

async function listFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(join(directory, entry.name), relative));
    else files.push(relative);
  }
  return files.sort();
}
