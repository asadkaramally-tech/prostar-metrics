import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";

import { computeDockerBuildContext } from "../../scripts/lib/deployment-provenance.mjs";
import { createSanitizedAuthSessionArtifact } from "../../scripts/check-release-evidence.mjs";
import {
  RELEASE_GATE_ASSERTION_EVENT_PREFIX,
  releaseGateAssertionEvent,
  summarizeReleaseGateAssertions,
} from "../../scripts/lib/release-gate-assertions.mjs";
import {
  FEATURE_LEDGER_SCHEMA_VERSION,
  PLAN_REVISION,
  PLAN_SHA256,
  expectedAcceptingGate,
  parseAuthoritativePlan,
} from "../../scripts/lib/feature-status-sync.mjs";
import { PRODUCTION_TARGETS } from "../../scripts/lib/production-targets.mjs";
import {
  BROWSER_ARTIFACT_VALIDATION_SCHEMA_VERSION,
  BROWSER_ARTIFACT_VALIDATOR_NAME,
  BROWSER_ARTIFACT_VALIDATOR_VERSION,
  EXPECTED_GATE_COMMANDS,
  GATE_CATEGORIES,
  GATE_RUNNER_NAME,
  GATE_RUNNER_SCHEMA_VERSION,
  GATE_RUNNER_VERSION,
  PRODUCTION_GATE_COMMANDS,
  STRUCTURED_GATE_RESULT_SCHEMA_VERSION,
  browserArtifactValidationSubject,
  gateReceiptSubject,
  jsonBytes,
  publicKeyFingerprint,
  externalReviewValidationSubject,
  verifyServiceReceipt,
} from "../../scripts/lib/release-evidence-trust.mjs";

export const validationNow = new Date("2026-07-13T20:40:00Z");
export const productionUrl = "https://aca-prostar-metrics-prod.example.test";
export const deployedRevision = "aca-prostar-metrics-prod--0000099";
export const imageDigest = `sha256:${"c".repeat(64)}`;
export const reviewerAgent = "019a1b2c-3d4e-5f60-a111-222233334444";
export const reviewerThread = "019b2c3d-4e5f-6071-b222-333344445555";
export const authenticatedActor = "asad@prostarmechanical.com";
export const authenticatedPrincipalId = "f7293194-18c0-4957-b259-9cd6ef8d492b";
export const authenticationProvider = "aad";

const deploymentRunId = "prostar-metrics-123e4567-e89b-42d3-a456-426614174000";
const deploymentNonce = "123e4567-e89b-42d3-a456-426614174000";
const keyNames = {
  gate: "prostar-release-gate-evidence",
  browser: "prostar-release-browser-evidence",
  reviewer: "prostar-release-reviewer-evidence",
};
const keyVersions = { gate: "a".repeat(32), browser: "b".repeat(32), reviewer: "d".repeat(32) };
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = publicKey.export({ format: "jwk" });
const normalizedPublicJwk = { kty: "RSA", n: publicJwk.n, e: publicJwk.e };

export async function createReleaseFixture() {
  const root = await mkdtemp(join(tmpdir(), "release-trust-fixture-"));
  const plan = await readFile(new URL("../../docs/prostar-metrics/execution-plan.md", import.meta.url), "utf8");
  const planRows = parseAuthoritativePlan(plan);
  const ledger = Buffer.from(`${JSON.stringify({
    schemaVersion: FEATURE_LEDGER_SCHEMA_VERSION,
    planRevision: PLAN_REVISION,
    planSha256: PLAN_SHA256,
    features: planRows.map((row) => ({
      id: row.id,
      requirement: row.requirement,
      baselineStatus: row.baselineStatus,
      executionStatus: row.baselineStatus === "REMOVED BY OWNER DECISION"
        ? row.baselineStatus
        : "PARTIAL",
      acceptingGate: expectedAcceptingGate(row.id),
    })),
  }, null, 2)}\n`);
  await writeAt(root, ".dockerignore", [
    "node_modules", ".next", ".git", ".env", ".env.local", "*.log", "coverage", "dist", "tmp",
    "tsconfig.tsbuildinfo", ".playwright-cli", ".work", "docs/prostar-metrics/verification",
    "docs/prostar-metrics/reconciliation", "docs/prostar-metrics/feature-status.json",
  ].join("\n") + "\n");
  await writeAt(root, "Dockerfile", "FROM scratch\nCOPY . /app\n");
  await writeAt(root, "src/app.txt", "release source\n");
  await writeAt(root, "docs/prostar-metrics/execution-plan.md", plan);
  await writeAt(root, "docs/prostar-metrics/feature-status.json", ledger);
  await mkdir(join(root, "node_modules"), { recursive: true });
  const buildSourceSha256 = (await computeDockerBuildContext(root)).sha256;
  const mandatoryIds = planRows
    .filter((row) => row.baselineStatus !== "REMOVED BY OWNER DECISION")
    .map((row) => row.id);

  const monitoringEvidence = {};
  for (const [name, content] of [
    ["longestQueryMetric", { operation: "azure-monitor-longest-query-metric-availability", success: true }],
    ["actionGroupNotification", { operation: "azure-monitor-action-group-test-notification", success: true }],
  ]) {
    const path = `docs/prostar-metrics/verification/monitoring/${name}.json`;
    monitoringEvidence[name] = { path, sha256: await writeJsonAt(root, path, content) };
  }
  const pinnedImage = `acrprostardispatchprod.azurecr.io/prostar-metrics@${imageDigest}`;
  const evidenceSigningKeyIds = Object.fromEntries(Object.entries(keyNames).map(([kind, name]) => [
    kind, `https://kv-prostar-metrics-prod.vault.azure.net/keys/${name}/${keyVersions[kind]}`,
  ]));
  const deployment = {
    schemaVersion: 3,
    environment: "production",
    planRevision: PLAN_REVISION,
    planSha256: PLAN_SHA256,
    buildSourceSha256,
    resourceGroup: "prostar-payroll",
    containerAppName: "aca-prostar-metrics-prod",
    registry: "acrprostardispatchprod",
    repository: "prostar-metrics",
    acrBuild: { runId: "acr-run-00000099", createdAt: "2026-07-13T18:00:00.000Z", digest: imageDigest, imageTag: `source-${buildSourceSha256}` },
    armDeployment: {
      deploymentName: deploymentRunId,
      operationId: `/subscriptions/sub/resourcegroups/prostar-payroll/providers/microsoft.resources/deployments/${deploymentRunId}`,
      correlationId: "123e4567-e89b-42d3-a456-426614174001",
      completedAt: "2026-07-13T18:30:00.000Z",
    },
    deploymentOperationId: `/subscriptions/sub/resourcegroups/prostar-payroll/providers/microsoft.resources/deployments/${deploymentRunId}`,
    deploymentRunId,
    deploymentNonce,
    evidenceSigningKeyIds,
    deployedRevision,
    latestReadyRevisionName: deployedRevision,
    revisionCreatedAt: "2026-07-13T18:25:00.000Z",
    imageDigest,
    pinnedImage,
    productionUrl,
    revisionMode: "Single",
    active: true,
    healthState: "Healthy",
    provisioningState: "Provisioned",
    trafficWeight: 100,
    trafficRevisionNames: [deployedRevision],
    targets: PRODUCTION_TARGETS.map((target) => targetContract(target, pinnedImage)),
    liveVerification: liveVerification(),
    monitoringEvidence,
    deployedAt: "2026-07-13T18:45:00.000Z",
  };
  const deploymentManifestPath = "docs/prostar-metrics/verification/deployment-manifest.json";
  const deploymentSha256 = await writeJsonAt(root, deploymentManifestPath, deployment);

  const browserAttestationPath = "docs/prostar-metrics/verification/browser/validated-artifacts-receipt.json";
  const authMeResponsePath = "docs/prostar-metrics/verification/browser/auth-session.sanitized.json";
  const sessionId = "223e4567-e89b-42d3-a456-426614174000";
  const authSession = createSanitizedAuthSessionArtifact({
    sessionId,
    deploymentNonce,
    productionUrl,
    requestHeaders: {
      accept: "application/json",
      cookie: "AppServiceAuthSession=must-not-persist",
    },
    responseStatus: 200,
    responseHeaders: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "set-cookie": "AppServiceAuthSession=must-not-persist",
    },
    responseBody: {
      authenticated: true,
      principalEmail: authenticatedActor,
      principalId: authenticatedPrincipalId,
      provider: authenticationProvider,
    },
    capturedAt: "2026-07-13T19:05:00.000Z",
  });
  const authMeResponseSha256 = await writeJsonAt(root, authMeResponsePath, authSession);
  const e2e = await buildE2E(root, {
    sessionId, deploymentNonce, browserAttestationPath, authMeResponsePath, authMeResponseSha256,
    authSessionBodySha256: authSession.response.bodySha256,
  });
  const a11y = await buildA11y(root, {
    sessionId, deploymentNonce, browserAttestationPath, authMeResponsePath, authMeResponseSha256,
  });
  const e2eReportPath = "docs/prostar-metrics/verification/browser/e2e-report.json";
  const a11yReportPath = "docs/prostar-metrics/verification/accessibility/a11y-report.json";
  const e2eSha256 = await writeJsonAt(root, e2eReportPath, e2e.report);
  const a11ySha256 = await writeJsonAt(root, a11yReportPath, a11y.report);
  const browserArtifactHashes = [authMeResponseSha256, ...e2e.hashes, ...a11y.hashes];
  const browserArtifactReferences = [
    { path: authMeResponsePath, sha256: authMeResponseSha256 },
    ...e2e.report.captures.flatMap((capture) => [
      { path: capture.screenshotPath, sha256: capture.screenshotSha256 },
      { path: capture.tracePath, sha256: capture.traceSha256 },
    ]),
    ...a11y.report.checks.map((check) => ({ path: check.evidencePath, sha256: check.evidenceSha256 })),
  ];
  const browserRunnerResultPath = "docs/prostar-metrics/verification/browser/validated-artifacts.json";
  await writeJsonAt(root, browserRunnerResultPath, {
    schemaVersion: BROWSER_ARTIFACT_VALIDATION_SCHEMA_VERSION,
    producer: {
      name: BROWSER_ARTIFACT_VALIDATOR_NAME,
      version: BROWSER_ARTIFACT_VALIDATOR_VERSION,
      executionId: "523e4567-e89b-42d3-a456-426614174000",
    },
    outcome: "PASS",
    sessionId,
    deploymentNonce,
    deployedRevision,
    imageDigest,
    authenticatedActor: e2e.report.authenticatedActor,
    startedAt: "2026-07-13T19:00:00.000Z",
    completedAt: "2026-07-13T19:50:00.000Z",
    e2eReport: { path: e2eReportPath, sha256: e2eSha256 },
    a11yReport: { path: a11yReportPath, sha256: a11ySha256 },
    artifacts: browserArtifactReferences,
  });
  const browserHandoff = fixtureHandoff("browser");
  const browserSubject = browserArtifactValidationSubject({
    deployment, e2e: e2e.report, e2eSha256, a11y: a11y.report, a11ySha256,
    artifactHashes: browserArtifactHashes,
    handoffBinding: browserHandoff,
  });
  const browserReceipt = makeFixtureReceipt("browser", browserSubject, evidenceSigningKeyIds.browser, "2026-07-13T19:51:00.000Z");
  const browserAttestationSha256 = await writeJsonAt(root, browserAttestationPath, browserReceipt);

  const gateDirectory = `docs/prostar-metrics/verification/gates/${deployedRevision}/run`;
  const gateReportPath = `${gateDirectory}/gate-report.json`;
  const gateRunnerReceiptPath = `${gateDirectory}/runner-receipt.json`;
  const runs = [];
  const gateExecutionId = "323e4567-e89b-42d3-a456-426614174000";
  for (const [index, category] of GATE_CATEGORIES.entries()) {
    const argv = [...EXPECTED_GATE_COMMANDS[category]];
    const startedAt = `2026-07-13T20:0${index}:00.000Z`;
    const completedAt = `2026-07-13T20:1${index}:00.000Z`;
    const runner = category === "integration" ? "integration-test" : category === "build" ? "build-check" : "node-test";
    const claims = [1, 2].map((claim) => ({
      category,
      outcome: "PASS",
      provenance: {
        runner,
        source: category === "build" ? `.next/fixture-${claim}.json` : `tests/evidence/${category}.test.mjs:${claim}:1`,
        assertion: `observed ${category} fixture check ${claim}`,
      },
      counts: { total: claim, passed: claim, failed: 0, skipped: 0, cancelled: 0, todo: 0 },
    }));
    const stdout = Buffer.from(claims.map(releaseGateAssertionEvent).join(""));
    const stderr = Buffer.alloc(0);
    const stdoutPath = `${gateDirectory}/${category}.stdout.log`;
    const stderrPath = `${gateDirectory}/${category}.stderr.log`;
    await writeAt(root, stdoutPath, stdout);
    await writeAt(root, stderrPath, stderr);
    const results = claims.map((claim) => JSON.parse(
      releaseGateAssertionEvent(claim).slice(RELEASE_GATE_ASSERTION_EVENT_PREFIX.length),
    )).map(({ id, outcome, provenance, counts }) => ({ id, outcome, provenance, counts }));
    const resultPath = `${gateDirectory}/${category}.results.json`;
    const resultBytes = jsonBytes({
      schemaVersion: STRUCTURED_GATE_RESULT_SCHEMA_VERSION,
      producer: { name: "fixture-gate-producer", version: "1.0.0" },
      category,
      executionId: gateExecutionId,
      runnerCommand: argv,
      command: PRODUCTION_GATE_COMMANDS[category],
      startedAt,
      completedAt,
      summary: summarizeReleaseGateAssertions(results),
      results,
    });
    await writeAt(root, resultPath, resultBytes);
    runs.push({
      category, argv, redactedArgv: argv,
      tool: { name: argv[0], version: argv[0] === "node" ? "24.17.0" : "11.13.0" },
      startedAt,
      completedAt,
      exitCode: 0, signal: null,
      stdout: { path: stdoutPath, sha256: hash(stdout), bytes: stdout.length },
      stderr: { path: stderrPath, sha256: hash(stderr), bytes: 0 },
      resultArtifact: { path: resultPath, sha256: hash(resultBytes), bytes: resultBytes.length },
      results,
    });
  }
  const gateReport = {
    schemaVersion: GATE_RUNNER_SCHEMA_VERSION,
    runner: {
      name: GATE_RUNNER_NAME,
      version: GATE_RUNNER_VERSION,
      executionId: gateExecutionId,
      immutableMode: "read-only-source-entries+docker-context-rehash",
    },
    sourceSnapshot: { buildSourceSha256, entryCount: (await computeDockerBuildContext(root)).entries.length },
    deploymentBinding: {
      manifestPath: deploymentManifestPath,
      manifestSha256: deploymentSha256,
      deploymentOperationId: deployment.deploymentOperationId,
      deploymentRunId,
      deploymentNonce,
      deployedRevision,
      imageDigest,
    },
    handoff: fixtureHandoff("gate"),
    startedAt: "2026-07-13T20:00:00.000Z",
    completedAt: "2026-07-13T20:20:00.000Z",
    runs,
    runnerReceiptPath: gateRunnerReceiptPath,
  };
  const gateReportSha256 = await writeJsonAt(root, gateReportPath, gateReport);
  const gateReceipt = makeFixtureReceipt(
    "gate", gateReceiptSubject({ report: gateReport, reportSha256: gateReportSha256 }),
    evidenceSigningKeyIds.gate, "2026-07-13T20:21:00.000Z",
  );
  const gateRunnerReceiptSha256 = await writeJsonAt(root, gateRunnerReceiptPath, gateReceipt);

  const reviewerReportPath = "docs/prostar-metrics/verification/reviewer-report.json";
  const reviewerReport = {
    schemaVersion: 1,
    declaredReviewerTaskId: reviewerAgent,
    declaredReviewerThreadId: reviewerThread,
    authorship: "NOT_AUTHENTICATED",
    reviewProcess: "SEPARATE_AGENT_REQUIRED",
    scopeFeatureIds: mandatoryIds,
    findings: [{
      id: "release-trust-reviewed", severity: "P1", disposition: "RESOLVED",
      summary: "The external report covers the deployment, supplied browser artifacts, exact gates, and release trust bindings.",
      featureIds: mandatoryIds,
      artifactHashes: [deploymentSha256, e2eSha256, a11ySha256, browserAttestationSha256, gateReportSha256],
    }],
    finalDecisionText: "SHIP: the external separate-agent report records review after all trusted gates completed.",
    timestamp: "2026-07-13T20:30:00.000Z",
    artifactHashes: {
      deploymentManifest: deploymentSha256,
      e2eReport: e2eSha256,
      a11yReport: a11ySha256,
      browserAttestation: browserAttestationSha256,
      gateReport: gateReportSha256,
      gateRunnerReceipt: gateRunnerReceiptSha256,
    },
  };
  const reviewerReportSha256 = await writeJsonAt(root, reviewerReportPath, reviewerReport);
  const reviewerAttestationPath = "docs/prostar-metrics/verification/external-review-validation-receipt.json";
  const reviewerSubject = externalReviewValidationSubject({
    reviewValidation: {
      declaredReviewerTaskId: reviewerAgent,
      declaredReviewerThreadId: reviewerThread,
      scopeFeatureIds: mandatoryIds,
      decision: "SHIP",
    },
    handoffBinding: fixtureHandoff("reviewer"),
    reviewerReportSha256,
    deploymentManifestSha256: deploymentSha256,
    e2eReportSha256: e2eSha256,
    a11yReportSha256: a11ySha256,
    browserAttestationSha256,
    gateReportSha256,
    gateRunnerReceiptSha256,
  });
  const reviewerReceipt = makeFixtureReceipt(
    "reviewer", reviewerSubject, evidenceSigningKeyIds.reviewer, "2026-07-13T20:31:00.000Z",
  );
  await writeJsonAt(root, reviewerAttestationPath, reviewerReceipt);

  const paths = {
    deploymentManifestPath, e2eReportPath, a11yReportPath,
    reviewerAttestationPath, reviewerReportPath, gateReportPath,
  };
  return {
    root, paths, deployment, e2e: e2e.report, a11y: a11y.report,
    browserAttestationPath, browserRunnerResultPath, gateRunnerReceiptPath, mandatoryIds,
    liveVerifier: async () => liveState(deployment),
    receiptVerifiers: {
      gate: verifyFixtureReceipt,
      browser: verifyFixtureReceipt,
      reviewer: verifyFixtureReceipt,
    },
    async cleanup() { await rm(root, { recursive: true, force: true }); },
  };
}

export async function copyFixture(fixture) {
  const root = await mkdtemp(join(tmpdir(), "release-trust-copy-"));
  await cp(fixture.root, root, { recursive: true });
  const deployment = structuredClone(fixture.deployment);
  return {
    ...fixture,
    root,
    deployment,
    e2e: structuredClone(fixture.e2e),
    a11y: structuredClone(fixture.a11y),
    liveVerifier: async () => liveState(deployment),
    async cleanup() { await rm(root, { recursive: true, force: true }); },
  };
}

export async function verifyFixtureReceipt(params) {
  return verifyServiceReceipt({ ...params, keyResolver: async () => normalizedPublicJwk });
}

export function makeFixtureReceipt(kind, subject, keyId, issuedAt) {
  const signature = sign("sha256", jsonBytes(subject), privateKey);
  const maxLifetime = kind === "reviewer" ? 60 * 60 * 1000 : 2 * 60 * 60 * 1000;
  const expiresAt = new Date(Math.min(
    Date.parse(issuedAt) + maxLifetime,
    Date.parse(subject?.handoff?.expiresAt ?? "9999-01-01T00:00:00.000Z"),
  )).toISOString();
  return {
    schemaVersion: 1,
    receiptType: kind === "gate" ? "gate-runner" : kind === "browser" ? "validated-browser-artifacts" : "external-review-report-validation",
    receiptId: `akv:${hash(signature)}`,
    issuer: "azure-key-vault",
    issuedAt,
    expiresAt,
    algorithm: "RS256",
    keyId,
    publicKey: normalizedPublicJwk,
    publicKeyFingerprintSha256: publicKeyFingerprint(keyId, normalizedPublicJwk),
    signature: signature.toString("base64url"),
    subject,
  };
}

export function fixtureHandoff(kind = "gate") {
  const index = { gate: "1", browser: "2", reviewer: "3" }[kind];
  return {
    messageId: `${index}23e4567-e89b-42d3-a456-426614174000`,
    nonceSha256: index.repeat(64),
    issuedAt: "2026-07-13T18:50:00.000Z",
    expiresAt: "2026-07-13T21:50:00.000Z",
    inputSha256: index.repeat(64),
  };
}

function targetContract(target, pinnedImage) {
  const resourceType = target.kind === "app" ? "Microsoft.App/containerApps" : "Microsoft.App/jobs";
  return {
    kind: target.kind,
    name: target.name,
    resourceGroup: target.resourceGroup,
    resourceId: `/subscriptions/sub/resourcegroups/${target.resourceGroup}/providers/${resourceType}/${target.name}`.toLowerCase(),
    resourceType,
    location: "westus2",
    tags: { workload: "prostar-metrics", environment: "prod" },
    identity: { type: "UserAssigned", userAssignedIdentityIds: ["/subscriptions/sub/resourcegroups/prostar-payroll/providers/microsoft.managedidentity/userassignedidentities/id-prostar-dispatch-prod"] },
    environmentId: "/subscriptions/sub/resourcegroups/prostar-payroll/providers/microsoft.app/managedenvironments/cae-prostar-prod",
    configuration: {
      activeRevisionsMode: target.kind === "app" ? "Single" : null,
      ingress: target.kind === "app" ? { external: true, targetPort: 3000, fqdn: new URL(productionUrl).hostname } : null,
      triggerType: target.kind === "job" ? "Schedule" : null,
      replicaTimeout: target.kind === "job" ? 3600 : null,
      replicaRetryLimit: target.kind === "job" ? 1 : null,
      scheduleTriggerConfig: target.kind === "job" ? { cronExpression: "0 * * * *", parallelism: 1, replicaCompletionCount: 1 } : null,
      manualTriggerConfig: null,
      eventTriggerConfig: null,
      registries: [{ server: "acrprostardispatchprod.azurecr.io", identity: "/subscriptions/sub/resourcegroups/prostar-payroll/providers/microsoft.managedidentity/userassignedidentities/id-prostar-dispatch-prod" }],
      secretReferences: [{
        name: "azure-postgres-connection-string",
        keyVaultUrl: "https://kv-prostar-metrics-prod.vault.azure.net/secrets/azure-postgres-connection-string",
        identity: "/subscriptions/sub/resourcegroups/prostar-payroll/providers/microsoft.managedidentity/userassignedidentities/id-prostar-dispatch-prod",
      }],
    },
    template: {
      containers: [{ name: "main", image: pinnedImage, command: [], args: [], env: [], resources: null, probes: [], volumeMounts: [] }],
      initContainers: [], scale: {}, volumes: [], serviceBinds: [], terminationGracePeriodSeconds: null,
    },
    image: pinnedImage,
  };
}

function liveVerification() {
  const clientId = "369bef95-48a6-45db-bad6-1e16278fa229";
  const tenantId = "515fbfd7-12b1-4238-bb6c-f827588dd488";
  return {
    health: { url: `${productionUrl}/api/health`, status: 200, ok: true, databaseConnected: true },
    unauthenticated: {
      browser: {
        url: `${productionUrl}/quotes`,
        status: 302,
        location: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(`${productionUrl}/.auth/login/aad/callback`)}&state=${encodeURIComponent("redir=%2Fquotes&nonce=fixture-nonce")}&nonce=fixture-nonce`,
        authorizeEndpoint: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`,
        clientId,
        redirectUri: `${productionUrl}/.auth/login/aad/callback`,
        stateRedirect: "/quotes",
      },
      api: { url: `${productionUrl}/quotes`, status: 401, location: null },
    },
    authContract: {
      platformEnabled: true, unauthenticatedClientAction: "RedirectToLoginPage",
      excludedPaths: ["/api/health"], redirectToProvider: "AzureActiveDirectory", requireHttps: true,
      clientId, openIdIssuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
      clientSecretSettingName: "microsoft-provider-authentication-secret",
      allowedAudiences: [clientId, `api://${clientId}`].sort(),
    },
    authenticatedIdentity: {
      authenticated: true, principalEmail: "asad@prostarmechanical.com", principalId: "owner-object-id",
      provider: "aad", verifiedAt: "2026-07-13T18:40:00.000Z", sessionReceiptSha256: "e".repeat(64),
    },
  };
}

function liveState(deployment) {
  return {
    buildSourceSha256: deployment.buildSourceSha256,
    resourceGroup: deployment.resourceGroup,
    containerAppName: deployment.containerAppName,
    registry: deployment.registry,
    repository: deployment.repository,
    latestRevisionName: deployment.deployedRevision,
    latestReadyRevisionName: deployment.deployedRevision,
    revisionMode: deployment.revisionMode,
    active: true,
    healthState: "Healthy",
    provisioningState: "Provisioned",
    trafficWeight: 100,
    trafficRevisionNames: [deployment.deployedRevision],
    pinnedImage: deployment.pinnedImage,
    imageDigest: deployment.imageDigest,
    productionUrl: deployment.productionUrl,
    revisionCreatedAt: deployment.revisionCreatedAt,
    targets: deployment.targets,
    acrBuild: deployment.acrBuild,
    armDeployment: deployment.armDeployment,
    liveVerification: deployment.liveVerification,
    monitoringEvidence: deployment.monitoringEvidence,
    deploymentOperationId: deployment.deploymentOperationId,
    deploymentRunId: deployment.deploymentRunId,
    deploymentNonce: deployment.deploymentNonce,
    evidenceSigningKeyIds: deployment.evidenceSigningKeyIds,
  };
}

async function buildE2E(root, bindings) {
  const captures = [];
  const hashes = [];
  let seed = 1;
  for (const route of ["/quotes", "/jobs", "/technicians", "/commissions"]) {
    for (const period of ["current", "2026-06"]) {
      for (const viewport of [{ name: "desktop", width: 1440, height: 1000 }, { name: "mobile", width: 390, height: 844 }]) {
        const capturedAt = "2026-07-13T19:15:00.000Z";
        const slug = `${route.slice(1)}-${period}-${viewport.name}`;
        const screenshotPath = `docs/prostar-metrics/verification/browser/${slug}.png`;
        const screenshot = generatedPng(viewport.width, viewport.height, seed++);
        await writeAt(root, screenshotPath, screenshot);
        const screenshotSha256 = hash(screenshot);
        const url = captureUrl(route, period, capturedAt);
        const tracePath = `docs/prostar-metrics/verification/browser/${slug}.trace.json`;
        const requestId = `request-${slug}`;
        const body = healthResponseBody();
        const trace = {
          schemaVersion: 3, sessionId: bindings.sessionId, deploymentNonce: bindings.deploymentNonce,
          tool: { name: "playwright", version: "1.55.0" },
          startedAt: "2026-07-13T19:10:00.000Z", completedAt: "2026-07-13T19:14:00.000Z", pageUrl: url,
          requests: [{ requestId, url, method: "GET", resourceType: "document", observedAt: "2026-07-13T19:11:00.000Z" }],
          responses: [{ requestId, url, status: 200, resourceType: "document", headers: { "content-type": "text/html" }, bodySha256: hash(`page-${slug}`), observedAt: "2026-07-13T19:12:00.000Z" }],
          consoleEntries: [],
          authSession: {
            url: `${productionUrl}/api/auth/session`,
            status: 200,
            identityReceiptSha256: bindings.authMeResponseSha256,
            identityBodySha256: bindings.authSessionBodySha256,
            observedAt: "2026-07-13T19:12:00.000Z",
          },
          dom: { clientWidth: viewport.width, scrollWidth: viewport.width, bodyClientWidth: viewport.width, bodyScrollWidth: viewport.width, overflowingSelectors: [] },
          deploymentResponse: { url: `${productionUrl}/api/health`, status: 200, body, bodySha256: hash(JSON.stringify(body)), observedAt: "2026-07-13T19:13:00.000Z" },
        };
        const traceSha256 = await writeJsonAt(root, tracePath, trace);
        hashes.push(screenshotSha256, traceSha256);
        captures.push({ route, period, viewport, url, screenshotPath, screenshotSha256, tracePath, traceSha256, capturedAt });
      }
    }
  }
  return { report: {
    schemaVersion: 3, productionUrl, authenticatedActor, authenticatedPrincipalId,
    authenticationProvider, deployedRevision, imageDigest,
    deploymentNonce: bindings.deploymentNonce,
    sessionId: bindings.sessionId,
    browserAttestationPath: bindings.browserAttestationPath,
    authMeResponsePath: bindings.authMeResponsePath,
    authMeResponseSha256: bindings.authMeResponseSha256,
    startedAt: "2026-07-13T19:00:00.000Z", completedAt: "2026-07-13T19:30:00.000Z", captures,
  }, hashes };
}

function captureUrl(route, period, capturedAt) {
  const monthKey = period === "current" ? pacificMonthKey(capturedAt) : period;
  if (route !== "/commissions") return `${productionUrl}${route}?month=${monthKey}`;
  const [year, month] = monthKey.split("-");
  return `${productionUrl}${route}?year=${year}&month=${String(Number(month))}&summaryYear=${year}`;
}

function pacificMonthKey(timestamp) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date(timestamp)).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}`;
}

function healthResponseBody() {
  return {
    ok: true,
    service: "prostar-metrics-dashboard",
    database: {
      configured: true,
      sslConfigured: true,
      connected: true,
      latencyMs: 12,
    },
    simpro: {
      baseUrl: "https://prostarmechanical.simprosuite.com/api/v1.0",
      companyId: "0",
      tokenConfigured: false,
      requestsPerSecond: 5,
      requestTimeoutMs: 60_000,
      maxPageSize: 250,
    },
    notes: [
      "Health does not perform broad request-time Simpro fan-out.",
      "Bounded Simpro sample pulls belong to the ingestion worker.",
    ],
  };
}

async function buildA11y(root, bindings) {
  const checks = [];
  const hashes = [];
  let seed = 1;
  for (const route of ["/quotes", "/jobs", "/technicians", "/commissions"]) {
    for (const viewport of [{ name: "desktop", width: 1440, height: 1000 }, { name: "mobile", width: 390, height: 844 }]) {
      const path = `docs/prostar-metrics/verification/accessibility/${route.slice(1)}-${viewport.name}.json`;
      const evidence = {
        schemaVersion: 3, sessionId: bindings.sessionId, deploymentNonce: bindings.deploymentNonce,
        tool: { name: "axe-core", version: "4.10.3" }, route, viewport,
        inspectedUrl: `${productionUrl}${route}`, inspectedAt: "2026-07-13T19:45:00.000Z",
        axe: { violations: [], passes: [{ id: `document-title-${seed++}`, impact: null, nodes: [{ target: ["html"] }] }], incomplete: [] },
        keyboardTrace: [
          { sequence: 1, action: "Tab", focusTarget: "nav a", result: "PASS", timestamp: "2026-07-13T19:41:00.000Z" },
          { sequence: 2, action: "Tab", focusTarget: "main button", result: "PASS", timestamp: "2026-07-13T19:42:00.000Z" },
          { sequence: 3, action: "Enter", focusTarget: "main button", result: "PASS", timestamp: "2026-07-13T19:43:00.000Z" },
          { sequence: 4, action: "Escape", focusTarget: "main", result: "PASS", timestamp: "2026-07-13T19:44:00.000Z" },
        ],
      };
      const evidenceSha256 = await writeJsonAt(root, path, evidence);
      hashes.push(evidenceSha256);
      checks.push({ route, viewport, url: `${productionUrl}${route}`, evidencePath: path, evidenceSha256, checkedAt: evidence.inspectedAt });
    }
  }
  return { report: {
    schemaVersion: 3, productionUrl, authenticatedActor, authenticatedPrincipalId,
    authenticationProvider, deployedRevision, imageDigest, ...bindings,
    startedAt: "2026-07-13T19:35:00.000Z", completedAt: "2026-07-13T19:50:00.000Z", checks,
  }, hashes };
}

function generatedPng(width, height, seed) {
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const offset = y * (width + 1);
    for (let x = 0; x < width; x += 1) raw[offset + 1 + x] = (x + y + seed) % 251;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 0;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length, 0); typeBytes.copy(output, 4); data.copy(output, 8);
  output.writeUInt32BE(pngCrc32(Buffer.concat([typeBytes, data])), data.length + 8);
  return output;
}

function pngCrc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function hash(value) { return createHash("sha256").update(value).digest("hex"); }
export async function writeJsonAt(root, path, value) { await writeAt(root, path, jsonBytes(value)); return hash(await readFile(join(root, path))); }
export async function writeAt(root, path, value) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), value); }
