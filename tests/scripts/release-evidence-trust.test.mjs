import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { computeDockerBuildContext } from "../../scripts/lib/deployment-provenance.mjs";
import {
  observedAssertionId,
  releaseGateAssertionEvent,
  summarizeReleaseGateAssertions,
} from "../../scripts/lib/release-gate-assertions.mjs";
import {
  EVIDENCE_SIGNER_IDENTITIES,
  EXPECTED_GATE_COMMANDS,
  GATE_CATEGORIES,
  PRODUCTION_GATE_COMMANDS,
  STRUCTURED_GATE_RESULT_SCHEMA_VERSION,
  executeImmutableGateRun,
  gateEnvironment,
  hashBytes,
  issueAzureKeyVaultReceipt,
  jsonBytes,
  validateTrustedGateReport,
  verifyActiveSignerIdentity,
  verifyEvidenceSignerRbacPolicy,
  verifyServiceReceipt,
} from "../../scripts/lib/release-evidence-trust.mjs";
import {
  fixtureHandoff,
  makeFixtureReceipt,
  verifyFixtureReceipt,
} from "./release-evidence-fixture.mjs";

const keyIds = {
  gate: `https://kv-prostar-metrics-prod.vault.azure.net/keys/prostar-release-gate-evidence/${"a".repeat(32)}`,
  browser: `https://kv-prostar-metrics-prod.vault.azure.net/keys/prostar-release-browser-evidence/${"b".repeat(32)}`,
  reviewer: `https://kv-prostar-metrics-prod.vault.azure.net/keys/prostar-release-reviewer-evidence/${"c".repeat(32)}`,
};

test("gateEnvironment exposes only explicit nonsecret bindings", () => {
  const inheritedEnv = secretRichEnvironment();
  const common = {
    projectRoot: "/release/source",
    deploymentManifestPath: "verification/deployment.json",
    e2eReportPath: "verification/e2e.json",
    a11yReportPath: "verification/a11y.json",
    browserAttestationPath: "verification/browser-receipt.json",
    executionId: "123e4567-e89b-42d3-a456-426614174000",
    resultOutputPath: "/release/results/unit.json",
    inheritedEnv,
  };
  const unit = gateEnvironment({ ...common, category: "unit" });
  assert.deepEqual(Object.keys(unit).sort(), [
    "NODE_PATH", "PATH", "RELEASE_A11Y_REPORT", "RELEASE_BROWSER_ATTESTATION",
    "RELEASE_DEPLOYMENT_MANIFEST", "RELEASE_E2E_REPORT", "RELEASE_PROJECT_ROOT",
    "RELEASE_GATE_CATEGORY", "RELEASE_GATE_EXECUTION_ID", "RELEASE_GATE_RESULT_PATH",
  ].sort());
  for (const secret of secretNames()) assert.equal(unit[secret], undefined);

  for (const category of GATE_CATEGORIES) {
    const categoryEnvironment = gateEnvironment({ ...common, category });
    for (const secret of secretNames()) assert.equal(categoryEnvironment[secret], undefined);
  }
});

test("Azure Key Vault CLI adapter signs a digest and verifies against the pinned public key", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const exported = publicKey.export({ format: "jwk" });
  const publicJwk = { kty: "RSA", n: exported.n, e: exported.e };
  const expectedSubject = {
    handoff: fixtureHandoff("browser"),
    sessionId: "723e4567-e89b-42d3-a456-426614174000",
    deploymentNonce: "123e4567-e89b-42d3-a456-426614174000",
    artifactHashes: ["d".repeat(64)],
  };
  const expectedDigest = createHash("sha256").update(jsonBytes(expectedSubject)).digest("base64url");
  const calls = [];
  const runAz = async (args) => {
    calls.push(args);
    if (args[2] === "show") return JSON.stringify(publicJwk);
    const digestIndex = args.indexOf("--digest") + 1;
    assert.equal(
      args[digestIndex],
      expectedDigest,
    );
    return sign("sha256", jsonBytes(expectedSubject), privateKey).toString("base64url");
  };
  const receipt = await issueAzureKeyVaultReceipt({
    kind: "browser",
    expectedSubject,
    keyId: keyIds.browser,
    runAz,
    signerIdentityVerifier: async ({ kind }) => assert.equal(kind, "browser"),
    now: () => new Date("2026-07-13T20:00:00.000Z"),
  });
  assert.deepEqual(calls, [
    ["keyvault", "key", "show", "--id", keyIds.browser, "--query", "key", "--output", "json", "--only-show-errors"],
    ["keyvault", "key", "sign", "--id", keyIds.browser, "--algorithm", "RS256", "--digest", expectedDigest, "--query", "result", "--output", "tsv", "--only-show-errors"],
  ]);
  await verifyServiceReceipt({
    kind: "browser",
    receipt,
    expectedSubject,
    expectedKeyId: keyIds.browser,
    keyResolver: async () => publicJwk,
  });
});

test("receipt issuer rejects cross-kind keys before any signing operation", async () => {
  let identityChecks = 0;
  await assert.rejects(issueAzureKeyVaultReceipt({
    kind: "gate",
    expectedSubject: { artifactHashes: ["d".repeat(64)] },
    keyId: keyIds.browser,
    runAz: async () => { throw new Error("must not call Azure"); },
    signerIdentityVerifier: async () => { identityChecks += 1; },
  }), /gate receipt cannot be signed with the prostar-release-browser-evidence evidence key/);
  assert.equal(identityChecks, 0);
});

test("one evidence identity or key cannot satisfy another evidence-kind policy", async () => {
  const policies = Object.entries(EVIDENCE_SIGNER_IDENTITIES);
  assert.equal(new Set(policies.map(([, policy]) => policy.name)).size, 3);
  assert.equal(new Set(policies.map(([, policy]) => policy.keyName)).size, 3);
  for (const [kind, policy] of policies) {
    for (const [otherKind, otherPolicy] of policies) {
      if (kind === otherKind) continue;
      const keyId = `https://kv-prostar-metrics-prod.vault.azure.net/keys/${otherPolicy.keyName}/${"a".repeat(32)}`;
      await assert.rejects(issueAzureKeyVaultReceipt({
        kind,
        expectedSubject: { policy: policy.name },
        keyId,
        runAz: async () => { throw new Error("must not call Azure"); },
        signerIdentityVerifier: async () => { throw new Error("must not verify the wrong identity"); },
      }), /cannot be signed with/);
    }
  }
});

test("dedicated signer check rejects an owner or another evidence identity", async () => {
  const dedicated = {
    principalId: "123e4567-e89b-42d3-a456-426614174010",
    clientId: "123e4567-e89b-42d3-a456-426614174011",
    id: "/subscriptions/sub/resourceGroups/prostar-payroll/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-prostar-release-browser-prod",
  };
  const ownerClaims = {
    oid: "123e4567-e89b-42d3-a456-426614174099",
    azp: dedicated.clientId,
  };
  const runAz = async (args) => (
    args[0] === "identity" ? JSON.stringify(dedicated) : jwt(ownerClaims)
  );
  await assert.rejects(
    verifyActiveSignerIdentity({ kind: "browser", runAz }),
    /active Azure principal is different/,
  );
});

test("RBAC policy rejects inherited owner signing, cross-key access, and one-principal control", () => {
  const vaultResourceId = "/subscriptions/sub/resourceGroups/prostar-payroll/providers/Microsoft.KeyVault/vaults/kv-prostar-metrics-prod";
  const cryptoRole = `/subscriptions/sub/providers/Microsoft.Authorization/roleDefinitions/12338af0-0e69-4776-bea7-57ae8d297424`;
  const roleDefinitions = {
    [cryptoRole.toLowerCase()]: {
      permissions: [{ dataActions: ["Microsoft.KeyVault/vaults/keys/sign/action"], notDataActions: [] }],
    },
  };
  const identities = Object.fromEntries(Object.keys(EVIDENCE_SIGNER_IDENTITIES).map((kind, index) => [kind, {
    principalId: `123e4567-e89b-42d3-a456-42661417401${index}`,
  }]));
  const assignmentsByKind = Object.fromEntries(Object.entries(EVIDENCE_SIGNER_IDENTITIES).map(([kind, policy]) => [kind, [{
    principalId: identities[kind].principalId,
    roleDefinitionId: cryptoRole,
    scope: `${vaultResourceId}/keys/${policy.keyName}`,
  }]]));
  assert.equal(verifyEvidenceSignerRbacPolicy({
    vaultResourceId, identities, assignmentsByKind, roleDefinitions,
  }), true);

  const inheritedOwner = structuredClone(assignmentsByKind);
  inheritedOwner.browser.push({
    principalId: "123e4567-e89b-42d3-a456-426614174099",
    roleDefinitionId: cryptoRole,
    scope: vaultResourceId,
  });
  assert.throws(() => verifyEvidenceSignerRbacPolicy({
    vaultResourceId, identities, assignmentsByKind: inheritedOwner, roleDefinitions,
  }), /exactly one signing-capable/);

  const customRole = "/subscriptions/sub/providers/Microsoft.Authorization/roleDefinitions/123e4567-e89b-42d3-a456-426614174098";
  const customSigning = structuredClone(assignmentsByKind);
  customSigning.gate.push({
    principalId: "123e4567-e89b-42d3-a456-426614174099",
    roleDefinitionId: customRole,
    scope: vaultResourceId,
  });
  assert.throws(() => verifyEvidenceSignerRbacPolicy({
    vaultResourceId,
    identities,
    assignmentsByKind: customSigning,
    roleDefinitions: {
      ...roleDefinitions,
      [customRole.toLowerCase()]: {
        permissions: [{ dataActions: ["Microsoft.KeyVault/vaults/keys/*"], notDataActions: [] }],
      },
    },
  }), /exactly one signing-capable/);

  const crossKey = structuredClone(assignmentsByKind);
  crossKey.reviewer[0].principalId = identities.gate.principalId;
  assert.throws(() => verifyEvidenceSignerRbacPolicy({
    vaultResourceId, identities, assignmentsByKind: crossKey, roleDefinitions,
  }), /isolated key policy/);

  const onePrincipal = structuredClone(identities);
  onePrincipal.browser.principalId = onePrincipal.gate.principalId;
  assert.throws(() => verifyEvidenceSignerRbacPolicy({
    vaultResourceId, identities: onePrincipal, assignmentsByKind, roleDefinitions,
  }), /three distinct principals/);
});

test("immutable runner executes exact commands and publishes checksummed raw logs atomically", async () => {
  const root = await makeRunnerRoot();
  try {
    const source = await computeDockerBuildContext(root);
    const deployment = fixtureDeployment(source.sha256);
    const observed = [];
    const timestamps = timestampSequence("2026-07-13T20:00:00.000Z", 12);
    const outputDirectory = "docs/prostar-metrics/verification/gates/release-test";
    const result = await executeImmutableGateRun({
      root,
      deployment,
      deploymentManifestPath: "docs/prostar-metrics/verification/deployment-manifest.json",
      deploymentManifestSha256: "d".repeat(64),
      e2eReportPath: "docs/prostar-metrics/verification/e2e.json",
      a11yReportPath: "docs/prostar-metrics/verification/a11y.json",
      browserAttestationPath: "docs/prostar-metrics/verification/browser-receipt.json",
      handoffBinding: fixtureHandoff("gate"),
      mandatoryIds: ["F-01"],
      outputDirectory,
      inheritedEnv: secretRichEnvironment(),
      now: () => timestamps.shift(),
      commandExecutor: async ({ argv, cwd, env }) => {
        observed.push({ argv, cwd, env });
        const index = observed.length - 1;
        const structured = await writeStructuredResult(env, argv, {
          startedAt: `2026-07-13T20:${String(index * 2 + 1).padStart(2, "0")}:10.000Z`,
          completedAt: `2026-07-13T20:${String(index * 2 + 1).padStart(2, "0")}:50.000Z`,
        });
        return {
          stdout: Buffer.from(structured.results.map((result) => releaseGateAssertionEvent({
            category: structured.category,
            ...result,
          })).join("")),
          stderr: Buffer.alloc(0),
          exitCode: 0,
          signal: null,
          toolName: argv[0],
          toolVersion: argv[0] === "node" ? "24.17.0" : "11.13.0",
        };
      },
      receiptIssuer: async ({ kind, expectedSubject, keyId }) => (
        makeFixtureReceipt(kind, expectedSubject, keyId, "2026-07-13T20:20:00.000Z")
      ),
    });

    assert.deepEqual(observed.map(({ argv }) => argv), GATE_CATEGORIES.map((category) => [...EXPECTED_GATE_COMMANDS[category]]));
    for (const invocation of observed) {
      for (const secret of secretNames()) assert.equal(invocation.env[secret], undefined);
      assert.equal(invocation.env.AZURE_POSTGRES_CONNECTION_STRING, undefined);
      assert.match(invocation.cwd, /prostar-gate-runner-.*\/snapshot$/);
    }

    const report = JSON.parse(await readFile(join(root, result.gateReportPath), "utf8"));
    const receipt = JSON.parse(await readFile(join(root, result.runnerReceiptPath), "utf8"));
    assert.equal(hashBytes(await readFile(join(root, result.gateReportPath))), result.gateReportSha256);
    assert.equal(hashBytes(await readFile(join(root, result.runnerReceiptPath))), result.runnerReceiptSha256);
    const gateResults = await validateTrustedGateReport({
      report,
      reportSha256: result.gateReportSha256,
      runnerReceipt: receipt,
      deployment,
      deploymentManifestPath: "docs/prostar-metrics/verification/deployment-manifest.json",
      deploymentManifestSha256: "d".repeat(64),
      mandatoryIds: ["F-01"],
      readArtifact: async (path, label, expectedSha256) => {
        const bytes = await readFile(join(root, path));
        assert.equal(hashBytes(bytes), expectedSha256, label);
        return { bytes };
      },
      receiptVerifier: verifyFixtureReceipt,
      nowMs: Date.parse("2026-07-13T20:30:00.000Z"),
    });
    assert.equal(gateResults.get(report.runs[0].results[0].id), "PASS");
    assert.equal(gateResults.get(report.runs.at(-1).results[0].id), "PASS");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gate runner never infers PASS from an exit code, forged IDs, or non-PASS outcomes", async (t) => {
  const cases = [
    ["missing producer artifact", null, /did not produce the required structured result artifact/],
    ["forged incomplete result", [{ id: "unit", outcome: "PASS" }], /unexpected fields/],
    ["failed producer outcome", [observedResult("unit", { outcome: "FAIL" })], /contains non-PASS outcomes/],
  ];
  for (const [name, results, expectedError] of cases) {
    await t.test(name, async () => {
      const root = await makeRunnerRoot();
      try {
        const source = await computeDockerBuildContext(root);
        const timestamps = timestampSequence("2026-07-13T20:00:00.000Z", 4);
        await assert.rejects(executeImmutableGateRun({
          root,
          deployment: fixtureDeployment(source.sha256),
          deploymentManifestPath: "docs/prostar-metrics/verification/deployment-manifest.json",
          deploymentManifestSha256: "d".repeat(64),
          e2eReportPath: "docs/prostar-metrics/verification/e2e.json",
          a11yReportPath: "docs/prostar-metrics/verification/a11y.json",
          browserAttestationPath: "docs/prostar-metrics/verification/browser-receipt.json",
          handoffBinding: fixtureHandoff("gate"),
          mandatoryIds: ["F-01"],
          inheritedEnv: secretRichEnvironment(),
          now: () => timestamps.shift(),
          commandExecutor: async ({ argv, env }) => {
            if (results) await writeStructuredResult(env, argv, {
              startedAt: "2026-07-13T20:01:10.000Z",
              completedAt: "2026-07-13T20:01:50.000Z",
              results,
            });
            return {
              stdout: Buffer.from("successful command output cannot create feature PASS results\n"),
              stderr: Buffer.alloc(0),
              exitCode: 0,
              signal: null,
              toolName: argv[0],
              toolVersion: "1.2.3",
            };
          },
        }), expectedError);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("failed gate command leaves no publishable gate directory", async () => {
  const root = await makeRunnerRoot();
  const outputDirectory = "docs/prostar-metrics/verification/gates/failed-release";
  try {
    const source = await computeDockerBuildContext(root);
    const timestamps = timestampSequence("2026-07-13T20:00:00.000Z", 6);
    let calls = 0;
    await assert.rejects(executeImmutableGateRun({
      root,
      deployment: fixtureDeployment(source.sha256),
      deploymentManifestPath: "docs/prostar-metrics/verification/deployment-manifest.json",
      deploymentManifestSha256: "d".repeat(64),
      e2eReportPath: "docs/prostar-metrics/verification/e2e.json",
      a11yReportPath: "docs/prostar-metrics/verification/a11y.json",
      browserAttestationPath: "docs/prostar-metrics/verification/browser-receipt.json",
      handoffBinding: fixtureHandoff("gate"),
      mandatoryIds: ["F-01"],
      outputDirectory,
      inheritedEnv: secretRichEnvironment(),
      now: () => timestamps.shift(),
      commandExecutor: async ({ argv, env }) => {
        calls += 1;
        if (calls === 1) {
          await writeStructuredResult(env, argv, {
            startedAt: "2026-07-13T20:01:10.000Z",
            completedAt: "2026-07-13T20:01:50.000Z",
          });
        }
        return {
          stdout: Buffer.from("command emitted substantive raw diagnostic output\n"),
          stderr: Buffer.alloc(0),
          exitCode: calls === 2 ? 1 : 0,
          signal: null,
          toolName: argv[0],
          toolVersion: "1.2.3",
        };
      },
    }), /integration gate command failed/);
    await assert.rejects(access(join(root, outputDirectory)), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function fixtureDeployment(buildSourceSha256) {
  return {
    buildSourceSha256,
    deploymentOperationId: "/subscriptions/sub/providers/Microsoft.Resources/deployments/release-operation",
    deploymentRunId: "prostar-metrics-123e4567-e89b-42d3-a456-426614174000",
    deploymentNonce: "123e4567-e89b-42d3-a456-426614174000",
    deployedRevision: "aca-prostar-metrics-prod--0000099",
    imageDigest: `sha256:${"e".repeat(64)}`,
    deployedAt: "2026-07-13T19:00:00.000Z",
    evidenceSigningKeyIds: keyIds,
  };
}

async function makeRunnerRoot() {
  const root = await mkdtemp(join(tmpdir(), "immutable-gate-test-"));
  await writeAt(root, ".dockerignore", [
    "node_modules", "docs/prostar-metrics/verification", "tmp", ".git",
  ].join("\n") + "\n");
  await writeAt(root, "Dockerfile", "FROM scratch\nCOPY . /app\n");
  await writeAt(root, "docs/prostar-metrics/execution-plan.md", "immutable plan fixture\n");
  await writeAt(root, "scripts/check-release-evidence.mjs", "// immutable fixture\n");
  await mkdir(join(root, "node_modules"), { recursive: true });
  return root;
}

async function writeAt(root, path, value) {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, value);
}

function secretRichEnvironment() {
  return {
    PATH: "/usr/bin",
    AZURE_POSTGRES_CONNECTION_STRING: "postgres://minimum-release-db",
    AZURE_POSTGRES_MIGRATION_CONNECTION_STRING: "postgres://migration-secret",
    SIMPRO_BEARER_TOKEN: "simpro-secret",
    RELEASE_GATE_RECEIPT_ISSUER_URL: "https://imaginary.invalid",
    RELEASE_REVIEWER_RECEIPT_ISSUER_URL: "https://imaginary.invalid",
    AZURE_CLIENT_SECRET: "azure-secret",
    UNRELATED_OPERATOR_SECRET: "must-not-leak",
  };
}

function secretNames() {
  return [
    "AZURE_POSTGRES_MIGRATION_CONNECTION_STRING", "SIMPRO_BEARER_TOKEN",
    "RELEASE_GATE_RECEIPT_ISSUER_URL", "RELEASE_REVIEWER_RECEIPT_ISSUER_URL",
    "AZURE_CLIENT_SECRET", "UNRELATED_OPERATOR_SECRET",
  ];
}

function timestampSequence(start, count) {
  const startMs = Date.parse(start);
  return Array.from({ length: count }, (_, index) => new Date(startMs + index * 60_000));
}

async function writeStructuredResult(env, argv, { startedAt, completedAt, results } = {}) {
  const observedResults = results ?? [observedResult(env.RELEASE_GATE_CATEGORY)];
  const document = {
    schemaVersion: STRUCTURED_GATE_RESULT_SCHEMA_VERSION,
    producer: { name: `prostar-${env.RELEASE_GATE_CATEGORY}-test-producer`, version: "1.0.0" },
    category: env.RELEASE_GATE_CATEGORY,
    executionId: env.RELEASE_GATE_EXECUTION_ID,
    runnerCommand: argv,
    command: PRODUCTION_GATE_COMMANDS[env.RELEASE_GATE_CATEGORY],
    startedAt,
    completedAt,
    summary: observedResults.every((result) => result.counts)
      ? summarizeReleaseGateAssertions(observedResults)
      : { claims: observedResults.length, total: 0, passed: 0, failed: 0, skipped: 0, cancelled: 0, todo: 0 },
    results: observedResults,
  };
  await writeFile(env.RELEASE_GATE_RESULT_PATH, jsonBytes(document));
  return document;
}

function observedResult(category, overrides = {}) {
  const outcome = overrides.outcome ?? "PASS";
  const provenance = {
    runner: category === "integration" ? "integration-test" : category === "build" ? "build-check" : "node-test",
    source: category === "build" ? ".next/required-server-files.json" : `tests/evidence/${category}.test.mjs:1:1`,
    assertion: `observed ${category} assertion`,
  };
  const counts = outcome === "FAIL"
    ? { total: 1, passed: 0, failed: 1, skipped: 0, cancelled: 0, todo: 0 }
    : { total: 1, passed: 1, failed: 0, skipped: 0, cancelled: 0, todo: 0 };
  return { id: observedAssertionId({ category, provenance }), outcome, provenance, counts, ...overrides };
}

function jwt(claims) {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(claims)).toString("base64url"),
    "unsigned",
  ].join(".");
}
