import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test, { after, before } from "node:test";

import {
  assertCredentialSafeEvidence,
  createSanitizedAuthSessionArtifact,
  validateRawPostDeployEvidence,
} from "../../scripts/check-release-evidence.mjs";
import {
  authenticatedActor,
  authenticatedPrincipalId,
  authenticationProvider,
  copyFixture,
  createReleaseFixture,
  hash,
  productionUrl,
  validationNow,
  writeJsonAt,
} from "./release-evidence-fixture.mjs";

let template;

before(async () => { template = await createReleaseFixture(); });
after(async () => { await template.cleanup(); });

test("capture constructor persists only sanitized owner identity and safe headers", () => {
  const artifact = createSanitizedAuthSessionArtifact(captureInput({
    requestHeaders: {
      accept: "application/json",
      authorization: "Bearer must-never-persist-12345678",
      cookie: "AppServiceAuthSession=must-never-persist",
      "x-client-trace": "not-required",
    },
    responseHeaders: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "set-cookie": "AppServiceAuthSession=must-never-persist",
      server: "not-required",
    },
  }));

  assert.deepEqual(artifact.request.headers, { accept: "application/json" });
  assert.deepEqual(artifact.response.headers, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  assert.deepEqual(artifact.response.body, {
    authenticated: true,
    principalEmail: authenticatedActor,
    principalId: authenticatedPrincipalId,
    provider: authenticationProvider,
  });
  assert.equal(artifact.response.bodySha256, hash(JSON.stringify(artifact.response.body)));
  assert.doesNotMatch(JSON.stringify(artifact), /must-never-persist|authorization|cookie|set-cookie/i);
});

test("capture constructor rejects extra claims, outsiders, malformed providers, and malformed object IDs", async (t) => {
  const cases = [
    ["extra claim", { ...identityBody(), roles: ["owner"] }, /unsupported fields: roles/],
    ["outsider", { ...identityBody(), principalEmail: "outsider@example.test" }, /authenticated Asad or Laila/],
    ["provider", { ...identityBody(), provider: "google" }, /provider must be aad/],
    ["object ID", { ...identityBody(), principalId: "not-an-entra-object-id" }, /Entra object ID GUID/],
    ["embedded token", { ...identityBody(), access_token: "secret-token-material" }, /unsupported fields: access_token/],
  ];
  for (const [name, responseBody, expected] of cases) {
    await t.test(name, () => {
      assert.throws(() => createSanitizedAuthSessionArtifact(captureInput({ responseBody })), expected);
    });
  }
});

test("checker derives the actor from the protected response and rejects an outsider body with an Asad report", async () => {
  const fixture = await copyFixture(template);
  try {
    await rewriteIdentityReceipt(fixture, (artifact) => {
      artifact.response.body.principalEmail = "outsider@example.test";
      artifact.response.bodySha256 = hash(JSON.stringify(artifact.response.body));
    });
    await assert.rejects(validateRaw(fixture), /authenticated Asad or Laila.*authenticatedActor mismatch/s);
  } finally {
    await fixture.cleanup();
  }
});

test("checker rejects report identity metadata that does not match the protected response", async () => {
  const fixture = await copyFixture(template);
  try {
    for (const reportPath of [fixture.paths.e2eReportPath, fixture.paths.a11yReportPath]) {
      const report = await readJson(fixture.root, reportPath);
      report.authenticatedActor = "laila@prostarmechanical.com";
      report.authenticatedPrincipalId = "7d9d33a2-66f2-4cca-911f-7a80425b5642";
      await writeJsonAt(fixture.root, reportPath, report);
    }
    await assert.rejects(validateRaw(fixture), /authenticatedActor mismatch.*authenticatedPrincipalId mismatch/s);
  } finally {
    await fixture.cleanup();
  }
});

test("checker rejects persisted bearer, cookie, and token material in browser evidence", async (t) => {
  const cases = [
    ["authorization", (artifact) => { artifact.request.headers.authorization = "Bearer browser-evidence-secret"; }, /Authorization header|Bearer credential/],
    ["set-cookie", (artifact) => { artifact.response.headers["set-cookie"] = "AppServiceAuthSession=browser-evidence-secret"; }, /Cookie header or value/],
    ["body token", (artifact) => { artifact.response.body.access_token = "browser-evidence-secret"; }, /secret or token assignment/],
  ];
  for (const [name, mutate, expected] of cases) {
    await t.test(name, async () => {
      const fixture = await copyFixture(template);
      try {
        await rewriteIdentityReceipt(fixture, mutate);
        await assert.rejects(validateRaw(fixture), expected);
      } finally {
        await fixture.cleanup();
      }
    });
  }
});

test("checker detects response-body mutation independently of the artifact hash", async () => {
  const fixture = await copyFixture(template);
  try {
    await rewriteIdentityReceipt(fixture, (artifact) => {
      artifact.response.body.principalId = "7d9d33a2-66f2-4cca-911f-7a80425b5642";
    });
    await assert.rejects(validateRaw(fixture), /bodySha256 mismatch/);
  } finally {
    await fixture.cleanup();
  }
});

test("credential scanner fails closed for browser artifacts and gate logs without treating hashes as secrets", async (t) => {
  const exposures = [
    "Authorization: Bearer browser-evidence-secret",
    "Cookie: AppServiceAuthSession=browser-evidence-secret",
    "eyJhbGciOiJSUzI1NiJ9.eyJvaWQiOiJwcml2YXRlIn0.signaturevalue",
    "postgresql://owner:private-password@database.example.test/metrics",
    "Host=database.example.test;Database=metrics;Username=owner;Password=private-password",
    "client_secret=browser-evidence-secret",
    "AccountKey=browser-evidence-secret",
    "-----BEGIN PRIVATE KEY-----",
  ];
  for (const exposure of exposures) {
    await t.test(exposure.split(/[:=\s]/, 1)[0], () => {
      assert.throws(() => assertCredentialSafeEvidence(exposure, "unit stdout raw log"), /forbidden credential material/);
    });
  }
  assert.doesNotThrow(() => assertCredentialSafeEvidence(
    `unit gate passed\nsha256=${"a".repeat(64)}\nbodySha256=${"b".repeat(64)}\n`,
    "unit stdout raw log",
  ));
});

function captureInput(overrides = {}) {
  return {
    sessionId: "223e4567-e89b-42d3-a456-426614174000",
    deploymentNonce: "123e4567-e89b-42d3-a456-426614174000",
    productionUrl,
    requestHeaders: { accept: "application/json" },
    responseStatus: 200,
    responseHeaders: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
    responseBody: identityBody(),
    capturedAt: "2026-07-13T19:05:00.000Z",
    ...overrides,
  };
}

function identityBody() {
  return {
    authenticated: true,
    principalEmail: authenticatedActor,
    principalId: authenticatedPrincipalId,
    provider: authenticationProvider,
  };
}

async function rewriteIdentityReceipt(fixture, mutate) {
  const e2e = await readJson(fixture.root, fixture.paths.e2eReportPath);
  const a11y = await readJson(fixture.root, fixture.paths.a11yReportPath);
  const artifact = await readJson(fixture.root, e2e.authMeResponsePath);
  mutate(artifact);
  const sha256 = await writeJsonAt(fixture.root, e2e.authMeResponsePath, artifact);
  e2e.authMeResponseSha256 = sha256;
  a11y.authMeResponseSha256 = sha256;
  await writeJsonAt(fixture.root, fixture.paths.e2eReportPath, e2e);
  await writeJsonAt(fixture.root, fixture.paths.a11yReportPath, a11y);
}

async function readJson(root, path) {
  return JSON.parse(await readFile(join(root, path), "utf8"));
}

async function validateRaw(fixture) {
  return validateRawPostDeployEvidence({
    root: fixture.root,
    ...fixture.paths,
    browserAttestationPath: fixture.browserAttestationPath,
    liveVerifier: fixture.liveVerifier,
    receiptVerifier: fixture.receiptVerifiers.browser,
    now: validationNow,
  });
}
