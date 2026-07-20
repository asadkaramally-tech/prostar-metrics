import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  AUTHORITATIVE_FEATURE_IDS,
  parseAuthoritativePlan,
} from "./lib/feature-status-sync.mjs";
import {
  browserArtifactValidationSubject,
  browserArtifactReferences,
  issueAzureKeyVaultReceipt,
  jsonBytes,
  externalReviewValidationSubject,
  validateBrowserArtifactValidationResult,
} from "./lib/release-evidence-trust.mjs";

export async function signReleaseReceipt(options) {
  const root = resolve(options.root ?? process.cwd());
  const deployment = await readJson(root, options.deploymentManifestPath, "deployment manifest");
  let expectedSubject;
  if (options.kind === "browser") {
    expectedSubject = await buildBrowserSubject(root, deployment, options);
  } else if (options.kind === "reviewer") {
    expectedSubject = await buildReviewerSubject(root, deployment, options);
  } else {
    throw new Error("receipt kind must be browser or reviewer; gate receipts are issued only by the immutable gate runner");
  }
  const keyId = deployment.evidenceSigningKeyIds?.[options.kind];
  const receiptIssuer = options.receiptIssuer ?? issueAzureKeyVaultReceipt;
  const receipt = await receiptIssuer({
    kind: options.kind,
    expectedSubject,
    keyId,
    ...(options.receiptDependencies ?? {}),
  });
  await writeJsonAtomic(root, options.outputPath, receipt);
  return { outputPath: options.outputPath, receiptId: receipt.receiptId, keyId };
}

async function buildBrowserSubject(root, deployment, options) {
  const [e2e, a11y, producerResult] = await Promise.all([
    readJson(root, options.e2eReportPath, "E2E report"),
    readJson(root, options.a11yReportPath, "accessibility report"),
    readJson(root, options.producerResultPath, "browser artifact validation result"),
  ]);
  validateBrowserReportsForSigning({ deployment, e2e, a11y });
  const artifactReferences = browserArtifactReferences(e2e, a11y);
  await verifyArtifactReferences(root, artifactReferences);
  const [e2eSha256, a11ySha256] = await Promise.all([
    fileSha256(root, options.e2eReportPath),
    fileSha256(root, options.a11yReportPath),
  ]);
  validateBrowserArtifactValidationResult(producerResult, {
    deployment,
    e2e,
    a11y,
    e2eReportPath: options.e2eReportPath,
    e2eReportSha256: e2eSha256,
    a11yReportPath: options.a11yReportPath,
    a11yReportSha256: a11ySha256,
    artifactReferences,
  });
  return browserArtifactValidationSubject({
    deployment,
    e2e,
    e2eSha256,
    a11y,
    a11ySha256,
    artifactHashes: artifactReferences.map((reference) => reference.sha256),
    handoffBinding: options.handoffBinding,
  });
}

async function buildReviewerSubject(root, deployment, options) {
  const plan = await readFile(resolve(root, "docs/prostar-metrics/execution-plan.md"), "utf8");
  const removed = new Set(parseAuthoritativePlan(plan)
    .filter((row) => row.baselineStatus === "REMOVED BY OWNER DECISION")
    .map((row) => row.id));
  const report = await readJson(root, options.reviewerReportPath, "externally supplied review report");
  const mandatoryIds = AUTHORITATIVE_FEATURE_IDS.filter((id) => !removed.has(id));
  validateExternalReviewReport(report, mandatoryIds);
  const reviewValidation = {
    declaredReviewerTaskId: report.declaredReviewerTaskId,
    declaredReviewerThreadId: report.declaredReviewerThreadId,
    scopeFeatureIds: report.scopeFeatureIds,
    decision: reviewDecision(report.finalDecisionText),
  };
  const hashes = await Promise.all([
    options.reviewerReportPath,
    options.deploymentManifestPath,
    options.e2eReportPath,
    options.a11yReportPath,
    options.browserAttestationPath,
    options.gateReportPath,
    options.gateRunnerReceiptPath,
  ].map((path) => fileSha256(root, path)));
  const expectedArtifactHashes = {
    deploymentManifest: hashes[1],
    e2eReport: hashes[2],
    a11yReport: hashes[3],
    browserAttestation: hashes[4],
    gateReport: hashes[5],
    gateRunnerReceipt: hashes[6],
  };
  if (JSON.stringify(report.artifactHashes) !== JSON.stringify(expectedArtifactHashes)) {
    throw new Error("externally supplied review report artifact hashes do not match the reviewed release evidence");
  }
  return externalReviewValidationSubject({
    reviewValidation,
    handoffBinding: options.handoffBinding,
    reviewerReportSha256: hashes[0],
    deploymentManifestSha256: hashes[1],
    e2eReportSha256: hashes[2],
    a11yReportSha256: hashes[3],
    browserAttestationSha256: hashes[4],
    gateReportSha256: hashes[5],
    gateRunnerReceiptSha256: hashes[6],
  });
}

function validateBrowserReportsForSigning({ deployment, e2e, a11y }) {
  const reportFields = [
    "productionUrl", "authenticatedActor", "deployedRevision", "imageDigest", "deploymentNonce",
    "sessionId", "browserAttestationPath", "authMeResponsePath", "authMeResponseSha256",
  ];
  for (const field of reportFields) {
    if (e2e?.[field] !== a11y?.[field]) throw new Error(`browser reports disagree on ${field}`);
  }
  for (const field of ["deployedRevision", "imageDigest", "deploymentNonce"]) {
    if (e2e?.[field] !== deployment?.[field]) throw new Error(`browser reports do not match deployment ${field}`);
  }
  if (!Array.isArray(e2e?.captures) || e2e.captures.length !== 16) {
    throw new Error("browser artifact validator requires exactly 16 supplied E2E captures");
  }
  if (!Array.isArray(a11y?.checks) || a11y.checks.length !== 8) {
    throw new Error("browser artifact validator requires exactly 8 supplied accessibility checks");
  }
  const expectedRoutes = ["/quotes", "/jobs", "/technicians", "/commissions"];
  const expectedPeriods = ["current", "2026-06"];
  const expectedViewports = ["desktop", "mobile"];
  const e2eCoverage = e2e.captures.map(({ route, period, viewport }) => `${route}|${period}|${viewport?.name}`).sort();
  const expectedE2e = expectedRoutes.flatMap((route) => expectedPeriods.flatMap((period) => (
    expectedViewports.map((viewport) => `${route}|${period}|${viewport}`)
  ))).sort();
  if (JSON.stringify(e2eCoverage) !== JSON.stringify(expectedE2e)) {
    throw new Error("browser artifact validation E2E coverage is incomplete or duplicated");
  }
  const a11yCoverage = a11y.checks.map(({ route, viewport }) => `${route}|${viewport?.name}`).sort();
  const expectedA11y = expectedRoutes.flatMap((route) => expectedViewports.map((viewport) => `${route}|${viewport}`)).sort();
  if (JSON.stringify(a11yCoverage) !== JSON.stringify(expectedA11y)) {
    throw new Error("browser artifact validation accessibility coverage is incomplete or duplicated");
  }
}

function validateExternalReviewReport(report, mandatoryIds) {
  exactKeys(report, [
    "schemaVersion", "declaredReviewerTaskId", "declaredReviewerThreadId", "authorship",
    "reviewProcess", "scopeFeatureIds", "findings",
    "finalDecisionText", "timestamp", "artifactHashes",
  ], "externally supplied review report");
  if (report.schemaVersion !== 1) throw new Error("externally supplied review report schemaVersion must be 1");
  if (
    !/^019[a-f0-9-]+$/.test(report.declaredReviewerTaskId ?? "")
    || !/^019[a-f0-9-]+$/.test(report.declaredReviewerThreadId ?? "")
  ) {
    throw new Error("externally supplied review report must declare concrete separate-agent task identifiers");
  }
  if (report.authorship !== "NOT_AUTHENTICATED" || report.reviewProcess !== "SEPARATE_AGENT_REQUIRED") {
    throw new Error("external review report must explicitly declare unauthenticated authorship and the separate-agent process gate");
  }
  if (JSON.stringify(report.scopeFeatureIds) !== JSON.stringify(mandatoryIds)) {
    throw new Error("externally supplied review report scope is incomplete");
  }
  if (!Array.isArray(report.findings) || report.findings.length === 0) {
    throw new Error("externally supplied review report must contain findings");
  }
  for (const [index, finding] of report.findings.entries()) {
    exactKeys(finding, ["id", "severity", "disposition", "summary", "featureIds", "artifactHashes"], `reviewer finding ${index + 1}`);
    if (!["RESOLVED", "ACCEPTED"].includes(finding.disposition)) {
      throw new Error(`reviewer finding ${index + 1} is not resolved or accepted`);
    }
  }
  exactKeys(report.artifactHashes, [
    "deploymentManifest", "e2eReport", "a11yReport", "browserAttestation",
    "gateReport", "gateRunnerReceipt",
  ], "externally supplied review report artifactHashes");
  reviewDecision(report.finalDecisionText);
}

function reviewDecision(value) {
  if (typeof value !== "string") throw new Error("externally supplied review report decision is missing");
  if (/^SHIP:\s+\S/.test(value)) return "SHIP";
  if (/^DO NOT SHIP:\s+\S/.test(value)) {
    throw new Error("externally supplied review report decision is DO NOT SHIP; no validation receipt may be issued");
  }
  throw new Error("externally supplied review report decision must start with SHIP: or DO NOT SHIP:");
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`${label} has unexpected fields`);
}

async function verifyArtifactReferences(root, references) {
  const paths = new Set();
  const hashes = new Set();
  for (const reference of references) {
    if (!reference?.path || !/^[a-f0-9]{64}$/.test(reference.sha256 ?? "")) {
      throw new Error("browser report contains an invalid raw artifact reference");
    }
    if (paths.has(reference.path) || hashes.has(reference.sha256)) {
      throw new Error("browser raw artifact paths and hashes must be unique");
    }
    paths.add(reference.path);
    hashes.add(reference.sha256);
    const actual = await fileSha256(root, reference.path);
    if (actual !== reference.sha256) throw new Error(`browser raw artifact hash mismatch: ${reference.path}`);
  }
}

async function readJson(root, path, label) {
  if (!path) throw new Error(`${label} path is required`);
  try {
    return JSON.parse(await readFile(resolve(root, path), "utf8"));
  } catch (error) {
    throw new Error(`${label} is unavailable or invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function fileSha256(root, path) {
  return createHash("sha256").update(await readFile(resolve(root, path))).digest("hex");
}

async function writeJsonAtomic(root, path, value) {
  if (!path) throw new Error("receipt output path is required");
  const target = resolve(root, path);
  const temporary = `${target}.partial-${process.pid}-${Date.now()}`;
  await mkdir(dirname(target), { recursive: true });
  try {
    await writeFile(temporary, jsonBytes(value), { flag: "wx", mode: 0o400 });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

function parseArguments(argv) {
  const names = new Map([
    ["--kind", "kind"], ["--root", "root"], ["--deployment-manifest", "deploymentManifestPath"],
    ["--e2e-report", "e2eReportPath"], ["--a11y-report", "a11yReportPath"],
    ["--producer-result", "producerResultPath"],
    ["--browser-attestation", "browserAttestationPath"], ["--gate-report", "gateReportPath"],
    ["--gate-runner-receipt", "gateRunnerReceiptPath"], ["--reviewer-report", "reviewerReportPath"],
    ["--output", "outputPath"],
  ]);
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const field = names.get(argv[index]);
    if (!field || index + 1 >= argv.length) throw new Error(`unknown or incomplete argument: ${String(argv[index])}`);
    parsed[field] = argv[index + 1];
  }
  for (const field of ["kind", "deploymentManifestPath", "e2eReportPath", "a11yReportPath", "outputPath"]) {
    if (!parsed[field]) throw new Error(`missing required argument for ${field}`);
  }
  if (parsed.kind === "reviewer") {
    for (const field of [
      "browserAttestationPath", "gateReportPath", "gateRunnerReceiptPath",
      "reviewerReportPath",
    ]) if (!parsed[field]) throw new Error(`missing required reviewer argument for ${field}`);
  } else if (parsed.kind === "browser" && !parsed.producerResultPath) {
    throw new Error("missing required browser argument for producerResultPath");
  }
  return parsed;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  signReleaseReceipt(parseArguments(process.argv.slice(2))).then((result) => {
    console.log(JSON.stringify(result, null, 2));
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
