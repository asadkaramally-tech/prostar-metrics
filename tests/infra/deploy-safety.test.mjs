import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createImmutableImageTag,
  finalizeCandidateDeployment,
  materializeSnapshotDependencies,
  migrationChildEnvironment,
  monitoringManagedResourceContract,
  parseDeployArgs,
  parseMigrationCompatibilityReport,
  preflightChildEnvironment,
  productionDeploymentSupportContract,
  productionDeploymentTargetContract,
  readyRevisionFailure,
  validateAcrBuildBinding,
  validateDeploymentWhatIf,
  validateEvidenceSigningKeyIds,
  validateKeyVaultReferenceSet,
  validateLongestQueryCollector,
  validateLongestQueryMetricResponse,
  validateMonitoringWhatIf,
  validateMonitoringTargetParameters,
  validateOwnerActionGroup,
  validatePostgresServerTarget,
  validateProductionParameterContract,
  verifyOwnerActionGroupNotification,
  verifyLongestQueryMetricAvailability,
  waitForDeploymentState,
  withReconciledTemporaryFirewall,
  withLongestQueryCollectorEnabled,
} from "../../scripts/deploy-prod.mjs";
import {
  backwardCompatibilityViolations,
  classifyStrictlyAdditiveMigration,
  parseMigrationCompatibilityMode,
  priorImageProbeDockerArgs,
  priorImageProbeEnvironment,
  runExecutableMigrationCompatibility,
} from "../../scripts/lib/migration-compatibility.mjs";
import {
  assertExactProductionJobNames,
  PRODUCTION_JOB_NAMES,
  PRODUCTION_TARGETS,
  productionTargetsForApp,
} from "../../scripts/lib/production-targets.mjs";

const [source, migrationSource, compatibilitySource, compatibilityLibrarySource, legacyDeploySource, packageJson, productionParameters, monitoringParameters] = await Promise.all([
  readFile(new URL("../../scripts/deploy-prod.mjs", import.meta.url), "utf8"),
  readFile(new URL("../../scripts/migrate-key-vault-secrets.mjs", import.meta.url), "utf8"),
  readFile(new URL("../../scripts/check-migration-compatibility.mjs", import.meta.url), "utf8"),
  readFile(new URL("../../scripts/lib/migration-compatibility.mjs", import.meta.url), "utf8"),
  readFile(new URL("../../infra/azure/deploy_metrics_commands.sh", import.meta.url), "utf8"),
  readFile(new URL("../../package.json", import.meta.url), "utf8").then(JSON.parse),
  readFile(new URL("../../infra/azure/main.parameters.prod.example.json", import.meta.url), "utf8").then(JSON.parse),
  readFile(new URL("../../infra/azure/monitoring.parameters.prod.example.json", import.meta.url), "utf8").then(JSON.parse),
]);

test("production deploy requires database-aware health and exact image identity", () => {
  assert.match(source, /payload\?\.database\?\.connected === true/);
  assert.match(source, /readyRevisionFailure\(currentRevisionState\(\), expectedImage\)/);
  assert.match(source, /production health smoke failed/);
});

test("production ARM create uses its operation name for release identity without unsupported deployment tags", () => {
  assert.doesNotMatch(source, /"--tags"/);
  assert.match(source, /"--name",\s*params\.deploymentName/);
});

test("production firewall commands use current Azure CLI server and rule flags", () => {
  assert.match(source, /"firewall-rule", "list"[\s\S]{0,120}"--server-name", POSTGRES_SERVER/);
  assert.match(source, /"firewall-rule", "delete"[\s\S]{0,160}"--server-name", POSTGRES_SERVER[\s\S]{0,80}"--name", TEMP_FIREWALL_RULE/);
  assert.match(source, /"firewall-rule",\s*"create"[\s\S]{0,220}"--server-name",\s*POSTGRES_SERVER[\s\S]{0,80}"--name",\s*TEMP_FIREWALL_RULE/);
  assert.doesNotMatch(source, /"--rule-name"/);
});

test("migration compatibility report requires a non-negative pending count", () => {
  assert.deepEqual(
    parseMigrationCompatibilityReport("Accepted 0 pending migrations\nMIGRATION_COMPATIBILITY_REPORT {\"pendingMigrationCount\":0}\n"),
    { pendingMigrationCount: 0 },
  );
  for (const output of [
    "",
    "MIGRATION_COMPATIBILITY_REPORT not-json",
    "MIGRATION_COMPATIBILITY_REPORT {\"pendingMigrationCount\":-1}",
    "MIGRATION_COMPATIBILITY_REPORT {\"pendingMigrationCount\":0}\nMIGRATION_COMPATIBILITY_REPORT {\"pendingMigrationCount\":0}",
  ]) assert.throws(() => parseMigrationCompatibilityReport(output), /pending-migration report|pending migration count/);
});

test("production target convergence retries the exact app and 24-job state before accepting it", async () => {
  let calls = 0;
  const expected = { targets: [{ name: "ready" }] };
  const actual = await waitForDeploymentState({}, "pinned-image", {
    attempts: 3,
    delayMs: 0,
    wait: async () => {},
    verify() {
      calls += 1;
      if (calls < 3) throw new Error(`job image has not converged on attempt ${calls}`);
      return expected;
    },
  });
  assert.equal(actual, expected);
  assert.equal(calls, 3);

  await assert.rejects(waitForDeploymentState({}, "pinned-image", {
    attempts: 2,
    delayMs: 0,
    wait: async () => {},
    verify() { throw new Error("job provisioning is still Updating"); },
  }), /production target convergence failed: job provisioning is still Updating/);
});

test("immutable deployment snapshots materialize contained dependencies without external symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "metrics-snapshot-dependencies-"));
  try {
    const dependencies = join(root, "dependencies");
    const snapshot = join(root, "snapshot");
    await mkdir(join(dependencies, "pkg"), { recursive: true });
    await mkdir(join(dependencies, ".bin"), { recursive: true });
    await mkdir(snapshot, { recursive: true });
    await writeFile(join(dependencies, "pkg", "tool.mjs"), "export default 1;\n");
    await symlink("../pkg/tool.mjs", join(dependencies, ".bin", "tool"));

    materializeSnapshotDependencies(snapshot, dependencies);
    const materialized = join(snapshot, "node_modules");
    assert.equal((await lstat(materialized)).isSymbolicLink(), false);
    assert.equal(await readlink(join(materialized, ".bin", "tool")), "../pkg/tool.mjs");
    assert.equal(
      await realpath(join(materialized, ".bin", "tool")),
      await realpath(join(materialized, "pkg", "tool.mjs")),
    );
    await writeFile(join(dependencies, "pkg", "tool.mjs"), "export default 2;\n");
    assert.equal(await readFile(join(materialized, "pkg", "tool.mjs"), "utf8"), "export default 1;\n");

    const hostileSnapshot = join(root, "hostile-snapshot");
    const hostileDependencies = join(root, "hostile-dependencies");
    await mkdir(join(hostileDependencies, ".bin"), { recursive: true });
    await mkdir(hostileSnapshot, { recursive: true });
    await writeFile(join(root, "outside.mjs"), "export default 3;\n");
    await symlink(join(root, "outside.mjs"), join(hostileDependencies, ".bin", "escape"));
    assert.throws(
      () => materializeSnapshotDependencies(hostileSnapshot, hostileDependencies),
      /dependency symlink escapes the immutable snapshot/,
    );
    await assert.rejects(lstat(join(hostileSnapshot, "node_modules")), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed migration URLs cannot escape the compatibility redaction boundary", () => {
  const sentinel = "migration-user:swordfish";
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../../scripts/check-migration-compatibility.mjs", import.meta.url))], {
    encoding: "utf8",
    env: {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      AZURE_POSTGRES_CONNECTION_STRING: `not-a-url://${sentinel}@db.example.test/metrics`,
      PRIOR_PRODUCTION_IMAGE: `acrprostardispatchprod.azurecr.io/prostar-metrics@sha256:${"a".repeat(64)}`,
    },
  });
  const diagnostic = `${result.stdout}\n${result.stderr}`;
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(diagnostic, /migration-user:swordfish|not-a-url:\/\//);
  assert.match(diagnostic, /details were redacted/);
});

test("compatibility command failures retain bounded redacted stdout as well as stderr", () => {
  assert.match(compatibilitySource, /redactDiagnostic\(`\$\{stdout\}\\n\$\{stderr\}`\)/);
  assert.match(compatibilitySource, /redactCompatibilityDiagnostic/);
  assert.match(compatibilityLibrarySource, /\.slice\(0, 3_000\)/);
});

test("prior-image compatibility gate supports bounded production timeout overrides", () => {
  assert.match(compatibilitySource, /MIGRATION_COMPATIBILITY_COMMAND_TIMEOUT_MS/);
  assert.match(compatibilitySource, /MIGRATION_COMPATIBILITY_QUERY_TIMEOUT_MS/);
  assert.match(source, /MIGRATION_COMPATIBILITY_COMMAND_TIMEOUT_MS/);
  assert.match(source, /MIGRATION_COMPATIBILITY_QUERY_TIMEOUT_MS/);
});

test("production deploy discovers the pinned PostgreSQL 17 Homebrew client before unversioned libpq", () => {
  const versioned = source.indexOf("/opt/homebrew/opt/postgresql@17/bin");
  const unversioned = source.indexOf("/opt/homebrew/opt/libpq/bin");
  assert.ok(versioned >= 0);
  assert.ok(unversioned > versioned);
});

test("temporary migration firewall reconciles ambiguous creation and proves final absence", async () => {
  const events = [];
  let present = false;
  await assert.rejects(withReconciledTemporaryFirewall({
    async create() { events.push("create"); present = true; throw new Error("create response timed out"); },
    async verifyPresent() { events.push("verify-present"); if (!present) throw new Error("missing"); },
    async remove() { events.push("remove"); const removed = present; present = false; return removed; },
    async verifyAbsent() { events.push("verify-absent"); if (present) throw new Error("still present"); },
    async run() { events.push("run"); },
    cleanupCycles: 1,
    requiredAbsenceChecks: 1,
  }), /create response timed out/);
  assert.deepEqual(events, ["create", "remove", "verify-absent"]);
  assert.equal(present, false);
});

test("temporary migration firewall preserves primary and every cleanup failure", async () => {
  await assert.rejects(withReconciledTemporaryFirewall({
    async create() {},
    async verifyPresent() {},
    async remove() { throw new Error("delete failed"); },
    async verifyAbsent() { throw new Error("absence unproven"); },
    async run() { throw new Error("migration failed"); },
    cleanupCycles: 1,
    requiredAbsenceChecks: 1,
  }), (error) => {
    assert.ok(error instanceof AggregateError);
    const messages = error.errors.map((entry) => entry.message);
    assert.equal(messages[0], "migration failed");
    assert.ok(messages.filter((message) => message === "delete failed").length >= 2);
    assert.ok(messages.filter((message) => message === "absence unproven").length >= 2);
    assert.match(messages.at(-1), /final absence could not be proven/);
    return true;
  });
});

test("temporary migration firewall removes a rule that reappears during the stability window", async () => {
  let present = false;
  let removals = 0;
  let settles = 0;
  await withReconciledTemporaryFirewall({
    async create() { present = true; },
    async verifyPresent() { if (!present) throw new Error("missing"); },
    async remove() { removals += 1; const removed = present; present = false; return removed; },
    async verifyAbsent() { if (present) throw new Error("still present"); },
    async run() {},
    cleanupCycles: 5,
    requiredAbsenceChecks: 3,
    async settle() {
      settles += 1;
      if (settles === 1) present = true;
    },
  });
  assert.equal(removals, 4);
  assert.equal(settles, 3);
  assert.equal(present, false);
});

test("temporary migration firewall reconciles a final-cycle observation before failing closed", async () => {
  let present = false;
  let verifications = 0;
  let removals = 0;
  await assert.rejects(withReconciledTemporaryFirewall({
    async create() { present = true; },
    async verifyPresent() { if (!present) throw new Error("missing"); },
    async remove() { removals += 1; const removed = present; present = false; return removed; },
    async verifyAbsent() {
      verifications += 1;
      if (verifications === 3) present = true;
      if (present) throw new Error(`present-after-remove-cycle-${verifications}`);
    },
    async run() {},
    cleanupCycles: 3,
    requiredAbsenceChecks: 3,
    async settle() {},
  }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.errors.at(-1)?.message ?? "", /did not remain absent for the full stability window/);
    return true;
  });
  assert.equal(removals, 4);
  assert.equal(present, false);
});

test("production firewall adapter propagates observed deletion to the stability state machine", () => {
  assert.match(source, /remove:\s*async \(\) => \{[\s\S]*?return removeTemporaryMigrationFirewallRule\(\);[\s\S]*?\},\s*verifyAbsent:/);
});

test("compatibility entrypoint applies fail-closed redaction to top-level failures", () => {
  const sourcePath = fileURLToPath(new URL("../../scripts/migration-compatibility-entrypoint.ts", import.meta.url));
  const connectionString = `postgresql://migration-user:swordfish@127.0.0.1:1/metrics_compat_${"a".repeat(32)}`;
  const result = spawnSync(process.execPath, ["--import", "tsx", sourcePath], {
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      AZURE_POSTGRES_CONNECTION_STRING: connectionString,
      MIGRATION_COMPATIBILITY_CLONE_ONLY: "true",
      MIGRATION_COMPATIBILITY_IMAGE_DIGEST: `acrprostardispatchprod.azurecr.io/prostar-metrics@sha256:${"b".repeat(64)}`,
      MIGRATION_COMPATIBILITY_PLATFORM: "linux/amd64",
    },
  });
  const diagnostic = `${result.stdout}\n${result.stderr}`;
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(diagnostic, /migration-user|swordfish|127\.0\.0\.1|postgresql:\/\//);
  assert.match(diagnostic, /REDACTED/);
});

test("legacy shell entry point delegates only to the guarded production authority", () => {
  assert.match(legacyDeploySource, /exec npm run deploy:prod/);
  assert.doesNotMatch(legacyDeploySource, /az\s+(?:acr|deployment|containerapp)|prostar-metrics:latest|--parameters/);

  const script = fileURLToPath(new URL("../../infra/azure/deploy_metrics_commands.sh", import.meta.url));
  assert.equal(spawnSync("bash", ["-n", script], { encoding: "utf8" }).status, 0);
  const positional = spawnSync("bash", [script, "legacy-image", "legacy-secret"], {
    encoding: "utf8",
    env: { HOME: process.env.HOME, PATH: process.env.PATH },
  });
  assert.equal(positional.status, 64);
  assert.match(positional.stderr, /Legacy deployment arguments are not supported/);
  const environment = spawnSync("bash", [script], {
    encoding: "utf8",
    env: { HOME: process.env.HOME, PATH: process.env.PATH, IMAGE_TAG: "prostar-metrics:latest" },
  });
  assert.equal(environment.status, 64);
  assert.match(environment.stderr, /Legacy deployment environment variable IMAGE_TAG is not supported/);
});

test("production deploy verifies EasyAuth and restores the previous image on failure", () => {
  assert.match(source, /collectLiveHttpVerification/);
  assert.match(source, /restoreBaseline/);
  assert.match(source, /restoring previous image, jobs, and traffic/);
  assert.match(source, /verifyState: \(expectedBaseline, expectedImage\) => waitForDeploymentState\(expectedBaseline, expectedImage\)/);
});

function signingKeyIds() {
  return {
    gate: `https://kv-prostar-metrics-prod.vault.azure.net/keys/gate/${"1".repeat(32)}`,
    browser: `https://kv-prostar-metrics-prod.vault.azure.net/keys/browser/${"2".repeat(32)}`,
    reviewer: `https://kv-prostar-metrics-prod.vault.azure.net/keys/reviewer/${"3".repeat(32)}`,
  };
}

function monitoringEvidence() {
  return {
    longestQueryMetric: { path: "docs/prostar-metrics/verification/monitoring/metric.json", sha256: "4".repeat(64) },
    actionGroupNotification: { path: "docs/prostar-metrics/verification/monitoring/action.json", sha256: "5".repeat(64) },
  };
}

function liveVerification(productionUrl) {
  const clientId = "369bef95-48a6-45db-bad6-1e16278fa229";
  const tenantId = "515fbfd7-12b1-4238-bb6c-f827588dd488";
  const redirectUri = `${productionUrl}/.auth/login/aad/callback`;
  const location = new URL(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`);
  location.searchParams.set("client_id", clientId);
  location.searchParams.set("redirect_uri", redirectUri);
  location.searchParams.set("state", "redir=%2Fquotes");
  return {
    health: { url: `${productionUrl}/api/health`, status: 200, ok: true, databaseConnected: true },
    unauthenticated: {
      browser: {
        url: `${productionUrl}/quotes`, status: 302, location: location.href,
        authorizeEndpoint: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`,
        clientId, redirectUri, stateRedirect: "/quotes",
      },
      api: { url: `${productionUrl}/quotes`, status: 401, location: null },
    },
    authContract: {
      platformEnabled: true,
      unauthenticatedClientAction: "RedirectToLoginPage",
      excludedPaths: ["/api/health"],
      redirectToProvider: "AzureActiveDirectory",
      requireHttps: true,
      clientId,
      openIdIssuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
      clientSecretSettingName: "microsoft-provider-authentication-secret",
      allowedAudiences: [clientId, `api://${clientId}`].sort(),
    },
    authenticatedIdentity: {
      authenticated: true,
      principalEmail: "asad@prostarmechanical.com",
      principalId: "principal-1",
      provider: "aad",
      verifiedAt: "2026-07-13T20:00:20.000Z",
      sessionReceiptSha256: "6".repeat(64),
    },
  };
}

function manifestTargets(image) {
  const identity = "/subscriptions/test/resourceGroups/prostar-payroll/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-prostar-dispatch-prod";
  const environmentId = "/subscriptions/test/resourceGroups/prostar-payroll/providers/Microsoft.App/managedEnvironments/cae-prostar-dispatch-prod";
  return PRODUCTION_TARGETS.map((target) => ({
    ...target,
    resourceId: `/subscriptions/test/resourceGroups/${target.resourceGroup}/providers/Microsoft.App/${target.kind === "app" ? "containerApps" : "jobs"}/${target.name}`.toLowerCase(),
    resourceType: target.kind === "app" ? "Microsoft.App/containerApps" : "Microsoft.App/jobs",
    location: "westus2",
    tags: { environment: "prod", managedBy: "bicep", workload: "prostar-metrics" },
    identity: { type: "UserAssigned", userAssignedIdentityIds: [identity.toLowerCase()] },
    environmentId: environmentId.toLowerCase(),
    configuration: {
      activeRevisionsMode: target.kind === "app" ? "Single" : null,
      ingress: target.kind === "app" ? { external: true, targetPort: 3000, allowInsecure: false } : null,
      triggerType: target.kind === "job" ? "Schedule" : null,
      replicaTimeout: target.kind === "job" ? 1200 : null,
      replicaRetryLimit: target.kind === "job" ? 1 : null,
      scheduleTriggerConfig: target.kind === "job" ? { cronExpression: "0 * * * *", parallelism: 1, replicaCompletionCount: 1 } : null,
      manualTriggerConfig: null,
      eventTriggerConfig: null,
      registries: [{ server: "acrprostardispatchprod.azurecr.io", identity: identity.toLowerCase() }],
      secretReferences: [{
        name: "azure-postgres-connection-string",
        keyVaultUrl: "https://kv-prostar-metrics-prod.vault.azure.net/secrets/azure-postgres-connection-string",
        identity: identity.toLowerCase(),
      }],
    },
    template: {
      containers: [{
        name: target.kind === "app" ? "web" : "worker",
        image,
        command: ["npm"],
        args: target.kind === "app" ? ["run", "start"] : ["run", "ingest:worker"],
        env: [{ name: "NODE_ENV", secretRef: null, value: "production" }],
        resources: { cpu: 0.5, memory: "1Gi" },
        probes: [],
        volumeMounts: [],
      }],
      initContainers: [],
      scale: target.kind === "app" ? { minReplicas: 1, maxReplicas: 2 } : null,
      volumes: [],
      serviceBinds: [],
      terminationGracePeriodSeconds: null,
    },
    image,
  })).sort((left, right) => left.name.localeCompare(right.name));
}

test("every candidate create, partial ARM, and postcheck failure restores the exact prior state", async (t) => {
  for (const stage of ["create", "arm", "fqdn", "health", "state", "revision", "acr", "live", "manifest"]) {
    await t.test(stage, async () => {
      const calls = [];
      const oldImage = `acrprostardispatchprod.azurecr.io/prostar-metrics@sha256:${"1".repeat(64)}`;
      const digest = `sha256:${"a".repeat(64)}`;
      const newImage = `acrprostardispatchprod.azurecr.io/prostar-metrics@${digest}`;
      const nonce = "0193f1a0-1234-4abc-8def-0123456789ab";
      const deploymentName = `prostar-metrics-${nonce}`;
      const acrBuild = {
        runId: "acr-run-42", createdAt: "2026-07-13T19:59:00.000Z", digest, imageTag: `deploy-${"c".repeat(16)}-${nonce}`,
      };
      const baseline = { webImage: oldImage, targets: manifestTargets(oldImage), revisionMode: "Single" };
      let currentImage = newImage;
      let revisionCalls = 0;
      let liveCalls = 0;
      const ready = (image) => ({
        revisionMode: "Single", latestRevisionName: "aca-prostar-metrics-prod--2",
        latestReadyRevisionName: "aca-prostar-metrics-prod--2", active: true,
        healthState: "Healthy", provisioningState: "Provisioned", image,
        trafficWeight: 100, trafficRevisionNames: ["aca-prostar-metrics-prod--2"],
        createdAt: "2026-07-13T20:00:10.000Z",
      });
      const armResult = (state = "Succeeded", outputs = { containerAppFqdn: { value: "candidate.example.test" } }) => ({
        id: `/subscriptions/test/resourceGroups/prostar-payroll/providers/Microsoft.Resources/deployments/${deploymentName}`,
        name: deploymentName,
        properties: {
          provisioningState: state,
          correlationId: "correlation-42",
          timestamp: "2026-07-13T20:00:00.000Z",
          outputs,
        },
      });
      const operations = {
        async deployCandidate() {
          calls.push(["deployCandidate"]);
          if (stage === "create") throw new Error("ARM create failed after a partial write");
          return armResult(stage === "arm" ? "Failed" : "Succeeded", stage === "fqdn" ? {} : undefined);
        },
        requireFqdn(outputs) {
          if (!outputs?.containerAppFqdn?.value) throw new Error("missing fqdn");
          return outputs.containerAppFqdn.value;
        },
        async waitForHealthy(fqdn, image) {
          calls.push(["health", image]);
          if (stage === "health" && fqdn === "candidate.example.test") throw new Error("health failed");
        },
        verifyState(value, image) {
          calls.push(["state", value, image]);
          if (stage === "state" && image === newImage) throw new Error("state failed");
          return { targets: manifestTargets(image) };
        },
        currentRevision() {
          revisionCalls += 1;
          const value = ready(currentImage);
          return stage === "revision" && revisionCalls === 1 ? { ...value, trafficWeight: 0 } : value;
        },
        verifyAcrBuild() {
          if (stage === "acr") throw new Error("ACR binding failed");
          return acrBuild;
        },
        verifyLive(fqdn) {
          liveCalls += 1;
          if (stage === "live" && liveCalls === 1) throw new Error("authenticated live verification failed");
          return liveVerification(`https://${fqdn}`);
        },
        async writeManifest() {
          calls.push(["writeManifest"]);
          if (stage === "manifest") throw new Error("manifest failed");
          return { path: "manifest", sha256: "x" };
        },
        restoreBaseline(image) {
          calls.push(["restoreBaseline", image]);
          currentImage = oldImage;
          return { outputs: { containerAppFqdn: { value: "restored.example.test" } } };
        },
        logRollback(image) { calls.push(["rollback", image]); },
        now: () => new Date("2026-07-13T20:01:00Z"),
      };
      await assert.rejects(finalizeCandidateDeployment({
        deploymentName, deploymentRunId: deploymentName, deploymentNonce: nonce,
        evidenceSigningKeyIds: signingKeyIds(), previousImage: oldImage, pinnedImage: newImage,
        acrBuild, buildSourceSha256: "c".repeat(64), baseline,
        monitoringEvidence: monitoringEvidence(), operations,
      }));
      const restore = calls.find(([name]) => name === "restoreBaseline");
      assert.equal(restore[1], oldImage);
      assert.ok(calls.some(([name, value, image]) => name === "state" && value === baseline && image === oldImage));
      assert.ok(calls.some(([name, image]) => name === "health" && image === oldImage));
      if (stage === "manifest") assert.ok(calls.some(([name]) => name === "writeManifest"));
    });
  }
});

test("pending migration compatibility gate rejects contract/destructive SQL", () => {
  assert.deepEqual(backwardCompatibilityViolations(
    "030_additive.sql",
    "create table if not exists metrics.new_evidence (id bigint primary key);",
  ), []);
  for (const sql of [
    "drop table metrics.old;",
    "alter table metrics.jobs drop column total;",
    "alter table metrics.jobs alter column total type bigint;",
    "truncate metrics.jobs;",
    "delete from metrics.jobs;",
  ]) assert.ok(backwardCompatibilityViolations("030_bad.sql", sql).length > 0);
  assert.deepEqual(backwardCompatibilityViolations(
    "031_guarded_constraint.sql",
    "update metrics.jobs set total = 0 where total is null; alter table metrics.jobs alter column total set not null;",
  ), []);
  assert.equal(classifyStrictlyAdditiveMigration(
    "030_additive.sql",
    "create schema if not exists metrics; create table if not exists metrics.new_evidence (id bigint primary key); create index if not exists new_evidence_idx on metrics.new_evidence (id); comment on table metrics.new_evidence is 'semicolon; remains inside this SQL string';",
  ).additive, true);
  for (const sql of [
    "alter table metrics.jobs add column if not exists extra text;",
    "update metrics.jobs set total = 0;",
    "create or replace view metrics.current_jobs as select * from metrics.jobs;",
    "create table metrics.copy as select * from metrics.jobs;",
  ]) assert.equal(classifyStrictlyAdditiveMigration("030_full.sql", sql).additive, false);
  assert.match(source, /runMigrationCompatibilityGate\(connectionString, previousImage\)/);
  assert.match(compatibilitySource, /MIGRATION_COMPATIBILITY_MODE \?\? "static"/);
  assert.match(compatibilitySource, /full-data clone probing is manual only/);
  assert.equal(packageJson.scripts["migration:compatibility:clone"], "node scripts/check-migration-compatibility.mjs --clone");
});

test("full-data migration compatibility cloning is opt-in and static mode is the release default", () => {
  assert.equal(parseMigrationCompatibilityMode(), "static");
  assert.equal(parseMigrationCompatibilityMode(["--clone"]), "clone");
  assert.equal(parseMigrationCompatibilityMode([], "clone"), "clone");
  assert.throws(() => parseMigrationCompatibilityMode(["--full"]), /only --clone/);
  assert.throws(() => parseMigrationCompatibilityMode([], "routine"), /static or clone/);
});

test("actual migrations 029 through 036 pass static defense for a migration-028 baseline", async () => {
  const directory = new URL("../../infra/db/migrations/", import.meta.url);
  const files = await readdir(directory);
  for (const number of ["029", "030", "031", "032", "033", "034", "035", "036"]) {
    const filename = files.find((file) => file.startsWith(`${number}_`) && file.endsWith(".sql"));
    assert.ok(filename, `missing migration ${number}`);
    const sql = await readFile(new URL(filename, directory), "utf8");
    assert.deepEqual(backwardCompatibilityViolations(filename, sql), [], filename);
  }
});

test("worker lease migration is strictly additive despite a semicolon in its COMMENT string", async () => {
  const sql = await readFile(new URL("../../infra/db/migrations/046_worker_execution_leases.sql", import.meta.url), "utf8");
  assert.deepEqual(classifyStrictlyAdditiveMigration("046_worker_execution_leases.sql", sql), {
    additive: true,
    statements: 2,
  });
});

test("executable prior-image compatibility validates all probes and always removes its clone", async () => {
  const previousImage = `acrprostardispatchprod.azurecr.io/prostar-metrics@sha256:${"a".repeat(64)}`;
  const passingProbes = {
    schemaVersion: 1,
    mode: "standard",
    platform: "linux/amd64",
    previousImage,
    probePeriods: { jobs: "2026-07-01", commissions: "2026-07-01" },
    application: {
      succeeded: true,
      routes: ["/api/health", "/api/jobs", "/api/quotes", "/api/technicians", "/api/commissions"],
    },
    runtime: {
      databaseHealth: { succeeded: true },
      dashboardStores: { succeeded: true },
      ingestionLifecycle: { succeeded: true },
      ingestionWorker: { succeeded: true },
      rollupWorker: {
        succeeded: true, outcome: "rebuilt", metricFamily: "jobs", periodStart: "2026-07-01",
      },
      commissionWorker: {
        succeeded: true, outcome: "rebuilt", metricFamily: "commissions", periodStart: "2026-07-01",
      },
    },
  };
  const events = [];
  let databaseName;
  let exists = false;
  const result = await runExecutableMigrationCompatibility({
    previousImage,
    operations: {
      async listDatabases() { events.push("list"); return exists ? ["postgres", databaseName] : ["postgres"]; },
      async createDatabase(name) { databaseName = name; exists = true; events.push(`create:${name}`); },
      async reconcileCreate() { events.push("reconcile"); return { databaseExists: exists, createOperationActive: false }; },
      async materializeClone(name) { events.push(`materialize:${name}`); },
      async applyPendingMigrations(name) { events.push(`apply:${name}`); return ["029.sql", "031.sql"]; },
      async runPriorImageProbes(name, image) { events.push(`probe:${name}:${image}`); return passingProbes; },
      async terminateSessions(name) { events.push(`terminate:${name}`); },
      async dropDatabase(name) { events.push(`drop:${name}`); exists = false; },
      async cleanupArtifacts() { events.push("artifacts"); },
    },
  });
  assert.deepEqual(result.appliedMigrations, ["029.sql", "031.sql"]);
  assert.match(result.databaseName, /^metrics_compat_[a-f0-9]{32}$/);
  assert.equal(events.at(-1), "list");
  assert.ok(events.indexOf(`create:${result.databaseName}`) < events.indexOf(`materialize:${result.databaseName}`));
  assert.ok(events.indexOf("artifacts") < events.indexOf(`drop:${result.databaseName}`));

  for (const mutate of [
    (probes) => { probes.previousImage = probes.previousImage.replace(/a/g, "b"); },
    (probes) => { probes.application.succeeded = false; },
    (probes) => { probes.application.routes.pop(); },
    (probes) => { probes.runtime.commissionWorker.succeeded = false; },
    (probes) => { probes.runtime.unexecutedFeature = { succeeded: true }; },
  ]) {
    const cleanup = [];
    const probes = structuredClone(passingProbes);
    mutate(probes);
    let ownedName;
    let owned = false;
    await assert.rejects(runExecutableMigrationCompatibility({
      previousImage,
      operations: {
        async listDatabases() { return owned ? ["postgres", ownedName] : ["postgres"]; },
        async createDatabase(name) { ownedName = name; owned = true; },
        async reconcileCreate() { return { databaseExists: owned, createOperationActive: false }; },
        async materializeClone() {},
        async applyPendingMigrations() { return []; },
        async runPriorImageProbes() { return probes; },
        async terminateSessions() {},
        async dropDatabase() { owned = false; cleanup.push("cleaned"); },
      },
    }), /probe|digest|coverage|application/);
    assert.deepEqual(cleanup, ["cleaned"]);
  }
  let failedCloneName;
  let failedCloneExists = false;
  await assert.rejects(runExecutableMigrationCompatibility({
    previousImage,
    operations: {
      async listDatabases() { return failedCloneExists ? ["postgres", failedCloneName] : ["postgres"]; },
      async createDatabase(name) { failedCloneName = name; failedCloneExists = true; },
      async reconcileCreate() { return { databaseExists: failedCloneExists, createOperationActive: false }; },
      async materializeClone() { throw new Error("clone materialization failed"); },
      async applyPendingMigrations() { throw new Error("not reached"); },
      async runPriorImageProbes() { throw new Error("not reached"); },
      async terminateSessions() {},
      async dropDatabase() { throw new Error("clone cleanup failed"); },
    },
  }), (error) => error instanceof AggregateError && error.errors.length === 2);
});

test("compatibility probes execute inside the exact prior image without putting credentials in argv", () => {
  const previousImage = `acrprostardispatchprod.azurecr.io/prostar-metrics@sha256:${"a".repeat(64)}`;
  const connectionString = `postgres://migration-user:very-secret@db.example.test/metrics_compat_${"1".repeat(32)}`;
  const environment = priorImageProbeEnvironment(connectionString, {
    PATH: "/bin",
    HOME: "/home/release",
    AZURE_POSTGRES_CA_CERT: "public-ca",
    DATABASE_URL: "application-secret",
    SIMPRO_BEARER_TOKEN: "simpro-secret",
  }, previousImage);
  assert.deepEqual(environment, {
    AZURE_POSTGRES_CA_CERT: "public-ca",
    AZURE_POSTGRES_CONNECTION_STRING: connectionString,
    HOME: "/home/release",
    METRICS_ADMIN_EMAILS: "asad@prostarmechanical.com",
    METRICS_AUTH_MODE: "easy-auth",
    MIGRATION_COMPATIBILITY_CLONE_ONLY: "true",
    MIGRATION_COMPATIBILITY_IMAGE_DIGEST: previousImage,
    MIGRATION_COMPATIBILITY_PLATFORM: "linux/amd64",
    NODE_ENV: "production",
    PATH: "/bin",
    POSTGRES_SSL_REJECT_UNAUTHORIZED: "true",
  });
  const args = priorImageProbeDockerArgs(previousImage, environment, {
    command: ["node", "node_modules/tsx/dist/cli.mjs", "workers/ingest-simpro.ts", "--dry-run", "--entity", "jobs"],
    name: "metrics-compat-probe-12345678-1234-4123-8123-123456789abc",
    pull: "always",
  });
  assert.ok(args.includes(previousImage));
  assert.ok(args.includes("--pull=always"));
  assert.ok(args.includes("--platform=linux/amd64"));
  assert.ok(args.includes("--read-only") && args.includes("no-new-privileges"));
  assert.ok(args.includes("AZURE_POSTGRES_CONNECTION_STRING"));
  assert.doesNotMatch(JSON.stringify(args), /very-secret|application-secret|simpro-secret/);
  assert.doesNotMatch(JSON.stringify(args), /--input-type|node",\s*"-"/);
  assert.doesNotMatch(compatibilitySource, /input:\s*PRIOR_IMAGE|--input-type=module/);
  assert.match(compatibilitySource, /node_modules\/tsx\/dist\/cli\.mjs/);
  assert.match(compatibilitySource, /node", "server\.js"/);
  assert.match(compatibilitySource, /environment\.PGSSLROOTCERT \|\|= "system"/);
});

test("immutable ACR tag and exact build run binding fail on ambiguity or drift", () => {
  assert.match(source, /"acr", "task", "show-run"[\s\S]*"--run-id"/);
  assert.doesNotMatch(source, /"acr", "task", "list-runs"/);
  const sourceSha256 = "c".repeat(64);
  const uuid1 = "0193f1a0-1234-4abc-8def-0123456789ab";
  const uuid2 = "0193f1a0-1234-4abc-8def-0123456789ac";
  const tag = createImmutableImageTag(sourceSha256, uuid1);
  assert.equal(tag, `deploy-${sourceSha256.slice(0, 16)}-${uuid1}`);
  assert.notEqual(tag, createImmutableImageTag(sourceSha256, uuid2));
  assert.throws(() => createImmutableImageTag(sourceSha256, "not-a-uuid"), /requires a UUID/);

  const digest = `sha256:${"d".repeat(64)}`;
  const buildResult = {
    status: "Succeeded",
    runId: "acr-run-42",
    createTime: "2026-07-13T19:00:00.000Z",
    outputImages: [{
      registry: "acrprostardispatchprod.azurecr.io",
      repository: "prostar-metrics",
      tag,
      digest,
    }],
  };
  assert.deepEqual(validateAcrBuildBinding({
    buildResult,
    liveRun: structuredClone(buildResult),
    tagManifest: { digest, tags: [tag] },
    imageTag: tag,
  }), { runId: "acr-run-42", createdAt: "2026-07-13T19:00:00.000Z", digest, imageTag: tag });

  for (const mutate of [
    ({ build }) => { build.outputImages.push(structuredClone(build.outputImages[0])); },
    ({ live }) => { live.runId = "different-run"; },
    ({ live }) => { live.createTime = "2026-07-13T19:00:01.000Z"; },
    ({ live }) => { live.outputImages[0].digest = `sha256:${"e".repeat(64)}`; },
    ({ manifest }) => { manifest.digest = `sha256:${"e".repeat(64)}`; },
    ({ manifest }) => { manifest.tags = ["different-tag"]; },
  ]) {
    const fixture = {
      build: structuredClone(buildResult),
      live: structuredClone(buildResult),
      manifest: { digest, tags: [tag] },
    };
    mutate(fixture);
    assert.throws(() => validateAcrBuildBinding({
      buildResult: fixture.build,
      liveRun: fixture.live,
      tagManifest: fixture.manifest,
      imageTag: tag,
    }), /exactly one|changed between build|drifted|does not bind/);
  }
});

test("release child environments isolate migration credentials from Azure and preflight tools", () => {
  const sourceEnvironment = {
    PATH: "/bin",
    HOME: "/home/release",
    AZURE_CONFIG_DIR: "/azure",
    LANG: "en_US.UTF-8",
    AZURE_POSTGRES_CA_CERT: "public-ca-pem",
    AZURE_POSTGRES_MIGRATION_CONNECTION_STRING: "privileged-migration-secret",
    DATABASE_URL: "application-database-secret",
    PROSTAR_RELEASE_AUTH_SESSION_COOKIE: "browser-secret",
    SIMPRO_BEARER_TOKEN: "simpro-secret",
  };
  const preflight = preflightChildEnvironment(sourceEnvironment);
  assert.deepEqual(preflight, {
    AZURE_CONFIG_DIR: "/azure", HOME: "/home/release", LANG: "en_US.UTF-8", PATH: "/bin",
  });
  assert.doesNotMatch(JSON.stringify(preflight), /secret|public-ca-pem/);

  const previousImage = `acrprostardispatchprod.azurecr.io/prostar-metrics@sha256:${"a".repeat(64)}`;
  const migration = migrationChildEnvironment("postgres://migration-credential", previousImage, sourceEnvironment);
  assert.equal(migration.AZURE_POSTGRES_CONNECTION_STRING, "postgres://migration-credential");
  assert.equal(migration.PRIOR_PRODUCTION_IMAGE, previousImage);
  assert.equal(migration.AZURE_POSTGRES_CA_CERT, "public-ca-pem");
  for (const forbidden of [
    "AZURE_POSTGRES_MIGRATION_CONNECTION_STRING", "DATABASE_URL", "PROSTAR_RELEASE_AUTH_SESSION_COOKIE", "SIMPRO_BEARER_TOKEN",
  ]) assert.equal(forbidden in migration, false);
});

test("evidence signing keys are exact distinct version-pinned production Key Vault IDs", () => {
  const vault = "kv-prostar-metrics-prod";
  const valid = {
    gate: `https://${vault}.vault.azure.net/keys/prostar-release-gate-evidence/${"1".repeat(32)}`,
    browser: `https://${vault}.vault.azure.net/keys/prostar-release-browser-evidence/${"2".repeat(32)}`,
    reviewer: `https://${vault}.vault.azure.net/keys/prostar-release-reviewer-evidence/${"3".repeat(32)}`,
  };
  assert.deepEqual(validateEvidenceSigningKeyIds(valid, vault), valid);
  for (const mutate of [
    (ids) => { ids.gate = ids.gate.slice(0, ids.gate.lastIndexOf("/")); },
    (ids) => { ids.browser = ids.browser.replace(vault, "wrong-vault"); },
    (ids) => { ids.reviewer = ids.reviewer.replace("prostar-release-reviewer-evidence", "wrong-key"); },
    (ids) => { ids.reviewer = ids.browser; },
  ]) {
    const ids = structuredClone(valid);
    mutate(ids);
    assert.throws(() => validateEvidenceSigningKeyIds(ids, vault), /version-pinned|distinct/);
  }
});

test("production deploy uses authoritative Key Vault references without runtime secret values", () => {
  assert.doesNotMatch(source, /prostar-lead-platform/);
  assert.doesNotMatch(source, /ENV_CANDIDATES|mergedEnv|SIMPRO_API_TOKEN/);
  assert.doesNotMatch(source, /getProductionSecret|--show-values|SIMPRO_BEARER_TOKEN|MICROSOFT_PROVIDER_AUTHENTICATION_SECRET/);
  assert.doesNotMatch(source, /azurePostgresConnectionString=|simproBearerToken=|microsoftProviderAuthenticationSecret=/);
  assert.match(source, /AZURE_POSTGRES_MIGRATION_CONNECTION_STRING/);
  const contract = validateProductionParameterContract(productionParameters);
  assert.equal(contract.keyVaultName, "kv-prostar-metrics-prod");
  assert.equal(contract.managedIdentityName, "id-prostar-dispatch-prod");
  assert.equal(contract.includePostgresSslCaCertSecret, false);
  const invalid = structuredClone(productionParameters);
  invalid.parameters.useKeyVaultSecretReferences.value = false;
  assert.throws(() => validateProductionParameterContract(invalid), /useKeyVaultSecretReferences=true/);
  const wrongApp = structuredClone(productionParameters);
  wrongApp.parameters.containerAppName.value = "aca-wrong";
  assert.throws(() => validateProductionParameterContract(wrongApp), /containerAppName must be exactly/);
});

test("Key Vault preflight requires exact versionless references and UAMI with no value field", () => {
  const identity = "/subscriptions/test/resourceGroups/prostar-payroll/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-prostar-dispatch-prod";
  const expected = [
    { name: "azure-postgres-connection-string", keyVaultUrl: "https://kv-prostar-metrics-prod.vault.azure.net/secrets/azure-postgres-connection-string", identity },
    { name: "simpro-bearer-token", keyVaultUrl: "https://kv-prostar-metrics-prod.vault.azure.net/secrets/simpro-bearer-token", identity },
    { name: "postgres-ssl-ca-cert-base64", keyVaultUrl: "https://kv-prostar-metrics-prod.vault.azure.net/secrets/postgres-ssl-ca-cert-base64", identity },
  ];
  assert.equal(validateKeyVaultReferenceSet(structuredClone(expected), expected, "job").length, 3);
  for (const mutate of [
    (references) => { references[0].keyVaultUrl += "/version"; },
    (references) => { references[0].identity = `${identity}-wrong`; },
    (references) => { references[0].value = "must-never-be-read"; },
    (references) => { references.pop(); },
  ]) {
    const actual = structuredClone(expected);
    mutate(actual);
    assert.throws(
      () => validateKeyVaultReferenceSet(actual, expected, "job"),
      /Key Vault reference contract drifted|inline secret value/,
    );
  }
});

test("production app and exact 24 jobs share one immutable target contract", () => {
  const jobs = monitoringParameters.parameters.containerAppsJobNames.value;
  assert.deepEqual(assertExactProductionJobNames(jobs), [...PRODUCTION_JOB_NAMES].sort());
  assert.equal(PRODUCTION_JOB_NAMES.length, 24);
  assert.equal(PRODUCTION_TARGETS.length, 25);
  assert.ok(PRODUCTION_JOB_NAMES.includes("job-prostar-timesheet-jobs"));
  assert.ok(Object.isFrozen(PRODUCTION_JOB_NAMES));
  assert.ok(Object.isFrozen(PRODUCTION_TARGETS));
  assert.equal(productionTargetsForApp("aca-prostar-metrics-prod"), PRODUCTION_TARGETS);
  assert.throws(() => productionTargetsForApp("aca-wrong"), /must be exactly/);
  assert.equal(validateMonitoringTargetParameters(monitoringParameters).jobNames.length, 24);
  const wrongMonitoringApp = structuredClone(monitoringParameters);
  wrongMonitoringApp.parameters.containerAppName.value = "aca-wrong";
  assert.throws(() => validateMonitoringTargetParameters(wrongMonitoringApp), /containerAppName must be exactly/);
  for (const invalid of [jobs.slice(1), [...jobs, "job-extra"], [...jobs.slice(0, -1), jobs[0]]]) {
    assert.throws(() => assertExactProductionJobNames(invalid), /immutable exact 24-job/);
  }
  assert.match(source, /assertExactProductionJobNames/);
  assert.match(migrationSource, /assertExactProductionTargets\(PRODUCTION_TARGETS\)/);
  assert.doesNotMatch(migrationSource, /containerAppsJobNames/);
});

function ownerActionGroup(expected, lailaStatus = "Enabled") {
  return {
    enabled: true,
    emailReceivers: [
      { name: "Laila", emailAddress: expected.laila, status: lailaStatus },
      { name: "Asad", emailAddress: expected.asad, status: "Enabled" },
    ],
  };
}

test("owner action-group validation consumes the Azure CLI root shape and requires exactly two enabled owners", () => {
  const expected = {
    asad: monitoringParameters.parameters.asadOwnerEmail.value,
    laila: monitoringParameters.parameters.lailaOwnerEmail.value,
  };
  const actionGroup = ownerActionGroup(expected);
  assert.equal(validateOwnerActionGroup(actionGroup, expected).length, 2);
  assert.throws(
    () => validateOwnerActionGroup({ properties: actionGroup }, expected),
    /unexpected Azure CLI shape/,
  );
  actionGroup.emailReceivers[0].status = "Disabled";
  assert.throws(() => validateOwnerActionGroup(actionGroup, expected), /not exactly enabled Asad and Laila/);
  actionGroup.emailReceivers.push({ name: "Other", emailAddress: "other@example.test", status: "Enabled" });
  assert.throws(() => validateOwnerActionGroup(actionGroup, expected), /not exactly Asad and Laila/);
});

test("disabled Laila is enabled before a secret-free Azure-accepted notification record is persisted", async () => {
  const expected = {
    asad: monitoringParameters.parameters.asadOwnerEmail.value,
    laila: monitoringParameters.parameters.lailaOwnerEmail.value,
  };
  const events = [];
  const states = [ownerActionGroup(expected, "Disabled"), ownerActionGroup(expected)];
  let clock = 0;
  const result = await verifyOwnerActionGroupNotification({
    resourceGroup: "prostar-payroll",
    actionGroupName: "ag-prostar-metrics-owners",
    expected,
    now: () => new Date(`2026-07-13T20:00:0${clock++}Z`),
    operations: {
      async readActionGroup() { events.push("read"); return states.shift(); },
      async enableReceiver(name) { events.push(`enable:${name}`); },
      async testNotification(request) {
        events.push(`test:${request.alertType}`);
        assert.deepEqual(request.receivers, [
          { name: "Asad", emailAddress: expected.asad },
          { name: "Laila", emailAddress: expected.laila },
        ]);
      },
      async persistEvidence(evidence) { events.push("persist"); return { path: "evidence.json", evidence }; },
    },
  });
  assert.deepEqual(events, ["read", "enable:Laila", "read", "test:logalertv2", "persist"]);
  assert.deepEqual(result.evidence.request.receiverNames, ["Asad", "Laila"]);
  assert.equal(result.evidence.result.azureRequestAccepted, true);
  assert.equal(result.evidence.result.inboxDeliveryVerified, false);
  const serialized = JSON.stringify(result.evidence);
  assert.doesNotMatch(serialized, /asad@|laila@|password|token|secret/i);
  assert.match(source, /"--add-action", "email", name, emailAddress, "usecommonalertschema"/);
});

test("notification command rejection fails before any acceptance evidence is persisted", async () => {
  const expected = {
    asad: monitoringParameters.parameters.asadOwnerEmail.value,
    laila: monitoringParameters.parameters.lailaOwnerEmail.value,
  };
  let persisted = false;
  await assert.rejects(verifyOwnerActionGroupNotification({
    resourceGroup: "prostar-payroll",
    actionGroupName: "ag-prostar-metrics-owners",
    expected,
    operations: {
      async readActionGroup() { return ownerActionGroup(expected); },
      async enableReceiver() { throw new Error("unexpected enable"); },
      async testNotification() { throw new Error("Azure rejected test notification"); },
      async persistEvidence() { persisted = true; },
    },
  }), /Azure rejected test notification/);
  assert.equal(persisted, false);
});

function monitoringWhatIfChanges(postgresId) {
  const currentProductionCreates = new Set([
    "alert-prostar-metrics-postgres-longest-query",
    "alert-prostar-metrics-postgres-not-alive",
    "alert-prostar-metrics-postgres-backup-storage-capacity",
    "alert-prostar-metrics-ingestion-three-consecutive-failures",
    "alert-prostar-metrics-dead-letter-immediate",
  ]);
  return monitoringManagedResourceContract(postgresId).map(({ resourceId, resourceType }) => ({
    changeType: currentProductionCreates.has(resourceId.slice(resourceId.lastIndexOf("/") + 1)) ? "Create" : "Deploy",
    resourceId,
    after: { id: resourceId, type: resourceType },
  }));
}

test("monitoring preflight locks the exact PostgreSQL target and exact 72-resource change set", () => {
  const id = "/subscriptions/sub/resourceGroups/prostar-payroll/providers/Microsoft.DBforPostgreSQL/flexibleServers/pg-prostar-metrics-prod";
  assert.equal(validatePostgresServerTarget({
    id, name: "pg-prostar-metrics-prod", resourceGroup: "prostar-payroll",
  }).id, id);
  for (const target of [
    { id, name: "pg-wrong", resourceGroup: "prostar-payroll" },
    { id: id.replace("prostar-payroll", "wrong"), name: "pg-prostar-metrics-prod", resourceGroup: "wrong" },
  ]) assert.throws(() => validatePostgresServerTarget(target), /must be exactly/);

  const contract = monitoringManagedResourceContract(id);
  assert.equal(contract.length, 72);
  assert.ok(contract.some((resource) => resource.resourceId.endsWith("/metricAlerts/alert-prostar-metrics-postgres-longest-query".toLowerCase())));
  assert.ok(contract.some((resource) => resource.resourceId.endsWith("/scheduledQueryRules/alert-prostar-metrics-dead-letter-immediate".toLowerCase())));
  assert.ok(contract.some((resource) => resource.resourceId.includes("/jobs/job-prostar-metrics-ingest/providers/microsoft.insights/diagnosticsettings/diag-job-prostar-metrics-ingest")));

  const changes = monitoringWhatIfChanges(id);
  changes[5].changeType = "Modify";
  changes[6].changeType = "NoChange";
  changes.push({
    changeType: "Ignore",
    resourceId: "/subscriptions/sub/resourceGroups/prostar-payroll/providers/Microsoft.Storage/storageAccounts/unrelated-existing-resource",
  });
  assert.deepEqual(validateMonitoringWhatIf({ properties: { changes } }, id), { changes: 73 });
});

test("monitoring what-if rejects every unrelated mutation and malformed representation", () => {
  const id = "/subscriptions/sub/resourceGroups/prostar-payroll/providers/Microsoft.DBforPostgreSQL/flexibleServers/pg-prostar-metrics-prod";
  const unexpected = "/subscriptions/sub/resourceGroups/prostar-payroll/providers/Microsoft.Storage/storageAccounts/unrelated-resource";
  for (const changeType of ["Create", "Modify", "Delete", "Replace"]) {
    const changes = monitoringWhatIfChanges(id);
    changes.push({ changeType, resourceId: unexpected });
    assert.throws(
      () => validateMonitoringWhatIf({ changes }, id),
      /unexpected|destructive/,
      `${changeType} of an unrelated non-PostgreSQL resource must fail closed`,
    );
  }

  const destructive = monitoringWhatIfChanges(id);
  destructive[0].changeType = "Delete";
  assert.throws(() => validateMonitoringWhatIf({ changes: destructive }, id), /destructive Delete/);

  const wrongType = monitoringWhatIfChanges(id);
  wrongType[0].after.type = "Microsoft.Storage/storageAccounts";
  assert.throws(() => validateMonitoringWhatIf({ changes: wrongType }, id), /resource type drifted/);

  const duplicate = monitoringWhatIfChanges(id);
  duplicate.push(structuredClone(duplicate[0]));
  assert.throws(() => validateMonitoringWhatIf({ changes: duplicate }, id), /duplicate managed resource/);

  const missing = monitoringWhatIfChanges(id).slice(1);
  assert.throws(() => validateMonitoringWhatIf({ changes: missing }, id), /omitted 1 managed resource/);

  const ignoredManaged = monitoringWhatIfChanges(id);
  ignoredManaged[0].changeType = "Ignore";
  assert.throws(() => validateMonitoringWhatIf({ changes: ignoredManaged }, id), /ignored a managed resource/);

  const unsupported = monitoringWhatIfChanges(id);
  unsupported[0].changeType = "NoEffect";
  assert.throws(() => validateMonitoringWhatIf({ changes: unsupported }, id), /unsupported change type/);

  const outOfScopeIgnore = monitoringWhatIfChanges(id);
  outOfScopeIgnore.push({
    changeType: "Ignore",
    resourceId: "/subscriptions/other/resourceGroups/other/providers/Microsoft.Storage/storageAccounts/ignored",
  });
  assert.throws(() => validateMonitoringWhatIf({ changes: outOfScopeIgnore }, id), /out-of-scope resource ID/);
});

test("longest-query collector is set and read on, then restored after any later release failure", async () => {
  const events = [];
  const reads = ["off", "on", "off"];
  await assert.rejects(withLongestQueryCollectorEnabled({
    operations: {
      async preflight() { events.push("preflight"); },
      async readParameter() {
        const value = reads.shift();
        events.push(`read:${value}`);
        return { name: "metrics.collector_database_activity", value, source: "system-default" };
      },
      async setParameter(value) { events.push(`set:${value}`); },
    },
    async run() { events.push("monitoring-and-release"); throw new Error("candidate failed"); },
  }), /candidate failed/);
  assert.deepEqual(events, [
    "preflight", "read:off", "set:on", "read:on", "monitoring-and-release", "set:off", "read:off",
  ]);
});

test("collector preflight and on read-back fail closed before monitoring verification", async () => {
  assert.equal(validateLongestQueryCollector({
    name: "metrics.collector_database_activity", value: "on",
  }, "on").value, "on");
  const events = [];
  await assert.rejects(withLongestQueryCollectorEnabled({
    operations: {
      async preflight() { events.push("preflight"); },
      async readParameter() {
        events.push("read");
        return { name: "metrics.collector_database_activity", value: "off" };
      },
      async setParameter(value) { events.push(`set:${value}`); },
    },
    async run() { events.push("run"); },
  }), /must read on/);
  assert.deepEqual(events, ["preflight", "read", "set:on", "read", "set:off", "read"]);
  assert.match(source, /"postgres", "flexible-server", "parameter", "set"/);
  assert.equal((source.match(/"parameter", "set"/g) ?? []).length, 1);
});

function longestQueryMetricResponse({
  metricName = "longest_query_time_sec",
  errorCode = "Success",
  timeseries = [{
    metadatavalues: [],
    data: [{ timeStamp: "2026-07-13T19:59:00.000Z", maximum: 1.25 }],
  }],
} = {}) {
  return { value: [{ name: { value: metricName }, errorCode, timeseries }] };
}

test("longest-query live metric query validates a real sample and persists secret-free evidence", async () => {
  const now = () => new Date("2026-07-13T20:00:00.000Z");
  const interval = {
    startTime: "2026-07-13T19:30:00.000Z",
    endTime: "2026-07-13T20:00:00.000Z",
  };
  assert.deepEqual(validateLongestQueryMetricResponse(longestQueryMetricResponse(), interval), {
    metricName: "longest_query_time_sec",
    timeseriesCount: 1,
    sampleCount: 1,
    latestSampleTimestamp: "2026-07-13T19:59:00.000Z",
    latestMaximumSeconds: 1.25,
  });
  let persisted = null;
  const result = await verifyLongestQueryMetricAvailability({
    resourceGroup: "prostar-payroll",
    serverName: "pg-prostar-metrics-prod",
    resourceId: "/subscriptions/sub/resourceGroups/prostar-payroll/providers/Microsoft.DBforPostgreSQL/flexibleServers/pg-prostar-metrics-prod",
    now,
    operations: {
      async queryMetric(query) {
        assert.deepEqual(query, {
          metricName: "longest_query_time_sec",
          aggregation: "Maximum",
          interval: "1m",
          ...interval,
        });
        return longestQueryMetricResponse();
      },
      async sleep() { throw new Error("unexpected activation poll"); },
      async persistEvidence(evidence) { persisted = evidence; return { path: "metric-evidence.json" }; },
    },
  });
  assert.equal(result.persisted.path, "metric-evidence.json");
  assert.equal(persisted.result.azureApiSuccess, true);
  assert.equal(persisted.result.sampleCount, 1);
  assert.doesNotMatch(JSON.stringify(persisted), /password|token|secret|asad@|laila@/i);
});

test("longest-query validation accepts Azure empty buckets before a real zero sample", () => {
  const interval = {
    startTime: "2026-07-13T19:30:00.000Z",
    endTime: "2026-07-13T20:00:00.000Z",
  };
  const response = longestQueryMetricResponse({
    timeseries: [{
      metadatavalues: [],
      data: [
        { timeStamp: "2026-07-13T19:58:00.000Z" },
        { timeStamp: "2026-07-13T19:59:00.000Z", maximum: 0 },
      ],
    }],
  });
  assert.deepEqual(validateLongestQueryMetricResponse(response, interval), {
    metricName: "longest_query_time_sec",
    timeseriesCount: 1,
    sampleCount: 1,
    latestSampleTimestamp: "2026-07-13T19:59:00.000Z",
    latestMaximumSeconds: 0,
  });
});

test("longest-query validation aligns the lower bound to Azure one-minute buckets", () => {
  const interval = {
    startTime: "2026-07-13T19:30:33.879Z",
    endTime: "2026-07-13T20:00:33.879Z",
  };
  const response = longestQueryMetricResponse({
    timeseries: [{
      metadatavalues: [],
      data: [{ timeStamp: "2026-07-13T19:30:00.000Z", maximum: 0 }],
    }],
  });
  assert.equal(validateLongestQueryMetricResponse(response, interval).sampleCount, 1);
  assert.throws(
    () => validateLongestQueryMetricResponse(longestQueryMetricResponse({
      timeseries: [{
        metadatavalues: [],
        data: [{ timeStamp: "2026-07-13T19:29:59.999Z", maximum: 0 }],
      }],
    }), interval),
    /outside the query interval/,
  );
  assert.throws(
    () => validateLongestQueryMetricResponse(longestQueryMetricResponse({
      timeseries: [{
        metadatavalues: [],
        data: [{ timeStamp: "2026-07-13T20:00:33.880Z", maximum: 0 }],
      }],
    }), interval),
    /outside the query interval/,
  );
});

test("longest-query live metric validation rejects malformed, errored, and different metrics", () => {
  const interval = {
    startTime: "2026-07-13T19:30:00.000Z",
    endTime: "2026-07-13T20:00:00.000Z",
  };
  assert.throws(
    () => validateLongestQueryMetricResponse({ value: {} }, interval),
    /exactly one metric value/,
  );
  assert.throws(
    () => validateLongestQueryMetricResponse(longestQueryMetricResponse({
      timeseries: [{ data: [] }],
    }), interval),
    /malformed schema/,
  );
  assert.throws(
    () => validateLongestQueryMetricResponse(longestQueryMetricResponse({
      timeseries: [{ metadatavalues: [], data: [{ maximum: 1 }] }],
    }), interval),
    /malformed schema/,
  );
  assert.throws(
    () => validateLongestQueryMetricResponse(longestQueryMetricResponse({ errorCode: "BadRequest" }), interval),
    /did not report Success/,
  );
  assert.throws(
    () => validateLongestQueryMetricResponse(longestQueryMetricResponse({ metricName: "cpu_percent" }), interval),
    /different metric/,
  );
});

test("empty metric availability times out and compensates the collector parameter", async () => {
  const events = [];
  const reads = ["off", "on", "off"];
  await assert.rejects(withLongestQueryCollectorEnabled({
    operations: {
      async preflight() { events.push("preflight"); return { id: "postgres-id" }; },
      async readParameter() {
        const value = reads.shift();
        events.push(`read:${value}`);
        return { name: "metrics.collector_database_activity", value };
      },
      async setParameter(value) { events.push(`set:${value}`); },
    },
    async run() {
      await verifyLongestQueryMetricAvailability({
        resourceGroup: "prostar-payroll",
        serverName: "pg-prostar-metrics-prod",
        resourceId: "postgres-id",
        timeoutMs: 0,
        now: () => new Date("2026-07-13T20:00:00.000Z"),
        operations: {
          async queryMetric() {
            events.push("metric:empty");
            return longestQueryMetricResponse({ timeseries: [{ metadatavalues: [], data: [] }] });
          },
          async sleep() { events.push("unexpected-sleep"); },
          async persistEvidence() { events.push("unexpected-evidence"); },
        },
      });
    },
  }), /bounded activation timeout/);
  assert.deepEqual(events, [
    "preflight", "read:off", "set:on", "read:on", "metric:empty", "set:off", "read:off",
  ]);
});

test("Azure metrics command rejection fails immediately without evidence or polling", async () => {
  const events = [];
  await assert.rejects(verifyLongestQueryMetricAvailability({
    resourceGroup: "prostar-payroll",
    serverName: "pg-prostar-metrics-prod",
    resourceId: "postgres-id",
    now: () => new Date("2026-07-13T20:00:00.000Z"),
    operations: {
      async queryMetric() { events.push("query"); throw new Error("Azure metrics API rejected query"); },
      async sleep() { events.push("sleep"); },
      async persistEvidence() { events.push("evidence"); },
    },
  }), /Azure metrics API rejected query/);
  assert.deepEqual(events, ["query"]);
});

test("production deploy reviews image-only what-if and verifies every managed job", () => {
  assert.match(source, /"deployment", "group", "what-if"/);
  assert.match(source, /Production what-if contains unexpected drift/);
  assert.match(source, /captureDeploymentState\(\)/);
  assert.match(source, /assertRollbackCompatibleBaseline\(baseline\)/);
  assert.match(source, /finalizeCandidateDeployment\(\{/);
  assert.match(source, /full target contract changed unexpectedly/);
});

test("what-if semantic validation rejects non-image drift and malformed evidence", () => {
  const expectedImage = "registry.example/metrics@sha256:new";
  const changes = productionWhatIfChanges(expectedImage);
  assert.deepEqual(validateDeploymentWhatIf({ changes }, {
    expectedImage,
    subscriptionId: TEST_SUBSCRIPTION_ID,
  }), { managedResourceCount: 25, supportResourceCount: 6 });
  const targetContract = productionDeploymentTargetContract(TEST_SUBSCRIPTION_ID);
  const supportContract = productionDeploymentSupportContract(TEST_SUBSCRIPTION_ID);
  assert.equal(targetContract.length, 25);
  assert.equal(supportContract.length, 6);
  assert.ok(supportContract.every((resourceId) => resourceId.startsWith(
    `/subscriptions/${TEST_SUBSCRIPTION_ID}/resourcegroups/prostar-payroll/providers/`,
  )));
  assert.deepEqual(targetContract.map(({ kind, name, resourceGroup }) => ({ kind, name, resourceGroup })), PRODUCTION_TARGETS);
  assert.ok(targetContract.every(({ resourceId, resourceType, kind }) => (
    resourceId.startsWith(`/subscriptions/${TEST_SUBSCRIPTION_ID}/resourcegroups/prostar-payroll/providers/microsoft.app/`)
    && resourceType === (kind === "app" ? "Microsoft.App/containerApps" : "Microsoft.App/jobs")
  )));

  for (const mutate of [
    (resource) => { resource.properties.template.containers[0].args = ["run", "wrong"]; },
    (resource) => { resource.properties.template.containers[0].env[0].value = "wrong"; },
    (resource) => { resource.properties.template.containers[0].resources.cpu = 99; },
    (resource) => { resource.properties.configuration.secrets.push({ name: "unexpected-secret" }); },
    (resource) => { resource.properties.configuration.replicaTimeout = 1; },
    (resource) => { resource.properties.environmentId = "/wrong/environment"; },
    (resource) => { resource.identity.userAssignedIdentities = { "/wrong/identity": {} }; },
    (resource) => { resource.tags.environment = "wrong"; },
    (resource) => { resource.properties.configuration.scheduleTriggerConfig.cronExpression = "0 0 * * *"; },
    (resource) => { resource.properties.template.scale = { minExecutions: 9 }; },
  ]) {
    const drifted = structuredClone(changes);
    mutate(drifted[1].after);
    assert.throws(
      () => validateDeploymentWhatIf({ changes: drifted }, {
        expectedImage,
        subscriptionId: TEST_SUBSCRIPTION_ID,
      }),
      /non-image-contract-drift/,
    );
  }

  assert.throws(
    () => validateDeploymentWhatIf({}, { expectedImage, subscriptionId: TEST_SUBSCRIPTION_ID }),
    /no recognized changes array/,
  );
  const missingDelta = structuredClone(changes);
  missingDelta[0].delta = [];
  assert.throws(
    () => validateDeploymentWhatIf({ changes: missingDelta }, {
      expectedImage,
      subscriptionId: TEST_SUBSCRIPTION_ID,
    }),
    /missing-semantic-evidence/,
  );
  const unsupportedDelta = structuredClone(changes);
  unsupportedDelta[0].delta[0].path = "properties.template.containers";
  assert.throws(
    () => validateDeploymentWhatIf({ changes: unsupportedDelta }, {
      expectedImage,
      subscriptionId: TEST_SUBSCRIPTION_ID,
    }),
    /missing-or-invalid-image-delta/,
  );
  const unsupportedField = structuredClone(changes);
  unsupportedField[0].after.properties.unsupported = true;
  assert.throws(
    () => validateDeploymentWhatIf({ changes: unsupportedField }, {
      expectedImage,
      subscriptionId: TEST_SUBSCRIPTION_ID,
    }),
    /unsupported-or-missing-contract/,
  );
});

test("image-only comparison keeps secondary and init container images and membership immutable", () => {
  const expectedImage = "registry.example/metrics@sha256:new";
  const validate = (changes) => validateDeploymentWhatIf({ changes }, {
    expectedImage,
    subscriptionId: TEST_SUBSCRIPTION_ID,
  });
  const stable = productionWhatIfChanges(expectedImage);
  for (const side of [stable[1].before, stable[1].after]) {
    side.properties.template.containers.push(auxiliaryContainer("sidecar", "registry.example/sidecar@sha256:stable"));
    side.properties.template.initContainers.push(auxiliaryContainer("setup", "registry.example/setup@sha256:stable"));
  }
  assert.deepEqual(validate(stable), { managedResourceCount: 25, supportResourceCount: 6 });

  const mutations = [
    {
      name: "init-container image",
      prepare(change) {
        change.before.properties.template.initContainers = [auxiliaryContainer("setup", "registry.example/setup@sha256:old")];
        change.after.properties.template.initContainers = [auxiliaryContainer("setup", "registry.example/setup@sha256:new")];
      },
    },
    {
      name: "secondary-container image",
      prepare(change) {
        change.before.properties.template.containers.push(auxiliaryContainer("sidecar", "registry.example/sidecar@sha256:old"));
        change.after.properties.template.containers.push(auxiliaryContainer("sidecar", "registry.example/sidecar@sha256:new"));
      },
    },
    {
      name: "added init container",
      prepare(change) {
        change.after.properties.template.initContainers.push(auxiliaryContainer("setup", "registry.example/setup@sha256:stable"));
      },
    },
    {
      name: "removed init container",
      prepare(change) {
        change.before.properties.template.initContainers.push(auxiliaryContainer("setup", "registry.example/setup@sha256:stable"));
      },
    },
    {
      name: "added secondary container",
      prepare(change) {
        change.after.properties.template.containers.push(auxiliaryContainer("sidecar", "registry.example/sidecar@sha256:stable"));
      },
    },
    {
      name: "removed secondary container",
      prepare(change) {
        change.before.properties.template.containers.push(auxiliaryContainer("sidecar", "registry.example/sidecar@sha256:stable"));
      },
    },
  ];

  for (const mutation of mutations) {
    const changes = productionWhatIfChanges(expectedImage);
    mutation.prepare(changes[1]);
    assert.throws(
      () => validate(changes),
      /non-image-contract-drift/,
      mutation.name,
    );
  }
});

test("production what-if accepts Azure nested image deltas and the app running-status projection", () => {
  const expectedImage = "registry.example/metrics@sha256:new";
  const changes = productionWhatIfChanges(expectedImage);
  for (let index = 0; index < PRODUCTION_TARGETS.length; index += 1) {
    const change = changes[index];
    const image = change.delta[0];
    change.before.resourceGroup = "prostar-payroll";
    change.after.resourceGroup = "prostar-payroll";
    change.delta = [{
      path: "properties.template.containers",
      propertyChangeType: "Array",
      before: null,
      after: null,
      children: [{
        path: "0",
        propertyChangeType: "Modify",
        before: null,
        after: null,
        children: [{
          path: "image",
          propertyChangeType: image.propertyChangeType,
          before: image.before,
          after: image.after,
          children: null,
        }],
      }],
    }];
    if (PRODUCTION_TARGETS[index].kind === "app") {
      change.before.properties.runningStatus = "Running";
      change.delta.unshift({
        path: "properties.runningStatus",
        propertyChangeType: "Delete",
        before: "Running",
        after: null,
        children: null,
      });
    }
  }
  changes.push({
    changeType: "Ignore",
    resourceId: `/subscriptions/${TEST_SUBSCRIPTION_ID}/resourceGroups/prostar-payroll/providers/Microsoft.App/containerApps/unrelated`,
  });
  assert.deepEqual(validateDeploymentWhatIf({ changes }, {
    expectedImage,
    subscriptionId: TEST_SUBSCRIPTION_ID,
  }), { managedResourceCount: 25, supportResourceCount: 6 });
});

test("production what-if rejects duplicate, misplaced, mistyped, missing, destructive, and unrelated targets", () => {
  const expectedImage = "registry.example/metrics@sha256:new";
  const valid = productionWhatIfChanges(expectedImage);
  const validate = (changes) => validateDeploymentWhatIf({ changes }, {
    expectedImage,
    subscriptionId: TEST_SUBSCRIPTION_ID,
  });

  const duplicate = [...structuredClone(valid), structuredClone(valid[0])];
  assert.throws(() => validate(duplicate), /duplicate-target/);

  const wrongResourceGroup = structuredClone(valid);
  rewriteWhatIfIdentity(wrongResourceGroup[1], wrongResourceGroup[1].resourceId.replace(
    "/resourceGroups/prostar-payroll/",
    "/resourceGroups/another-group/",
  ));
  assert.throws(() => validate(wrongResourceGroup), /unrelated-or-malformed-resource/);

  const wrongType = structuredClone(valid);
  rewriteWhatIfIdentity(wrongType[1], wrongType[1].resourceId.replace(
    "/Microsoft.App/jobs/",
    "/Microsoft.App/containerApps/",
  ));
  wrongType[1].before.type = "Microsoft.App/containerApps";
  wrongType[1].after.type = "Microsoft.App/containerApps";
  assert.throws(() => validate(wrongType), /unrelated-or-malformed-resource/);

  const typeDrift = structuredClone(valid);
  typeDrift[1].after.type = "Microsoft.App/containerApps";
  assert.throws(() => validate(typeDrift), /resource-type-drift/);

  assert.throws(() => validate(valid.slice(1)), /MissingModify:/);

  for (const changeType of ["Delete", "Replace", "Create", "NoChange", "Ignore"]) {
    const destructive = structuredClone(valid);
    destructive[0].changeType = changeType;
    assert.throws(() => validate(destructive), /expected-image-only-modify/);
  }

  const malformed = structuredClone(valid);
  rewriteWhatIfIdentity(malformed[0], "not-an-azure-resource-id");
  assert.throws(() => validate(malformed), /unrelated-or-malformed-resource/);

  const supportMutation = structuredClone(valid);
  supportMutation[PRODUCTION_TARGETS.length].changeType = "Modify";
  assert.throws(() => validate(supportMutation), /support-resource-mutation/);

  const missingSupport = structuredClone(valid);
  missingSupport.pop();
  assert.throws(() => validate(missingSupport), /MissingNoChange:/);

  const duplicateSupport = [...structuredClone(valid), structuredClone(valid[PRODUCTION_TARGETS.length])];
  assert.throws(() => validate(duplicateSupport), /duplicate-support-resource/);

  for (const changeType of ["Ignore", "NoChange"]) {
    const harmlessSharedResource = structuredClone(valid);
    harmlessSharedResource.push({
      changeType,
      resourceId: `/subscriptions/${TEST_SUBSCRIPTION_ID}/resourceGroups/prostar-payroll/providers/Microsoft.Storage/storageAccounts/unrelated`,
    });
    assert.deepEqual(validate(harmlessSharedResource), { managedResourceCount: 25, supportResourceCount: 6 });
  }

  const unrelated = structuredClone(valid);
  unrelated.push({
    changeType: "Modify",
    resourceId: `/subscriptions/${TEST_SUBSCRIPTION_ID}/resourceGroups/prostar-payroll/providers/Microsoft.Storage/storageAccounts/unrelated`,
  });
  assert.throws(() => validate(unrelated), /unrelated-or-malformed-resource/);
});

test("release health requires the candidate revision itself at 100 percent traffic", () => {
  const expectedImage = "registry.example/metrics@sha256:new";
  const ready = {
    revisionMode: "Single",
    latestRevisionName: "app--2",
    latestReadyRevisionName: "app--2",
    active: true,
    healthState: "Healthy",
    provisioningState: "Provisioned",
    image: expectedImage,
    trafficWeight: 100,
    trafficRevisionNames: ["app--2"],
  };
  assert.equal(readyRevisionFailure(ready, expectedImage), null);
  for (const [field, value] of [
    ["latestReadyRevisionName", "app--1"],
    ["active", false],
    ["healthState", "Unknown"],
    ["provisioningState", "Provisioning"],
    ["image", "old"],
    ["trafficWeight", 0],
    ["trafficRevisionNames", ["app--1"]],
  ]) {
    assert.notEqual(readyRevisionFailure({ ...ready, [field]: value }, expectedImage), null);
  }
});

test("routine deploy remains lean while --full retains exhaustive preflight and monitoring", () => {
  const releaseSource = source.slice(
    source.indexOf("async function executeProductionRelease"),
    source.indexOf("async function main()"),
  );
  const keyVaultGate = releaseSource.indexOf("verifyProductionKeyVaultPreflight(keyVaultContract);");
  const buildCall = releaseSource.indexOf('"acr",\n      "build"');
  const postgresGate = releaseSource.indexOf("runPostgresPredeployGate(connectionString, previousImage)");
  const compatibilityCall = releaseSource.indexOf("runMigrationCompatibilityGate(connectionString, previousImage)");
  const migrationCall = releaseSource.indexOf("applyTrackedMigrations(connectionString, previousImage)");
  const deploymentCall = releaseSource.indexOf("finalizeCandidateDeployment({");
  const migrationFirewallGate = releaseSource.slice(
    releaseSource.indexOf("const publicIp = await getPublicIp();"),
    releaseSource.indexOf("const deploymentName = releaseIdentity.deploymentRunId;"),
  );
  assert.ok(keyVaultGate < buildCall && keyVaultGate < migrationCall);
  assert.match(source, /preflight: \(\) => reviewMonitoringWhatIfAndTarget\(\)/);
  assert.match(source, /if \(args\.mode === "routine"\)/);
  assert.match(source, /readRoutineMonitoringEvidence\(\)/);
  assert.match(source, /else if \(args\.mode === "full"\) \{\s*runDeploymentPreflight/s);
  const monitoringSource = source.slice(
    source.indexOf("async function deployAndVerifyMonitoringReceivers"),
    source.indexOf("function versionlessSecretUrl"),
  );
  const monitoringDeploy = monitoringSource.indexOf('"deployment", "group", "create"');
  const metricQuery = monitoringSource.indexOf("verifyLongestQueryMetricAvailability({");
  const receiverVerification = monitoringSource.indexOf("verifyOwnerActionGroupNotification({");
  assert.ok(monitoringDeploy < metricQuery && metricQuery < receiverVerification);
  assert.match(monitoringSource, /"test-notifications", "create"[\s\S]*"--no-wait"[\s\S]*"--output", "none"/);
  assert.doesNotMatch(source, /already-verified/);
  assert.deepEqual(parseDeployArgs([]), { mode: "routine" });
  assert.deepEqual(parseDeployArgs(["--resume"]), { mode: "routine" });
  assert.deepEqual(parseDeployArgs(["--full"]), { mode: "full" });
  assert.throws(() => parseDeployArgs(["--full", "--resume"]), /Unknown deploy argument/);
  assert.throws(() => parseDeployArgs(["--resume", "--resume"]), /Unknown deploy argument/);
  assert.throws(() => parseDeployArgs(["--already-verified"]), /Unknown deploy argument/);
  assert.throws(() => parseDeployArgs(["--anything"]), /Unknown deploy argument/);
  for (const contract of [
    /\["npm", \["test"\], "tests"\]/,
    /\["npm", \["run", "test:infra"\], "infrastructure tests"\]/,
    /\["npm", \["run", "lint"\], "ESLint"\]/,
    /\["npm", \["exec", "--", "tsc", "--noEmit"\], "TypeScript"\]/,
    /\["npm", \["run", "guard:no-mirror"\], "no-mirror guard"\]/,
    /\["npm", \["run", "build"\], "production build"\]/,
  ]) assert.match(source, contract);
  const mainSource = source.slice(source.indexOf("async function main()"));
  assert.ok(mainSource.indexOf("runDeploymentPreflight(snapshotPath);") < mainSource.indexOf("withLongestQueryCollectorEnabled({"));
  assert.equal(packageJson.scripts["test:predeploy:postgres"], "npm run test:migrations");
  assert.doesNotMatch(packageJson.scripts["phase0:check"], /test:migrations|test:predeploy:postgres/);
  assert.ok(postgresGate >= 0 && postgresGate < migrationCall);
  assert.ok(compatibilityCall >= 0 && compatibilityCall < postgresGate);
  assert.ok(migrationCall < deploymentCall);
  assert.match(source, /MIGRATION_COMPATIBILITY_REPORT = "1"/);
  assert.match(compatibilitySource, /MIGRATION_COMPATIBILITY_REPORT \$\{JSON\.stringify\(\{ pendingMigrationCount: pending\.length \}\)\}/);
  assert.ok(migrationFirewallGate.indexOf("withReconciledTemporaryFirewall({")
    < migrationFirewallGate.indexOf("runMigrationCompatibilityGate(connectionString, previousImage)"));
  assert.match(migrationFirewallGate, /const publicIp = await getPublicIp\(\);[\s\S]*withReconciledTemporaryFirewall\(\{/);
  assert.match(migrationFirewallGate, /verifyPresent: async \(\) => verifyTemporaryMigrationFirewallPresent\(publicIp\)/);
  assert.match(migrationFirewallGate, /if \(migrationCompatibility\.pendingMigrationCount === 0\) \{\s*log\("no pending migrations; skipping the migration-only predeploy gates"\);\s*return;\s*\}/);
  assert.match(migrationFirewallGate, /runPostgresPredeployGate\(connectionString, previousImage\)/);
  assert.match(migrationFirewallGate, /applyTrackedMigrations\(connectionString, previousImage\)/);
  assert.match(source, /MIGRATION_COMPATIBILITY_MODE = "static"/);
  assert.match(releaseSource, /static prior-image compatibility classification \(no production data clone\)/);
  assert.match(releaseSource, /dedicated empty database/);
  assert.match(source, /PostgreSQL migration and two-session concurrency predeploy gate failed/);
  assert.match(source, /re-verifying reusable certified ACR image/);
  assert.match(source, /computeDependencyTreeSha256/);
  assert.match(source, /Routine deployment requires existing full-release monitoring evidence/);
});

const TEST_SUBSCRIPTION_ID = "11111111-1111-4111-8111-111111111111";

function productionWhatIfChanges(expectedImage) {
  return [
    ...PRODUCTION_TARGETS.map((target) => whatIfChange(
      target.name,
      target.kind === "app" ? "Microsoft.App/containerApps" : "Microsoft.App/jobs",
      expectedImage,
      target.resourceGroup,
    )),
    ...productionDeploymentSupportContract(TEST_SUBSCRIPTION_ID).map((resourceId) => ({
      changeType: "NoChange",
      resourceId,
      delta: [],
    })),
  ];
}

function rewriteWhatIfIdentity(change, resourceId) {
  change.resourceId = resourceId;
  change.before.id = resourceId;
  change.after.id = resourceId;
}

function auxiliaryContainer(name, image) {
  return {
    name,
    image,
    command: ["node"],
    args: ["worker.mjs"],
    env: [{ name: "NODE_ENV", value: "production" }],
    resources: { cpu: 0.25, memory: "0.5Gi" },
    probes: [],
    volumeMounts: [],
  };
}

function whatIfChange(name, resourceType, expectedImage, resourceGroup = "prostar-payroll") {
  const isJob = resourceType.endsWith("/jobs");
  const identity = "/subscriptions/test/resourceGroups/prostar-payroll/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-prostar-dispatch-prod";
  const environmentId = "/subscriptions/test/resourceGroups/prostar-payroll/providers/Microsoft.App/managedEnvironments/cae-prostar-dispatch-prod";
  const resourceId = `/subscriptions/${TEST_SUBSCRIPTION_ID}/resourceGroups/${resourceGroup}/providers/${resourceType}/${name}`;
  const resource = {
    id: resourceId,
    name,
    type: resourceType,
    location: "westus2",
    tags: { environment: "prod", managedBy: "bicep", workload: "prostar-metrics" },
    identity: { type: "UserAssigned", userAssignedIdentities: { [identity]: {} } },
    properties: {
      ...(isJob ? { environmentId } : { managedEnvironmentId: environmentId }),
      configuration: {
        activeRevisionsMode: isJob ? undefined : "Single",
        ingress: isJob ? undefined : { allowInsecure: false, external: true, targetPort: 3000, transport: "Auto" },
        registries: [{ identity, server: "acrprostardispatchprod.azurecr.io" }],
        secrets: [
          { name: "azure-postgres-connection-string", keyVaultUrl: "https://kv-prostar-metrics-prod.vault.azure.net/secrets/azure-postgres-connection-string", identity },
          { name: "simpro-bearer-token", keyVaultUrl: "https://kv-prostar-metrics-prod.vault.azure.net/secrets/simpro-bearer-token", identity },
        ],
        triggerType: isJob ? "Schedule" : undefined,
        scheduleTriggerConfig: isJob ? { cronExpression: "*/15 * * * *", parallelism: 1, replicaCompletionCount: 1 } : undefined,
        replicaTimeout: isJob ? 1200 : undefined,
        replicaRetryLimit: isJob ? 1 : undefined,
      },
      template: {
        containers: [{
          name: isJob ? "ingest" : "web",
          image: "registry.example/metrics@sha256:old",
          command: ["npm"],
          args: isJob ? ["run", "ingest:worker"] : ["run", "start"],
          env: [{ name: "NODE_ENV", value: "production" }],
          resources: { cpu: 1, memory: "2Gi" },
          probes: isJob ? [] : [{ type: "Liveness", periodSeconds: 30 }],
          volumeMounts: [],
        }],
        initContainers: [],
        scale: isJob ? { minExecutions: 0, maxExecutions: 1 } : { minReplicas: 1, maxReplicas: 2 },
        serviceBinds: [],
        terminationGracePeriodSeconds: 30,
        volumes: [],
      },
    },
  };
  const after = structuredClone(resource);
  after.properties.template.containers[0].image = expectedImage;
  return {
    changeType: "Modify",
    resourceId,
    before: resource,
    after,
    delta: [{
      path: "properties.template.containers[0].image",
      propertyChangeType: "Modify",
      before: resource.properties.template.containers[0].image,
      after: expectedImage,
    }],
  };
}
