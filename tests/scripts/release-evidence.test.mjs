import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";

import {
  resolvePostDeploySuiteCategories,
  validateRawPostDeployEvidence,
  validateReleaseEvidence,
} from "../../scripts/check-release-evidence.mjs";
import { GATE_CATEGORIES } from "../../scripts/lib/release-evidence-trust.mjs";
import { publishReleaseEvidence } from "../../scripts/publish-release-evidence.mjs";
import {
  copyFixture,
  createReleaseFixture,
  hash,
  validationNow,
  writeJsonAt,
} from "./release-evidence-fixture.mjs";

let template;

before(async () => { template = await createReleaseFixture(); });
after(async () => { await template.cleanup(); });

test("accepts one signed browser/a11y session bound to the complete live deployment", async () => {
  const fixture = await copyFixture(template);
  try {
    const result = await validateRaw(fixture);
    assert.deepEqual(result, {
      sessionId: "223e4567-e89b-42d3-a456-426614174000",
      captures: 16,
      checks: 8,
    });
  } finally {
    await fixture.cleanup();
  }
});

test("accepts the published 95-feature ledger only after all trusted evidence is present", async () => {
  const fixture = await copyFixture(template);
  try {
    await publish(fixture);
    const document = JSON.parse(await readFile(
      join(fixture.root, "docs/prostar-metrics/feature-status.json"),
      "utf8",
    ));
    const result = await validateReleaseEvidence({
      root: fixture.root,
      document,
      liveVerifier: fixture.liveVerifier,
      receiptVerifiers: fixture.receiptVerifiers,
      now: validationNow,
      skipPlanSynchronizationCheck: true,
    });
    assert.deepEqual(result, { total: 98, verified: 95, removed: 3 });
  } finally {
    await fixture.cleanup();
  }
});

for (const { suite, reportPathField, reportLabel, failurePattern } of [
  {
    suite: "e2e",
    reportPathField: "e2eReportPath",
    reportLabel: "E2E",
    failurePattern: /E2E report hash mismatch/,
  },
  {
    suite: "a11y",
    reportPathField: "a11yReportPath",
    reportLabel: "accessibility",
    failurePattern: /accessibility report hash mismatch/,
  },
]) {
  test(`${suite} post-deployment alias validates the full trusted bundle and ${reportLabel} artifacts`, async () => {
    const fixture = await copyFixture(template);
    try {
      await publish(fixture);
      const document = await readPublishedLedger(fixture);
      const requiredTestCategories = resolvePostDeploySuiteCategories(suite);
      assert.deepEqual(requiredTestCategories, [...GATE_CATEGORIES]);

      const validationOptions = {
        root: fixture.root,
        document,
        requiredTestCategories,
        liveVerifier: fixture.liveVerifier,
        receiptVerifiers: fixture.receiptVerifiers,
        now: validationNow,
        skipPlanSynchronizationCheck: true,
      };
      assert.deepEqual(
        await validateReleaseEvidence(validationOptions),
        { total: 98, verified: 95, removed: 3 },
      );

      const reportPath = fixture.paths[reportPathField];
      const report = JSON.parse(await readFile(join(fixture.root, reportPath), "utf8"));
      report.completedAt = report.completedAt.replace(".000Z", ".001Z");
      await writeJsonAt(fixture.root, reportPath, report);
      await assert.rejects(validateReleaseEvidence(validationOptions), failurePattern);
    } finally {
      await fixture.cleanup();
    }
  });
}

test("rejects an unknown post-deployment suite alias before evidence validation", () => {
  const cliPath = fileURLToPath(new URL("../../scripts/check-release-evidence.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [cliPath, "--post-deploy-suite=unit"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown post-deployment suite alias "unit"; expected one of: e2e, a11y/);
});

test("rejects self-generated browser pixels and JSON without a valid external signature", async () => {
  const fixture = await copyFixture(template);
  try {
    const receipt = JSON.parse(await readFile(join(fixture.root, fixture.browserAttestationPath), "utf8"));
    const forgedSignature = Buffer.alloc(256, 7);
    receipt.signature = forgedSignature.toString("base64url");
    receipt.receiptId = `akv:${hash(forgedSignature)}`;
    await writeJsonAt(fixture.root, fixture.browserAttestationPath, receipt);
    await assert.rejects(validateRaw(fixture), /browser artifact validation trust verification failed:.*signature/i);
  } finally {
    await fixture.cleanup();
  }
});

test("rejects capture artifacts whose session no longer matches the signed session", async () => {
  const fixture = await copyFixture(template);
  try {
    const capture = fixture.e2e.captures[0];
    const trace = JSON.parse(await readFile(join(fixture.root, capture.tracePath), "utf8"));
    trace.sessionId = "423e4567-e89b-42d3-a456-426614174000";
    capture.traceSha256 = await writeJsonAt(fixture.root, capture.tracePath, trace);
    await writeJsonAt(fixture.root, fixture.paths.e2eReportPath, fixture.e2e);
    await assert.rejects(validateRaw(fixture), /trace sessionId mismatch/);
  } finally {
    await fixture.cleanup();
  }
});

test("rejects E2E captures that use the wrong route query parameter", async () => {
  const fixture = await copyFixture(template);
  try {
    const capture = findCapture(fixture, "/quotes", "current");
    await rewriteCaptureUrl(fixture, capture, `${fixture.e2e.productionUrl}/quotes?period=current`);
    await assert.rejects(
      validateRaw(fixture),
      /must exactly bind production route \/quotes\?month=2026-07/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("rejects E2E captures whose month does not match the labeled period", async () => {
  const fixture = await copyFixture(template);
  try {
    const capture = findCapture(fixture, "/commissions", "current");
    await rewriteCaptureUrl(
      fixture,
      capture,
      `${fixture.e2e.productionUrl}/commissions?year=2026&month=6&summaryYear=2026`,
    );
    await assert.rejects(
      validateRaw(fixture),
      /must exactly bind production route \/commissions\?year=2026&month=7&summaryYear=2026/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("rejects E2E capture URLs with extra query parameters", async () => {
  const fixture = await copyFixture(template);
  try {
    const capture = findCapture(fixture, "/jobs", "2026-06");
    await rewriteCaptureUrl(
      fixture,
      capture,
      `${fixture.e2e.productionUrl}/jobs?month=2026-06&category=service`,
    );
    await assert.rejects(
      validateRaw(fixture),
      /must exactly bind production route \/jobs\?month=2026-06/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("rejects browser traces when deployment health reports a disconnected database", async () => {
  const fixture = await copyFixture(template);
  try {
    const capture = findCapture(fixture, "/technicians", "current");
    await rewriteHealthBody(fixture, capture, (body) => {
      body.database.connected = false;
    });
    await assert.rejects(validateRaw(fixture), /deployment response body database connected mismatch/);
  } finally {
    await fixture.cleanup();
  }
});

test("rejects browser traces with a malformed deployment health response", async () => {
  const fixture = await copyFixture(template);
  try {
    const capture = findCapture(fixture, "/technicians", "2026-06");
    await rewriteHealthBody(fixture, capture, (body) => {
      body.database = { connected: true };
    });
    await assert.rejects(validateRaw(fixture), /deployment response body database is missing fields/);
  } finally {
    await fixture.cleanup();
  }
});

test("rejects stale browser evidence at publication time", async () => {
  const fixture = await copyFixture(template);
  try {
    await assert.rejects(
      validateRaw(fixture, new Date("2026-07-13T22:01:00.000Z")),
      /E2E report completedAt is older than/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("rejects a deployment missing any app or scheduled-job contract", async () => {
  const fixture = await copyFixture(template);
  try {
    fixture.deployment.targets.pop();
    await writeJsonAt(fixture.root, fixture.paths.deploymentManifestPath, fixture.deployment);
    await assert.rejects(validateRaw(fixture), /Production targets must match the immutable app plus exact 24-job allowlist/);
  } finally {
    await fixture.cleanup();
  }
});

test("rejects deploymentOperationId that is not the ARM operation ID", async () => {
  const fixture = await copyFixture(template);
  try {
    fixture.deployment.deploymentOperationId = "/subscriptions/sub/providers/Microsoft.Resources/deployments/other";
    await writeJsonAt(fixture.root, fixture.paths.deploymentManifestPath, fixture.deployment);
    await assert.rejects(validateRaw(fixture), /deploymentOperationId must exactly equal armDeployment\.operationId/);
  } finally {
    await fixture.cleanup();
  }
});

async function validateRaw(fixture, now = validationNow) {
  return validateRawPostDeployEvidence({
    root: fixture.root,
    ...fixture.paths,
    browserAttestationPath: fixture.browserAttestationPath,
    liveVerifier: fixture.liveVerifier,
    receiptVerifier: fixture.receiptVerifiers.browser,
    now,
  });
}

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

async function readPublishedLedger(fixture) {
  return JSON.parse(await readFile(
    join(fixture.root, "docs/prostar-metrics/feature-status.json"),
    "utf8",
  ));
}

function findCapture(fixture, route, period) {
  return fixture.e2e.captures.find((capture) => (
    capture.route === route && capture.period === period && capture.viewport.name === "desktop"
  ));
}

async function rewriteCaptureUrl(fixture, capture, url) {
  const tracePath = join(fixture.root, capture.tracePath);
  const trace = JSON.parse(await readFile(tracePath, "utf8"));
  const priorUrl = capture.url;
  capture.url = url;
  trace.pageUrl = url;
  for (const request of trace.requests) {
    if (request.url === priorUrl) request.url = url;
  }
  for (const response of trace.responses) {
    if (response.url === priorUrl) response.url = url;
  }
  capture.traceSha256 = await writeJsonAt(fixture.root, capture.tracePath, trace);
  await writeJsonAt(fixture.root, fixture.paths.e2eReportPath, fixture.e2e);
}

async function rewriteHealthBody(fixture, capture, mutate) {
  const tracePath = join(fixture.root, capture.tracePath);
  const trace = JSON.parse(await readFile(tracePath, "utf8"));
  mutate(trace.deploymentResponse.body);
  trace.deploymentResponse.bodySha256 = hash(JSON.stringify(trace.deploymentResponse.body));
  capture.traceSha256 = await writeJsonAt(fixture.root, capture.tracePath, trace);
  await writeJsonAt(fixture.root, fixture.paths.e2eReportPath, fixture.e2e);
}
