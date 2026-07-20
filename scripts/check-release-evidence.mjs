import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

import {
  DEPLOYMENT_MANIFEST_KEYS,
  DEPLOYMENT_PROVENANCE_SCHEMA_VERSION,
  PRODUCTION_ACR,
  PRODUCTION_CONTAINER_APP,
  PRODUCTION_REPOSITORY,
  PRODUCTION_RESOURCE_GROUP,
  validateDeploymentManifestDocument,
  verifyAzureDeploymentLive,
} from "./lib/deployment-provenance.mjs";
import {
  AUTHORITATIVE_FEATURE_IDS,
  FEATURE_EVIDENCE_SCHEMA_VERSION,
  FEATURE_LEDGER_SCHEMA_VERSION,
  PLAN_REVISION,
  PLAN_SHA256,
  expectedAcceptingGate,
  parseAuthoritativePlan,
} from "./lib/feature-status-sync.mjs";
import {
  GATE_CATEGORIES,
  MAX_BROWSER_EVIDENCE_AGE_MS,
  MAX_DEPLOYMENT_AGE_MS,
  MAX_REVIEWER_EVIDENCE_AGE_MS,
  UNAUTHENTICATED_EXTERNAL_REVIEWER,
  browserArtifactValidationSubject,
  externalReviewValidationSubject,
  validateEvidenceAge,
  validateHandoffReceiptBinding,
  validateReceiptFreshness,
  validateServiceReceiptShape,
  validateTrustedGateReport,
  verifyServiceReceipt,
} from "./lib/release-evidence-trust.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const removedStatus = "REMOVED BY OWNER DECISION";
const verifiedStatus = "VERIFIED DONE";
const sha256Pattern = /^[a-f0-9]{64}$/;
const imageDigestPattern = /^sha256:[a-f0-9]{64}$/;
const deployedRevisionPattern = /^aca-prostar-metrics-prod--\d+$/;
const principalIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const placeholderPattern = /^(?:tbd|todo|pending|unknown|none|null|n\/?a|not deployed|placeholder)$/i;
const allTestCategories = [...GATE_CATEGORIES];
const supportedPostDeploySuites = Object.freeze(["e2e", "a11y"]);
const requiredRoutes = ["/quotes", "/jobs", "/technicians", "/commissions"];
const requiredPeriods = ["current", "2026-06"];
const pacificMonthFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
});
const healthService = "prostar-metrics-dashboard";
const healthNotes = [
  "Health does not perform broad request-time Simpro fan-out.",
  "Bounded Simpro sample pulls belong to the ingestion worker.",
];
const allowedActors = new Set([
  "asad@prostarmechanical.com",
  "laila@prostarmechanical.com",
]);
const allowedAuthenticationProvider = "aad";
const safeTraceResponseHeaders = new Set([
  "cache-control", "content-length", "content-type", "etag", "last-modified",
]);
const viewportContracts = {
  desktop: { name: "desktop", width: 1440, height: 1000 },
  mobile: { name: "mobile", width: 390, height: 844 },
};
const featureEvidenceKeys = [
  "schemaVersion", "featureId", "planRevision", "planSha256",
  "deploymentManifestPath", "deploymentManifestSha256",
  "e2eReportPath", "e2eReportSha256",
  "a11yReportPath", "a11yReportSha256",
  "authMeResponsePath", "authMeResponseSha256",
  "browserAttestationPath", "browserAttestationSha256",
  "gateReportPath", "gateReportSha256", "gateRunnerReceiptPath", "gateRunnerReceiptSha256",
  "reviewerReportPath", "reviewerReportSha256",
  "reviewerAttestationPath", "reviewerAttestationSha256",
  "buildSourceSha256", "deployedRevision", "imageDigest",
  "testResults", "gateResults", "productionVerifiedAt", "reviewer", "reviewResult",
];
const e2eReportKeys = [
  "schemaVersion", "productionUrl", "authenticatedActor", "authenticatedPrincipalId",
  "authenticationProvider", "deployedRevision", "imageDigest",
  "deploymentNonce", "sessionId", "browserAttestationPath",
  "authMeResponsePath", "authMeResponseSha256", "startedAt", "completedAt", "captures",
];
const e2eCaptureKeys = [
  "route", "period", "viewport", "url", "screenshotPath", "screenshotSha256",
  "tracePath", "traceSha256", "capturedAt",
];
const a11yReportKeys = [
  "schemaVersion", "productionUrl", "authenticatedActor", "authenticatedPrincipalId",
  "authenticationProvider", "deployedRevision", "imageDigest",
  "deploymentNonce", "sessionId", "browserAttestationPath", "authMeResponsePath",
  "authMeResponseSha256", "startedAt", "completedAt", "checks",
];
const a11yCheckKeys = [
  "route", "viewport", "url", "evidencePath", "evidenceSha256", "checkedAt",
];
const reviewerReportKeys = [
  "schemaVersion", "declaredReviewerTaskId", "declaredReviewerThreadId", "authorship",
  "reviewProcess", "scopeFeatureIds", "findings",
  "finalDecisionText", "timestamp", "artifactHashes",
];
const agentPathPattern = /^019[a-f0-9-]+$/;

export class ReleaseEvidenceError extends Error {
  constructor(failures) {
    super(`Release evidence gate failed:\n- ${failures.join("\n- ")}`);
    this.name = "ReleaseEvidenceError";
    this.failures = failures;
  }
}

export function resolvePostDeploySuiteCategories(suite) {
  if (!supportedPostDeploySuites.includes(suite)) {
    throw new ReleaseEvidenceError([
      `unknown post-deployment suite alias ${JSON.stringify(suite)}; expected one of: ${supportedPostDeploySuites.join(", ")}`,
    ]);
  }
  return [...allTestCategories];
}

export async function validateReleaseEvidence({
  root = defaultRoot,
  document,
  ledgerPath = "docs/prostar-metrics/feature-status.json",
  requiredTestCategories = allTestCategories,
  liveVerifier = verifyAzureDeploymentLive,
  receiptVerifiers = {},
  now = new Date(),
  skipPlanSynchronizationCheck = false,
} = {}) {
  const projectRoot = await realpath(resolve(root));
  const failures = [];
  const nowMs = normalizeNow(now, failures);
  validateRequestedCategories(requiredTestCategories, failures);
  const baseline = await loadAuthoritativeBaseline(projectRoot, failures);
  const ledger = document ?? await readJson(resolve(projectRoot, ledgerPath), "feature ledger", failures);
  if (document === undefined && !skipPlanSynchronizationCheck) {
    await validateOnDiskPlanSynchronization(projectRoot, failures);
  }
  if (!ledger || !baseline) throw new ReleaseEvidenceError(failures);

  validateLedgerBaseline(ledger, baseline, failures);
  if (!Array.isArray(ledger.features)) throw new ReleaseEvidenceError(failures);

  const deployment = await validateDeploymentManifest({
    projectRoot, ledger, failures, liveVerifier, nowMs,
  });
  const e2e = await validateE2EReport({ projectRoot, ledger, deployment, failures, nowMs });
  const a11y = await validateA11yReport({ projectRoot, ledger, deployment, failures, nowMs });
  const browserAttestation = await validateBrowserAttestation({
    projectRoot, ledger, deployment, e2e, a11y, failures, nowMs,
    receiptVerifier: receiptVerifiers.browser,
  });
  const gate = await validateGateEvidence({
    projectRoot, ledger, deployment, failures, nowMs,
    receiptVerifier: receiptVerifiers.gate,
  });
  const attestation = await validateReviewerAttestation({
    projectRoot, ledger, deployment, e2e, a11y, browserAttestation, gate, failures, nowMs,
    receiptVerifier: receiptVerifiers.reviewer,
  });

  const evidencePaths = new Map();
  let verified = 0;
  let removed = 0;
  for (const feature of ledger.features) {
    if (!feature || typeof feature !== "object") continue;
    const id = feature.id || "<missing-id>";
    const baselineRow = baseline.byId.get(id);
    if (!baselineRow) continue;
    validateSynchronizedFeatureFields(feature, baselineRow, gate, failures);

    if (feature.executionStatus === removedStatus) {
      if (baselineRow.baselineStatus !== removedStatus) {
        failures.push(`${id}: owner removal must be explicit in the authoritative plan baseline`);
      } else {
        removed += 1;
      }
      continue;
    }
    if (baselineRow.baselineStatus === removedStatus) {
      failures.push(`${id}: authoritative owner removal must remain REMOVED BY OWNER DECISION`);
      continue;
    }
    if (feature.executionStatus !== verifiedStatus) {
      failures.push(`${id}: mandatory feature is ${String(feature.executionStatus)}, not VERIFIED DONE`);
      continue;
    }
    verified += 1;
    validateLedgerReleaseFields(feature, failures);

    const evidencePath = feature.evidenceArtifactPath;
    if (typeof evidencePath === "string") {
      const priorFeature = evidencePaths.get(evidencePath);
      if (priorFeature) {
        failures.push(`${id}: evidenceArtifactPath is already used by ${priorFeature}: ${evidencePath}`);
      } else {
        evidencePaths.set(evidencePath, id);
      }
    }
    const loaded = await readHashedJsonArtifact({
      projectRoot,
      artifactPath: evidencePath,
      expectedSha256: feature.evidenceArtifactSha256,
      label: `${id}: evidence artifact`,
      failures,
    });
    if (loaded) {
      validateFeatureEvidence({
        feature,
        evidence: loaded.document,
        deployment,
        e2e,
        a11y,
        attestation,
        gate,
        ledger,
        failures,
        nowMs,
      });
    }
  }

  if (failures.length > 0) throw new ReleaseEvidenceError(failures);
  return { total: ledger.features.length, verified, removed };
}

async function validateDeploymentManifest({ projectRoot, ledger, failures, liveVerifier, nowMs }) {
  const loaded = await readLedgerArtifact({
    projectRoot,
    ledger,
    pathField: "deploymentManifestPath",
    hashField: "deploymentManifestSha256",
    label: "deployment manifest",
    failures,
  });
  if (!loaded) return null;
  const manifest = loaded.document;
  const before = failures.length;
  validateExactKeys(manifest, DEPLOYMENT_MANIFEST_KEYS, "deployment manifest", failures);
  if (!isRecord(manifest)) return null;
  try {
    await validateDeploymentManifestDocument(manifest, {
      expectedPlanRevision: PLAN_REVISION,
      expectedPlanSha256: PLAN_SHA256,
    });
  } catch (error) {
    failures.push(`deployment manifest authoritative schema failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (manifest.schemaVersion !== DEPLOYMENT_PROVENANCE_SCHEMA_VERSION) {
    failures.push(`deployment manifest schemaVersion must be ${DEPLOYMENT_PROVENANCE_SCHEMA_VERSION}`);
  }
  crossCheck(manifest, "environment", "production", "deployment manifest", failures);
  crossCheck(manifest, "planRevision", PLAN_REVISION, "deployment manifest", failures);
  crossCheck(manifest, "planSha256", PLAN_SHA256, "deployment manifest", failures);
  crossCheck(manifest, "resourceGroup", PRODUCTION_RESOURCE_GROUP, "deployment manifest", failures);
  crossCheck(manifest, "containerAppName", PRODUCTION_CONTAINER_APP, "deployment manifest", failures);
  crossCheck(manifest, "registry", PRODUCTION_ACR, "deployment manifest", failures);
  crossCheck(manifest, "repository", PRODUCTION_REPOSITORY, "deployment manifest", failures);
  validateSha256(manifest.buildSourceSha256, "deployment manifest buildSourceSha256", failures);
  validateRevision(manifest.deployedRevision, "deployment manifest deployedRevision", failures);
  crossCheck(manifest, "latestReadyRevisionName", manifest.deployedRevision, "deployment manifest", failures);
  validateImageDigest(manifest.imageDigest, "deployment manifest imageDigest", failures);
  crossCheck(
    manifest,
    "pinnedImage",
    `${PRODUCTION_ACR}.azurecr.io/${PRODUCTION_REPOSITORY}@${String(manifest.imageDigest)}`,
    "deployment manifest",
    failures,
  );
  validateProductionUrl(manifest.productionUrl, "deployment manifest productionUrl", failures);
  crossCheck(manifest, "revisionMode", "Single", "deployment manifest", failures);
  crossCheck(manifest, "active", true, "deployment manifest", failures);
  crossCheck(manifest, "healthState", "Healthy", "deployment manifest", failures);
  crossCheck(manifest, "provisioningState", "Provisioned", "deployment manifest", failures);
  crossCheck(manifest, "trafficWeight", 100, "deployment manifest", failures);
  if (
    !Array.isArray(manifest.trafficRevisionNames)
    || manifest.trafficRevisionNames.length !== 1
    || manifest.trafficRevisionNames[0] !== manifest.deployedRevision
  ) {
    failures.push("deployment manifest trafficRevisionNames must contain only deployedRevision");
  }
  validateBoundedTimestamp(manifest.deployedAt, "deployment manifest deployedAt", null, nowMs, failures);
  validateBoundedTimestamp(manifest.revisionCreatedAt, "deployment manifest revisionCreatedAt", null, nowMs, failures);
  validateConcreteValue(manifest.deploymentOperationId, "deployment manifest deploymentOperationId", failures);
  validateConcreteValue(manifest.deploymentRunId, "deployment manifest deploymentRunId", failures);
  validateConcreteValue(manifest.deploymentNonce, "deployment manifest deploymentNonce", failures);
  if (!isRecord(manifest.evidenceSigningKeyIds)) {
    failures.push("deployment manifest evidenceSigningKeyIds must be an object");
  } else {
    validateExactKeys(manifest.evidenceSigningKeyIds, ["gate", "browser", "reviewer"], "deployment manifest evidenceSigningKeyIds", failures);
    for (const [kind, keyId] of Object.entries(manifest.evidenceSigningKeyIds)) {
      if (!/^https:\/\/[a-z0-9-]+\.vault\.azure\.net\/keys\/[A-Za-z0-9-]+\/[a-f0-9]{32}$/.test(keyId ?? "")) {
        failures.push(`deployment manifest ${kind} signing key must pin an Azure Key Vault key version`);
      }
    }
  }
  try {
    validateEvidenceAge(manifest.deployedAt, {
      label: "deployment manifest deployedAt", nowMs, maxAgeMs: MAX_DEPLOYMENT_AGE_MS,
    });
  } catch (error) {
    failures.push(error.message);
  }
  for (const [name, artifact] of Object.entries(manifest.monitoringEvidence ?? {})) {
    await readHashedJsonArtifact({
      projectRoot,
      artifactPath: artifact?.path,
      expectedSha256: artifact?.sha256,
      label: `deployment monitoring evidence ${name}`,
      failures,
    });
  }
  if (failures.length !== before) return { ...manifest, sha256: loaded.sha256, structurallyValid: false };

  try {
    const live = await liveVerifier({ projectRoot, manifest });
    validateLiveDeployment(manifest, live, failures);
  } catch (error) {
    failures.push(`live deployment verification failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { ...manifest, sha256: loaded.sha256, structurallyValid: true };
}

function validateLiveDeployment(manifest, live, failures) {
  if (!isRecord(live)) {
    failures.push("live deployment verifier must return an object");
    return;
  }
  const expected = {
    buildSourceSha256: manifest.buildSourceSha256,
    resourceGroup: manifest.resourceGroup,
    containerAppName: manifest.containerAppName,
    registry: manifest.registry,
    repository: manifest.repository,
    latestRevisionName: manifest.deployedRevision,
    latestReadyRevisionName: manifest.deployedRevision,
    revisionMode: "Single",
    active: true,
    healthState: "Healthy",
    provisioningState: "Provisioned",
    trafficWeight: 100,
    pinnedImage: manifest.pinnedImage,
    imageDigest: manifest.imageDigest,
    productionUrl: manifest.productionUrl,
    deploymentOperationId: manifest.deploymentOperationId,
    deploymentRunId: manifest.deploymentRunId,
    deploymentNonce: manifest.deploymentNonce,
    revisionCreatedAt: manifest.revisionCreatedAt,
    evidenceSigningKeyIds: manifest.evidenceSigningKeyIds,
    targets: manifest.targets,
    acrBuild: manifest.acrBuild,
    armDeployment: manifest.armDeployment,
    liveVerification: manifest.liveVerification,
    monitoringEvidence: manifest.monitoringEvidence,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (value !== null && typeof value === "object") {
      if (JSON.stringify(live[field]) !== JSON.stringify(value)) failures.push(`live deployment ${field} mismatch`);
    } else {
      crossCheck(live, field, value, "live deployment", failures);
    }
  }
  if (
    !Array.isArray(live.trafficRevisionNames)
    || live.trafficRevisionNames.length !== 1
    || live.trafficRevisionNames[0] !== manifest.deployedRevision
  ) {
    failures.push("live deployment traffic must be 100% assigned only to deployedRevision");
  }
}

async function validateE2EReport({ projectRoot, ledger, deployment, failures, nowMs }) {
  const loaded = await readLedgerArtifact({
    projectRoot, ledger, pathField: "e2eReportPath", hashField: "e2eReportSha256",
    label: "E2E report", failures,
  });
  if (!loaded) return null;
  const report = loaded.document;
  validateExactKeys(report, e2eReportKeys, "E2E report", failures);
  if (!isRecord(report)) return null;
  crossCheck(report, "schemaVersion", 3, "E2E report", failures);
  validateCommonReportFields(report, deployment, "E2E report", failures, nowMs);
  validateCaptureSession(report, deployment, ledger, "E2E report", failures);
  const authSession = await validateSanitizedAuthSessionReceipt({
    projectRoot, report, deployment, label: "E2E report", failures, nowMs,
  });
  if (authSession) crossCheckReportIdentity(report, authSession.identity, "E2E report", failures);
  if (!Array.isArray(report.captures)) {
    failures.push("E2E report captures must be an array");
    return { ...report, sha256: loaded.sha256 };
  }
  const expectedCoverage = requiredRoutes.flatMap((route) => requiredPeriods.flatMap((period) => (
    Object.keys(viewportContracts).map((viewport) => `${route}|${period}|${viewport}`)
  )));
  const coverage = [];
  const screenshotPaths = new Set();
  for (const [index, capture] of report.captures.entries()) {
    const label = `E2E capture ${index + 1}`;
    validateExactKeys(capture, e2eCaptureKeys, label, failures);
    if (!isRecord(capture)) continue;
    validateRoute(capture.route, `${label} route`, failures);
    if (!requiredPeriods.includes(capture.period)) failures.push(`${label} period must be current or 2026-06`);
    const viewportName = validateViewport(capture.viewport, `${label} viewport`, failures);
    coverage.push(`${String(capture.route)}|${String(capture.period)}|${String(viewportName)}`);
    validateReportUrl(
      capture.url,
      report.productionUrl,
      capture.route,
      capture.period,
      `${label} url`,
      failures,
      capture.capturedAt,
    );
    validateBoundedTimestamp(capture.capturedAt, `${label} capturedAt`, deployment?.deployedAt, nowMs, failures);
    if (screenshotPaths.has(capture.screenshotPath)) {
      failures.push(`${label} screenshotPath must be unique: ${String(capture.screenshotPath)}`);
    }
    screenshotPaths.add(capture.screenshotPath);
    const screenshot = await readHashedArtifact({
      projectRoot,
      artifactPath: capture.screenshotPath,
      expectedSha256: capture.screenshotSha256,
      label: `${label} screenshot`,
      failures,
    });
    if (screenshot && viewportName) {
      validatePng(screenshot.bytes, viewportContracts[viewportName], `${label} screenshot`, failures);
    }
    const trace = await readHashedJsonArtifact({
      projectRoot,
      artifactPath: capture.tracePath,
      expectedSha256: capture.traceSha256,
      label: `${label} browser trace`,
      failures,
    });
    if (trace) {
      validateBrowserTrace({
        trace: trace.document, capture, report, deployment, authSession, label, failures, nowMs,
      });
    }
  }
  validateExactCoverage(coverage, expectedCoverage, "E2E report", failures);
  return {
    ...report,
    sha256: loaded.sha256,
    authSession,
    rawArtifactHashes: [
      report.authMeResponseSha256,
      ...report.captures.flatMap((capture) => [capture.screenshotSha256, capture.traceSha256]),
    ],
  };
}

async function validateA11yReport({ projectRoot, ledger, deployment, failures, nowMs }) {
  const loaded = await readLedgerArtifact({
    projectRoot, ledger, pathField: "a11yReportPath", hashField: "a11yReportSha256",
    label: "accessibility report", failures,
  });
  if (!loaded) return null;
  const report = loaded.document;
  validateExactKeys(report, a11yReportKeys, "accessibility report", failures);
  if (!isRecord(report)) return null;
  crossCheck(report, "schemaVersion", 3, "accessibility report", failures);
  validateCommonReportFields(report, deployment, "accessibility report", failures, nowMs);
  validateCaptureSession(report, deployment, ledger, "accessibility report", failures);
  if (!Array.isArray(report.checks)) {
    failures.push("accessibility report checks must be an array");
    return { ...report, sha256: loaded.sha256 };
  }
  const expectedCoverage = requiredRoutes.flatMap((route) => (
    Object.keys(viewportContracts).map((viewport) => `${route}|${viewport}`)
  ));
  const coverage = [];
  const evidencePaths = new Set();
  for (const [index, check] of report.checks.entries()) {
    const label = `accessibility check ${index + 1}`;
    validateExactKeys(check, a11yCheckKeys, label, failures);
    if (!isRecord(check)) continue;
    validateRoute(check.route, `${label} route`, failures);
    const viewportName = validateViewport(check.viewport, `${label} viewport`, failures);
    coverage.push(`${String(check.route)}|${String(viewportName)}`);
    validateReportUrl(check.url, report.productionUrl, check.route, null, `${label} url`, failures);
    validateBoundedTimestamp(check.checkedAt, `${label} checkedAt`, deployment?.deployedAt, nowMs, failures);
    if (evidencePaths.has(check.evidencePath)) {
      failures.push(`${label} evidencePath must be unique: ${String(check.evidencePath)}`);
    }
    evidencePaths.add(check.evidencePath);
    const evidence = await readHashedJsonArtifact({
      projectRoot,
      artifactPath: check.evidencePath,
      expectedSha256: check.evidenceSha256,
      label: `${label} evidence`,
      failures,
    });
    if (evidence) {
      validateA11yEvidence({
        evidence: evidence.document, check, report, deployment, label, failures, nowMs,
      });
    }
  }
  validateExactCoverage(coverage, expectedCoverage, "accessibility report", failures);
  return {
    ...report,
    sha256: loaded.sha256,
    rawArtifactHashes: report.checks.map((check) => check.evidenceSha256),
  };
}

async function validateBrowserAttestation({
  projectRoot, ledger, deployment, e2e, a11y, failures, nowMs, receiptVerifier,
}) {
  const loaded = await readLedgerArtifact({
    projectRoot, ledger, pathField: "browserAttestationPath", hashField: "browserAttestationSha256",
    label: "validated browser artifacts receipt", failures,
  });
  if (!loaded || !e2e || !a11y || !deployment) return null;
  for (const field of [
    "sessionId", "deploymentNonce", "authenticatedActor", "authenticatedPrincipalId",
    "authenticationProvider", "authMeResponsePath", "authMeResponseSha256",
  ]) {
    crossCheck(a11y, field, e2e[field], "accessibility report capture session", failures);
  }
  if (e2e.authSession) crossCheckReportIdentity(a11y, e2e.authSession.identity, "accessibility report", failures);
  crossCheck(e2e, "browserAttestationPath", ledger.browserAttestationPath, "E2E report", failures);
  crossCheck(a11y, "browserAttestationPath", ledger.browserAttestationPath, "accessibility report", failures);
  const artifactHashes = [...(e2e.rawArtifactHashes ?? []), ...(a11y.rawArtifactHashes ?? [])];
  if (new Set(artifactHashes).size !== artifactHashes.length) {
    failures.push("browser capture raw artifact hashes must be unique and session-specific");
  }
  let issuedAt = null;
  try {
    const expectedSubject = browserArtifactValidationSubject({
      deployment,
      e2e,
      e2eSha256: e2e.sha256,
      a11y,
      a11ySha256: a11y.sha256,
      artifactHashes,
      handoffBinding: validateHandoffReceiptBinding(loaded.document?.subject?.handoff, { nowMs }),
    });
    issuedAt = validateServiceReceiptShape(loaded.document, {
      kind: "browser", expectedSubject, expectedKeyId: deployment.evidenceSigningKeyIds?.browser,
    });
    const completedAt = Math.max(Date.parse(e2e.completedAt), Date.parse(a11y.completedAt));
    if (issuedAt <= completedAt) throw new Error("browser artifact validation receipt must be issued after artifact production completed");
    validateEvidenceAge(loaded.document.issuedAt, {
      label: "browser artifact validation receipt issuedAt", nowMs, maxAgeMs: MAX_BROWSER_EVIDENCE_AGE_MS, after: completedAt,
    });
    validateReceiptFreshness(loaded.document, { kind: "browser", nowMs });
    await (receiptVerifier ?? verifyServiceReceipt)({
      kind: "browser",
      receipt: loaded.document,
      expectedSubject,
      expectedKeyId: deployment.evidenceSigningKeyIds?.browser,
    });
  } catch (error) {
    failures.push(`browser artifact validation trust verification failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { ...loaded.document, sha256: loaded.sha256, issuedAt };
}

async function validateGateEvidence({
  projectRoot, ledger, deployment, failures, nowMs, receiptVerifier,
}) {
  const report = await readLedgerArtifact({
    projectRoot, ledger, pathField: "gateReportPath", hashField: "gateReportSha256",
    label: "trusted gate report", failures,
  });
  const receipt = await readLedgerArtifact({
    projectRoot, ledger, pathField: "gateRunnerReceiptPath", hashField: "gateRunnerReceiptSha256",
    label: "gate runner receipt", failures,
  });
  if (!report || !receipt || !deployment) return null;
  crossCheck(report.document, "runnerReceiptPath", ledger.gateRunnerReceiptPath, "trusted gate report", failures);
  try {
    const results = await validateTrustedGateReport({
      report: report.document,
      reportSha256: report.sha256,
      runnerReceipt: receipt.document,
      deployment,
      deploymentManifestPath: ledger.deploymentManifestPath,
      deploymentManifestSha256: ledger.deploymentManifestSha256,
      mandatoryIds: AUTHORITATIVE_FEATURE_IDS.filter((id) => !["Q-22", "J-15", "J-16"].includes(id)),
      readArtifact: (path, label, expectedSha256, requireJson, allowEmpty) => readHashedArtifact({
        projectRoot, artifactPath: path, expectedSha256, label, failures, requireJson, allowEmpty,
      }),
      receiptVerifier: receiptVerifier ?? verifyServiceReceipt,
      nowMs,
    });
    return { ...report.document, sha256: report.sha256, receiptSha256: receipt.sha256, results };
  } catch (error) {
    failures.push(`trusted gate verification failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function validateReviewerAttestation({
  projectRoot, ledger, deployment, e2e, a11y, browserAttestation, gate,
  failures, nowMs, receiptVerifier,
}) {
  const [receipt, report] = await Promise.all([
    readLedgerArtifact({
      projectRoot, ledger, pathField: "reviewerAttestationPath", hashField: "reviewerAttestationSha256",
      label: "external review report validation receipt", failures,
    }),
    readLedgerArtifact({
      projectRoot, ledger, pathField: "reviewerReportPath", hashField: "reviewerReportSha256",
      label: "externally supplied review report", failures,
    }),
  ]);
  if (!receipt || !report || !deployment || !e2e || !a11y || !browserAttestation || !gate) return null;
  const mandatoryIds = AUTHORITATIVE_FEATURE_IDS.filter((id) => !["Q-22", "J-15", "J-16"].includes(id));
  const attestation = {
    declaredReviewerTaskId: report.document.declaredReviewerTaskId,
    declaredReviewerThreadId: report.document.declaredReviewerThreadId,
    scopeFeatureIds: report.document.scopeFeatureIds,
    result: "SHIP",
    reviewer: UNAUTHENTICATED_EXTERNAL_REVIEWER,
  };
  validateExternalReviewReport(report.document, attestation, ledger, failures, nowMs);
  if (JSON.stringify(attestation.scopeFeatureIds) !== JSON.stringify(mandatoryIds)) {
    failures.push("external review report validation scopeFeatureIds must exactly cover every mandatory feature in plan order");
  }
  const expectedSubject = externalReviewValidationSubject({
    reviewValidation: {
      declaredReviewerTaskId: attestation.declaredReviewerTaskId,
      declaredReviewerThreadId: attestation.declaredReviewerThreadId,
      scopeFeatureIds: attestation.scopeFeatureIds,
      decision: attestation.result,
    },
    handoffBinding: validateHandoffReceiptBinding(receipt.document?.subject?.handoff, { nowMs }),
    reviewerReportSha256: report.sha256,
    deploymentManifestSha256: ledger.deploymentManifestSha256,
    e2eReportSha256: ledger.e2eReportSha256,
    a11yReportSha256: ledger.a11yReportSha256,
    browserAttestationSha256: ledger.browserAttestationSha256,
    gateReportSha256: ledger.gateReportSha256,
    gateRunnerReceiptSha256: ledger.gateRunnerReceiptSha256,
  });
  try {
    const reviewedAfter = Math.max(
      Date.parse(e2e.completedAt), Date.parse(a11y.completedAt), Date.parse(gate.completedAt),
    );
    validateEvidenceAge(report.document.timestamp, {
      label: "externally supplied review report timestamp", nowMs,
      maxAgeMs: MAX_REVIEWER_EVIDENCE_AGE_MS, after: reviewedAfter,
    });
    const issuedAt = validateServiceReceiptShape(receipt.document, {
      kind: "reviewer", expectedSubject, expectedKeyId: deployment.evidenceSigningKeyIds?.reviewer,
    });
    if (issuedAt <= Date.parse(report.document.timestamp)) throw new Error("external review validation receipt must be issued after the report");
    validateEvidenceAge(receipt.document.issuedAt, {
      label: "external review validation receipt issuedAt", nowMs,
      maxAgeMs: MAX_REVIEWER_EVIDENCE_AGE_MS, after: Date.parse(report.document.timestamp),
    });
    validateReceiptFreshness(receipt.document, { kind: "reviewer", nowMs });
    await (receiptVerifier ?? verifyServiceReceipt)({
      kind: "reviewer", receipt: receipt.document, expectedSubject,
      expectedKeyId: deployment.evidenceSigningKeyIds?.reviewer,
    });
  } catch (error) {
    failures.push(`external review report content validation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { ...attestation, timestamp: report.document.timestamp, sha256: receipt.sha256 };
}

function validateFeatureEvidence({
  feature, evidence, deployment, e2e, a11y, attestation, gate, ledger, failures, nowMs,
}) {
  const id = feature.id;
  validateExactKeys(evidence, featureEvidenceKeys, `${id}: evidence artifact`, failures);
  if (!isRecord(evidence)) return;
  crossCheck(evidence, "schemaVersion", FEATURE_EVIDENCE_SCHEMA_VERSION, `${id}: evidence artifact`, failures);
  crossCheck(evidence, "featureId", id, `${id}: evidence artifact`, failures);
  crossCheck(evidence, "planRevision", PLAN_REVISION, `${id}: evidence artifact`, failures);
  crossCheck(evidence, "planSha256", PLAN_SHA256, `${id}: evidence artifact`, failures);
  for (const [pathField, hashField] of [
    ["deploymentManifestPath", "deploymentManifestSha256"],
    ["e2eReportPath", "e2eReportSha256"],
    ["a11yReportPath", "a11yReportSha256"],
    ["authMeResponsePath", "authMeResponseSha256"],
    ["browserAttestationPath", "browserAttestationSha256"],
    ["gateReportPath", "gateReportSha256"],
    ["gateRunnerReceiptPath", "gateRunnerReceiptSha256"],
    ["reviewerReportPath", "reviewerReportSha256"],
    ["reviewerAttestationPath", "reviewerAttestationSha256"],
  ]) {
    crossCheck(evidence, pathField, ledger[pathField], `${id}: evidence artifact`, failures);
    crossCheck(evidence, hashField, ledger[hashField], `${id}: evidence artifact`, failures);
  }
  for (const field of ["buildSourceSha256", "deployedRevision", "imageDigest"]) {
    crossCheck(evidence, field, feature[field], `${id}: evidence artifact`, failures);
    if (deployment) crossCheck(evidence, field, deployment[field], `${id}: deployment manifest`, failures);
  }
  crossCheck(evidence, "reviewer", feature.independentReviewer, `${id}: evidence artifact`, failures);
  crossCheck(evidence, "reviewResult", feature.reviewResult, `${id}: evidence artifact`, failures);
  if (attestation) {
    crossCheck(evidence, "reviewer", attestation.reviewer, `${id}: external review validation`, failures);
    crossCheck(evidence, "reviewResult", attestation.result, `${id}: reviewer attestation`, failures);
  }
  validateBoundedTimestamp(
    evidence.productionVerifiedAt,
    `${id}: productionVerifiedAt`,
    latestTimestamp(deployment?.deployedAt, e2e?.completedAt, a11y?.completedAt, attestation?.timestamp),
    nowMs,
    failures,
  );
  validateTestResults(feature, evidence.testResults, gate, failures);
  validateGateResults(feature, evidence.gateResults, failures);
}

function validateCommonReportFields(report, deployment, label, failures, nowMs) {
  validateProductionUrl(report.productionUrl, `${label} productionUrl`, failures);
  validateActor(report.authenticatedActor, `${label} authenticatedActor`, failures);
  validatePrincipalId(report.authenticatedPrincipalId, `${label} authenticatedPrincipalId`, failures);
  if (report.authenticationProvider !== allowedAuthenticationProvider) {
    failures.push(`${label} authenticationProvider must be aad`);
  }
  if (deployment) {
    crossCheck(report, "productionUrl", deployment.productionUrl, label, failures);
    crossCheck(report, "deployedRevision", deployment.deployedRevision, label, failures);
    crossCheck(report, "imageDigest", deployment.imageDigest, label, failures);
  }
  validateRevision(report.deployedRevision, `${label} deployedRevision`, failures);
  validateImageDigest(report.imageDigest, `${label} imageDigest`, failures);
  validateBoundedTimestamp(report.startedAt, `${label} startedAt`, deployment?.deployedAt, nowMs, failures);
  validateBoundedTimestamp(report.completedAt, `${label} completedAt`, deployment?.deployedAt, nowMs, failures);
  if (validTimestamp(report.startedAt) && validTimestamp(report.completedAt)
    && Date.parse(report.startedAt) > Date.parse(report.completedAt)) {
    failures.push(`${label} startedAt must not be after completedAt`);
  }
  try {
    validateEvidenceAge(report.completedAt, {
      label: `${label} completedAt`, nowMs, maxAgeMs: MAX_BROWSER_EVIDENCE_AGE_MS,
      after: deployment?.deployedAt ? Date.parse(deployment.deployedAt) : null,
    });
  } catch (error) {
    failures.push(error.message);
  }
}

function validateCaptureSession(report, deployment, ledger, label, failures) {
  validateConcreteValue(report.sessionId, `${label} sessionId`, failures);
  crossCheck(report, "deploymentNonce", deployment?.deploymentNonce, label, failures);
  crossCheck(report, "browserAttestationPath", ledger.browserAttestationPath, label, failures);
  crossCheck(report, "authMeResponsePath", ledger.authMeResponsePath, label, failures);
  crossCheck(report, "authMeResponseSha256", ledger.authMeResponseSha256, label, failures);
}

async function validateSanitizedAuthSessionReceipt({ projectRoot, report, deployment, label, failures, nowMs }) {
  const loaded = await readHashedJsonArtifact({
    projectRoot,
    artifactPath: report.authMeResponsePath,
    expectedSha256: report.authMeResponseSha256,
    label: `${label} sanitized auth session receipt`,
    failures,
  });
  if (!loaded) return null;
  const artifact = loaded.document;
  validateExactKeys(artifact, [
    "schemaVersion", "sessionId", "deploymentNonce", "request", "response", "capturedAt",
  ], `${label} sanitized auth session receipt`, failures);
  crossCheck(artifact, "schemaVersion", 2, `${label} sanitized auth session receipt`, failures);
  crossCheck(artifact, "sessionId", report.sessionId, `${label} sanitized auth session receipt`, failures);
  crossCheck(artifact, "deploymentNonce", deployment?.deploymentNonce, `${label} sanitized auth session receipt`, failures);

  validateExactKeys(artifact.request, ["url", "method", "headers"], `${label} sanitized auth session request`, failures);
  crossCheck(artifact.request, "url", `${report.productionUrl}/api/auth/session`, `${label} sanitized auth session request`, failures);
  crossCheck(artifact.request, "method", "GET", `${label} sanitized auth session request`, failures);
  validateExactKeys(artifact.request?.headers, ["accept"], `${label} sanitized auth session request headers`, failures);
  crossCheck(artifact.request?.headers, "accept", "application/json", `${label} sanitized auth session request headers`, failures);

  validateExactKeys(
    artifact.response,
    ["status", "headers", "body", "bodySha256"],
    `${label} sanitized auth session response`,
    failures,
  );
  crossCheck(artifact.response, "status", 200, `${label} sanitized auth session response`, failures);
  validateExactKeys(
    artifact.response?.headers,
    ["cache-control", "content-type"],
    `${label} sanitized auth session response headers`,
    failures,
  );
  crossCheck(artifact.response?.headers, "cache-control", "no-store", `${label} sanitized auth session response headers`, failures);
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(artifact.response?.headers?.["content-type"] ?? "")) {
    failures.push(`${label} sanitized auth session response content-type must be application/json with optional UTF-8 charset`);
  }

  const identity = validateSessionIdentity(
    artifact.response?.body,
    `${label} sanitized auth session response body`,
    failures,
  );
  const bodySha256 = createHash("sha256").update(JSON.stringify(artifact.response?.body ?? null)).digest("hex");
  crossCheck(
    artifact.response,
    "bodySha256",
    bodySha256,
    `${label} sanitized auth session response`,
    failures,
  );
  validateBoundedTimestamp(
    artifact.capturedAt,
    `${label} sanitized auth session capturedAt`,
    deployment?.deployedAt,
    nowMs,
    failures,
  );
  return { ...artifact, identity, sha256: loaded.sha256 };
}

function validateBrowserTrace({ trace, capture, report, deployment, authSession, label, failures, nowMs }) {
  validateExactKeys(trace, [
    "schemaVersion", "sessionId", "deploymentNonce", "tool", "startedAt", "completedAt",
    "pageUrl", "requests", "responses", "consoleEntries", "authSession", "dom", "deploymentResponse",
  ], `${label} browser trace`, failures);
  if (!isRecord(trace)) return;
  crossCheck(trace, "schemaVersion", 3, `${label} browser trace`, failures);
  crossCheck(trace, "sessionId", report.sessionId, `${label} browser trace`, failures);
  crossCheck(trace, "deploymentNonce", report.deploymentNonce, `${label} browser trace`, failures);
  validateExactKeys(trace.tool, ["name", "version"], `${label} browser trace tool`, failures);
  crossCheck(trace.tool, "name", "playwright", `${label} browser trace tool`, failures);
  validateSemver(trace.tool?.version, `${label} browser trace tool version`, failures);
  crossCheck(trace, "pageUrl", capture.url, `${label} browser trace`, failures);
  validateBoundedTimestamp(trace.startedAt, `${label} browser trace startedAt`, deployment?.deployedAt, nowMs, failures);
  validateBoundedTimestamp(trace.completedAt, `${label} browser trace completedAt`, trace.startedAt, nowMs, failures);
  validateBoundedTimestamp(capture.capturedAt, `${label} capturedAt`, trace.completedAt, nowMs, failures);

  const requestIds = new Set();
  if (!Array.isArray(trace.requests) || trace.requests.length === 0) {
    failures.push(`${label} browser trace requests must be a non-empty array`);
  } else {
    for (const [index, request] of trace.requests.entries()) {
      validateExactKeys(request, ["requestId", "url", "method", "resourceType", "observedAt"], `${label} request ${index + 1}`, failures);
      validateConcreteValue(request?.requestId, `${label} request ${index + 1} requestId`, failures);
      if (requestIds.has(request?.requestId)) failures.push(`${label} browser trace requestId must be unique`);
      requestIds.add(request?.requestId);
      validateConcreteValue(request?.method, `${label} request ${index + 1} method`, failures);
      validateBoundedTimestamp(request?.observedAt, `${label} request ${index + 1} observedAt`, deployment?.deployedAt, nowMs, failures);
    }
  }
  let pageResponse = false;
  if (!Array.isArray(trace.responses) || trace.responses.length === 0) {
    failures.push(`${label} browser trace responses must be a non-empty array`);
  } else {
    for (const [index, response] of trace.responses.entries()) {
      validateExactKeys(response, ["requestId", "url", "status", "resourceType", "headers", "bodySha256", "observedAt"], `${label} response ${index + 1}`, failures);
      if (!isRecord(response)) continue;
      if (!requestIds.has(response.requestId)) failures.push(`${label} response ${index + 1} has no matching raw request`);
      validateSafeHeaderSubset(
        response.headers,
        safeTraceResponseHeaders,
        `${label} response ${index + 1} headers`,
        failures,
      );
      validateSha256(response.bodySha256, `${label} response ${index + 1} bodySha256`, failures);
      if (response.url === capture.url && response.status >= 200 && response.status < 400) pageResponse = true;
      try {
        if (new URL(response.url).origin === new URL(report.productionUrl).origin
          && (!Number.isInteger(response.status) || response.status < 200 || response.status >= 400)) {
          failures.push(`${label} browser trace contains failed app request ${String(response.url)} (${String(response.status)})`);
        }
      } catch {
        failures.push(`${label} response ${index + 1} url must be absolute`);
      }
      validateConcreteValue(response.resourceType, `${label} response ${index + 1} resourceType`, failures);
      validateBoundedTimestamp(response.observedAt, `${label} response ${index + 1} observedAt`, deployment?.deployedAt, nowMs, failures);
    }
  }
  if (!pageResponse) failures.push(`${label} browser trace must contain a successful response for the exact page URL`);
  if (!Array.isArray(trace.consoleEntries)) {
    failures.push(`${label} browser trace consoleEntries must be an array`);
  } else {
    for (const [index, entry] of trace.consoleEntries.entries()) {
      validateExactKeys(entry, ["type", "text", "timestamp"], `${label} console entry ${index + 1}`, failures);
      validateConcreteValue(entry?.type, `${label} console entry ${index + 1} type`, failures);
      validateBoundedTimestamp(entry?.timestamp, `${label} console entry ${index + 1} timestamp`, deployment?.deployedAt, nowMs, failures);
    }
    if (trace.consoleEntries.some((entry) => entry?.type === "error")) failures.push(`${label} browser trace must contain zero console errors`);
  }

  validateExactKeys(
    trace.authSession,
    ["url", "status", "identityReceiptSha256", "identityBodySha256", "observedAt"],
    `${label} browser trace authSession`,
    failures,
  );
  crossCheck(trace.authSession, "url", `${report.productionUrl}/api/auth/session`, `${label} browser trace authSession`, failures);
  crossCheck(trace.authSession, "status", 200, `${label} browser trace authSession`, failures);
  crossCheck(
    trace.authSession,
    "identityReceiptSha256",
    report.authMeResponseSha256,
    `${label} browser trace authSession`,
    failures,
  );
  crossCheck(
    trace.authSession,
    "identityBodySha256",
    authSession?.response?.bodySha256,
    `${label} browser trace authSession`,
    failures,
  );
  validateBoundedTimestamp(
    trace.authSession?.observedAt,
    `${label} browser trace authSession observedAt`,
    deployment?.deployedAt,
    nowMs,
    failures,
  );

  validateExactKeys(trace.dom, [
    "clientWidth", "scrollWidth", "bodyClientWidth", "bodyScrollWidth", "overflowingSelectors",
  ], `${label} browser trace DOM measurement`, failures);
  if (!Number.isInteger(trace.dom?.clientWidth) || trace.dom.clientWidth !== capture.viewport.width) {
    failures.push(`${label} browser trace DOM clientWidth must equal viewport width ${String(capture.viewport.width)}`);
  }
  if (!Number.isInteger(trace.dom?.scrollWidth) || trace.dom.scrollWidth > trace.dom.clientWidth) {
    failures.push(`${label} browser trace proves global horizontal overflow`);
  }
  if (!Number.isInteger(trace.dom?.bodyClientWidth) || !Number.isInteger(trace.dom?.bodyScrollWidth)
    || trace.dom.bodyScrollWidth > trace.dom.bodyClientWidth) failures.push(`${label} browser trace proves body horizontal overflow`);
  if (!Array.isArray(trace.dom?.overflowingSelectors) || trace.dom.overflowingSelectors.length !== 0) {
    failures.push(`${label} browser trace must contain zero overflowing DOM selectors`);
  }

  const response = trace.deploymentResponse;
  validateExactKeys(response, ["url", "status", "body", "bodySha256", "observedAt"], `${label} deployment response`, failures);
  crossCheck(response, "url", `${report.productionUrl}/api/health`, `${label} deployment response`, failures);
  crossCheck(response, "status", 200, `${label} deployment response`, failures);
  validateDeploymentHealthBody(response?.body, `${label} deployment response body`, failures);
  const serializedBody = JSON.stringify(response?.body);
  const bodyHash = typeof serializedBody === "string"
    ? createHash("sha256").update(serializedBody).digest("hex")
    : null;
  crossCheck(response, "bodySha256", bodyHash, `${label} deployment response`, failures);
  validateBoundedTimestamp(response?.observedAt, `${label} deployment response observedAt`, deployment?.deployedAt, nowMs, failures);
}

function validateDeploymentHealthBody(body, label, failures) {
  validateExactKeys(body, ["ok", "service", "database", "simpro", "notes"], label, failures);
  if (!isRecord(body)) return;
  crossCheck(body, "ok", true, label, failures);
  crossCheck(body, "service", healthService, label, failures);

  validateExactKeys(
    body.database,
    ["configured", "sslConfigured", "connected", "latencyMs"],
    `${label} database`,
    failures,
  );
  if (isRecord(body.database)) {
    crossCheck(body.database, "configured", true, `${label} database`, failures);
    crossCheck(body.database, "connected", true, `${label} database`, failures);
    if (typeof body.database.sslConfigured !== "boolean") {
      failures.push(`${label} database sslConfigured must be a boolean`);
    }
    if (!Number.isInteger(body.database.latencyMs) || body.database.latencyMs < 0) {
      failures.push(`${label} database latencyMs must be a non-negative integer`);
    }
  }

  validateExactKeys(
    body.simpro,
    ["baseUrl", "companyId", "tokenConfigured", "requestsPerSecond", "requestTimeoutMs", "maxPageSize"],
    `${label} simpro`,
    failures,
  );
  if (isRecord(body.simpro)) {
    validateSafeHealthUrl(body.simpro.baseUrl, `${label} simpro baseUrl`, failures);
    if (typeof body.simpro.companyId !== "string" || !body.simpro.companyId.trim()) {
      failures.push(`${label} simpro companyId must be a non-empty string`);
    }
    if (typeof body.simpro.tokenConfigured !== "boolean") {
      failures.push(`${label} simpro tokenConfigured must be a boolean`);
    }
    validateBoundedInteger(body.simpro.requestsPerSecond, 1, 5, `${label} simpro requestsPerSecond`, failures);
    validateBoundedInteger(body.simpro.requestTimeoutMs, 1_000, 300_000, `${label} simpro requestTimeoutMs`, failures);
    validateBoundedInteger(body.simpro.maxPageSize, 1, 250, `${label} simpro maxPageSize`, failures);
  }

  if (JSON.stringify(body.notes) !== JSON.stringify(healthNotes)) {
    failures.push(`${label} notes must match the public health contract`);
  }
}

function validateSafeHealthUrl(value, label, failures) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      failures.push(`${label} must be a safe HTTPS URL`);
    }
  } catch {
    failures.push(`${label} must be a safe HTTPS URL`);
  }
}

function validateBoundedInteger(value, minimum, maximum, label, failures) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    failures.push(`${label} must be an integer from ${String(minimum)} through ${String(maximum)}`);
  }
}

function validateA11yEvidence({ evidence, check, report, deployment, label, failures, nowMs }) {
  validateExactKeys(evidence, [
    "schemaVersion", "sessionId", "deploymentNonce", "tool", "route", "viewport",
    "inspectedUrl", "inspectedAt", "axe", "keyboardTrace",
  ], `${label} evidence`, failures);
  if (!isRecord(evidence)) return;
  crossCheck(evidence, "schemaVersion", 3, `${label} evidence`, failures);
  crossCheck(evidence, "sessionId", report.sessionId, `${label} evidence`, failures);
  crossCheck(evidence, "deploymentNonce", report.deploymentNonce, `${label} evidence`, failures);
  validateExactKeys(evidence.tool, ["name", "version"], `${label} evidence tool`, failures);
  crossCheck(evidence.tool, "name", "axe-core", `${label} evidence tool`, failures);
  validateSemver(evidence.tool?.version, `${label} evidence tool version`, failures);
  crossCheck(evidence, "route", check.route, `${label} evidence`, failures);
  if (JSON.stringify(evidence.viewport) !== JSON.stringify(check.viewport)) failures.push(`${label} evidence viewport mismatch`);
  crossCheck(evidence, "inspectedUrl", check.url, `${label} evidence`, failures);
  validateReportUrl(evidence.inspectedUrl, report.productionUrl, check.route, null, `${label} evidence inspectedUrl`, failures);
  validateBoundedTimestamp(evidence.inspectedAt, `${label} evidence inspectedAt`, deployment?.deployedAt, nowMs, failures);
  crossCheck(check, "checkedAt", evidence.inspectedAt, label, failures);

  validateExactKeys(evidence.axe, ["violations", "passes", "incomplete"], `${label} axe output`, failures);
  for (const name of ["violations", "passes", "incomplete"]) {
    if (!Array.isArray(evidence.axe?.[name])) failures.push(`${label} axe ${name} must be an array`);
  }
  if (!Array.isArray(evidence.axe?.passes) || evidence.axe.passes.length === 0) {
    failures.push(`${label} axe passes must contain substantive rule/node output`);
  }
  for (const collection of ["violations", "passes", "incomplete"]) {
    for (const [index, rule] of (evidence.axe?.[collection] ?? []).entries()) {
      validateExactKeys(rule, ["id", "impact", "nodes"], `${label} axe ${collection} ${index + 1}`, failures);
      validateConcreteValue(rule?.id, `${label} axe ${collection} ${index + 1} id`, failures);
      if (!Array.isArray(rule?.nodes) || rule.nodes.length === 0) failures.push(`${label} axe ${collection} ${index + 1} nodes must be non-empty`);
      for (const [nodeIndex, node] of (rule?.nodes ?? []).entries()) {
        if (!isRecord(node) || !Array.isArray(node.target) || node.target.length === 0
          || node.target.some((target) => typeof target !== "string" || !target.trim())) {
          failures.push(`${label} axe ${collection} ${index + 1} node ${nodeIndex + 1} must contain concrete target selectors`);
        }
      }
    }
  }
  const blocking = (evidence.axe?.violations ?? []).filter((rule) => ["critical", "serious"].includes(rule?.impact));
  if (blocking.length) failures.push(`${label} axe output contains critical/serious violations: ${blocking.map((rule) => rule.id).join(", ")}`);

  if (!Array.isArray(evidence.keyboardTrace) || evidence.keyboardTrace.length < 4) {
    failures.push(`${label} keyboardTrace must contain at least four substantive steps`);
  } else {
    const actions = new Set();
    for (const [index, step] of evidence.keyboardTrace.entries()) {
      validateExactKeys(step, ["sequence", "action", "focusTarget", "result", "timestamp"], `${label} keyboard step ${index + 1}`, failures);
      if (step?.sequence !== index + 1) failures.push(`${label} keyboard step ${index + 1} sequence mismatch`);
      if (!["Tab", "Shift+Tab", "Enter", "Space", "Escape"].includes(step?.action)) failures.push(`${label} keyboard step ${index + 1} action is unsupported`);
      actions.add(step?.action);
      validateConcreteValue(step?.focusTarget, `${label} keyboard step ${index + 1} focusTarget`, failures);
      crossCheck(step, "result", "PASS", `${label} keyboard step ${index + 1}`, failures);
      validateBoundedTimestamp(step?.timestamp, `${label} keyboard step ${index + 1} timestamp`, deployment?.deployedAt, nowMs, failures);
    }
    if (!actions.has("Tab") || !(actions.has("Enter") || actions.has("Space")) || !actions.has("Escape")) {
      failures.push(`${label} keyboardTrace must exercise Tab, Enter/Space, and Escape`);
    }
  }
}

function validateExternalReviewReport(report, attestation, ledger, failures, nowMs) {
  validateExactKeys(report, reviewerReportKeys, "externally supplied review report", failures);
  if (!isRecord(report)) return;
  crossCheck(report, "schemaVersion", 1, "externally supplied review report", failures);
  validateAgentPath(report.declaredReviewerTaskId, "external review declaredReviewerTaskId", failures);
  validateAgentPath(report.declaredReviewerThreadId, "external review declaredReviewerThreadId", failures);
  crossCheck(report, "authorship", "NOT_AUTHENTICATED", "externally supplied review report", failures);
  crossCheck(report, "reviewProcess", "SEPARATE_AGENT_REQUIRED", "externally supplied review report", failures);
  crossCheck(report, "declaredReviewerTaskId", attestation.declaredReviewerTaskId, "externally supplied review report", failures);
  crossCheck(report, "declaredReviewerThreadId", attestation.declaredReviewerThreadId, "externally supplied review report", failures);
  if (JSON.stringify(report.scopeFeatureIds) !== JSON.stringify(attestation.scopeFeatureIds)) failures.push("externally supplied review report scope mismatch");
  if (!Array.isArray(report.findings) || report.findings.length === 0) {
    failures.push("externally supplied review report findings must contain scoped review findings");
  } else {
    for (const [index, finding] of report.findings.entries()) {
      validateExactKeys(finding, ["id", "severity", "disposition", "summary", "featureIds", "artifactHashes"], `external review finding ${index + 1}`, failures);
      validateConcreteValue(finding?.id, `external review finding ${index + 1} id`, failures);
      validateConcreteValue(finding?.summary, `external review finding ${index + 1} summary`, failures);
      if (!Array.isArray(finding?.featureIds) || finding.featureIds.length === 0
        || finding.featureIds.some((id) => !attestation.scopeFeatureIds.includes(id))) {
        failures.push(`external review finding ${index + 1} featureIds must scope the finding to reviewed features`);
      }
      if (!["RESOLVED", "ACCEPTED"].includes(finding?.disposition)) failures.push(`external review finding ${index + 1} disposition must be RESOLVED or ACCEPTED`);
      if (!Array.isArray(finding?.artifactHashes) || finding.artifactHashes.length === 0
        || finding.artifactHashes.some((value) => !sha256Pattern.test(value))) {
        failures.push(`external review finding ${index + 1} artifactHashes must contain SHA-256 values`);
      }
    }
  }
  if (typeof report.finalDecisionText !== "string" || report.finalDecisionText.length < 20 || !/\bSHIP\b/.test(report.finalDecisionText)) {
    failures.push("externally supplied review report finalDecisionText must contain a substantive SHIP decision");
  }
  validateBoundedTimestamp(report.timestamp, "externally supplied review report timestamp", null, nowMs, failures);
  validateExactKeys(report.artifactHashes, [
    "deploymentManifest", "e2eReport", "a11yReport", "browserAttestation",
    "gateReport", "gateRunnerReceipt",
  ], "externally supplied review report artifactHashes", failures);
  for (const [name, hashField] of [
    ["deploymentManifest", "deploymentManifestSha256"],
    ["e2eReport", "e2eReportSha256"],
    ["a11yReport", "a11yReportSha256"],
    ["browserAttestation", "browserAttestationSha256"],
    ["gateReport", "gateReportSha256"],
    ["gateRunnerReceipt", "gateRunnerReceiptSha256"],
  ]) {
    crossCheck(report.artifactHashes, name, ledger[hashField], "externally supplied review report artifactHashes", failures);
  }
}

function validateAgentPath(value, label, failures) {
  if (typeof value !== "string" || !agentPathPattern.test(value)) failures.push(`${label} must match ${agentPathPattern}`);
}

function validateSemver(value, label, failures) {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)) failures.push(`${label} must be a concrete semantic version`);
}

function validateLedgerBaseline(ledger, baseline, failures) {
  if (ledger.schemaVersion !== FEATURE_LEDGER_SCHEMA_VERSION) {
    failures.push(`feature ledger schemaVersion must be ${FEATURE_LEDGER_SCHEMA_VERSION}, received ${String(ledger.schemaVersion)}`);
  }
  crossCheck(ledger, "planRevision", PLAN_REVISION, "feature ledger", failures);
  crossCheck(ledger, "planSha256", PLAN_SHA256, "feature ledger", failures);
  if (!Array.isArray(ledger.features)) {
    failures.push("feature ledger must contain a features array");
    return;
  }
  const foundIds = ledger.features.map((feature) => feature?.id);
  const missing = AUTHORITATIVE_FEATURE_IDS.filter((id) => !foundIds.includes(id));
  const extra = foundIds.filter((id) => !AUTHORITATIVE_FEATURE_IDS.includes(id));
  const duplicate = foundIds.filter((id, index) => foundIds.indexOf(id) !== index);
  if (ledger.features.length !== AUTHORITATIVE_FEATURE_IDS.length) {
    failures.push(`feature ledger must contain exactly ${AUTHORITATIVE_FEATURE_IDS.length} records, received ${ledger.features.length}`);
  }
  if (missing.length) failures.push(`feature ledger is missing authoritative IDs: ${missing.join(", ")}`);
  if (extra.length) failures.push(`feature ledger contains extra IDs: ${extra.map(String).join(", ")}`);
  if (duplicate.length) failures.push(`feature ledger contains duplicate IDs: ${[...new Set(duplicate)].map(String).join(", ")}`);
  const firstOrderMismatch = foundIds.findIndex((id, index) => id !== AUTHORITATIVE_FEATURE_IDS[index]);
  if (firstOrderMismatch !== -1) {
    failures.push(`feature ledger order diverges at index ${firstOrderMismatch}: expected ${String(AUTHORITATIVE_FEATURE_IDS[firstOrderMismatch])}, received ${String(foundIds[firstOrderMismatch])}`);
  }
  for (const row of baseline.rows) {
    const feature = ledger.features.find((candidate) => candidate?.id === row.id);
    if (!feature) continue;
    if (feature.baselineStatus !== row.baselineStatus) failures.push(`${row.id}: baselineStatus diverges from the execution plan`);
    if (feature.requirement !== row.requirement) failures.push(`${row.id}: requirement text diverges from the execution plan`);
  }
}

function validateSynchronizedFeatureFields(feature, baselineRow, gate, failures) {
  const id = feature.id;
  if (baselineRow.baselineStatus !== removedStatus && gate) {
    const expectedTestIds = Object.fromEntries(GATE_CATEGORIES.map((category) => [
      category,
      gate.runs.find((run) => run.category === category)?.results?.map((result) => result.id) ?? [],
    ]));
    if (JSON.stringify(feature.testIds) !== JSON.stringify(expectedTestIds)) {
      failures.push(`${id}: testIds do not exactly reference the trusted emitted gate assertions`);
    }
  }
  const acceptingGate = expectedAcceptingGate(id);
  if (feature.acceptingGate !== acceptingGate) failures.push(`${id}: acceptingGate must be ${acceptingGate}`);
  if (baselineRow.baselineStatus === removedStatus && feature.executionStatus !== removedStatus) {
    failures.push(`${id}: authoritative owner removal was not preserved`);
  }
  if (Object.hasOwn(feature, "implementingCommitSha")) {
    failures.push(`${id}: implementingCommitSha is invalid for this uncommitted source tree; use buildSourceSha256`);
  }
}

function validateLedgerReleaseFields(feature, failures) {
  const id = feature.id;
  validateSha256(feature.buildSourceSha256, `${id}: buildSourceSha256`, failures);
  validateRevision(feature.deployedRevision, `${id}: deployedRevision`, failures);
  validateImageDigest(feature.imageDigest, `${id}: imageDigest`, failures);
  validateSha256(feature.evidenceArtifactSha256, `${id}: evidenceArtifactSha256`, failures);
  if (feature.independentReviewer !== UNAUTHENTICATED_EXTERNAL_REVIEWER) {
    failures.push(`${id}: legacy independentReviewer field must explicitly state that external review authorship is not authenticated`);
  }
  if (feature.reviewResult !== "SHIP") failures.push(`${id}: reviewResult must be SHIP`);
}

function validateTestResults(feature, results, gate, failures) {
  const id = feature.id;
  if (!Array.isArray(results)) {
    failures.push(`${id}: evidence artifact testResults must be an array`);
    return;
  }
  if (!gate) return;
  const expected = GATE_CATEGORIES.flatMap((category) => (
    gate.runs.find((run) => run.category === category)?.results ?? []
  ));
  if (JSON.stringify(results) !== JSON.stringify(expected)) {
    failures.push(`${id}: evidence artifact testResults do not exactly match trusted emitted assertions and provenance`);
  }
  for (const result of results) validateObservedResultRecord(result, `${id}: test result`, failures);
}

function validateGateResults(feature, results, failures) {
  const id = feature.id;
  if (!Array.isArray(results)) {
    failures.push(`${id}: evidence artifact gateResults must be an array`);
    return;
  }
  if (results.length !== 0) {
    failures.push(`${id}: evidence artifact gateResults must remain empty; acceptingGate is plan metadata, not a synthesized PASS claim`);
  }
}

function validateObservedResultRecord(result, label, failures) {
  validateExactKeys(result, ["id", "outcome", "provenance", "counts"], label, failures);
  if (!isRecord(result)) return;
  if (!/^OBS-[A-Z]+-[a-f0-9]{32}$/.test(result.id ?? "")) failures.push(`${label} id must be an observed assertion ID`);
  if (result.outcome !== "PASS") failures.push(`${label} ${String(result.id)} outcome must be PASS`);
  validateExactKeys(result.provenance, ["runner", "source", "assertion"], `${label} provenance`, failures);
  validateExactKeys(result.counts, ["total", "passed", "failed", "skipped", "cancelled", "todo"], `${label} counts`, failures);
}

async function readLedgerArtifact({ projectRoot, ledger, pathField, hashField, label, failures }) {
  if (!sha256Pattern.test(ledger[hashField] ?? "")) failures.push(`feature ledger ${hashField} must be a concrete SHA-256`);
  return readHashedJsonArtifact({
    projectRoot,
    artifactPath: ledger[pathField],
    expectedSha256: ledger[hashField],
    label,
    failures,
  });
}

async function readHashedJsonArtifact(params) {
  const loaded = await readHashedArtifact({ ...params, requireJson: true });
  if (!loaded) return null;
  try {
    return { ...loaded, document: JSON.parse(loaded.bytes.toString("utf8")) };
  } catch {
    params.failures.push(`${params.label} is not valid JSON: ${String(params.artifactPath)}`);
    return null;
  }
}

async function readHashedArtifact({
  projectRoot, artifactPath, expectedSha256, label, failures, requireJson = false, allowEmpty = false,
}) {
  if (typeof artifactPath !== "string" || !artifactPath.trim()) {
    failures.push(`${label} path must be a non-empty project-relative path`);
    return null;
  }
  if (isAbsolute(artifactPath)) {
    failures.push(`${label} path must be project-relative: ${artifactPath}`);
    return null;
  }
  if (requireJson && !artifactPath.endsWith(".json")) {
    failures.push(`${label} path must identify a JSON file: ${artifactPath}`);
    return null;
  }
  const allowedRoot = resolve(projectRoot, "docs/prostar-metrics/verification");
  const resolvedPath = resolve(projectRoot, artifactPath);
  if (!isWithin(allowedRoot, resolvedPath)) {
    failures.push(`${label} path must be under docs/prostar-metrics/verification: ${artifactPath}`);
    return null;
  }
  try {
    const canonicalPath = await realpath(resolvedPath);
    if (!isWithin(allowedRoot, canonicalPath)) {
      failures.push(`${label} path resolves outside verification: ${artifactPath}`);
      return null;
    }
    const artifactStat = await stat(canonicalPath);
    if (!artifactStat.isFile()) {
      failures.push(`${label} path is not a file: ${artifactPath}`);
      return null;
    }
    const bytes = await readFile(canonicalPath);
    if (!allowEmpty && bytes.length === 0) failures.push(`${label} file is empty: ${artifactPath}`);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (expectedSha256 !== null && sha256 !== expectedSha256) {
      failures.push(`${label} hash mismatch: expected ${String(expectedSha256)}, received ${sha256}`);
    }
    if (requiresCredentialScan(label)) scanForCredentialExposure(bytes, label, failures);
    return { bytes, sha256, path: artifactPath };
  } catch (error) {
    if (error?.code === "ENOENT") {
      failures.push(`${label} file does not exist: ${artifactPath}`);
      return null;
    }
    throw error;
  }
}

async function validateOnDiskPlanSynchronization(projectRoot, failures) {
  const child = spawn(process.execPath, [resolve(projectRoot, "scripts/sync-feature-status.mjs"), "--check"], {
    cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const result = await new Promise((resolveResult, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveResult({ code, signal }));
  });
  if (result.code !== 0) failures.push(`plan synchronization validation failed: ${stderr.trim() || stdout.trim() || `exit ${String(result.code ?? result.signal)}`}`);
}

async function loadAuthoritativeBaseline(projectRoot, failures) {
  try {
    const plan = await readFile(resolve(projectRoot, "docs/prostar-metrics/execution-plan.md"), "utf8");
    const rows = parseAuthoritativePlan(plan);
    return { rows, byId: new Map(rows.map((row) => [row.id, row])) };
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
    return null;
  }
}

async function readJson(path, label, failures) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    failures.push(`${label} could not be read as JSON: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function validateViewport(value, label, failures) {
  validateExactKeys(value, ["name", "width", "height"], label, failures);
  if (!isRecord(value) || !Object.hasOwn(viewportContracts, value.name)) {
    failures.push(`${label} name must be desktop or mobile`);
    return null;
  }
  const expected = viewportContracts[value.name];
  if (JSON.stringify(value) !== JSON.stringify(expected)) failures.push(`${label} must be ${expected.width}x${expected.height}`);
  return value.name;
}

function validatePng(bytes, viewport, label, failures) {
  try {
    if (bytes.length < 128 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
      throw new Error("must be a complete PNG of at least 128 bytes");
    }
    let offset = 8;
    let header = null;
    let ended = false;
    const compressed = [];
    while (offset < bytes.length) {
      if (offset + 12 > bytes.length) throw new Error("contains a truncated chunk");
      const length = bytes.readUInt32BE(offset);
      const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
      const end = offset + 12 + length;
      if (end > bytes.length) throw new Error(`contains a truncated ${type} chunk`);
      const data = bytes.subarray(offset + 8, offset + 8 + length);
      const expectedCrc = bytes.readUInt32BE(offset + 8 + length);
      if (pngCrc32(Buffer.concat([Buffer.from(type, "ascii"), data])) !== expectedCrc) throw new Error(`contains an invalid ${type} CRC`);
      if (type === "IHDR") {
        if (header || length !== 13 || offset !== 8) throw new Error("contains an invalid IHDR");
        header = {
          width: data.readUInt32BE(0), height: data.readUInt32BE(4), bitDepth: data[8],
          colorType: data[9], compression: data[10], filter: data[11], interlace: data[12],
        };
      } else if (type === "IDAT") {
        compressed.push(data);
      } else if (type === "IEND") {
        if (length !== 0) throw new Error("contains an invalid IEND");
        ended = true;
        offset = end;
        break;
      }
      offset = end;
    }
    if (!header || !ended || offset !== bytes.length || compressed.length === 0) throw new Error("must contain IHDR, IDAT, and terminal IEND chunks");
    if (header.width !== viewport.width || header.height !== viewport.height) {
      throw new Error(`dimensions must be ${viewport.width}x${viewport.height}, received ${header.width}x${header.height}`);
    }
    const channels = new Map([[0, 1], [2, 3], [4, 2], [6, 4]]).get(header.colorType);
    if (header.bitDepth !== 8 || !channels || header.compression !== 0 || header.filter !== 0 || header.interlace !== 0) {
      throw new Error("must use supported non-interlaced 8-bit PNG encoding");
    }
    const rowBytes = header.width * channels;
    const raw = inflateSync(Buffer.concat(compressed), { maxOutputLength: (rowBytes + 1) * header.height });
    if (raw.length !== (rowBytes + 1) * header.height) throw new Error("decoded pixel data length is invalid");
    let prior = Buffer.alloc(rowBytes);
    let firstPixel = null;
    let varied = false;
    for (let y = 0; y < header.height; y += 1) {
      const rowStart = y * (rowBytes + 1);
      const filter = raw[rowStart];
      if (filter > 4) throw new Error(`contains unsupported row filter ${filter}`);
      const encoded = raw.subarray(rowStart + 1, rowStart + 1 + rowBytes);
      const decoded = Buffer.allocUnsafe(rowBytes);
      for (let x = 0; x < rowBytes; x += 1) {
        const left = x >= channels ? decoded[x - channels] : 0;
        const up = prior[x];
        const upperLeft = x >= channels ? prior[x - channels] : 0;
        decoded[x] = (encoded[x] + pngFilterDelta(filter, left, up, upperLeft)) & 0xff;
      }
      for (let x = 0; x < rowBytes; x += channels) {
        const pixel = decoded.subarray(x, x + channels).toString("hex");
        if (firstPixel === null) firstPixel = pixel;
        else if (pixel !== firstPixel) varied = true;
      }
      prior = decoded;
    }
    if (!varied) throw new Error("must contain nonblank pixel evidence");
  } catch (error) {
    failures.push(`${label} ${error instanceof Error ? error.message : String(error)}`);
  }
}

function pngFilterDelta(filter, left, up, upperLeft) {
  if (filter === 0) return 0;
  if (filter === 1) return left;
  if (filter === 2) return up;
  if (filter === 3) return Math.floor((left + up) / 2);
  const prediction = left + up - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const upDistance = Math.abs(prediction - up);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  return leftDistance <= upDistance && leftDistance <= upperLeftDistance ? left : upDistance <= upperLeftDistance ? up : upperLeft;
}

function pngCrc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function validateExactCoverage(found, expected, label, failures) {
  const duplicate = found.filter((key, index) => found.indexOf(key) !== index);
  const missing = expected.filter((key) => !found.includes(key));
  const extra = found.filter((key) => !expected.includes(key));
  if (missing.length) failures.push(`${label} is missing coverage: ${missing.join(", ")}`);
  if (extra.length) failures.push(`${label} contains unsupported coverage: ${extra.join(", ")}`);
  if (duplicate.length) failures.push(`${label} contains duplicate coverage: ${[...new Set(duplicate)].join(", ")}`);
}

function validateReportUrl(value, productionUrl, route, period, label, failures, capturedAt) {
  try {
    const url = new URL(value);
    const base = new URL(productionUrl);
    const expectedParams = expectedReportSearchParams(route, period, capturedAt, label, failures);
    const expectedSearch = expectedParams.length === 0
      ? ""
      : `?${new URLSearchParams(expectedParams).toString()}`;
    const actualParams = [...url.searchParams.entries()];
    const searchMatches = actualParams.length === expectedParams.length
      && expectedParams.every(([key, expectedValue]) => (
        actualParams.filter(([actualKey]) => actualKey === key).length === 1
        && url.searchParams.get(key) === expectedValue
      ));
    if (
      url.origin !== base.origin
      || url.username
      || url.password
      || url.pathname !== route
      || !searchMatches
      || url.hash
    ) {
      failures.push(`${label} must exactly bind production route ${String(route)}${expectedSearch}`);
    }
  } catch {
    failures.push(`${label} must be an absolute production URL`);
  }
}

function expectedReportSearchParams(route, period, capturedAt, label, failures) {
  if (period === null) return [];
  const monthKey = period === "current"
    ? pacificMonthKey(capturedAt, label, failures)
    : period;
  if (!monthKey) return [];
  if (route !== "/commissions") return [["month", monthKey]];
  const [year, month] = monthKey.split("-");
  return [["year", year], ["month", String(Number(month))], ["summaryYear", year]];
}

function pacificMonthKey(capturedAt, label, failures) {
  if (!validTimestamp(capturedAt)) {
    failures.push(`${label} current period requires a valid capturedAt timestamp`);
    return null;
  }
  const parts = Object.fromEntries(
    pacificMonthFormatter.formatToParts(new Date(capturedAt)).map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}`;
}

function validateProductionUrl(value, label, failures) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      failures.push(`${label} must be an HTTPS origin without credentials, path, query, or fragment`);
    }
  } catch {
    failures.push(`${label} must be an absolute HTTPS origin`);
  }
}

function validateRoute(value, label, failures) {
  if (!requiredRoutes.includes(value)) failures.push(`${label} must be one of ${requiredRoutes.join(", ")}`);
}

export function createSanitizedAuthSessionArtifact({
  sessionId,
  deploymentNonce,
  productionUrl,
  requestHeaders = {},
  responseStatus,
  responseHeaders = {},
  responseBody,
  capturedAt,
}) {
  const failures = [];
  validateProductionUrl(productionUrl, "auth session productionUrl", failures);
  validateConcreteValue(sessionId, "auth session sessionId", failures);
  validateConcreteValue(deploymentNonce, "auth session deploymentNonce", failures);
  if (responseStatus !== 200) failures.push("auth session response status must be 200");
  if (!validTimestamp(capturedAt)) failures.push("auth session capturedAt must be an ISO-8601 UTC timestamp");

  let parsedBody = responseBody;
  if (typeof responseBody === "string" || Buffer.isBuffer(responseBody)) {
    try {
      parsedBody = JSON.parse(Buffer.from(responseBody).toString("utf8"));
    } catch {
      failures.push("auth session response body must be valid JSON");
      parsedBody = null;
    }
  }
  const identity = validateSessionIdentity(parsedBody, "auth session response body", failures);
  const safeRequestHeaders = retainSafeHeaders(requestHeaders, new Set(["accept"]));
  const safeResponseHeaders = retainSafeHeaders(responseHeaders, new Set(["cache-control", "content-type"]));
  if (safeRequestHeaders.accept !== "application/json") {
    failures.push("auth session request accept header must be application/json");
  }
  if (safeResponseHeaders["cache-control"] !== "no-store") {
    failures.push("auth session response cache-control header must be no-store");
  }
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(safeResponseHeaders["content-type"] ?? "")) {
    failures.push("auth session response content-type must be application/json with optional UTF-8 charset");
  }
  if (failures.length) throw new ReleaseEvidenceError(failures);

  const body = {
    authenticated: true,
    principalEmail: identity.principalEmail,
    principalId: identity.principalId,
    provider: identity.provider,
  };
  const artifact = {
    schemaVersion: 2,
    sessionId,
    deploymentNonce,
    request: {
      url: `${productionUrl}/api/auth/session`,
      method: "GET",
      headers: { accept: safeRequestHeaders.accept },
    },
    response: {
      status: 200,
      headers: {
        "cache-control": safeResponseHeaders["cache-control"],
        "content-type": safeResponseHeaders["content-type"],
      },
      body,
      bodySha256: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
    },
    capturedAt,
  };
  const exposureFailures = [];
  scanForCredentialExposure(Buffer.from(JSON.stringify(artifact)), "sanitized auth session receipt", exposureFailures);
  if (exposureFailures.length) throw new ReleaseEvidenceError(exposureFailures);
  return artifact;
}

function crossCheckReportIdentity(report, identity, label, failures) {
  if (!identity) return;
  crossCheck(report, "authenticatedActor", identity.principalEmail, label, failures);
  crossCheck(report, "authenticatedPrincipalId", identity.principalId, label, failures);
  crossCheck(report, "authenticationProvider", identity.provider, label, failures);
}

function validateSessionIdentity(value, label, failures) {
  validateExactKeys(value, ["authenticated", "principalEmail", "principalId", "provider"], label, failures);
  if (!isRecord(value)) return null;
  crossCheck(value, "authenticated", true, label, failures);
  validateActor(value.principalEmail, `${label} principalEmail`, failures);
  validatePrincipalId(value.principalId, `${label} principalId`, failures);
  if (value.provider !== allowedAuthenticationProvider) failures.push(`${label} provider must be aad`);
  return {
    principalEmail: value.principalEmail,
    principalId: value.principalId,
    provider: value.provider,
  };
}

function validatePrincipalId(value, label, failures) {
  if (typeof value !== "string" || !principalIdPattern.test(value)) {
    failures.push(`${label} must be an Entra object ID GUID`);
  }
}

function validateSafeHeaderSubset(value, allowlist, label, failures) {
  if (!isRecord(value)) {
    failures.push(`${label} must be an object`);
    return;
  }
  for (const [name, headerValue] of Object.entries(value)) {
    if (name !== name.toLowerCase() || !allowlist.has(name)) {
      failures.push(`${label} contains forbidden header ${name}`);
    }
    if (typeof headerValue !== "string" || /[\r\n]/.test(headerValue)) {
      failures.push(`${label} ${name} must be a single-line string`);
    }
  }
}

function retainSafeHeaders(value, allowlist) {
  const retained = {};
  for (const [rawName, rawValue] of headerEntries(value)) {
    const name = String(rawName).trim().toLowerCase();
    if (!allowlist.has(name)) continue;
    const normalizedValue = String(rawValue).trim();
    if (/^[^\r\n]*$/.test(normalizedValue)) retained[name] = normalizedValue;
  }
  return retained;
}

function headerEntries(value) {
  if (value && typeof value.entries === "function") return [...value.entries()];
  if (Array.isArray(value)) return value;
  if (isRecord(value)) return Object.entries(value);
  return [];
}

function requiresCredentialScan(label) {
  return label === "E2E report"
    || label === "accessibility report"
    || /sanitized auth session receipt|browser trace|accessibility check .* evidence|(?:stdout|stderr) raw log/i.test(label);
}

export function assertCredentialSafeEvidence(value, label = "evidence artifact") {
  const failures = [];
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  scanForCredentialExposure(bytes, label, failures);
  if (failures.length) throw new ReleaseEvidenceError(failures);
}

function scanForCredentialExposure(bytes, label, failures) {
  const text = bytes.toString("utf8");
  const patterns = [
    ["Authorization header", /(?:^|[\s"'{,])authorization["']?\s*[:=]/im],
    ["Cookie header or value", /(?:^|[\s"'{,])(?:set-cookie|cookie)["']?\s*[:=]/im],
    ["Bearer credential", /\bbearer\s+[a-z0-9._~+/=-]{8,}/i],
    ["JWT", /\beyJ[a-z0-9_-]{5,}\.[a-z0-9_-]{5,}\.[a-z0-9_-]{5,}\b/i],
    ["database URL", /\b(?:postgres(?:ql)?|mysql|mssql):\/\/[^\s"'<>]+/i],
    ["database connection string", /\b(?:server|data source|host)\s*=\s*[^;\r\n]+;[^\r\n]*(?:password|pwd|user id|username)\s*=\s*[^;\s"']+/i],
    ["password assignment", /\b(?:password|pwd)\s*[:=]\s*["']?[^\s"',;}]{8,}/i],
    ["secret or token assignment", /\b(?:client[_-]?secret|api[_-]?key|account[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token|secret|token)\b["']?\s*[:=]\s*["']?[^\s"',;}]{8,}/i],
    ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i],
  ];
  for (const [kind, pattern] of patterns) {
    if (pattern.test(text)) failures.push(`${label} contains forbidden credential material (${kind})`);
  }
}

function validateActor(value, label, failures) {
  if (typeof value !== "string" || !allowedActors.has(value)) {
    failures.push(`${label} must be an authenticated Asad or Laila owner account`);
  }
}

function validateBoundedTimestamp(value, label, after, nowMs, failures) {
  if (!validTimestamp(value)) {
    failures.push(`${label} must be an ISO-8601 UTC timestamp`);
    return;
  }
  const timestamp = Date.parse(value);
  if (after && validTimestamp(after) && timestamp <= Date.parse(after)) failures.push(`${label} must be after ${after}`);
  if (Number.isFinite(nowMs) && timestamp > nowMs) failures.push(`${label} must not be in the future`);
}

function latestTimestamp(...values) {
  const valid = values.filter(validTimestamp);
  return valid.length ? valid.sort((left, right) => Date.parse(right) - Date.parse(left))[0] : null;
}

function normalizeNow(now, failures) {
  const value = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(value)) failures.push("validation now value must be a valid timestamp");
  return value;
}

function validateRequestedCategories(categories, failures) {
  if (!Array.isArray(categories) || categories.length === 0) {
    failures.push("at least one release evidence test category is required");
    return [];
  }
  const unknown = categories.filter((category) => !allTestCategories.includes(category));
  if (unknown.length) failures.push(`unknown release evidence test categories: ${unknown.join(", ")}`);
  return categories.filter((category) => allTestCategories.includes(category));
}

function validateExactKeys(value, expectedKeys, label, failures) {
  if (!isRecord(value)) {
    failures.push(`${label} must be an object`);
    return;
  }
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  const missing = expected.filter((key) => !keys.includes(key));
  const extra = keys.filter((key) => !expected.includes(key));
  if (missing.length) failures.push(`${label} is missing fields: ${missing.join(", ")}`);
  if (extra.length) failures.push(`${label} contains unsupported fields: ${extra.join(", ")}`);
}

function crossCheck(document, field, expected, label, failures) {
  if (document?.[field] !== expected) failures.push(`${label} ${field} mismatch: expected ${String(expected)}, received ${String(document?.[field])}`);
}

function validateSha256(value, label, failures) {
  if (!sha256Pattern.test(value ?? "")) failures.push(`${label} must be 64 lowercase hex characters`);
}

function validateImageDigest(value, label, failures) {
  if (!imageDigestPattern.test(value ?? "")) failures.push(`${label} must be an immutable sha256:<64 lowercase hex> digest`);
}

function validateRevision(value, label, failures) {
  if (!deployedRevisionPattern.test(value ?? "")) failures.push(`${label} must identify an aca-prostar-metrics-prod revision`);
}

function validateConcreteValue(value, label, failures) {
  if (typeof value !== "string" || value.trim().length < 3 || placeholderPattern.test(value.trim()) || /placeholder/i.test(value)) {
    failures.push(`${label} must be a concrete non-placeholder value`);
  }
}

function validTimestamp(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isWithin(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..");
}

export async function validateRawPostDeployEvidence({
  root = defaultRoot,
  deploymentManifestPath,
  e2eReportPath,
  a11yReportPath,
  browserAttestationPath,
  liveVerifier = verifyAzureDeploymentLive,
  receiptVerifier,
  now = new Date(),
} = {}) {
  const projectRoot = await realpath(resolve(root));
  const failures = [];
  const nowMs = normalizeNow(now, failures);
  const [deploymentBytes, e2eBytes, a11yBytes, browserBytes] = await Promise.all([
    readFile(resolve(projectRoot, deploymentManifestPath)),
    readFile(resolve(projectRoot, e2eReportPath)),
    readFile(resolve(projectRoot, a11yReportPath)),
    readFile(resolve(projectRoot, browserAttestationPath)),
  ]);
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const e2eDocument = JSON.parse(e2eBytes.toString("utf8"));
  const ledger = {
    deploymentManifestPath,
    deploymentManifestSha256: hash(deploymentBytes),
    e2eReportPath,
    e2eReportSha256: hash(e2eBytes),
    a11yReportPath,
    a11yReportSha256: hash(a11yBytes),
    authMeResponsePath: e2eDocument.authMeResponsePath,
    authMeResponseSha256: e2eDocument.authMeResponseSha256,
    browserAttestationPath,
    browserAttestationSha256: hash(browserBytes),
  };
  const deployment = await validateDeploymentManifest({
    projectRoot, ledger, failures, liveVerifier, nowMs,
  });
  const e2e = await validateE2EReport({ projectRoot, ledger, deployment, failures, nowMs });
  const a11y = await validateA11yReport({ projectRoot, ledger, deployment, failures, nowMs });
  await validateBrowserAttestation({
    projectRoot, ledger, deployment, e2e, a11y, failures, nowMs, receiptVerifier,
  });
  if (failures.length) throw new ReleaseEvidenceError(failures);
  return { sessionId: e2e.sessionId, captures: e2e.captures.length, checks: a11y.checks.length };
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    const rawSuiteArg = process.argv.find((argument) => argument.startsWith("--raw-post-deploy-suite="));
    if (rawSuiteArg) {
      const result = await validateRawPostDeployEvidence({
        deploymentManifestPath: process.env.RELEASE_DEPLOYMENT_MANIFEST,
        e2eReportPath: process.env.RELEASE_E2E_REPORT,
        a11yReportPath: process.env.RELEASE_A11Y_REPORT,
        browserAttestationPath: process.env.RELEASE_BROWSER_ATTESTATION,
      });
      console.log(`Accepted raw post-deployment capture session ${result.sessionId}.`);
      process.exit(0);
    }
    const suiteArg = process.argv.find((argument) => argument.startsWith("--post-deploy-suite="));
    const suite = suiteArg?.slice("--post-deploy-suite=".length);
    const suiteCategories = suiteArg ? resolvePostDeploySuiteCategories(suite) : undefined;
    const result = await validateReleaseEvidence({ requiredTestCategories: suiteCategories });
    const scope = suite ? `${suite} post-deployment evidence` : "release evidence";
    console.log(`Accepted ${scope} for ${result.verified} verified features and ${result.removed} owner-removed features.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
