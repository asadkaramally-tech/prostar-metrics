import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { validateReleaseEvidence } from "./check-release-evidence.mjs";
import {
  computeDockerBuildContext,
  validateDeploymentManifestDocument,
} from "./lib/deployment-provenance.mjs";
import {
  AUTHORITATIVE_FEATURE_IDS,
  FEATURE_EVIDENCE_SCHEMA_VERSION,
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

const removedStatus = "REMOVED BY OWNER DECISION";
const verificationRoot = "docs/prostar-metrics/verification";
const agentPattern = /^019[a-f0-9-]+$/;
const placeholderPattern = /^(?:tbd|todo|pending|unknown|none|null|n\/a|placeholder)$/i;

export class ReleaseEvidencePublisherError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseEvidencePublisherError";
  }
}

export async function publishReleaseEvidence({
  root = process.cwd(),
  deploymentManifestPath,
  e2eReportPath,
  a11yReportPath,
  reviewerAttestationPath,
  reviewerReportPath,
  gateReportPath,
  ledgerPath = "docs/prostar-metrics/feature-status.json",
  liveVerifier,
  receiptVerifiers = {},
  now = new Date(),
  beforePromote,
} = {}) {
  const projectRoot = await realpath(resolve(root));
  const nowMs = normalizeNow(now);
  const normalized = {
    deploymentManifestPath: await requireVerificationFile(projectRoot, deploymentManifestPath, "deployment manifest"),
    e2eReportPath: await requireVerificationFile(projectRoot, e2eReportPath, "E2E report"),
    a11yReportPath: await requireVerificationFile(projectRoot, a11yReportPath, "accessibility report"),
    reviewerAttestationPath: await requireVerificationFile(projectRoot, reviewerAttestationPath, "external review validation receipt"),
    reviewerReportPath: await requireVerificationFile(projectRoot, reviewerReportPath, "externally supplied review report"),
    gateReportPath: await requireVerificationFile(projectRoot, gateReportPath, "gate-run report"),
  };
  const normalizedLedgerPath = normalizeProjectPath(projectRoot, ledgerPath, "feature ledger");
  const artifacts = new Map();
  const load = (artifactPath, label, expectedSha256 = null, requireJson = true, allowEmpty = false) => loadArtifact({
    projectRoot, artifactPath, label, expectedSha256, requireJson, allowEmpty, artifacts,
  });

  const deployment = await load(normalized.deploymentManifestPath, "deployment manifest");
  const e2e = await load(normalized.e2eReportPath, "E2E report");
  const a11y = await load(normalized.a11yReportPath, "accessibility report");
  const attestation = await load(normalized.reviewerAttestationPath, "external review validation receipt");
  const reviewerReport = await load(normalized.reviewerReportPath, "externally supplied review report");
  const gateReport = await load(normalized.gateReportPath, "gate-run report");
  try {
    await validateDeploymentManifestDocument(deployment.document, {
      expectedPlanRevision: PLAN_REVISION,
      expectedPlanSha256: PLAN_SHA256,
    });
    validateEvidenceAge(deployment.document.deployedAt, {
      label: "deployment manifest deployedAt", nowMs, maxAgeMs: MAX_DEPLOYMENT_AGE_MS,
    });
  } catch (error) {
    throw new ReleaseEvidencePublisherError(error.message);
  }
  for (const [name, artifact] of Object.entries(deployment.document.monitoringEvidence ?? {})) {
    await load(artifact.path, `deployment monitoring evidence ${name}`, artifact.sha256, true);
  }
  normalized.browserAttestationPath = await requireVerificationFile(
    projectRoot, e2e.document.browserAttestationPath, "validated browser artifacts receipt",
  );
  normalized.gateRunnerReceiptPath = await requireVerificationFile(
    projectRoot, gateReport.document.runnerReceiptPath, "gate runner receipt",
  );
  const browserAttestation = await load(normalized.browserAttestationPath, "validated browser artifacts receipt");
  const gateRunnerReceipt = await load(normalized.gateRunnerReceiptPath, "gate runner receipt");
  const ledger = JSON.parse(await readFile(resolve(projectRoot, normalizedLedgerPath), "utf8"));
  const plan = await readFile(resolve(projectRoot, "docs/prostar-metrics/execution-plan.md"), "utf8");
  const planRows = parseAuthoritativePlan(plan);
  const mandatoryIds = planRows.filter((row) => row.baselineStatus !== removedStatus).map((row) => row.id);

  validateSharedBindings({ normalized, deployment, e2e, a11y });
  const browserArtifactHashes = await loadReportArtifacts({ e2e: e2e.document, a11y: a11y.document, load });
  await validateBrowserReceipt({
    deployment, e2e, a11y, browserAttestation, browserArtifactHashes,
    nowMs, receiptVerifier: receiptVerifiers.browser,
  });
  await validateTrustedGateReport({
    report: gateReport.document,
    reportSha256: gateReport.sha256,
    runnerReceipt: gateRunnerReceipt.document,
    deployment: deployment.document,
    deploymentManifestPath: normalized.deploymentManifestPath,
    deploymentManifestSha256: deployment.sha256,
    mandatoryIds,
    readArtifact: (path, label, expectedSha256, requireJson, allowEmpty) => (
      load(path, label, expectedSha256, requireJson, allowEmpty)
    ),
    receiptVerifier: receiptVerifiers.gate ?? verifyServiceReceipt,
    nowMs,
  });
  rejectReusedEvidenceArtifacts({
    deployment, e2e, a11y, browserAttestation, gateReport, gateRunnerReceipt,
    attestation, reviewerReport, artifacts,
  });
  await validateExternalReviewReportReceipt({
    receipt: attestation,
    report: reviewerReport,
    mandatoryIds,
    deployment,
    e2e,
    a11y,
    browserAttestation,
    gateReport,
    gateRunnerReceipt,
    nowMs,
    receiptVerifier: receiptVerifiers.reviewer,
  });

  const productionVerifiedAt = new Date(nowMs).toISOString();
  const candidate = buildCandidateLedger({
    ledger,
    mandatoryIds,
    normalized,
    deployment,
    e2e,
    a11y,
    browserAttestation,
    gateReport,
    gateRunnerReceipt,
    reviewerReport,
    attestation,
    productionVerifiedAt,
  });

  const sourceBefore = await computeDockerBuildContext(projectRoot);
  if (sourceBefore.sha256 !== deployment.document.buildSourceSha256) {
    throw new ReleaseEvidencePublisherError(
      `current source hash ${sourceBefore.sha256} does not match deployed source ${String(deployment.document.buildSourceSha256)}`,
    );
  }
  const stagingRoot = await mkdtemp(resolve(tmpdir(), "prostar-release-publish-"));
  try {
    await materializeSourceContext(projectRoot, stagingRoot, sourceBefore.entries);
    await copyLoadedArtifacts(stagingRoot, artifacts);
    for (const feature of candidate.features) {
      if (feature.executionStatus !== "VERIFIED DONE") continue;
      const stagedPath = resolve(stagingRoot, feature.evidenceArtifactPath);
      await mkdir(dirname(stagedPath), { recursive: true });
      await writeFile(stagedPath, candidate.evidenceBytes.get(feature.id));
    }
    const stagedLedgerPath = resolve(stagingRoot, normalizedLedgerPath);
    await mkdir(dirname(stagedLedgerPath), { recursive: true });
    await writeFile(stagedLedgerPath, candidate.ledgerBytes);
    const stagedSource = await computeDockerBuildContext(stagingRoot);
    const sourceAfter = await computeDockerBuildContext(projectRoot);
    if (stagedSource.sha256 !== sourceBefore.sha256 || sourceAfter.sha256 !== sourceBefore.sha256) {
      throw new ReleaseEvidencePublisherError("source changed while staging release evidence");
    }
    await validateReleaseEvidence({
      root: stagingRoot,
      document: candidate.ledger,
      liveVerifier,
      receiptVerifiers,
      now,
      skipPlanSynchronizationCheck: true,
    });
    await promoteCandidate({
      projectRoot,
      ledgerPath: normalizedLedgerPath,
      candidate,
      beforePromote,
    });
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }

  return {
    verified: mandatoryIds.length,
    removed: AUTHORITATIVE_FEATURE_IDS.length - mandatoryIds.length,
    ledgerPath: normalizedLedgerPath,
    productionVerifiedAt,
  };
}

function buildCandidateLedger({
  ledger, mandatoryIds, normalized, deployment, e2e, a11y, browserAttestation,
  gateReport, gateRunnerReceipt, reviewerReport, attestation, productionVerifiedAt,
}) {
  if (!Array.isArray(ledger.features)) throw new ReleaseEvidencePublisherError("feature ledger features must be an array");
  if (JSON.stringify(ledger.features.map((feature) => feature?.id)) !== JSON.stringify(AUTHORITATIVE_FEATURE_IDS)) {
    throw new ReleaseEvidencePublisherError("feature ledger must contain the exact authoritative feature order");
  }
  const mandatory = new Set(mandatoryIds);
  const reviewResult = reviewerReportDecision(reviewerReport.document);
  const emittedByCategory = Object.fromEntries(GATE_CATEGORIES.map((category) => {
    const run = gateReport.document.runs.find((candidate) => candidate.category === category);
    if (!run || !Array.isArray(run.results) || run.results.length === 0) {
      throw new ReleaseEvidencePublisherError(`${category}: trusted gate report contains no emitted assertions`);
    }
    return [category, structuredClone(run.results)];
  }));
  const emittedResults = GATE_CATEGORIES.flatMap((category) => emittedByCategory[category]);
  const releaseDirectory = `docs/prostar-metrics/verification/releases/${deployment.document.deployedRevision}`;
  const shared = {
    deploymentManifestPath: normalized.deploymentManifestPath,
    deploymentManifestSha256: deployment.sha256,
    e2eReportPath: normalized.e2eReportPath,
    e2eReportSha256: e2e.sha256,
    a11yReportPath: normalized.a11yReportPath,
    a11yReportSha256: a11y.sha256,
    authMeResponsePath: e2e.document.authMeResponsePath,
    authMeResponseSha256: e2e.document.authMeResponseSha256,
    browserAttestationPath: normalized.browserAttestationPath,
    browserAttestationSha256: browserAttestation.sha256,
    gateReportPath: normalized.gateReportPath,
    gateReportSha256: gateReport.sha256,
    gateRunnerReceiptPath: normalized.gateRunnerReceiptPath,
    gateRunnerReceiptSha256: gateRunnerReceipt.sha256,
    reviewerReportPath: normalized.reviewerReportPath,
    reviewerReportSha256: reviewerReport.sha256,
    reviewerAttestationPath: normalized.reviewerAttestationPath,
    reviewerAttestationSha256: attestation.sha256,
  };
  const evidenceBytes = new Map();
  const features = ledger.features.map((existing) => {
    if (!mandatory.has(existing.id)) {
      if (existing.executionStatus !== removedStatus || existing.baselineStatus !== removedStatus) {
        throw new ReleaseEvidencePublisherError(`${existing.id}: only authoritative owner removals may remain removed`);
      }
      return structuredClone(existing);
    }
    const acceptingGate = expectedAcceptingGate(existing.id);
    const evidence = {
      schemaVersion: FEATURE_EVIDENCE_SCHEMA_VERSION,
      featureId: existing.id,
      planRevision: PLAN_REVISION,
      planSha256: PLAN_SHA256,
      ...shared,
      buildSourceSha256: deployment.document.buildSourceSha256,
      deployedRevision: deployment.document.deployedRevision,
      imageDigest: deployment.document.imageDigest,
      testResults: structuredClone(emittedResults),
      gateResults: [],
      productionVerifiedAt,
      reviewer: UNAUTHENTICATED_EXTERNAL_REVIEWER,
      reviewResult,
    };
    const bytes = jsonBytes(evidence);
    const evidenceArtifactPath = `${releaseDirectory}/${acceptingGate}/${existing.id}/evidence.json`;
    evidenceBytes.set(existing.id, bytes);
    return {
      ...structuredClone(existing),
      executionStatus: "VERIFIED DONE",
      acceptingGate,
      testIds: Object.fromEntries(GATE_CATEGORIES.map((category) => [
        category,
        emittedByCategory[category].map(({ id }) => id),
      ])),
      evidenceArtifactPath,
      evidenceArtifactSha256: sha256(bytes),
      buildSourceSha256: deployment.document.buildSourceSha256,
      deployedRevision: deployment.document.deployedRevision,
      imageDigest: deployment.document.imageDigest,
      independentReviewer: UNAUTHENTICATED_EXTERNAL_REVIEWER,
      reviewResult,
    };
  });
  const candidateLedger = {
    ...structuredClone(ledger),
    schemaVersion: 4,
    planRevision: PLAN_REVISION,
    planSha256: PLAN_SHA256,
    ...shared,
    features,
  };
  return { ledger: candidateLedger, ledgerBytes: jsonBytes(candidateLedger), evidenceBytes, features };
}

async function validateBrowserReceipt({
  deployment, e2e, a11y, browserAttestation, browserArtifactHashes, nowMs, receiptVerifier,
}) {
  const expectedSubject = browserArtifactValidationSubject({
    deployment: deployment.document,
    e2e: e2e.document,
    e2eSha256: e2e.sha256,
    a11y: a11y.document,
    a11ySha256: a11y.sha256,
    artifactHashes: browserArtifactHashes,
    handoffBinding: validateHandoffReceiptBinding(browserAttestation.document?.subject?.handoff, { nowMs }),
  });
  const completedAt = Math.max(Date.parse(e2e.document.completedAt), Date.parse(a11y.document.completedAt));
  try {
    const issuedAt = validateServiceReceiptShape(browserAttestation.document, {
      kind: "browser", expectedSubject,
      expectedKeyId: deployment.document.evidenceSigningKeyIds?.browser,
    });
    if (issuedAt <= completedAt) throw new Error("browser artifact validation receipt must be issued after artifact production completed");
    validateEvidenceAge(browserAttestation.document.issuedAt, {
      label: "browser artifact validation receipt issuedAt", nowMs, maxAgeMs: MAX_BROWSER_EVIDENCE_AGE_MS, after: completedAt,
    });
    validateReceiptFreshness(browserAttestation.document, { kind: "browser", nowMs });
    await (receiptVerifier ?? verifyServiceReceipt)({
      kind: "browser", receipt: browserAttestation.document, expectedSubject,
      expectedKeyId: deployment.document.evidenceSigningKeyIds?.browser,
    });
  } catch (error) {
    throw new ReleaseEvidencePublisherError(error instanceof Error ? error.message : String(error));
  }
}

async function validateExternalReviewReportReceipt({
  receipt, report, mandatoryIds, deployment, e2e, a11y, browserAttestation,
  gateReport, gateRunnerReceipt, nowMs, receiptVerifier,
}) {
  if (
    !agentPattern.test(report.document?.declaredReviewerTaskId ?? "")
    || !agentPattern.test(report.document?.declaredReviewerThreadId ?? "")
  ) {
    throw new ReleaseEvidencePublisherError("external review report must declare concrete separate-agent task identifiers");
  }
  if (report.document.authorship !== "NOT_AUTHENTICATED" || report.document.reviewProcess !== "SEPARATE_AGENT_REQUIRED") {
    throw new ReleaseEvidencePublisherError("external review report must explicitly state that authorship is not authenticated");
  }
  if (JSON.stringify(report.document.scopeFeatureIds) !== JSON.stringify(mandatoryIds)) {
    throw new ReleaseEvidencePublisherError("reviewer report scope is incomplete");
  }
  const reviewResult = reviewerReportDecision(report.document);
  const reviewValidation = {
    declaredReviewerTaskId: report.document.declaredReviewerTaskId,
    declaredReviewerThreadId: report.document.declaredReviewerThreadId,
    scopeFeatureIds: report.document.scopeFeatureIds,
    decision: reviewResult,
  };
  const expectedSubject = externalReviewValidationSubject({
    reviewValidation,
    handoffBinding: validateHandoffReceiptBinding(receipt.document?.subject?.handoff, { nowMs }),
    reviewerReportSha256: report.sha256,
    deploymentManifestSha256: deployment.sha256,
    e2eReportSha256: e2e.sha256,
    a11yReportSha256: a11y.sha256,
    browserAttestationSha256: browserAttestation.sha256,
    gateReportSha256: gateReport.sha256,
    gateRunnerReceiptSha256: gateRunnerReceipt.sha256,
  });
  try {
    const reviewedAfter = Math.max(
      Date.parse(e2e.document.completedAt), Date.parse(a11y.document.completedAt), Date.parse(gateReport.document.completedAt),
    );
    validateEvidenceAge(report.document.timestamp, {
      label: "externally supplied review report timestamp", nowMs,
      maxAgeMs: MAX_REVIEWER_EVIDENCE_AGE_MS, after: reviewedAfter,
    });
    const issuedAt = validateServiceReceiptShape(receipt.document, {
      kind: "reviewer", expectedSubject,
      expectedKeyId: deployment.document.evidenceSigningKeyIds?.reviewer,
    });
    if (issuedAt <= Date.parse(report.document.timestamp)) throw new Error("external review validation receipt must be issued after the report");
    validateEvidenceAge(receipt.document.issuedAt, {
      label: "external review validation receipt issuedAt", nowMs,
      maxAgeMs: MAX_REVIEWER_EVIDENCE_AGE_MS, after: Date.parse(report.document.timestamp),
    });
    validateReceiptFreshness(receipt.document, { kind: "reviewer", nowMs });
    await (receiptVerifier ?? verifyServiceReceipt)({
      kind: "reviewer", receipt: receipt.document, expectedSubject,
      expectedKeyId: deployment.document.evidenceSigningKeyIds?.reviewer,
    });
  } catch (error) {
    throw new ReleaseEvidencePublisherError(error instanceof Error ? error.message : String(error));
  }
}

function reviewerReportDecision(report) {
  if (/^SHIP:\s+\S/.test(report?.finalDecisionText ?? "")) return "SHIP";
  throw new ReleaseEvidencePublisherError("externally supplied review report must begin with an explicit SHIP decision");
}

function validateSharedBindings({ normalized, deployment, e2e, a11y }) {
  equal(e2e.document.deployedRevision, deployment.document.deployedRevision, "E2E report deployedRevision");
  equal(e2e.document.imageDigest, deployment.document.imageDigest, "E2E report imageDigest");
  equal(a11y.document.deployedRevision, deployment.document.deployedRevision, "accessibility report deployedRevision");
  equal(a11y.document.imageDigest, deployment.document.imageDigest, "accessibility report imageDigest");
  for (const field of ["deploymentNonce", "sessionId", "authenticatedActor", "authMeResponsePath", "authMeResponseSha256"]) {
    equal(a11y.document[field], e2e.document[field], `capture-session ${field}`);
  }
  equal(e2e.document.deploymentNonce, deployment.document.deploymentNonce, "E2E report deploymentNonce");
  equal(e2e.document.browserAttestationPath, normalized.browserAttestationPath, "E2E browserAttestationPath");
  equal(a11y.document.browserAttestationPath, normalized.browserAttestationPath, "accessibility browserAttestationPath");
}

async function loadReportArtifacts({ e2e, a11y, load }) {
  if (!Array.isArray(e2e.captures) || !Array.isArray(a11y.checks)) throw new ReleaseEvidencePublisherError("browser/accessibility reports lack evidence arrays");
  const hashes = [];
  await load(e2e.authMeResponsePath, "raw /.auth/me response", e2e.authMeResponseSha256, true);
  hashes.push(e2e.authMeResponseSha256);
  for (const [index, capture] of e2e.captures.entries()) {
    await load(capture.screenshotPath, `E2E capture ${index + 1} screenshot`, capture.screenshotSha256, false);
    await load(capture.tracePath, `E2E capture ${index + 1} trace`, capture.traceSha256, true);
    hashes.push(capture.screenshotSha256, capture.traceSha256);
  }
  for (const [index, check] of a11y.checks.entries()) {
    await load(check.evidencePath, `accessibility check ${index + 1} evidence`, check.evidenceSha256, true);
    hashes.push(check.evidenceSha256);
  }
  if (new Set(hashes).size !== hashes.length) throw new ReleaseEvidencePublisherError("browser raw artifacts must be unique within one capture session");
  return hashes;
}

function rejectReusedEvidenceArtifacts({
  deployment, e2e, a11y, browserAttestation, gateReport, gateRunnerReceipt,
  attestation, reviewerReport, artifacts,
}) {
  const shared = [
    deployment, e2e, a11y, browserAttestation, gateReport, gateRunnerReceipt,
    attestation, reviewerReport,
  ];
  if (new Set(shared.map((artifact) => artifact.sha256)).size !== shared.length) throw new ReleaseEvidencePublisherError("shared release artifacts must not reuse identical bytes");
  const referenced = [
    e2e.document.authMeResponsePath,
    ...e2e.document.captures.flatMap((capture) => [capture.screenshotPath, capture.tracePath]),
    ...a11y.document.checks.map((check) => check.evidencePath),
  ].map((path) => artifacts.get(path));
  if (referenced.some((artifact) => !artifact)) throw new ReleaseEvidencePublisherError("a report references an unloaded artifact");
  if (new Set(referenced.map((artifact) => artifact.sha256)).size !== referenced.length) {
    throw new ReleaseEvidencePublisherError("browser/accessibility evidence artifacts must be unique and cannot be reused");
  }
}

async function promoteCandidate({ projectRoot, ledgerPath, candidate, beforePromote }) {
  const targets = candidate.features
    .filter((feature) => feature.executionStatus === "VERIFIED DONE")
    .map((feature) => ({ path: feature.evidenceArtifactPath, bytes: candidate.evidenceBytes.get(feature.id) }));
  for (const target of targets) await assertTargetCompatible(projectRoot, target);
  const ledgerTarget = resolve(projectRoot, ledgerPath);
  const currentLedger = await readFile(ledgerTarget);
  const created = [];
  try {
    for (const [index, target] of targets.entries()) {
      if (await targetMatches(projectRoot, target)) continue;
      await beforePromote?.({ index, path: target.path, kind: "feature" });
      await atomicWriteNew(resolve(projectRoot, target.path), target.bytes);
      created.push(resolve(projectRoot, target.path));
    }
    if (!currentLedger.equals(candidate.ledgerBytes)) {
      await beforePromote?.({ index: targets.length, path: ledgerPath, kind: "ledger" });
      await atomicReplace(ledgerTarget, candidate.ledgerBytes);
    }
  } catch (error) {
    for (const path of created.reverse()) await rm(path, { force: true });
    throw error;
  }
}

async function assertTargetCompatible(projectRoot, target) {
  try {
    const existing = await readFile(resolve(projectRoot, target.path));
    if (!existing.equals(target.bytes)) throw new ReleaseEvidencePublisherError(`refusing to overwrite stale release evidence: ${target.path}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function targetMatches(projectRoot, target) {
  try {
    return (await readFile(resolve(projectRoot, target.path))).equals(target.bytes);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function atomicWriteNew(target, bytes) {
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.publish-${randomUUID()}`;
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function atomicReplace(target, bytes) {
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.publish-${randomUUID()}`;
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function materializeSourceContext(projectRoot, stagingRoot, entries) {
  const directories = [];
  for (const entry of entries) {
    const source = resolve(projectRoot, entry.path);
    const target = resolve(stagingRoot, entry.path);
    if (entry.type === "D") {
      await mkdir(target, { recursive: true });
      directories.push({ target, mode: entry.mode });
    } else if (entry.type === "L") {
      await mkdir(dirname(target), { recursive: true });
      await symlink(await readlink(source), target);
    } else {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
      await chmod(target, entry.mode);
    }
  }
  directories.sort((left, right) => right.target.length - left.target.length);
  for (const directory of directories) await chmod(directory.target, directory.mode);
}

async function copyLoadedArtifacts(stagingRoot, artifacts) {
  for (const artifact of artifacts.values()) {
    const target = resolve(stagingRoot, artifact.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, artifact.bytes);
  }
}

async function loadArtifact({
  projectRoot, artifactPath, label, expectedSha256, requireJson, allowEmpty, artifacts,
}) {
  const path = await requireVerificationFile(projectRoot, artifactPath, label);
  if (artifacts.has(path)) {
    const loaded = artifacts.get(path);
    if (expectedSha256 && loaded.sha256 !== expectedSha256) throw new ReleaseEvidencePublisherError(`${label} hash mismatch`);
    return loaded;
  }
  const absolute = resolve(projectRoot, path);
  const before = await lstat(absolute);
  if (!before.isFile()) throw new ReleaseEvidencePublisherError(`${label} must be a regular file`);
  const bytes = await readFile(absolute);
  const after = await lstat(absolute);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.mode !== after.mode) throw new ReleaseEvidencePublisherError(`${label} changed while reading`);
  if (!allowEmpty && bytes.length === 0) throw new ReleaseEvidencePublisherError(`${label} is empty`);
  const digest = sha256(bytes);
  if (expectedSha256 && digest !== expectedSha256) throw new ReleaseEvidencePublisherError(`${label} hash mismatch: expected ${expectedSha256}, received ${digest}`);
  let document = null;
  if (requireJson) {
    if (!path.endsWith(".json")) throw new ReleaseEvidencePublisherError(`${label} must be JSON`);
    try { document = JSON.parse(bytes.toString("utf8")); } catch { throw new ReleaseEvidencePublisherError(`${label} is not valid JSON`); }
  }
  const loaded = { path, bytes, sha256: digest, document };
  artifacts.set(path, loaded);
  return loaded;
}

async function requireVerificationFile(projectRoot, value, label) {
  const path = normalizeProjectPath(projectRoot, value, label);
  const allowed = resolve(projectRoot, verificationRoot);
  const absolute = resolve(projectRoot, path);
  if (!isWithin(allowed, absolute)) throw new ReleaseEvidencePublisherError(`${label} must be under ${verificationRoot}`);
  let canonical;
  try { canonical = await realpath(absolute); } catch (error) {
    if (error?.code === "ENOENT") throw new ReleaseEvidencePublisherError(`${label} does not exist: ${path}`);
    throw error;
  }
  if (!isWithin(allowed, canonical) || !(await stat(canonical)).isFile()) throw new ReleaseEvidencePublisherError(`${label} must resolve to a regular verification file`);
  return path;
}

function normalizeProjectPath(projectRoot, value, label) {
  if (typeof value !== "string" || !value.trim() || placeholderPattern.test(value.trim())) throw new ReleaseEvidencePublisherError(`${label} path must be concrete`);
  const absolute = isAbsolute(value) ? resolve(value) : resolve(projectRoot, value);
  const path = relative(projectRoot, absolute).split(sep).join("/");
  if (!path || path === ".." || path.startsWith("../")) throw new ReleaseEvidencePublisherError(`${label} path must be inside the project`);
  return path;
}

function equal(actual, expected, label) {
  if (actual !== expected) throw new ReleaseEvidencePublisherError(`${label} mismatch: expected ${String(expected)}, received ${String(actual)}`);
}

function normalizeNow(now) {
  const value = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(value)) throw new ReleaseEvidencePublisherError("now must be a valid timestamp");
  return value;
}

function isWithin(parent, candidate) {
  const path = relative(parent, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseArguments(argv) {
  const names = new Map([
    ["--deployment-manifest", "deploymentManifestPath"],
    ["--e2e-report", "e2eReportPath"],
    ["--a11y-report", "a11yReportPath"],
    ["--reviewer-attestation", "reviewerAttestationPath"],
    ["--reviewer-report", "reviewerReportPath"],
    ["--gate-report", "gateReportPath"],
    ["--ledger", "ledgerPath"],
    ["--root", "root"],
  ]);
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const field = names.get(argv[index]);
    if (!field || index + 1 >= argv.length) throw new ReleaseEvidencePublisherError(`unknown or incomplete argument: ${String(argv[index])}`);
    if (Object.hasOwn(parsed, field)) throw new ReleaseEvidencePublisherError(`duplicate argument: ${argv[index]}`);
    parsed[field] = argv[index + 1];
  }
  for (const field of [
    "deploymentManifestPath", "e2eReportPath", "a11yReportPath",
    "reviewerAttestationPath", "reviewerReportPath", "gateReportPath",
  ]) if (!parsed[field]) throw new ReleaseEvidencePublisherError(`missing required argument for ${field}`);
  return parsed;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  publishReleaseEvidence(parseArguments(process.argv.slice(2))).then((result) => {
    console.log(`Published ${result.verified} verified feature artifacts; preserved ${result.removed} owner removals.`);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
