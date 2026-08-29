import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  applyReferenceMigration,
  assertEasyAuthContract,
  assertReferenceContract,
  constantTimeSecretEqual,
  patchTargetSecrets,
  parseMigrationArgs,
  putVaultSecret,
  resolveMigrationSource,
  restoreVaultVersions,
  runKeyVaultMigrationWorkflow,
  runWithKnownSecretRedaction,
  verifyUnauthenticatedEasyAuth,
} from "../../scripts/migrate-key-vault-secrets.mjs";
import {
  PRODUCTION_JOB_NAMES,
  PRODUCTION_TARGETS,
  assertExactProductionJobNames,
  assertExactProductionTargets,
} from "../../scripts/lib/production-targets.mjs";

const [monitoringParameters, metricsBicep] = await Promise.all([
  readFile(new URL("../../infra/azure/monitoring.parameters.prod.example.json", import.meta.url), "utf8").then(JSON.parse),
  readFile(new URL("../../infra/azure/metrics.bicep", import.meta.url), "utf8"),
]);

const productionFqdn = "aca-prostar-metrics-prod.thankfulmushroom-31ebfcb1.westus2.azurecontainerapps.io";
const aadTenantId = "515fbfd7-12b1-4238-bb6c-f827588dd488";
const aadClientId = "369bef95-48a6-45db-bad6-1e16278fa229";
const sanitizedLiveNonce = "sanitized-live-nonce-0123456789abcdef";
const identityId = "/subscriptions/sub/resourceGroups/prostar-payroll/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-prostar-dispatch-prod";
const migrationRunId = "4f6f043f-2138-4dbc-9aab-74f512662903";
const appSecretNames = [
  "azure-postgres-connection-string",
  "simpro-bearer-token",
  "microsoft-provider-authentication-secret",
];

function targetBaseline(target, mode) {
  return {
    secrets: appSecretNames.map((name) => mode === "key-vault" ? {
      name,
      keyVaultUrl: `https://kv-prostar-metrics-prod.vault.azure.net/secrets/${name}`,
      identity: identityId,
      value: null,
    } : {
      name,
      keyVaultUrl: null,
      identity: null,
      value: `${target.name}-${name}-value`,
    }),
  };
}

function workflowTargetState(target, mode = "key-vault") {
  const names = target.kind === "app" ? appSecretNames : appSecretNames.slice(0, 2);
  return {
    secrets: names.map((name) => mode === "key-vault" ? {
      name,
      keyVaultUrl: `https://kv-prostar-metrics-prod.vault.azure.net/secrets/${name}`,
      identity: identityId,
      value: null,
      valueInspected: false,
    } : {
      name,
      keyVaultUrl: null,
      identity: null,
      value: null,
      valueInspected: false,
    }),
  };
}

function workflowInlineValueState(target) {
  const names = target.kind === "app" ? appSecretNames : appSecretNames.slice(0, 2);
  return {
    secrets: names.map((name) => ({
      name,
      keyVaultUrl: null,
      identity: null,
      value: `source-${name}`,
      valueInspected: true,
    })),
  };
}

function createWorkflowHarness({ targetMode = "key-vault", versionFactory, healthError } = {}) {
  const vaultId = "/subscriptions/sub/resourceGroups/prostar-payroll/providers/Microsoft.KeyVault/vaults/kv-prostar-metrics-prod";
  const principalId = "application-principal";
  const secretsUserId = "4633458b-17de-408a-b874-0445c86b69e6";
  const counters = {
    azureWrites: 0,
    evidenceWrites: 0,
    healthAuthChecks: 0,
    targetMetadataReads: 0,
    targetValueReads: 0,
    vaultMetadataReads: 0,
    vaultValueReads: 0,
    whatIfChecks: 0,
  };
  const reports = [];
  const writeAttempt = async () => {
    counters.azureWrites += 1;
    throw new Error("unexpected Azure mutation");
  };
  const versionsFor = versionFactory ?? ((name) => [{
    id: `https://kv-prostar-metrics-prod.vault.azure.net/secrets/${name}/active`,
    attributes: { created: 100, enabled: true },
  }]);
  return {
    counters,
    reports,
    operations: {
      async readIdentity() { return { id: identityId, principalId }; },
      async readVault() {
        return {
          id: vaultId,
          name: "kv-prostar-metrics-prod",
          properties: {
            enableRbacAuthorization: true,
            enablePurgeProtection: true,
            enableSoftDelete: true,
            publicNetworkAccess: "Enabled",
            networkAcls: null,
          },
        };
      },
      async readEffectiveRoleAssignments() {
        return [{
          id: "expected-role",
          principalId,
          scope: vaultId,
          roleDefinitionId: `/subscriptions/sub/providers/Microsoft.Authorization/roleDefinitions/${secretsUserId}`,
        }];
      },
      async readRoleDefinitions() { return new Map(); },
      async readAccessContext() {
        return { subscriptionId: "sub", armToken: "arm-token", vaultToken: "vault-token" };
      },
      async readTargetMetadata({ target }) {
        counters.targetMetadataReads += 1;
        return workflowTargetState(target, targetMode);
      },
      async listVaultVersions(name) {
        counters.vaultMetadataReads += 1;
        return structuredClone(versionsFor(name));
      },
      async assertMigrationRunIdUnused() { throw new Error("unexpected fresh run recheck"); },
      async readTargetState() {
        counters.targetValueReads += 1;
        throw new Error("metadata-only workflow read target secret values");
      },
      async readVaultSecretVersion() {
        counters.vaultValueReads += 1;
        throw new Error("metadata-only workflow read a Key Vault secret value");
      },
      async runWhatIf() {
        counters.whatIfChecks += 1;
        return { properties: { changes: [] } };
      },
      async writeEvidence(_directory, evidence) {
        counters.evidenceWrites += 1;
        reports.push(structuredClone(evidence));
        return "/evidence/key-vault-migration.json";
      },
      async verifyHealthAndAuth() {
        counters.healthAuthChecks += 1;
        if (healthError) throw healthError;
      },
      putVaultSecret: writeAttempt,
      assertOwnedMigrationWrites: writeAttempt,
      restoreVaultVersions: writeAttempt,
      patchTargetSecrets: writeAttempt,
      restartLatestRevision: writeAttempt,
    },
  };
}

function productionAuthContract() {
  return {
    platform: { enabled: true },
    globalValidation: {
      excludedPaths: ["/api/health"],
      redirectToProvider: "AzureActiveDirectory",
      unauthenticatedClientAction: "RedirectToLoginPage",
    },
    httpSettings: { forwardProxy: { convention: "Standard" }, requireHttps: true },
    identityProviders: {
      azureActiveDirectory: {
        isAutoProvisioned: false,
        registration: {
          clientId: aadClientId,
          clientSecretSettingName: "microsoft-provider-authentication-secret",
          openIdIssuer: `https://login.microsoftonline.com/${aadTenantId}/v2.0`,
        },
        validation: { allowedAudiences: [aadClientId, `api://${aadClientId}`] },
      },
    },
    login: { preserveUrlFragmentsForLogins: false },
  };
}

function authorizeLocation(overrides = {}) {
  const nonce = overrides.nonce ?? sanitizedLiveNonce;
  const url = new URL(`https://login.microsoftonline.com/${aadTenantId}/oauth2/v2.0/authorize`);
  url.searchParams.set("client_id", aadClientId);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("redirect_uri", `https://${productionFqdn}/.auth/login/aad/callback`);
  url.searchParams.set("response_mode", "form_post");
  url.searchParams.set("response_type", "code id_token");
  url.searchParams.set("scope", "openid profile email");
  url.searchParams.set("state", "redir=%2Fquotes");
  for (const [name, value] of Object.entries(overrides)) {
    if (name === "origin") {
      const replacement = new URL(value);
      url.protocol = replacement.protocol;
      url.hostname = replacement.hostname;
    } else if (name === "pathname") {
      url.pathname = value;
    } else {
      url.searchParams.set(name, value);
    }
  }
  return url.href;
}

function probeResponse(status, location = null) {
  return {
    status,
    headers: { get: (name) => name.toLowerCase() === "location" ? location : null },
  };
}

function authProbeFetch({ browserStatus = 302, browserLocation = authorizeLocation(), apiStatus = 401, apiLocation = null } = {}) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return options.headers.accept === "text/html"
        ? probeResponse(browserStatus, browserLocation)
        : probeResponse(apiStatus, apiLocation);
    },
  };
}

test("migration execution requires the fixed confirmation and rejects every target override", () => {
  assert.equal(parseMigrationArgs([]).execute, false);
  assert.throws(() => parseMigrationArgs(["--execute"]), /MIGRATE-PROSTAR-METRICS-KEY-VAULT/);
  assert.equal(parseMigrationArgs([
    "--execute",
    "--confirm=MIGRATE-PROSTAR-METRICS-KEY-VAULT",
  ]).execute, true);
  const writerFreeze = parseMigrationArgs([
    "--execute",
    "--confirm=MIGRATE-PROSTAR-METRICS-KEY-VAULT",
    "--writer-freeze-id=4F6F043F-2138-4DBC-9AAB-74F512662903",
    "--confirm-writer-freeze=NO-CONCURRENT-PROSTAR-METRICS-SECRET-WRITERS",
  ]);
  assert.equal(writerFreeze.writerFreezeConfirmed, true);
  assert.equal(writerFreeze.writerFreezeId, "4f6f043f-2138-4dbc-9aab-74f512662903");
  assert.throws(() => parseMigrationArgs([
    "--execute",
    "--confirm=MIGRATE-PROSTAR-METRICS-KEY-VAULT",
    "--writer-freeze-id=not-a-uuid",
    "--confirm-writer-freeze=NO-CONCURRENT-PROSTAR-METRICS-SECRET-WRITERS",
  ]), /fresh UUIDv4/);
  assert.throws(() => parseMigrationArgs([
    "--execute",
    "--confirm=MIGRATE-PROSTAR-METRICS-KEY-VAULT",
    "--writer-freeze-id=4f6f043f-2138-4dbc-9aab-74f512662903",
  ]), /must be supplied together/);
  for (const override of [
    "--resource-group=other",
    "--app-name=other",
    "--vault-name=other",
    "--identity-name=other",
    "--include-ca",
  ]) assert.throws(() => parseMigrationArgs([override]), /Unknown migration argument/);
  assert.throws(
    () => parseMigrationArgs(["--confirm=MIGRATE-PROSTAR-METRICS-KEY-VAULT"]),
    /only with --execute/,
  );
});

test("canonical production targets are frozen and match monitoring plus metrics exactly", () => {
  const monitoringJobs = monitoringParameters.parameters.containerAppsJobNames.value;
  assert.equal(PRODUCTION_JOB_NAMES.length, 24);
  assert.equal(PRODUCTION_TARGETS.length, 25);
  assert.ok(Object.isFrozen(PRODUCTION_JOB_NAMES));
  assert.ok(Object.isFrozen(PRODUCTION_TARGETS));
  assert.ok(PRODUCTION_TARGETS.every(Object.isFrozen));
  assert.deepEqual(assertExactProductionJobNames(monitoringJobs), [...PRODUCTION_JOB_NAMES].sort());
  const bicepJobs = [...new Set([...metricsBicep.matchAll(/'(job-[^']+)'/g)].map((match) => match[1]))];
  assert.deepEqual(assertExactProductionJobNames(bicepJobs), [...PRODUCTION_JOB_NAMES].sort());
  assert.equal(assertExactProductionTargets(PRODUCTION_TARGETS), PRODUCTION_TARGETS);
  assert.throws(() => assertExactProductionTargets(PRODUCTION_TARGETS.slice(1)), /immutable app plus exact 24-job/);
  assert.throws(
    () => assertExactProductionTargets([...PRODUCTION_TARGETS, { ...PRODUCTION_TARGETS[0] }]),
    /immutable app plus exact 24-job/,
  );
});

test("reference verification requires the exact set, versionless URL, identity, and no inline value", () => {
  const expected = [{
    name: "azure-postgres-connection-string",
    keyVaultUrl: "https://kv-prostar-metrics-prod.vault.azure.net/secrets/azure-postgres-connection-string",
    identity: "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id",
  }];
  assert.doesNotThrow(() => assertReferenceContract([{ ...expected[0] }], expected));
  assert.throws(() => assertReferenceContract([{ ...expected[0], value: "inline" }], expected), /Invalid/);
  assert.throws(
    () => assertReferenceContract([{ ...expected[0], keyVaultUrl: `${expected[0].keyVaultUrl}/version` }], expected),
    /Invalid/,
  );
  assert.throws(() => assertReferenceContract([], expected), /exact allowlist/);
  assert.throws(() => assertReferenceContract([...expected, { ...expected[0], name: "other" }], expected), /exact allowlist/);
});

test("migration source resolution classifies exact inline and referenced states and rejects mixed state", () => {
  const targets = [{ kind: "app", name: "web" }];
  const inline = new Map([["app:web", targetBaseline(targets[0], "inline")]]);
  const referenced = new Map([["app:web", targetBaseline(targets[0], "key-vault")]]);
  assert.deepEqual(resolveMigrationSource({
    baselines: inline,
    targets,
    includeCa: false,
    identityId,
  }), { alreadyReferenced: false });
  assert.deepEqual(resolveMigrationSource({
    baselines: referenced,
    targets,
    includeCa: false,
    identityId,
  }), { alreadyReferenced: true });

  const mixedBaseline = targetBaseline(targets[0], "inline");
  mixedBaseline.secrets[0] = targetBaseline(targets[0], "key-vault").secrets[0];
  assert.throws(() => resolveMigrationSource({
    baselines: new Map([["app:web", mixedBaseline]]),
    targets,
    includeCa: false,
    identityId,
  }), /mixed inline and Key Vault reference state/);

  const wrongReference = targetBaseline(targets[0], "key-vault");
  wrongReference.secrets[0].keyVaultUrl += "/unexpected-version";
  assert.throws(() => resolveMigrationSource({
    baselines: new Map([["app:web", wrongReference]]),
    targets,
    includeCa: false,
    identityId,
  }), /Invalid Key Vault reference contract/);
});

test("complete already-referenced workflow is a schema-v3 metadata-only no-op across all 25 targets", async () => {
  const { counters, operations, reports } = createWorkflowHarness();
  const outcome = await runKeyVaultMigrationWorkflow({
    args: parseMigrationArgs([
      "--execute",
      "--confirm=MIGRATE-PROSTAR-METRICS-KEY-VAULT",
    ]),
    includeCa: false,
    targets: PRODUCTION_TARGETS,
    operations,
    now: () => "2026-07-13T12:00:00.000Z",
  });
  assert.deepEqual(outcome.result, {
    changed: 0,
    verified: 25,
    verificationMode: "metadata-only",
    secretValuesAccessed: false,
  });
  assert.equal(counters.targetMetadataReads, 50);
  assert.equal(counters.vaultMetadataReads, 6);
  assert.equal(counters.targetValueReads, 0);
  assert.equal(counters.vaultValueReads, 0);
  assert.equal(counters.azureWrites, 0);
  assert.equal(counters.whatIfChecks, 1);
  assert.equal(counters.healthAuthChecks, 1);
  assert.equal(counters.evidenceWrites, 1);
  assert.equal(reports.length, 1);
  assert.deepEqual(outcome.evidence, reports[0]);
  assert.deepEqual({
    schemaVersion: reports[0].schemaVersion,
    status: reports[0].status,
    initialSecretMode: reports[0].initialSecretMode,
    verificationMode: reports[0].verificationMode,
    secretValuesAccessed: reports[0].secretValuesAccessed,
    secretValuesWritten: reports[0].secretValuesWritten,
    operatorSecretsOfficerRequired: reports[0].operatorSecretsOfficerRequired,
    migrationRunId: reports[0].migrationRunId,
    noOpVerified: reports[0].noOpVerified,
    targetCount: reports[0].targetCount,
    referencesVerified: reports[0].referencesVerified,
  }, {
    schemaVersion: 3,
    status: "succeeded",
    initialSecretMode: "key-vault",
    verificationMode: "metadata-only",
    secretValuesAccessed: false,
    secretValuesWritten: false,
    operatorSecretsOfficerRequired: false,
    migrationRunId: null,
    noOpVerified: true,
    targetCount: 25,
    referencesVerified: 25,
  });
  assert.equal(reports[0].targetBaseline.length, 25);
  assert.equal(reports[0].vaultVersionBaseline.length, 3);
  assert.ok(reports[0].targetBaseline.every(({ secrets }) => secrets.every((secret) => (
    secret.mode === "key-vault" && secret.valueInspected === false && !("valuePresent" in secret)
  ))));
  assert.ok(reports[0].vaultVersionBaseline.every(({ activeVersionId }) => activeVersionId?.endsWith("/active")));
});

test("workflow rejects reused migration run IDs case-insensitively before every value read or mutation", async () => {
  for (const [tagRunId, argumentRunId] of [
    [migrationRunId, migrationRunId.toUpperCase()],
    [migrationRunId.toUpperCase(), migrationRunId],
  ]) {
    const { counters, operations } = createWorkflowHarness({
      targetMode: "inline",
      versionFactory: (name) => [{
        id: `https://kv-prostar-metrics-prod.vault.azure.net/secrets/${name}/owned-old-run`,
        attributes: { created: 100, enabled: true },
        tags: { "prostar-metrics-migration-run-id": tagRunId },
      }],
    });
    await assert.rejects(runKeyVaultMigrationWorkflow({
      args: parseMigrationArgs([
        "--execute",
        "--confirm=MIGRATE-PROSTAR-METRICS-KEY-VAULT",
        `--writer-freeze-id=${argumentRunId}`,
        "--confirm-writer-freeze=NO-CONCURRENT-PROSTAR-METRICS-SECRET-WRITERS",
      ]),
      includeCa: false,
      targets: PRODUCTION_TARGETS,
      operations,
    }), /not fresh/);
    assert.equal(counters.targetMetadataReads, 25);
    assert.equal(counters.vaultMetadataReads, 3);
    assert.equal(counters.targetValueReads, 0);
    assert.equal(counters.vaultValueReads, 0);
    assert.equal(counters.azureWrites, 0);
    assert.equal(counters.whatIfChecks, 0);
    assert.equal(counters.evidenceWrites, 0);
  }
});

test("workflow rejects malformed migration ownership tags before every value read or mutation", async () => {
  const { counters, operations } = createWorkflowHarness({
    targetMode: "inline",
    versionFactory: (name) => [{
      id: `https://kv-prostar-metrics-prod.vault.azure.net/secrets/${name}/malformed-owner`,
      attributes: { created: 100, enabled: true },
      tags: { "prostar-metrics-migration-run-id": "not-a-uuid" },
    }],
  });
  await assert.rejects(runKeyVaultMigrationWorkflow({
    args: parseMigrationArgs([
      "--execute",
      "--confirm=MIGRATE-PROSTAR-METRICS-KEY-VAULT",
      `--writer-freeze-id=${migrationRunId}`,
      "--confirm-writer-freeze=NO-CONCURRENT-PROSTAR-METRICS-SECRET-WRITERS",
    ]),
    includeCa: false,
    targets: PRODUCTION_TARGETS,
    operations,
  }), /malformed migration run ownership tag/);
  assert.equal(counters.targetMetadataReads, 25);
  assert.equal(counters.vaultMetadataReads, 3);
  assert.equal(counters.targetValueReads, 0);
  assert.equal(counters.vaultValueReads, 0);
  assert.equal(counters.azureWrites, 0);
  assert.equal(counters.whatIfChecks, 0);
  assert.equal(counters.evidenceWrites, 0);
});

test("workflow uses the lowercase migration run ID for reports and every operation binding", async () => {
  const harness = createWorkflowHarness({ targetMode: "inline" });
  const boundRunIds = [];
  harness.operations.readTargetState = async ({ target, knownSecretValues }) => {
    harness.counters.targetValueReads += 1;
    const state = workflowInlineValueState(target);
    for (const secret of state.secrets) knownSecretValues.add(secret.value);
    return state;
  };
  harness.operations.readVaultSecretVersion = async (versionId) => {
    harness.counters.vaultValueReads += 1;
    return { id: versionId, value: `prior-${new URL(versionId).pathname.split("/")[2]}`, attributes: { enabled: true } };
  };
  harness.operations.assertMigrationRunIdUnused = async (_names, _token, runId) => boundRunIds.push(runId);
  harness.operations.putVaultSecret = async (_name, _value, _token, options) => {
    harness.counters.azureWrites += 1;
    boundRunIds.push(options.migrationRunId);
  };
  harness.operations.assertOwnedMigrationWrites = async (_names, _token, runId) => boundRunIds.push(runId);
  harness.operations.patchTargetSecrets = async () => {
    harness.counters.azureWrites += 1;
    throw new Error("synthetic stop after canonical run binding");
  };
  harness.operations.restoreVaultVersions = async ({ migrationRunId: runId }) => boundRunIds.push(runId);
  harness.operations.restartLatestRevision = async () => { harness.counters.azureWrites += 1; };

  const parsedArgs = parseMigrationArgs([
    "--execute",
    "--confirm=MIGRATE-PROSTAR-METRICS-KEY-VAULT",
    `--writer-freeze-id=${migrationRunId.toUpperCase()}`,
    "--confirm-writer-freeze=NO-CONCURRENT-PROSTAR-METRICS-SECRET-WRITERS",
  ]);
  await assert.rejects(runKeyVaultMigrationWorkflow({
    args: { ...parsedArgs, writerFreezeId: migrationRunId.toUpperCase() },
    includeCa: false,
    targets: PRODUCTION_TARGETS,
    operations: harness.operations,
  }), /synthetic stop after canonical run binding/);
  assert.ok(boundRunIds.length > 0);
  assert.ok(boundRunIds.every((runId) => runId === migrationRunId));
  assert.equal(harness.reports.length, 1);
  assert.equal(harness.reports[0].migrationRunId, migrationRunId);
  assert.doesNotMatch(JSON.stringify(harness.reports[0]), /4F6F043F|4DBC|9AAB/);
});

test("top-level workflow failure diagnostics retain the known-value redaction set", async () => {
  const marker = "known-unlabelled-value-482901";
  const credentialUrl = "https://operator:credential-material@example.test/private";
  const knownSecretValues = new Set([marker]);
  const { counters, operations, reports } = createWorkflowHarness({
    healthError: new Error(`health failed ${marker} at ${credentialUrl}`),
  });
  let reportedDiagnostics;
  await assert.rejects(runWithKnownSecretRedaction({
    knownSecretValues,
    reportFailure: (diagnostics) => { reportedDiagnostics = diagnostics; },
    run: () => runKeyVaultMigrationWorkflow({
      args: parseMigrationArgs([
        "--execute",
        "--confirm=MIGRATE-PROSTAR-METRICS-KEY-VAULT",
      ]),
      includeCa: false,
      targets: PRODUCTION_TARGETS,
      operations,
      knownSecretValues,
    }),
  }), /health failed/);
  const serializedReport = JSON.stringify(reportedDiagnostics);
  const serializedEvidence = JSON.stringify(reports[0]);
  assert.doesNotMatch(serializedReport, /known-unlabelled-value|credential-material/);
  assert.doesNotMatch(serializedEvidence, /known-unlabelled-value|credential-material/);
  assert.match(serializedReport, /REDACTED/);
  assert.match(serializedEvidence, /REDACTED/);
  assert.equal(counters.targetValueReads, 0);
  assert.equal(counters.vaultValueReads, 0);
  assert.equal(counters.azureWrites, 0);
});

test("workflow evidence records that compensation preserved a concurrent active rotation", async () => {
  const harness = createWorkflowHarness({ targetMode: "inline" });
  const concurrentVersionId = "https://kv-prostar-metrics-prod.vault.azure.net/secrets/simpro-bearer-token/concurrent";
  harness.operations.readTargetState = async ({ target, knownSecretValues }) => {
    harness.counters.targetValueReads += 1;
    const state = workflowInlineValueState(target);
    for (const secret of state.secrets) knownSecretValues.add(secret.value);
    return state;
  };
  harness.operations.readVaultSecretVersion = async (versionId) => {
    harness.counters.vaultValueReads += 1;
    const name = new URL(versionId).pathname.split("/")[2];
    return {
      id: versionId,
      value: `prior-${name}`,
      attributes: { enabled: true },
    };
  };
  harness.operations.assertMigrationRunIdUnused = async () => {};
  harness.operations.putVaultSecret = async () => { harness.counters.azureWrites += 1; };
  harness.operations.assertOwnedMigrationWrites = async () => {};
  harness.operations.patchTargetSecrets = async () => {
    harness.counters.azureWrites += 1;
    throw new Error("synthetic target patch failure");
  };
  harness.operations.restoreVaultVersions = async ({ onResult }) => {
    onResult({
      name: "simpro-bearer-token",
      disabledMigrationVersions: ["owned-version"],
      compensationAction: "concurrent-rotation-preserved",
      baselineRestored: false,
      concurrentRotationPreserved: true,
      activeVersionId: concurrentVersionId,
      preservedConcurrentVersionId: concurrentVersionId,
      unrelatedPostBaselineVersionIds: [concurrentVersionId],
      restoredFromVersionId: null,
      restoredVersionId: null,
    });
  };
  harness.operations.restartLatestRevision = async () => { harness.counters.azureWrites += 1; };

  await assert.rejects(runKeyVaultMigrationWorkflow({
    args: parseMigrationArgs([
      "--execute",
      "--confirm=MIGRATE-PROSTAR-METRICS-KEY-VAULT",
      `--writer-freeze-id=${migrationRunId}`,
      "--confirm-writer-freeze=NO-CONCURRENT-PROSTAR-METRICS-SECRET-WRITERS",
    ]),
    includeCa: false,
    targets: PRODUCTION_TARGETS,
    operations: harness.operations,
  }), /synthetic target patch failure/);
  assert.equal(harness.reports.length, 1);
  assert.equal(harness.reports[0].status, "failed");
  assert.deepEqual(harness.reports[0].vaultRollback, [{
    name: "simpro-bearer-token",
    disabledMigrationVersions: ["owned-version"],
    compensationAction: "concurrent-rotation-preserved",
    baselineRestored: false,
    concurrentRotationPreserved: true,
    activeVersionId: concurrentVersionId,
    preservedConcurrentVersionId: concurrentVersionId,
    unrelatedPostBaselineVersionIds: [concurrentVersionId],
    restoredFromVersionId: null,
    restoredVersionId: null,
  }]);
});

test("workflow evidence upserts compensation phases to one final incomplete per-secret journal", async () => {
  const harness = createWorkflowHarness({ targetMode: "inline" });
  harness.operations.readTargetState = async ({ target, knownSecretValues }) => {
    harness.counters.targetValueReads += 1;
    const state = workflowInlineValueState(target);
    for (const secret of state.secrets) knownSecretValues.add(secret.value);
    return state;
  };
  harness.operations.readVaultSecretVersion = async (versionId) => ({
    id: versionId,
    value: `prior-${new URL(versionId).pathname.split("/")[2]}`,
    attributes: { enabled: true },
  });
  harness.operations.assertMigrationRunIdUnused = async () => {};
  harness.operations.putVaultSecret = async () => {};
  harness.operations.assertOwnedMigrationWrites = async () => {};
  harness.operations.patchTargetSecrets = async () => { throw new Error("synthetic patch failure"); };
  harness.operations.restoreVaultVersions = async ({ onResult }) => {
    const shared = {
      name: "simpro-bearer-token",
      failurePhase: null,
      failure: null,
      ownedMigrationVersions: ["owned-version"],
      disabledMigrationVersions: [],
      compensationAction: "pending",
      baselineRestored: false,
      concurrentRotationPreserved: false,
      activeVersionId: null,
      preservedConcurrentVersionId: null,
      unrelatedPostBaselineVersionIds: [],
      restoredFromVersionId: null,
      restoredVersionId: null,
    };
    onResult({ ...shared, status: "in-progress", lastCompletedPhase: "journal-created" });
    onResult({
      ...shared,
      status: "in-progress",
      lastCompletedPhase: "owned-version-disabled",
      disabledMigrationVersions: ["owned-version"],
    });
    onResult({
      ...shared,
      status: "incomplete",
      lastCompletedPhase: "owned-versions-disabled-verified",
      failurePhase: "plan-compensation",
      failure: "manual-reconciliation-required",
      disabledMigrationVersions: ["owned-version"],
    });
    throw new Error("ambiguous compensation ordering");
  };
  harness.operations.restartLatestRevision = async () => {};

  await assert.rejects(runKeyVaultMigrationWorkflow({
    args: parseMigrationArgs([
      "--execute",
      "--confirm=MIGRATE-PROSTAR-METRICS-KEY-VAULT",
      `--writer-freeze-id=${migrationRunId}`,
      "--confirm-writer-freeze=NO-CONCURRENT-PROSTAR-METRICS-SECRET-WRITERS",
    ]),
    includeCa: false,
    targets: PRODUCTION_TARGETS,
    operations: harness.operations,
  }), /rollback verification was incomplete/);
  assert.equal(harness.reports.length, 1);
  assert.equal(harness.reports[0].vaultRollback.length, 1);
  assert.deepEqual(harness.reports[0].vaultRollback[0], {
    name: "simpro-bearer-token",
    status: "incomplete",
    lastCompletedPhase: "owned-versions-disabled-verified",
    failurePhase: "plan-compensation",
    failure: "manual-reconciliation-required",
    ownedMigrationVersions: ["owned-version"],
    disabledMigrationVersions: ["owned-version"],
    compensationAction: "pending",
    baselineRestored: false,
    concurrentRotationPreserved: false,
    activeVersionId: null,
    preservedConcurrentVersionId: null,
    unrelatedPostBaselineVersionIds: [],
    restoredFromVersionId: null,
    restoredVersionId: null,
  });
});

test("target patch performs a fresh exact-state guard before PATCH and fails closed on drift", async () => {
  const target = { kind: "app", name: "web" };
  const baseline = targetBaseline(target, "inline");
  const definitions = targetBaseline(target, "key-vault").secrets.map(({ name, keyVaultUrl, identity }) => ({
    name,
    keyVaultUrl,
    identity,
  }));
  const requests = [];
  await patchTargetSecrets({
    target,
    definitions,
    subscriptionId: "sub",
    armToken: "opaque-token",
    includeCa: false,
    readState: async () => baseline,
    assertCurrent: (current) => assert.equal(current, baseline),
    request: async (url, options) => { requests.push({ url, options }); },
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.method, "PATCH");
  assert.deepEqual(requests[0].options.body, { properties: { configuration: { secrets: definitions } } });

  let patchAttempted = false;
  await assert.rejects(patchTargetSecrets({
    target,
    definitions,
    subscriptionId: "sub",
    armToken: "opaque-token",
    includeCa: false,
    readState: async () => ({ secrets: [] }),
    assertCurrent: () => { throw new Error("fresh state drifted"); },
    request: async () => { patchAttempted = true; },
  }), /fresh state drifted/);
  assert.equal(patchAttempted, false);
});

test("Key Vault secret creation durably marks the returned version with exact run ownership", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), method: init.method, body });
    return new Response(JSON.stringify({
      id: `${String(url).split("?")[0]}/owned-version`,
      attributes: { enabled: true },
      tags: body.tags,
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await putVaultSecret("simpro-bearer-token", "unprinted-test-value", "opaque-token", {
      migrationRunId: migrationRunId.toUpperCase(),
      phase: "source-write",
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "PUT");
    assert.equal(calls[0].body.tags["prostar-metrics-migration-run-id"], migrationRunId);
    assert.equal(calls[0].body.tags["prostar-metrics-migration-phase"], "source-write");
    await assert.rejects(putVaultSecret("simpro-bearer-token", "phase-test-value", "opaque-token", {
      migrationRunId,
      phase: "unknown",
    }), /exact owned phase/);
    assert.equal(calls.length, 1);
    globalThis.fetch = async (url) => new Response(JSON.stringify({
      id: `${String(url).split("?")[0]}/unverified-version`,
      attributes: { enabled: true },
      tags: {},
    }), { status: 200, headers: { "content-type": "application/json" } });
    await assert.rejects(putVaultSecret("simpro-bearer-token", "another-test-value", "opaque-token", {
      migrationRunId,
      phase: "source-write",
    }), /did not return enabled version metadata/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("secret equality performs exactly one fixed-size comparison for equal and unequal strings", () => {
  for (const [left, right, expected] of [
    ["same-value", "same-value", true],
    ["same-value", "same-valuE", false],
    ["short", "longer-value", false],
  ]) {
    const calls = [];
    const actual = constantTimeSecretEqual(left, right, (leftDigest, rightDigest) => {
      calls.push([leftDigest.length, rightDigest.length]);
      return Buffer.compare(leftDigest, rightDigest) === 0;
    });
    assert.equal(actual, expected);
    assert.deepEqual(calls, [[32, 32]]);
  }
  assert.equal(constantTimeSecretEqual(null, "value"), false);
});

test("migration Easy Auth verification requires exact ARM metadata", () => {
  assert.doesNotThrow(() => assertEasyAuthContract(productionAuthContract()));
  const mutations = [
    (auth) => { auth.platform.enabled = false; },
    (auth) => { auth.globalValidation.unauthenticatedClientAction = "Return401"; },
    (auth) => { auth.globalValidation.excludedPaths = ["/api/health", "/api/other"]; },
    (auth) => { auth.globalValidation.redirectToProvider = "Google"; },
    (auth) => { auth.httpSettings.requireHttps = false; },
    (auth) => { auth.httpSettings.forwardProxy.convention = "NoProxy"; },
    (auth) => { auth.identityProviders.azureActiveDirectory.isAutoProvisioned = true; },
    (auth) => { auth.identityProviders.azureActiveDirectory.registration.clientId = "wrong"; },
    (auth) => { auth.identityProviders.azureActiveDirectory.registration.openIdIssuer = "https://login.microsoftonline.com/common/v2.0"; },
    (auth) => { auth.identityProviders.azureActiveDirectory.registration.clientSecretSettingName = "wrong"; },
    (auth) => { auth.identityProviders.azureActiveDirectory.validation.allowedAudiences = [aadClientId]; },
    (auth) => { auth.login.preserveUrlFragmentsForLogins = true; },
  ];
  for (const mutate of mutations) {
    const auth = productionAuthContract();
    mutate(auth);
    assert.throws(() => assertEasyAuthContract(auth), /ARM contract changed/);
  }
});

test("migration Easy Auth verification uses separate browser and API probes", async () => {
  const { calls, fetchImpl } = authProbeFetch();
  await verifyUnauthenticatedEasyAuth(fetchImpl, productionFqdn);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, `https://${productionFqdn}/quotes`);
  assert.equal(calls[0].options.headers.accept, "text/html");
  assert.match(calls[0].options.headers["user-agent"], /Chrome/);
  assert.equal(calls[0].options.redirect, "manual");
  assert.equal(calls[1].options.headers.accept, "application/json");
  assert.equal(calls[1].options.headers["user-agent"], "prostar-rollout-probe/1.0");
  assert.equal(calls[1].options.redirect, "manual");
});

test("migration Easy Auth verification rejects browser and API drift", async (t) => {
  const mutateLocation = (mutate) => {
    const url = new URL(authorizeLocation());
    mutate(url);
    return url.href;
  };
  const cases = [
    ["wrong AAD host", { browserLocation: authorizeLocation({ origin: "https://login.example.test" }) }],
    ["wrong tenant", { browserLocation: authorizeLocation({ pathname: "/common/oauth2/v2.0/authorize" }) }],
    ["wrong client", { browserLocation: authorizeLocation({ client_id: "wrong" }) }],
    ["wrong callback", { browserLocation: authorizeLocation({ redirect_uri: "https://other.example.test/.auth/login/aad/callback" }) }],
    ["wrong state", { browserLocation: authorizeLocation({ state: "redir=%2Fadmin" }) }],
    ["missing response type", { browserLocation: mutateLocation((url) => url.searchParams.delete("response_type")) }],
    ["wrong response type", { browserLocation: authorizeLocation({ response_type: "code" }) }],
    ["duplicate response type", { browserLocation: mutateLocation((url) => url.searchParams.append("response_type", "code id_token")) }],
    ["missing response mode", { browserLocation: mutateLocation((url) => url.searchParams.delete("response_mode")) }],
    ["wrong response mode", { browserLocation: authorizeLocation({ response_mode: "query" }) }],
    ["duplicate response mode", { browserLocation: mutateLocation((url) => url.searchParams.append("response_mode", "form_post")) }],
    ["missing scope", { browserLocation: mutateLocation((url) => url.searchParams.delete("scope")) }],
    ["wrong scope", { browserLocation: authorizeLocation({ scope: "openid profile" }) }],
    ["duplicate scope", { browserLocation: mutateLocation((url) => url.searchParams.append("scope", "openid profile email")) }],
    ["duplicate client ID", { browserLocation: mutateLocation((url) => url.searchParams.append("client_id", aadClientId)) }],
    ["duplicate top-level nonce", { browserLocation: mutateLocation((url) => url.searchParams.append("nonce", sanitizedLiveNonce)) }],
    ["extra authorization parameter", { browserLocation: mutateLocation((url) => url.searchParams.set("prompt", "login")) }],
    ["invalid nonce shape", { browserLocation: authorizeLocation({ nonce: "short" }) }],
    ["missing state key", { browserLocation: authorizeLocation({ state: "" }) }],
    ["duplicate state redirect", { browserLocation: mutateLocation((url) => {
      const state = new URLSearchParams(url.searchParams.get("state"));
      state.append("redir", "/quotes");
      url.searchParams.set("state", state);
    }) }],
    ["extra state parameter", { browserLocation: mutateLocation((url) => {
      const state = new URLSearchParams(url.searchParams.get("state"));
      state.set("nonce", sanitizedLiveNonce);
      url.searchParams.set("state", state);
    }) }],
    ["Node 401 substituted for browser probe", { browserStatus: 401, browserLocation: null }],
    ["API redirect", { apiStatus: 302, apiLocation: authorizeLocation() }],
  ];
  for (const [name, options] of cases) {
    await t.test(name, async () => {
      await assert.rejects(
        verifyUnauthenticatedEasyAuth(authProbeFetch(options).fetchImpl, productionFqdn),
        /Browser Easy Auth probe|production authorization contract|API Easy Auth probe/,
      );
    });
  }
});

test("verification failure restores vault versions first, then all attempted targets in reverse order", async () => {
  const targets = Array.from({ length: 25 }, (_, index) => ({ name: `target-${index}` }));
  const events = [];
  await assert.rejects(
    applyReferenceMigration({
      targets,
      operations: {
        async writeVaultSecrets() { events.push("vault-write"); },
        async restoreVaultVersions() { events.push("vault-restore"); },
        async setReferences(target) { events.push(`set:${target.name}`); },
        async verifyReferences(target) {
          events.push(`verify:${target.name}`);
          if (target.name === "target-12") throw new Error("verification failed");
        },
        async activateReferences() { events.push("activate"); },
        async verifyHealthAndAuth() { events.push("health"); },
        async restoreBaseline(target) { events.push(`restore:${target.name}`); },
        async activateRollback() { events.push("activate-rollback"); },
        async verifyRollback() { events.push("verify-rollback"); },
      },
    }),
    /verification failed/,
  );

  assert.equal(events.filter((entry) => entry.startsWith("set:")).length, 25);
  assert.equal(events.indexOf("vault-restore") < events.findIndex((entry) => entry.startsWith("restore:")), true);
  assert.deepEqual(
    events.filter((entry) => entry.startsWith("restore:")),
    [...targets].reverse().map((target) => `restore:${target.name}`),
  );
  assert.equal(events.includes("activate"), false);
  assert.deepEqual(events.slice(-2), ["activate-rollback", "verify-rollback"]);
});

test("partial vault write failure still runs version rollback before target verification", async () => {
  const events = [];
  await assert.rejects(applyReferenceMigration({
    targets: [{ name: "web" }],
    operations: {
      async writeVaultSecrets() { events.push("vault-write"); throw new Error("second secret failed"); },
      async restoreVaultVersions() { events.push("vault-restore"); },
      async setReferences() { events.push("unexpected-set"); },
      async verifyReferences() {},
      async activateReferences() {},
      async verifyHealthAndAuth() {},
      async restoreBaseline() { events.push("unexpected-target-restore"); },
      async activateRollback() { events.push("activate-rollback"); },
      async verifyRollback() { events.push("verify-rollback"); },
    },
  }), /second secret failed/);
  assert.deepEqual(events, ["vault-write", "vault-restore", "activate-rollback", "verify-rollback"]);
});

test("vault rollback preserves a newer concurrent version as versionless active and publishes no baseline restore", async () => {
  const priorId = "https://kv-prostar-metrics-prod.vault.azure.net/secrets/simpro-bearer-token/prior";
  const ownedId = "https://kv-prostar-metrics-prod.vault.azure.net/secrets/simpro-bearer-token/owned";
  const olderConcurrentId = "https://kv-prostar-metrics-prod.vault.azure.net/secrets/simpro-bearer-token/concurrent-older";
  const concurrentId = "https://kv-prostar-metrics-prod.vault.azure.net/secrets/simpro-bearer-token/concurrent";
  const calls = [];
  const originalFetch = globalThis.fetch;
  let ownedEnabled = true;
  const concurrentEnabled = true;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null });
    if (String(url).includes("/versions?")) {
      return new Response(JSON.stringify({
        value: [
          { id: priorId, attributes: { created: 10, enabled: true } },
          {
            id: ownedId,
            attributes: { created: 20, enabled: ownedEnabled },
            tags: {
              "prostar-metrics-migration-run-id": migrationRunId.toUpperCase(),
              "prostar-metrics-migration-phase": "source-write",
            },
          },
          { id: olderConcurrentId, attributes: { created: 25, enabled: true }, tags: { writer: "rotation-a" } },
          { id: concurrentId, attributes: { created: 30, enabled: concurrentEnabled }, tags: { writer: "rotation-b" } },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (init.method === "PATCH") {
      assert.equal(String(url).startsWith(ownedId), true);
      ownedEnabled = false;
      return new Response(JSON.stringify({ id: ownedId, attributes: { enabled: false } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected ${init.method ?? "GET"} request`);
  };
  try {
    const reportedOutcomes = [];
    const persistedOutcomes = new Map();
    const result = await restoreVaultVersions({
      names: ["simpro-bearer-token"],
      token: "opaque-token",
      migrationRunId,
      onResult: (outcome) => {
        reportedOutcomes.push(outcome);
        persistedOutcomes.set(outcome.name, outcome);
      },
      baselines: new Map([["simpro-bearer-token", {
        versionIds: new Set([priorId]),
        active: {
          id: priorId,
          value: "prior-raw-value",
          contentType: "application/x-simpro-bearer-token",
          tags: null,
          attributes: { enabled: true },
        },
      }]]),
    });
    assert.deepEqual(calls.map(({ method }) => method), ["GET", "PATCH", "GET"]);
    assert.equal(calls[1].url.startsWith(ownedId), true);
    assert.deepEqual(calls[1].body, { attributes: { enabled: false } });
    assert.equal(calls.some(({ method }) => method === "PUT"), false);
    assert.equal(calls.some(({ method, url }) => method === "PATCH" && url.startsWith(concurrentId)), false);
    assert.equal(concurrentEnabled, true);
    assert.deepEqual(result[0].disabledMigrationVersions, [ownedId]);
    assert.equal(result[0].compensationAction, "concurrent-rotation-preserved");
    assert.equal(result[0].concurrentRotationPreserved, true);
    assert.equal(result[0].baselineRestored, false);
    assert.equal(result[0].activeVersionId, concurrentId);
    assert.equal(result[0].preservedConcurrentVersionId, concurrentId);
    assert.deepEqual(result[0].unrelatedPostBaselineVersionIds, [olderConcurrentId, concurrentId]);
    assert.equal(result[0].restoredVersionId, null);
    assert.equal(result[0].status, "succeeded");
    assert.equal(result[0].lastCompletedPhase, "concurrent-rotation-preserved");
    assert.equal(reportedOutcomes[0].lastCompletedPhase, "journal-created");
    assert.ok(reportedOutcomes.some(({ lastCompletedPhase }) => lastCompletedPhase === "owned-version-disabled"));
    assert.deepEqual([...persistedOutcomes.values()], result);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("vault rollback may restore baseline when every unrelated post-baseline version is disabled", async () => {
  const base = "https://kv-prostar-metrics-prod.vault.azure.net/secrets/simpro-bearer-token";
  const priorId = `${base}/prior`;
  const ownedId = `${base}/owned`;
  const disabledConcurrentId = `${base}/disabled-concurrent`;
  const restoredId = `${base}/restored`;
  const calls = [];
  const originalFetch = globalThis.fetch;
  let ownedEnabled = true;
  let restored;
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    calls.push({ url: String(url), method, body: init.body ? JSON.parse(init.body) : null });
    if (String(url).includes("/versions?")) {
      return new Response(JSON.stringify({ value: [
        { id: priorId, attributes: { created: 10, enabled: true } },
        {
          id: ownedId,
          attributes: { created: 20, enabled: ownedEnabled },
          tags: {
            "prostar-metrics-migration-run-id": migrationRunId,
            "prostar-metrics-migration-phase": "source-write",
          },
        },
        { id: disabledConcurrentId, attributes: { created: 30, enabled: false } },
      ] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (method === "PATCH") {
      assert.equal(String(url).startsWith(ownedId), true);
      ownedEnabled = false;
      return new Response(JSON.stringify({ id: ownedId, attributes: { enabled: false } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (method === "PUT") {
      const body = JSON.parse(init.body);
      restored = {
        id: restoredId,
        value: body.value,
        attributes: { created: 40, enabled: true },
        tags: body.tags,
      };
      return new Response(JSON.stringify(restored), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(restored), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await restoreVaultVersions({
      names: ["simpro-bearer-token"],
      token: "opaque-token",
      migrationRunId,
      baselines: new Map([["simpro-bearer-token", {
        versionIds: new Set([priorId]),
        active: {
          id: priorId,
          value: "prior-raw-value",
          contentType: "application/x-simpro-bearer-token",
          tags: null,
          attributes: { enabled: true },
        },
      }]]),
    });
    assert.deepEqual(calls.map(({ method }) => method), ["GET", "PATCH", "GET", "PUT", "GET"]);
    assert.equal(calls.some(({ method, url }) => method === "PATCH" && url.startsWith(disabledConcurrentId)), false);
    assert.equal(result[0].compensationAction, "baseline-restored");
    assert.equal(result[0].baselineRestored, true);
    assert.equal(result[0].concurrentRotationPreserved, false);
    assert.equal(result[0].activeVersionId, restoredId);
    assert.equal(result[0].restoredFromVersionId, priorId);
    assert.equal(result[0].restoredVersionId, restoredId);
    assert.deepEqual(result[0].unrelatedPostBaselineVersionIds, [disabledConcurrentId]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("vault rollback fails before PUT when version ordering metadata is ambiguous", async () => {
  const base = "https://kv-prostar-metrics-prod.vault.azure.net/secrets/simpro-bearer-token";
  const priorId = `${base}/prior`;
  const ownedId = `${base}/owned`;
  const concurrentA = `${base}/concurrent-a`;
  const concurrentB = `${base}/concurrent-b`;
  const methods = [];
  const journalEvents = [];
  const persistedOutcomes = new Map();
  const timeline = [];
  const originalFetch = globalThis.fetch;
  let ownedEnabled = true;
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    methods.push(method);
    timeline.push(method);
    if (String(url).includes("/versions?")) {
      return new Response(JSON.stringify({ value: [
        { id: priorId, attributes: { created: 10, enabled: true } },
        {
          id: ownedId,
          attributes: { created: 20, enabled: ownedEnabled },
          tags: {
            "prostar-metrics-migration-run-id": migrationRunId,
            "prostar-metrics-migration-phase": "source-write",
          },
        },
        { id: concurrentA, attributes: { created: 30, enabled: true } },
        { id: concurrentB, attributes: { created: 30, enabled: true } },
      ] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (method === "PATCH") {
      ownedEnabled = false;
      return new Response(JSON.stringify({ id: ownedId, attributes: { enabled: false } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error("rollback attempted a write after ambiguous ordering");
  };
  try {
    await assert.rejects(restoreVaultVersions({
      names: ["simpro-bearer-token"],
      token: "opaque-token",
      migrationRunId,
      onResult: (outcome) => {
        journalEvents.push(outcome);
        persistedOutcomes.set(outcome.name, outcome);
        timeline.push(`journal:${outcome.lastCompletedPhase}:${outcome.status}`);
      },
      baselines: new Map([["simpro-bearer-token", {
        versionIds: new Set([priorId]),
        active: { id: priorId, value: "prior-raw-value", attributes: { enabled: true } },
      }]]),
    }), /ordering metadata is incomplete or ambiguous; manual reconciliation required/);
    assert.deepEqual(methods, ["GET", "PATCH", "GET"]);
    assert.equal(methods.includes("PUT"), false);
    assert.ok(timeline.indexOf("journal:journal-created:in-progress") < timeline.indexOf("PATCH"));
    assert.ok(timeline.indexOf("journal:owned-version-disabled:in-progress") > timeline.indexOf("PATCH"));
    const persisted = persistedOutcomes.get("simpro-bearer-token");
    assert.equal(persisted.status, "incomplete");
    assert.equal(persisted.lastCompletedPhase, "owned-versions-disabled-verified");
    assert.equal(persisted.failurePhase, "plan-compensation");
    assert.equal(persisted.failure, "manual-reconciliation-required");
    assert.deepEqual(persisted.ownedMigrationVersions, [ownedId]);
    assert.deepEqual(persisted.disabledMigrationVersions, [ownedId]);
    assert.equal(journalEvents.at(-1), persisted);
    assert.doesNotMatch(JSON.stringify(persisted), /prior-raw-value|sha|hash/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("vault rollback with no prior active version disables exact run-owned partial versions and writes no replacement", async () => {
  const ids = [
    "https://kv-prostar-metrics-prod.vault.azure.net/secrets/simpro-bearer-token/partial-one",
    "https://kv-prostar-metrics-prod.vault.azure.net/secrets/simpro-bearer-token/partial-two",
  ];
  const enabled = new Map(ids.map((id) => [id, true]));
  const methods = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    methods.push(method);
    if (String(url).includes("/versions?")) {
      return new Response(JSON.stringify({
        value: ids.map((id, index) => ({
          id,
          attributes: { created: (index + 1) * 10, enabled: enabled.get(id) },
          tags: {
            "prostar-metrics-migration-run-id": migrationRunId,
            "prostar-metrics-migration-phase": "source-write",
          },
        })),
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const id = String(url).split("?")[0];
    enabled.set(id, false);
    return new Response(JSON.stringify({ id, attributes: { enabled: false } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const result = await restoreVaultVersions({
      names: ["simpro-bearer-token"],
      token: "opaque-token",
      migrationRunId,
      baselines: new Map([["simpro-bearer-token", {
        versionIds: new Set(),
        active: null,
      }]]),
    });
    assert.deepEqual(methods, ["GET", "PATCH", "PATCH", "GET"]);
    assert.equal(methods.includes("PUT"), false);
    assert.deepEqual(result[0].disabledMigrationVersions, ids);
    assert.equal(result[0].compensationAction, "no-baseline-preserved");
    assert.equal(result[0].baselineRestored, false);
    assert.equal(result[0].concurrentRotationPreserved, false);
    assert.equal(result[0].activeVersionId, null);
    assert.equal(result[0].restoredVersionId, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("successful migration writes vault first and verifies every target before restart and health/auth", async () => {
  const targets = [{ name: "web" }, { name: "job" }];
  const events = [];
  const result = await applyReferenceMigration({
    targets,
    operations: {
      async writeVaultSecrets() { events.push("vault-write"); },
      async restoreVaultVersions() { throw new Error("unexpected rollback"); },
      async setReferences(target) { events.push(`set:${target.name}`); },
      async verifyReferences(target) { events.push(`verify:${target.name}`); },
      async activateReferences() { events.push("activate"); },
      async verifyHealthAndAuth() { events.push("health-auth"); },
      async restoreBaseline() { throw new Error("unexpected rollback"); },
      async activateRollback() { throw new Error("unexpected rollback"); },
      async verifyRollback() { throw new Error("unexpected rollback"); },
    },
  });
  assert.deepEqual(result, { changed: 2, verified: 2 });
  assert.deepEqual(events, ["vault-write", "set:web", "set:job", "verify:web", "verify:job", "activate", "health-auth"]);
});
