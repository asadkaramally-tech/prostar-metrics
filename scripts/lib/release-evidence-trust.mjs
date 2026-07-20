import {
  constants as cryptoConstants,
  createHash,
  createPublicKey,
  randomUUID,
  verify as verifySignature,
} from "node:crypto";
import { spawn } from "node:child_process";
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
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";

import { computeDockerBuildContext } from "./deployment-provenance.mjs";

export const GATE_RUNNER_SCHEMA_VERSION = 3;
export const SERVICE_RECEIPT_SCHEMA_VERSION = 1;
export const GATE_RUNNER_NAME = "prostar-immutable-gate-runner";
export const GATE_RUNNER_VERSION = "3.0.0";
export const STRUCTURED_GATE_RESULT_SCHEMA_VERSION = 3;
export const BROWSER_ARTIFACT_VALIDATION_SCHEMA_VERSION = 1;
export const BROWSER_ARTIFACT_VALIDATOR_NAME = "prostar-browser-artifact-validator";
export const BROWSER_ARTIFACT_VALIDATOR_VERSION = "1.0.0";
export const MAX_DEPLOYMENT_AGE_MS = 24 * 60 * 60 * 1000;
export const MAX_BROWSER_EVIDENCE_AGE_MS = 2 * 60 * 60 * 1000;
export const MAX_REVIEWER_EVIDENCE_AGE_MS = 60 * 60 * 1000;
export const MAX_HANDOFF_AGE_MS = 3 * 60 * 60 * 1000;
export const UNAUTHENTICATED_EXTERNAL_REVIEWER = "EXTERNAL_REVIEW_AUTHORSHIP_NOT_AUTHENTICATED";

export const GATE_CATEGORIES = Object.freeze([
  "unit",
  "integration",
  "scripts",
  "infra",
  "build",
]);

export const EXPECTED_GATE_COMMANDS = Object.freeze({
  unit: Object.freeze(["node", "scripts/run-structured-gate-command.mjs", "--category", "unit"]),
  integration: Object.freeze(["node", "scripts/run-structured-gate-command.mjs", "--category", "integration"]),
  scripts: Object.freeze(["node", "scripts/run-structured-gate-command.mjs", "--category", "scripts"]),
  infra: Object.freeze(["node", "scripts/run-structured-gate-command.mjs", "--category", "infra"]),
  build: Object.freeze(["node", "scripts/run-structured-gate-command.mjs", "--category", "build"]),
});
export const PRODUCTION_GATE_COMMANDS = Object.freeze({
  unit: Object.freeze(["npm", "run", "test:unit"]),
  integration: Object.freeze(["npm", "run", "test:integration"]),
  scripts: Object.freeze(["npm", "run", "test:scripts"]),
  infra: Object.freeze(["npm", "run", "test:infra"]),
  build: Object.freeze(["npm", "run", "build"]),
});

const receiptTypeByKind = Object.freeze({
  gate: "gate-runner",
  browser: "validated-browser-artifacts",
  reviewer: "external-review-report-validation",
});
export const EVIDENCE_SIGNER_IDENTITIES = Object.freeze({
  gate: Object.freeze({ name: "id-prostar-release-gate-prod", keyName: "prostar-release-gate-evidence" }),
  browser: Object.freeze({ name: "id-prostar-release-browser-prod", keyName: "prostar-release-browser-evidence" }),
  reviewer: Object.freeze({ name: "id-prostar-release-reviewer-prod", keyName: "prostar-release-reviewer-evidence" }),
});
const sha256Pattern = /^[a-f0-9]{64}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const receiptIdPattern = /^akv:[a-f0-9]{64}$/;
const signaturePattern = /^[A-Za-z0-9+/=_-]{32,8192}$/;
const versionedKeyIdPattern = /^https:\/\/[a-z0-9-]+\.vault\.azure\.net\/keys\/[A-Za-z0-9-]+\/[a-f0-9]{32}$/;
const keyVaultCryptoUserRoleId = "12338af0-0e69-4776-bea7-57ae8d297424";
const noncePattern = /^[a-f0-9]{64}$/;

export class ReleaseEvidenceTrustError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseEvidenceTrustError";
  }
}

export function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function validateServiceReceiptShape(receipt, { kind, expectedSubject, expectedKeyId = null }) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new ReleaseEvidenceTrustError(`${kind} service receipt must be an object`);
  }
  exactKeys(receipt, [
    "schemaVersion", "receiptType", "receiptId", "issuer", "issuedAt", "expiresAt", "algorithm",
    "keyId", "publicKey", "publicKeyFingerprintSha256", "signature", "subject",
  ], `${kind} service receipt`);
  if (receipt.schemaVersion !== SERVICE_RECEIPT_SCHEMA_VERSION) {
    throw new ReleaseEvidenceTrustError(`${kind} service receipt schemaVersion must be ${SERVICE_RECEIPT_SCHEMA_VERSION}`);
  }
  equal(receipt.receiptType, receiptTypeByKind[kind], `${kind} service receipt receiptType`);
  if (!receiptIdPattern.test(receipt.receiptId ?? "")) {
    throw new ReleaseEvidenceTrustError(`${kind} service receipt receiptId is not service-issued`);
  }
  equal(receipt.issuer, "azure-key-vault", `${kind} service receipt issuer`);
  const issuedAt = parseTimestamp(receipt.issuedAt, `${kind} service receipt issuedAt`);
  const expiresAt = parseTimestamp(receipt.expiresAt, `${kind} service receipt expiresAt`);
  const maxLifetime = kind === "reviewer" ? MAX_REVIEWER_EVIDENCE_AGE_MS : MAX_BROWSER_EVIDENCE_AGE_MS;
  if (expiresAt <= issuedAt || expiresAt - issuedAt > maxLifetime) {
    throw new ReleaseEvidenceTrustError(`${kind} service receipt expiry exceeds its bounded validity window`);
  }
  equal(receipt.algorithm, "RS256", `${kind} service receipt algorithm`);
  if (!versionedKeyIdPattern.test(receipt.keyId ?? "")) {
    throw new ReleaseEvidenceTrustError(`${kind} service receipt keyId must pin an Azure Key Vault key version`);
  }
  if (expectedKeyId !== null) equal(receipt.keyId, expectedKeyId, `${kind} service receipt keyId`);
  exactKeys(receipt.publicKey, ["kty", "n", "e"], `${kind} service receipt publicKey`);
  equal(receipt.publicKey.kty, "RSA", `${kind} service receipt publicKey kty`);
  if (!signaturePattern.test(receipt.publicKey.n ?? "") || !/^[A-Za-z0-9_-]{2,16}$/.test(receipt.publicKey.e ?? "")) {
    throw new ReleaseEvidenceTrustError(`${kind} service receipt publicKey is not a valid RSA JWK`);
  }
  equal(
    receipt.publicKeyFingerprintSha256,
    publicKeyFingerprint(receipt.keyId, receipt.publicKey),
    `${kind} service receipt public key fingerprint`,
  );
  if (!signaturePattern.test(receipt.signature ?? "")) {
    throw new ReleaseEvidenceTrustError(`${kind} service receipt signature is missing or malformed`);
  }
  if (JSON.stringify(receipt.subject) !== JSON.stringify(expectedSubject)) {
    throw new ReleaseEvidenceTrustError(`${kind} service receipt subject does not match the verified artifacts`);
  }
  validateHandoffReceiptBinding(receipt.subject?.handoff);
  return issuedAt;
}

export function validateReceiptFreshness(receipt, { kind, nowMs }) {
  const issuedAt = parseTimestamp(receipt?.issuedAt, `${kind} service receipt issuedAt`);
  const expiresAt = parseTimestamp(receipt?.expiresAt, `${kind} service receipt expiresAt`);
  if (!Number.isFinite(nowMs)) throw new ReleaseEvidenceTrustError(`${kind} receipt validation time is invalid`);
  if (issuedAt > nowMs) throw new ReleaseEvidenceTrustError(`${kind} service receipt must not be issued in the future`);
  if (expiresAt <= nowMs) throw new ReleaseEvidenceTrustError(`${kind} service receipt has expired`);
  return { issuedAt, expiresAt };
}

export function validateHandoffRequest(value, { nowMs }) {
  exactKeys(value, ["messageId", "nonce", "issuedAt", "expiresAt"], "evidence handoff request binding");
  if (!uuidPattern.test(value.messageId ?? "") || !noncePattern.test(value.nonce ?? "")) {
    throw new ReleaseEvidenceTrustError("evidence handoff message ID or cryptographic nonce is invalid");
  }
  const issuedAt = parseTimestamp(value.issuedAt, "evidence handoff issuedAt");
  const expiresAt = parseTimestamp(value.expiresAt, "evidence handoff expiresAt");
  if (issuedAt > nowMs || expiresAt <= nowMs || expiresAt <= issuedAt || expiresAt - issuedAt > MAX_HANDOFF_AGE_MS) {
    throw new ReleaseEvidenceTrustError("evidence handoff is future-dated, expired, or outside the bounded freshness window");
  }
  return value;
}

export function handoffReceiptBinding(handoff, inputSha256) {
  if (!sha256Pattern.test(inputSha256 ?? "")) throw new ReleaseEvidenceTrustError("evidence handoff input hash is invalid");
  return {
    messageId: handoff.messageId,
    nonceSha256: hashBytes(Buffer.from(handoff.nonce, "utf8")),
    issuedAt: handoff.issuedAt,
    expiresAt: handoff.expiresAt,
    inputSha256,
  };
}

export function validateHandoffReceiptBinding(value, { nowMs = null } = {}) {
  exactKeys(
    value,
    ["messageId", "nonceSha256", "issuedAt", "expiresAt", "inputSha256"],
    "evidence signed handoff binding",
  );
  if (
    !uuidPattern.test(value.messageId ?? "")
    || !sha256Pattern.test(value.nonceSha256 ?? "")
    || !sha256Pattern.test(value.inputSha256 ?? "")
  ) throw new ReleaseEvidenceTrustError("evidence signed handoff identifiers are invalid");
  const issuedAt = parseTimestamp(value.issuedAt, "evidence signed handoff issuedAt");
  const expiresAt = parseTimestamp(value.expiresAt, "evidence signed handoff expiresAt");
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_HANDOFF_AGE_MS) {
    throw new ReleaseEvidenceTrustError("evidence signed handoff validity window is invalid");
  }
  if (nowMs !== null && (issuedAt > nowMs || expiresAt <= nowMs)) {
    throw new ReleaseEvidenceTrustError("evidence signed handoff is future-dated or expired");
  }
  return value;
}

export async function verifyServiceReceipt({
  kind,
  receipt,
  expectedSubject,
  expectedKeyId,
  keyResolver = resolveAzureKeyVaultPublicKey,
}) {
  if (!expectedKeyId) throw new ReleaseEvidenceTrustError(`${kind} receipt has no deployment-manifest signing-key trust root`);
  validateServiceReceiptShape(receipt, { kind, expectedSubject, expectedKeyId });
  const anchoredKey = normalizeAzurePublicKey(await keyResolver({ keyId: expectedKeyId }));
  if (JSON.stringify(anchoredKey) !== JSON.stringify(receipt.publicKey)) {
    throw new ReleaseEvidenceTrustError(`${kind} receipt public key does not match the version-pinned Azure Key Vault key`);
  }
  const signature = Buffer.from(receipt.signature, "base64url");
  equal(receipt.receiptId, `akv:${hashBytes(signature)}`, `${kind} service receipt receiptId`);
  let verified = false;
  try {
    const publicKey = createPublicKey({ key: anchoredKey, format: "jwk" });
    verified = verifySignature("sha256", jsonBytes(expectedSubject), {
      key: publicKey,
      padding: cryptoConstants.RSA_PKCS1_PADDING,
    }, signature);
  } catch (error) {
    throw new ReleaseEvidenceTrustError(
      `${kind} receipt public-key verification failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!verified) throw new ReleaseEvidenceTrustError(`${kind} receipt signature is not valid for the verified subject`);
  return { valid: true, receiptId: receipt.receiptId, keyId: expectedKeyId };
}

export async function executeImmutableGateRun({
  root,
  deployment,
  deploymentManifestPath,
  deploymentManifestSha256,
  e2eReportPath,
  a11yReportPath,
  browserAttestationPath,
  handoffBinding,
  mandatoryIds,
  outputDirectory,
  receiptIssuer = issueGateReceipt,
  commandExecutor = executeCommand,
  now = () => new Date(),
  temporaryDirectory = tmpdir(),
  inheritedEnv = process.env,
}) {
  const projectRoot = await realpath(resolve(root));
  validateHandoffReceiptBinding(handoffBinding);
  validateDeploymentBinding(deployment, deploymentManifestPath, deploymentManifestSha256);
  const source = await computeDockerBuildContext(projectRoot);
  if (source.sha256 !== deployment.buildSourceSha256) {
    throw new ReleaseEvidenceTrustError(
      `gate source ${source.sha256} does not match deployed source ${String(deployment.buildSourceSha256)}`,
    );
  }
  const executionId = randomUUID();
  const finalDirectory = normalizeOutputDirectory(projectRoot, outputDirectory, deployment.deployedRevision, executionId);
  const stagingParent = await mkdtemp(resolve(temporaryDirectory, "prostar-gate-runner-"));
  const snapshotRoot = resolve(stagingParent, "snapshot");
  const artifactRoot = resolve(stagingParent, "artifacts");
  await mkdir(snapshotRoot, { recursive: true });
  await mkdir(artifactRoot, { recursive: true });
  const startedAt = now().toISOString();
  let receipt;
  let snapshotLock = [];
  try {
    await materializeSnapshot(projectRoot, snapshotRoot, source.entries);
    await mountIgnoredRuntime(projectRoot, snapshotRoot);
    const snapshotSource = await computeDockerBuildContext(snapshotRoot);
    if (snapshotSource.sha256 !== source.sha256) throw new ReleaseEvidenceTrustError("materialized gate snapshot hash mismatch");
    snapshotLock = await lockSourceEntries(snapshotRoot, source.entries);

    const runs = [];
    for (const category of GATE_CATEGORIES) {
      const argv = [...EXPECTED_GATE_COMMANDS[category]];
      const resultName = `${category}.results.json`;
      const resultOutputPath = resolve(artifactRoot, resultName);
      const commandStartedAt = now().toISOString();
      const result = await commandExecutor({
        argv,
        cwd: snapshotRoot,
        env: gateEnvironment({
          category,
          executionId,
          resultOutputPath,
          projectRoot: snapshotRoot,
          deploymentManifestPath,
          e2eReportPath,
          a11yReportPath,
          browserAttestationPath,
          inheritedEnv,
        }),
      });
      const commandCompletedAt = now().toISOString();
      const stdout = Buffer.from(result.stdout ?? Buffer.alloc(0));
      const stderr = Buffer.from(result.stderr ?? Buffer.alloc(0));
      const combinedSubstantive = `${stdout.toString("utf8")}\n${stderr.toString("utf8")}`.trim();
      if (result.exitCode !== 0 || result.signal !== null) {
        throw new ReleaseEvidenceTrustError(
          `${category} gate command failed (${String(result.exitCode ?? result.signal)})`,
        );
      }
      if (combinedSubstantive.length < 16) {
        throw new ReleaseEvidenceTrustError(`${category} gate command produced no substantive raw output`);
      }
      const structuredBytes = await readFile(resultOutputPath).catch(() => null);
      if (!structuredBytes) {
        throw new ReleaseEvidenceTrustError(
          `${category} gate command did not produce the required structured result artifact`,
        );
      }
      let structuredResult;
      try {
        structuredResult = JSON.parse(structuredBytes.toString("utf8"));
      } catch {
        throw new ReleaseEvidenceTrustError(`${category} gate command produced invalid structured result JSON`);
      }
      validateStructuredGateResult(structuredResult, {
        category,
        executionId,
        mandatoryIds,
        commandStartedAt,
        commandCompletedAt,
      });
      await chmod(resultOutputPath, 0o400);
      const stdoutName = `${category}.stdout.log`;
      const stderrName = `${category}.stderr.log`;
      await writeFile(resolve(artifactRoot, stdoutName), stdout, { flag: "wx", mode: 0o400 });
      await writeFile(resolve(artifactRoot, stderrName), stderr, { flag: "wx", mode: 0o400 });
      runs.push({
        category,
        argv,
        redactedArgv: argv,
        tool: { name: result.toolName ?? argv[0], version: result.toolVersion },
        startedAt: commandStartedAt,
        completedAt: commandCompletedAt,
        exitCode: result.exitCode,
        signal: result.signal,
        stdout: {
          path: `${finalDirectory}/${stdoutName}`,
          sha256: hashBytes(stdout),
          bytes: stdout.length,
        },
        stderr: {
          path: `${finalDirectory}/${stderrName}`,
          sha256: hashBytes(stderr),
          bytes: stderr.length,
        },
        resultArtifact: {
          path: `${finalDirectory}/${resultName}`,
          sha256: hashBytes(structuredBytes),
          bytes: structuredBytes.length,
        },
        results: structuredResult.results,
      });
    }
    await unlockSourceEntries(snapshotLock);
    snapshotLock = [];
    const snapshotAfter = await computeDockerBuildContext(snapshotRoot);
    if (snapshotAfter.sha256 !== source.sha256) {
      throw new ReleaseEvidenceTrustError("gate source snapshot changed while commands executed");
    }
    const sourceAfter = await computeDockerBuildContext(projectRoot);
    if (sourceAfter.sha256 !== source.sha256) {
      throw new ReleaseEvidenceTrustError("release source changed while immutable gates executed");
    }
    const completedAt = now().toISOString();
    const runnerReceiptPath = `${finalDirectory}/runner-receipt.json`;
    const report = {
      schemaVersion: GATE_RUNNER_SCHEMA_VERSION,
      runner: {
        name: GATE_RUNNER_NAME,
        version: GATE_RUNNER_VERSION,
        executionId,
        immutableMode: "read-only-source-entries+docker-context-rehash",
      },
      sourceSnapshot: {
        buildSourceSha256: source.sha256,
        entryCount: source.entries.length,
      },
      deploymentBinding: {
        manifestPath: deploymentManifestPath,
        manifestSha256: deploymentManifestSha256,
        deploymentOperationId: deployment.deploymentOperationId,
        deploymentRunId: deployment.deploymentRunId,
        deploymentNonce: deployment.deploymentNonce,
        deployedRevision: deployment.deployedRevision,
        imageDigest: deployment.imageDigest,
      },
      handoff: handoffBinding,
      startedAt,
      completedAt,
      runs,
      runnerReceiptPath,
    };
    const reportBytes = jsonBytes(report);
    const reportSha256 = hashBytes(reportBytes);
    const expectedSubject = gateReceiptSubject({ report, reportSha256 });
    const expectedKeyId = deployment.evidenceSigningKeyIds?.gate;
    receipt = await receiptIssuer({ kind: "gate", expectedSubject, keyId: expectedKeyId });
    validateServiceReceiptShape(receipt, { kind: "gate", expectedSubject, expectedKeyId });
    await writeFile(resolve(artifactRoot, "gate-report.json"), reportBytes, { flag: "wx", mode: 0o400 });
    await writeFile(resolve(artifactRoot, "runner-receipt.json"), jsonBytes(receipt), { flag: "wx", mode: 0o400 });
    const absoluteFinal = resolve(projectRoot, finalDirectory);
    await mkdir(dirname(absoluteFinal), { recursive: true });
    try {
      await lstat(absoluteFinal);
      throw new ReleaseEvidenceTrustError(`gate output directory already exists: ${finalDirectory}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await rename(artifactRoot, absoluteFinal);
    return {
      gateReportPath: `${finalDirectory}/gate-report.json`,
      gateReportSha256: reportSha256,
      runnerReceiptPath,
      runnerReceiptSha256: hashBytes(jsonBytes(receipt)),
      executionId,
    };
  } finally {
    try {
      await unlockSourceEntries(snapshotLock);
    } finally {
      await rm(stagingParent, { recursive: true, force: true });
    }
  }
}

export function gateReceiptSubject({ report, reportSha256 }) {
  return {
    handoff: report.handoff,
    reportSha256,
    executionId: report.runner.executionId,
    buildSourceSha256: report.sourceSnapshot.buildSourceSha256,
    deploymentOperationId: report.deploymentBinding.deploymentOperationId,
    deploymentRunId: report.deploymentBinding.deploymentRunId,
    deploymentNonce: report.deploymentBinding.deploymentNonce,
    deployedRevision: report.deploymentBinding.deployedRevision,
    imageDigest: report.deploymentBinding.imageDigest,
    rawArtifactHashes: report.runs.flatMap((run) => [
      run.stdout.sha256,
      run.stderr.sha256,
      run.resultArtifact.sha256,
    ]),
  };
}

export async function validateTrustedGateReport({
  report,
  reportSha256,
  runnerReceipt,
  deployment,
  deploymentManifestPath,
  deploymentManifestSha256,
  mandatoryIds,
  readArtifact,
  receiptVerifier = (params) => verifyServiceReceipt(params),
  nowMs,
}) {
  exactKeys(report, [
    "schemaVersion", "runner", "sourceSnapshot", "deploymentBinding",
    "handoff", "startedAt", "completedAt", "runs", "runnerReceiptPath",
  ], "gate-run report");
  if (report.schemaVersion !== GATE_RUNNER_SCHEMA_VERSION) {
    throw new ReleaseEvidenceTrustError(`gate-run report schemaVersion must be ${GATE_RUNNER_SCHEMA_VERSION}`);
  }
  exactKeys(report.runner, ["name", "version", "executionId", "immutableMode"], "gate-run report runner");
  equal(report.runner.name, GATE_RUNNER_NAME, "gate-run report runner name");
  equal(report.runner.version, GATE_RUNNER_VERSION, "gate-run report runner version");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(report.runner.executionId ?? "")) {
    throw new ReleaseEvidenceTrustError("gate-run report runner executionId must be a UUID");
  }
  equal(
    report.runner.immutableMode,
    "read-only-source-entries+docker-context-rehash",
    "gate-run report runner immutableMode",
  );
  exactKeys(report.sourceSnapshot, ["buildSourceSha256", "entryCount"], "gate-run report sourceSnapshot");
  equal(report.sourceSnapshot.buildSourceSha256, deployment.buildSourceSha256, "gate-run report source hash");
  if (!Number.isInteger(report.sourceSnapshot.entryCount) || report.sourceSnapshot.entryCount < 1) {
    throw new ReleaseEvidenceTrustError("gate-run report sourceSnapshot entryCount must be positive");
  }
  exactKeys(report.deploymentBinding, [
    "manifestPath", "manifestSha256", "deploymentOperationId", "deploymentRunId",
    "deploymentNonce", "deployedRevision", "imageDigest",
  ], "gate-run report deploymentBinding");
  const expectedBinding = {
    manifestPath: deploymentManifestPath,
    manifestSha256: deploymentManifestSha256,
    deploymentOperationId: deployment.deploymentOperationId,
    deploymentRunId: deployment.deploymentRunId,
    deploymentNonce: deployment.deploymentNonce,
    deployedRevision: deployment.deployedRevision,
    imageDigest: deployment.imageDigest,
  };
  for (const [field, expected] of Object.entries(expectedBinding)) {
    equal(report.deploymentBinding[field], expected, `gate-run report deploymentBinding ${field}`);
  }
  validateHandoffReceiptBinding(report.handoff, { nowMs });
  const deployedAt = parseTimestamp(deployment.deployedAt, "deployment deployedAt");
  const startedAt = validateEvidenceAge(report.startedAt, {
    label: "gate-run report startedAt", nowMs, maxAgeMs: MAX_BROWSER_EVIDENCE_AGE_MS, after: deployedAt,
  });
  const completedAt = validateEvidenceAge(report.completedAt, {
    label: "gate-run report completedAt", nowMs, maxAgeMs: MAX_BROWSER_EVIDENCE_AGE_MS, after: startedAt - 1,
  });
  if (!Array.isArray(report.runs) || report.runs.length !== GATE_CATEGORIES.length) {
    throw new ReleaseEvidenceTrustError(`gate-run report must contain exactly ${GATE_CATEGORIES.length} runs`);
  }
  const paths = new Set();
  for (const [index, run] of report.runs.entries()) {
    const category = GATE_CATEGORIES[index];
    validateGateRun(run, { category, mandatoryIds, reportStartedAt: startedAt, reportCompletedAt: completedAt });
    let substantive = "";
    for (const stream of ["stdout", "stderr"]) {
      const reference = run[stream];
      if (paths.has(reference.path)) {
        throw new ReleaseEvidenceTrustError("gate raw log paths must be unique and cannot be reused");
      }
      paths.add(reference.path);
      const loaded = await readArtifact(
        reference.path,
        `${category} ${stream} raw log`,
        reference.sha256,
        false,
        true,
      );
      if (!loaded || !Buffer.isBuffer(loaded.bytes)) throw new ReleaseEvidenceTrustError(`${category} ${stream} raw log is unavailable`);
      if (loaded.bytes.length !== reference.bytes) {
        throw new ReleaseEvidenceTrustError(`${category} ${stream} raw log byte count mismatch`);
      }
      substantive += loaded.bytes.toString("utf8");
    }
    if (substantive.trim().length < 16) {
      throw new ReleaseEvidenceTrustError(`${category} gate raw logs contain no substantive command output`);
    }
    const rawAssertions = extractRawGateAssertions(substantive, category);
    if (JSON.stringify(rawAssertions) !== JSON.stringify(run.results)) {
      throw new ReleaseEvidenceTrustError(`${category} raw emitted assertions do not exactly match the gate report results`);
    }
    if (paths.has(run.resultArtifact.path)) {
      throw new ReleaseEvidenceTrustError("gate structured-result paths must be unique and cannot be reused");
    }
    paths.add(run.resultArtifact.path);
    const loadedResult = await readArtifact(
      run.resultArtifact.path,
      `${category} structured result`,
      run.resultArtifact.sha256,
      true,
      false,
    );
    if (!loadedResult || !Buffer.isBuffer(loadedResult.bytes)) {
      throw new ReleaseEvidenceTrustError(`${category} structured result is unavailable`);
    }
    if (loadedResult.bytes.length !== run.resultArtifact.bytes) {
      throw new ReleaseEvidenceTrustError(`${category} structured result byte count mismatch`);
    }
    let structuredResult;
    try {
      structuredResult = loadedResult.document
        ?? JSON.parse(loadedResult.bytes.toString("utf8"));
    } catch {
      throw new ReleaseEvidenceTrustError(`${category} structured result is invalid JSON`);
    }
    validateStructuredGateResult(structuredResult, {
      category,
      executionId: report.runner.executionId,
      mandatoryIds,
      commandStartedAt: run.startedAt,
      commandCompletedAt: run.completedAt,
    });
    if (JSON.stringify(run.results) !== JSON.stringify(structuredResult.results)) {
      throw new ReleaseEvidenceTrustError(`${category} report results do not match the producer result artifact`);
    }
  }
  const expectedSubject = gateReceiptSubject({ report, reportSha256 });
  const expectedKeyId = deployment.evidenceSigningKeyIds?.gate;
  const receiptIssuedAt = validateServiceReceiptShape(runnerReceipt, {
    kind: "gate", expectedSubject, expectedKeyId,
  });
  if (receiptIssuedAt <= completedAt) {
    throw new ReleaseEvidenceTrustError("gate service receipt must be issued after the command report completed");
  }
  validateReceiptFreshness(runnerReceipt, { kind: "gate", nowMs });
  await receiptVerifier({ kind: "gate", receipt: runnerReceipt, expectedSubject, expectedKeyId });
  return new Map(report.runs.flatMap((run) => run.results.map(({ id, outcome }) => [id, outcome])));
}

export function browserArtifactValidationSubject({
  deployment,
  e2e,
  e2eSha256,
  a11ySha256,
  artifactHashes,
  handoffBinding,
}) {
  validateHandoffReceiptBinding(handoffBinding);
  return {
    handoff: handoffBinding,
    sessionId: e2e.sessionId,
    deploymentNonce: deployment.deploymentNonce,
    deployedRevision: deployment.deployedRevision,
    imageDigest: deployment.imageDigest,
    authenticatedActor: e2e.authenticatedActor,
    authMeResponseSha256: e2e.authMeResponseSha256,
    e2eReportSha256: e2eSha256,
    a11yReportSha256: a11ySha256,
    rawArtifactHashes: [...artifactHashes].sort(),
  };
}

export function browserArtifactReferences(e2e, a11y) {
  if (!Array.isArray(e2e?.captures) || !Array.isArray(a11y?.checks)) {
    throw new ReleaseEvidenceTrustError("browser reports lack capture/check arrays");
  }
  return [
    { path: e2e.authMeResponsePath, sha256: e2e.authMeResponseSha256 },
    ...e2e.captures.flatMap((capture) => [
      { path: capture.screenshotPath, sha256: capture.screenshotSha256 },
      { path: capture.tracePath, sha256: capture.traceSha256 },
    ]),
    ...a11y.checks.map((check) => ({ path: check.evidencePath, sha256: check.evidenceSha256 })),
  ];
}

export function validateBrowserArtifactValidationResult(document, {
  deployment,
  e2e,
  a11y,
  e2eReportPath,
  e2eReportSha256,
  a11yReportPath,
  a11yReportSha256,
  artifactReferences,
}) {
  exactKeys(document, [
    "schemaVersion", "producer", "outcome", "sessionId", "deploymentNonce",
    "deployedRevision", "imageDigest", "authenticatedActor", "startedAt", "completedAt",
    "e2eReport", "a11yReport", "artifacts",
  ], "browser artifact validation result");
  if (document.schemaVersion !== BROWSER_ARTIFACT_VALIDATION_SCHEMA_VERSION) {
    throw new ReleaseEvidenceTrustError(
      `browser artifact validation result schemaVersion must be ${BROWSER_ARTIFACT_VALIDATION_SCHEMA_VERSION}`,
    );
  }
  exactKeys(document.producer, ["name", "version", "executionId"], "browser artifact validator");
  equal(document.producer.name, BROWSER_ARTIFACT_VALIDATOR_NAME, "browser artifact validator name");
  equal(document.producer.version, BROWSER_ARTIFACT_VALIDATOR_VERSION, "browser artifact validator version");
  if (!uuidPattern.test(document.producer.executionId ?? "")) {
    throw new ReleaseEvidenceTrustError("browser artifact validator executionId must be a UUID");
  }
  equal(document.outcome, "PASS", "browser artifact validation outcome");
  for (const [field, expected] of Object.entries({
    sessionId: e2e.sessionId,
    deploymentNonce: deployment.deploymentNonce,
    deployedRevision: deployment.deployedRevision,
    imageDigest: deployment.imageDigest,
    authenticatedActor: e2e.authenticatedActor,
  })) equal(document[field], expected, `browser artifact validation result ${field}`);
  equal(a11y.sessionId, e2e.sessionId, "browser report sessionId");
  equal(a11y.deploymentNonce, e2e.deploymentNonce, "browser report deploymentNonce");
  equal(a11y.deployedRevision, e2e.deployedRevision, "browser report deployedRevision");
  equal(a11y.imageDigest, e2e.imageDigest, "browser report imageDigest");
  equal(a11y.authenticatedActor, e2e.authenticatedActor, "browser report authenticatedActor");
  const expectedStartedAt = new Date(Math.min(Date.parse(e2e.startedAt), Date.parse(a11y.startedAt))).toISOString();
  const expectedCompletedAt = new Date(Math.max(Date.parse(e2e.completedAt), Date.parse(a11y.completedAt))).toISOString();
  equal(document.startedAt, expectedStartedAt, "browser artifact validation result startedAt");
  equal(document.completedAt, expectedCompletedAt, "browser artifact validation result completedAt");
  for (const [label, actual, expected] of [
    ["e2eReport", document.e2eReport, { path: e2eReportPath, sha256: e2eReportSha256 }],
    ["a11yReport", document.a11yReport, { path: a11yReportPath, sha256: a11yReportSha256 }],
  ]) {
    exactKeys(actual, ["path", "sha256"], `browser artifact validation result ${label}`);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new ReleaseEvidenceTrustError(`browser artifact validation result ${label} does not match the supplied report`);
    }
  }
  if (JSON.stringify(document.artifacts) !== JSON.stringify(artifactReferences)) {
    throw new ReleaseEvidenceTrustError("browser artifact validation result does not exactly match the supplied artifacts");
  }
  for (const [index, artifact] of document.artifacts.entries()) {
    exactKeys(artifact, ["path", "sha256"], `browser validated artifact ${index + 1}`);
    if (!sha256Pattern.test(artifact.sha256 ?? "")) {
      throw new ReleaseEvidenceTrustError(`browser validated artifact ${index + 1} SHA-256 is invalid`);
    }
  }
  return document;
}

export function externalReviewValidationSubject({
  reviewValidation,
  handoffBinding,
  reviewerReportSha256,
  deploymentManifestSha256,
  e2eReportSha256,
  a11yReportSha256,
  browserAttestationSha256,
  gateReportSha256,
  gateRunnerReceiptSha256,
}) {
  validateHandoffReceiptBinding(handoffBinding);
  return {
    handoff: handoffBinding,
    validationType: "EXTERNAL_REPORT_CONTENT_ONLY",
    authorship: "NOT_AUTHENTICATED",
    reviewProcess: "SEPARATE_AGENT_REQUIRED",
    declaredReviewerTaskId: reviewValidation.declaredReviewerTaskId,
    declaredReviewerThreadId: reviewValidation.declaredReviewerThreadId,
    scopeFeatureIds: reviewValidation.scopeFeatureIds,
    decision: reviewValidation.decision,
    artifactHashes: {
      deploymentManifest: deploymentManifestSha256,
      e2eReport: e2eReportSha256,
      a11yReport: a11yReportSha256,
      browserAttestation: browserAttestationSha256,
      gateReport: gateReportSha256,
      gateRunnerReceipt: gateRunnerReceiptSha256,
      reviewerReport: reviewerReportSha256,
    },
  };
}

export function validateEvidenceAge(timestamp, { label, nowMs, maxAgeMs, after = null }) {
  const value = parseTimestamp(timestamp, label);
  if (value > nowMs) throw new ReleaseEvidenceTrustError(`${label} must not be in the future`);
  if (nowMs - value > maxAgeMs) throw new ReleaseEvidenceTrustError(`${label} is older than the permitted evidence window`);
  if (after !== null && value <= after) throw new ReleaseEvidenceTrustError(`${label} must be after its prerequisite evidence`);
  return value;
}

export async function issueAzureKeyVaultReceipt({
  kind,
  expectedSubject,
  keyId,
  runAz = runAzureCli,
  signerIdentityVerifier = verifyActiveSignerIdentity,
  keyResolver = ({ keyId: requestedKeyId }) => resolveAzureKeyVaultPublicKey({ keyId: requestedKeyId, runAz }),
  digestSigner = ({ keyId: requestedKeyId, digest }) => signAzureKeyVaultDigest({
    keyId: requestedKeyId,
    digest,
    runAz,
  }),
  now = () => new Date(),
}) {
  if (!receiptTypeByKind[kind]) throw new ReleaseEvidenceTrustError(`unknown receipt kind ${String(kind)}`);
  if (!versionedKeyIdPattern.test(keyId ?? "")) {
    throw new ReleaseEvidenceTrustError(`${kind} signing key must be a version-pinned Azure Key Vault key ID`);
  }
  const keyName = new URL(keyId).pathname.split("/")[2];
  if (keyName !== EVIDENCE_SIGNER_IDENTITIES[kind].keyName) {
    throw new ReleaseEvidenceTrustError(
      `${kind} receipt cannot be signed with the ${String(keyName)} evidence key`,
    );
  }
  validateHandoffReceiptBinding(expectedSubject?.handoff);
  await signerIdentityVerifier({ kind, keyId, runAz });
  const publicKey = normalizeAzurePublicKey(await keyResolver({ keyId }));
  const digest = createHash("sha256").update(jsonBytes(expectedSubject)).digest("base64url");
  const signature = String(await digestSigner({ keyId, digest })).trim();
  if (!signaturePattern.test(signature)) throw new ReleaseEvidenceTrustError("Azure Key Vault returned a malformed signature");
  const issuedAtValue = now();
  const issuedAtMs = issuedAtValue instanceof Date ? issuedAtValue.getTime() : Date.parse(issuedAtValue);
  if (!Number.isFinite(issuedAtMs)) throw new ReleaseEvidenceTrustError("receipt issuer returned an invalid timestamp");
  const maxLifetime = kind === "reviewer" ? MAX_REVIEWER_EVIDENCE_AGE_MS : MAX_BROWSER_EVIDENCE_AGE_MS;
  const handoffExpiresAt = Date.parse(expectedSubject?.handoff?.expiresAt);
  const expiresAtMs = Number.isFinite(handoffExpiresAt)
    ? Math.min(issuedAtMs + maxLifetime, handoffExpiresAt)
    : issuedAtMs + maxLifetime;
  if (expiresAtMs <= issuedAtMs) throw new ReleaseEvidenceTrustError(`${kind} receipt cannot outlive an expired handoff`);
  const receipt = {
    schemaVersion: SERVICE_RECEIPT_SCHEMA_VERSION,
    receiptType: receiptTypeByKind[kind],
    receiptId: `akv:${hashBytes(Buffer.from(signature, "base64url"))}`,
    issuer: "azure-key-vault",
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    algorithm: "RS256",
    keyId,
    publicKey,
    publicKeyFingerprintSha256: publicKeyFingerprint(keyId, publicKey),
    signature,
    subject: expectedSubject,
  };
  validateServiceReceiptShape(receipt, { kind, expectedSubject, expectedKeyId: keyId });
  return receipt;
}

async function signAzureKeyVaultDigest({ keyId, digest, runAz }) {
  return runAz([
    "keyvault", "key", "sign", "--id", keyId, "--algorithm", "RS256",
    "--digest", digest, "--query", "result", "--output", "tsv", "--only-show-errors",
  ]);
}

export async function verifyActiveSignerIdentity({
  kind,
  keyId,
  runAz = runAzureCli,
  resourceGroup = "prostar-payroll",
}) {
  const policy = EVIDENCE_SIGNER_IDENTITIES[kind];
  if (!policy) throw new ReleaseEvidenceTrustError(`unknown receipt kind ${String(kind)}`);
  const identities = {};
  for (const [evidenceKind, evidencePolicy] of Object.entries(EVIDENCE_SIGNER_IDENTITIES)) {
    const identityOutput = await runAz([
      "identity", "show", "--resource-group", resourceGroup, "--name", evidencePolicy.name,
      "--query", "{principalId:principalId,clientId:clientId,id:id}", "--output", "json", "--only-show-errors",
    ]);
    try {
      identities[evidenceKind] = typeof identityOutput === "string" ? JSON.parse(identityOutput) : identityOutput;
    } catch {
      throw new ReleaseEvidenceTrustError(`${evidenceKind} signer identity lookup returned invalid JSON`);
    }
  }
  const identity = identities[kind];
  if (!uuidPattern.test(identity?.principalId ?? "") || !uuidPattern.test(identity?.clientId ?? "")) {
    throw new ReleaseEvidenceTrustError(`${kind} signer identity is missing a concrete principal or client ID`);
  }
  const token = String(await runAz([
    "account", "get-access-token", "--resource", "https://vault.azure.net",
    "--query", "accessToken", "--output", "tsv", "--only-show-errors",
  ])).trim();
  const claims = decodeJwtClaims(token, `${kind} signer access token`);
  if (claims.oid?.toLowerCase() !== identity.principalId.toLowerCase()) {
    throw new ReleaseEvidenceTrustError(
      `${kind} evidence must be signed by dedicated identity ${policy.name}; the active Azure principal is different`,
    );
  }
  const tokenClientId = claims.azp ?? claims.appid;
  if (tokenClientId?.toLowerCase() !== identity.clientId.toLowerCase()) {
    throw new ReleaseEvidenceTrustError(`${kind} signer token client ID does not match ${policy.name}`);
  }
  await verifyLiveSignerRbacPolicy({ keyId, identities, runAz });
  return { ...identity, name: policy.name };
}

async function verifyLiveSignerRbacPolicy({ keyId, identities, runAz }) {
  if (!versionedKeyIdPattern.test(keyId ?? "")) {
    throw new ReleaseEvidenceTrustError("signer RBAC verification requires a version-pinned evidence key ID");
  }
  const vaultName = new URL(keyId).hostname.split(".")[0];
  const vaultOutput = await runAz([
    "keyvault", "show", "--name", vaultName, "--query", "id", "--output", "tsv", "--only-show-errors",
  ]);
  const vaultResourceId = String(vaultOutput).trim();
  if (!/^\/subscriptions\/[^/]+\/resourcegroups\/[^/]+\/providers\/microsoft\.keyvault\/vaults\/[^/]+$/i.test(vaultResourceId)) {
    throw new ReleaseEvidenceTrustError("evidence vault lookup returned an invalid resource ID");
  }
  const assignmentsByKind = {};
  const roleDefinitionIds = new Set();
  for (const [evidenceKind, policy] of Object.entries(EVIDENCE_SIGNER_IDENTITIES)) {
    const scope = `${vaultResourceId}/keys/${policy.keyName}`;
    const assignmentOutput = await runAz([
      "role", "assignment", "list", "--scope", scope, "--include-inherited", "--all",
      "--output", "json", "--only-show-errors",
    ]);
    const assignments = parseJsonArray(assignmentOutput, `${evidenceKind} evidence-key role assignments`);
    assignmentsByKind[evidenceKind] = assignments;
    for (const assignment of assignments) {
      if (typeof assignment?.roleDefinitionId === "string") roleDefinitionIds.add(assignment.roleDefinitionId);
    }
  }
  const roleDefinitions = {};
  for (const roleDefinitionId of roleDefinitionIds) {
    const definitionOutput = await runAz([
      "role", "definition", "list", "--name", roleDefinitionId,
      "--output", "json", "--only-show-errors",
    ]);
    const definitions = parseJsonArray(definitionOutput, `role definition ${roleDefinitionId}`);
    if (definitions.length !== 1) {
      throw new ReleaseEvidenceTrustError(`role definition ${roleDefinitionId} is missing or ambiguous`);
    }
    roleDefinitions[roleDefinitionId.toLowerCase()] = definitions[0];
  }
  verifyEvidenceSignerRbacPolicy({ vaultResourceId, identities, assignmentsByKind, roleDefinitions });
}

export function verifyEvidenceSignerRbacPolicy({
  vaultResourceId,
  identities,
  assignmentsByKind,
  roleDefinitions,
}) {
  const principalIds = Object.values(identities ?? {}).map((identity) => identity?.principalId?.toLowerCase());
  if (principalIds.some((value) => !uuidPattern.test(value ?? "")) || new Set(principalIds).size !== 3) {
    throw new ReleaseEvidenceTrustError("evidence signer identities must have three distinct principals");
  }
  for (const [kind, policy] of Object.entries(EVIDENCE_SIGNER_IDENTITIES)) {
    const expectedScope = `${vaultResourceId}/keys/${policy.keyName}`.toLowerCase();
    const signingAssignments = (assignmentsByKind?.[kind] ?? []).filter((assignment) => {
      const definition = roleDefinitions?.[assignment?.roleDefinitionId?.toLowerCase()];
      if (!definition) throw new ReleaseEvidenceTrustError(`${kind} evidence key has an unresolved role definition`);
      return roleDefinitionCanSign(definition);
    });
    if (signingAssignments.length !== 1) {
      throw new ReleaseEvidenceTrustError(`${kind} evidence key must have exactly one signing-capable role assignment`);
    }
    const assignment = signingAssignments[0];
    const roleDefinitionId = String(assignment.roleDefinitionId).toLowerCase();
    if (
      assignment.scope?.toLowerCase() !== expectedScope
      || assignment.principalId?.toLowerCase() !== identities[kind].principalId.toLowerCase()
      || !roleDefinitionId.endsWith(`/${keyVaultCryptoUserRoleId}`)
    ) {
      throw new ReleaseEvidenceTrustError(`${kind} evidence key signer assignment violates the isolated key policy`);
    }
  }
  return true;
}

function roleDefinitionCanSign(definition) {
  const operation = "microsoft.keyvault/vaults/keys/sign/action";
  return (definition?.permissions ?? []).some((permission) => {
    const allowed = (permission?.dataActions ?? []).some((pattern) => operationPatternMatches(pattern, operation));
    const denied = (permission?.notDataActions ?? []).some((pattern) => operationPatternMatches(pattern, operation));
    return allowed && !denied;
  });
}

function operationPatternMatches(pattern, operation) {
  if (typeof pattern !== "string") return false;
  const escaped = pattern.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(operation);
}

function parseJsonArray(value, label) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!Array.isArray(parsed)) throw new Error("not an array");
    return parsed;
  } catch {
    throw new ReleaseEvidenceTrustError(`${label} lookup returned invalid JSON`);
  }
}

export async function resolveAzureKeyVaultPublicKey({ keyId, runAz = runAzureCli }) {
  if (!versionedKeyIdPattern.test(keyId ?? "")) {
    throw new ReleaseEvidenceTrustError("public-key resolution requires a version-pinned Azure Key Vault key ID");
  }
  const output = await runAz([
    "keyvault", "key", "show", "--id", keyId, "--query", "key",
    "--output", "json", "--only-show-errors",
  ]);
  try {
    return typeof output === "string" ? JSON.parse(output) : output;
  } catch {
    throw new ReleaseEvidenceTrustError("Azure Key Vault public-key lookup returned invalid JSON");
  }
}

export function normalizeAzurePublicKey(value) {
  const key = value?.key ?? value;
  if (!key || !["RSA", "RSA-HSM"].includes(key.kty) || typeof key.n !== "string" || typeof key.e !== "string") {
    throw new ReleaseEvidenceTrustError("Azure Key Vault evidence key must be an RSA or RSA-HSM public key");
  }
  return { kty: "RSA", n: key.n, e: key.e };
}

export function publicKeyFingerprint(keyId, publicKey) {
  return hashBytes(jsonBytes({ keyId, ...normalizeAzurePublicKey(publicKey) }));
}

function validateGateRun(run, { category, reportStartedAt, reportCompletedAt }) {
  exactKeys(run, [
    "category", "argv", "redactedArgv", "tool", "startedAt", "completedAt",
    "exitCode", "signal", "stdout", "stderr", "resultArtifact", "results",
  ], `${category} gate run`);
  equal(run.category, category, `${category} gate run category`);
  const expectedArgv = EXPECTED_GATE_COMMANDS[category];
  if (JSON.stringify(run.argv) !== JSON.stringify(expectedArgv)) {
    throw new ReleaseEvidenceTrustError(`${category} gate run argv is not the exact required command`);
  }
  if (JSON.stringify(run.redactedArgv) !== JSON.stringify(expectedArgv)) {
    throw new ReleaseEvidenceTrustError(`${category} gate run redactedArgv must exactly record the non-secret command`);
  }
  exactKeys(run.tool, ["name", "version"], `${category} gate run tool`);
  equal(run.tool.name, expectedArgv[0], `${category} gate run tool name`);
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(run.tool.version ?? "")) {
    throw new ReleaseEvidenceTrustError(`${category} gate run tool version must be semantic`);
  }
  const startedAt = parseTimestamp(run.startedAt, `${category} gate run startedAt`);
  const completedAt = parseTimestamp(run.completedAt, `${category} gate run completedAt`);
  if (startedAt < reportStartedAt || completedAt > reportCompletedAt || completedAt < startedAt) {
    throw new ReleaseEvidenceTrustError(`${category} gate run timestamps fall outside the report interval`);
  }
  if (run.exitCode !== 0 || run.signal !== null) {
    throw new ReleaseEvidenceTrustError(`${category} gate run did not exit successfully`);
  }
  for (const stream of ["stdout", "stderr"]) {
    exactKeys(run[stream], ["path", "sha256", "bytes"], `${category} gate run ${stream}`);
    if (!sha256Pattern.test(run[stream].sha256 ?? "")) throw new ReleaseEvidenceTrustError(`${category} ${stream} SHA-256 is invalid`);
    if (!Number.isInteger(run[stream].bytes) || run[stream].bytes < 0) throw new ReleaseEvidenceTrustError(`${category} ${stream} byte count is invalid`);
  }
  exactKeys(run.resultArtifact, ["path", "sha256", "bytes"], `${category} gate run resultArtifact`);
  if (!sha256Pattern.test(run.resultArtifact.sha256 ?? "")) {
    throw new ReleaseEvidenceTrustError(`${category} structured result SHA-256 is invalid`);
  }
  if (!Number.isInteger(run.resultArtifact.bytes) || run.resultArtifact.bytes < 2) {
    throw new ReleaseEvidenceTrustError(`${category} structured result byte count is invalid`);
  }
  validateResultOutcomes(run.results, { category });
}

export function validateStructuredGateResult(document, {
  category,
  executionId,
  commandStartedAt,
  commandCompletedAt,
}) {
  exactKeys(document, [
    "schemaVersion", "producer", "category", "executionId", "runnerCommand", "command",
    "startedAt", "completedAt", "summary", "results",
  ], `${category} structured gate result`);
  if (document.schemaVersion !== STRUCTURED_GATE_RESULT_SCHEMA_VERSION) {
    throw new ReleaseEvidenceTrustError(
      `${category} structured gate result schemaVersion must be ${STRUCTURED_GATE_RESULT_SCHEMA_VERSION}`,
    );
  }
  exactKeys(document.producer, ["name", "version"], `${category} structured gate result producer`);
  concrete(document.producer.name, `${category} structured gate result producer name`);
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(document.producer.version ?? "")) {
    throw new ReleaseEvidenceTrustError(`${category} structured gate result producer version must be semantic`);
  }
  equal(document.category, category, `${category} structured gate result category`);
  equal(document.executionId, executionId, `${category} structured gate result executionId`);
  if (JSON.stringify(document.runnerCommand) !== JSON.stringify(EXPECTED_GATE_COMMANDS[category])) {
    throw new ReleaseEvidenceTrustError(`${category} structured gate result runnerCommand is not the controlled runner command`);
  }
  if (JSON.stringify(document.command) !== JSON.stringify(PRODUCTION_GATE_COMMANDS[category])) {
    throw new ReleaseEvidenceTrustError(`${category} structured gate result command is not the exact production command`);
  }
  const resultStartedAt = parseTimestamp(document.startedAt, `${category} structured gate result startedAt`);
  const resultCompletedAt = parseTimestamp(document.completedAt, `${category} structured gate result completedAt`);
  const commandStart = parseTimestamp(commandStartedAt, `${category} command startedAt`);
  const commandComplete = parseTimestamp(commandCompletedAt, `${category} command completedAt`);
  if (resultStartedAt < commandStart || resultCompletedAt > commandComplete || resultCompletedAt < resultStartedAt) {
    throw new ReleaseEvidenceTrustError(`${category} structured result timestamps fall outside the command execution`);
  }
  const expectedSummary = validateResultOutcomes(document.results, { category });
  exactKeys(document.summary, [
    "claims", "total", "passed", "failed", "skipped", "cancelled", "todo",
  ], `${category} structured gate result summary`);
  if (JSON.stringify(document.summary) !== JSON.stringify(expectedSummary)) {
    throw new ReleaseEvidenceTrustError(`${category} structured result summary does not match emitted claim counts`);
  }
  return document.results;
}

function validateResultOutcomes(results, { category }) {
  if (!Array.isArray(results) || results.length === 0) {
    throw new ReleaseEvidenceTrustError(`${category} structured result must contain actual test outcomes`);
  }
  const ids = new Set();
  const provenanceMappings = new Set();
  const summary = { claims: results.length, total: 0, passed: 0, failed: 0, skipped: 0, cancelled: 0, todo: 0 };
  const expectedRunner = category === "integration" ? "integration-test" : category === "build" ? "build-check" : "node-test";
  for (const [index, result] of results.entries()) {
    exactKeys(result, ["id", "outcome", "provenance", "counts"], `${category} structured result outcome ${index + 1}`);
    if (!["PASS", "FAIL", "SKIP"].includes(result.outcome)) {
      throw new ReleaseEvidenceTrustError(`${category} structured result has an invalid outcome for ${String(result.id)}`);
    }
    exactKeys(
      result.provenance,
      ["runner", "source", "assertion"],
      `${category} structured result outcome ${index + 1} provenance`,
    );
    if (
      result.provenance.runner !== expectedRunner
      || !/^[A-Za-z0-9_.@/: -]{3,240}$/.test(result.provenance.source ?? "")
      || typeof result.provenance.assertion !== "string"
      || result.provenance.assertion.length < 3
      || result.provenance.assertion.length > 240
      || result.provenance.source.startsWith("/")
      || result.provenance.source.includes("..")
      || /[\r\n]/.test(result.provenance.assertion)
    ) throw new ReleaseEvidenceTrustError(`${category} structured result outcome ${index + 1} provenance is invalid`);
    const expectedId = derivedObservedAssertionId(category, result.provenance);
    if (result.id !== expectedId || ids.has(result.id)) {
      throw new ReleaseEvidenceTrustError(`${category} structured result outcome ${index + 1} ID is not uniquely derived from provenance`);
    }
    ids.add(result.id);
    const mapping = `${result.id}|${result.provenance.runner}|${result.provenance.source}|${result.provenance.assertion}`;
    if (provenanceMappings.has(mapping)) {
      throw new ReleaseEvidenceTrustError(`${category} structured result contains duplicate assertion provenance`);
    }
    provenanceMappings.add(mapping);
    validateObservedCounts(result.counts, result.outcome, `${category} structured result outcome ${index + 1}`);
    for (const key of ["total", "passed", "failed", "skipped", "cancelled", "todo"]) {
      summary[key] += result.counts[key];
    }
  }
  const nonPassing = results.filter((result) => result.outcome !== "PASS");
  if (nonPassing.length > 0) {
    throw new ReleaseEvidenceTrustError(
      `${category} structured result contains non-PASS outcomes: ${nonPassing.map(({ id, outcome }) => `${id}=${outcome}`).join(", ")}`,
    );
  }
  return summary;
}

function derivedObservedAssertionId(category, provenance) {
  const digest = createHash("sha256").update(JSON.stringify([
    category, provenance?.runner, provenance?.source, provenance?.assertion,
  ])).digest("hex");
  return `OBS-${String(category).toUpperCase()}-${digest.slice(0, 32)}`;
}

function validateObservedCounts(counts, outcome, label) {
  const keys = ["total", "passed", "failed", "skipped", "cancelled", "todo"];
  exactKeys(counts, keys, `${label} counts`);
  for (const key of keys) {
    if (!Number.isSafeInteger(counts[key]) || counts[key] < 0) {
      throw new ReleaseEvidenceTrustError(`${label} count ${key} is invalid`);
    }
  }
  if (counts.total <= 0 || counts.total !== keys.slice(1).reduce((sum, key) => sum + counts[key], 0)) {
    throw new ReleaseEvidenceTrustError(`${label} counts are inconsistent`);
  }
  if (
    (outcome === "PASS" && (counts.passed <= 0 || counts.failed > 0))
    || (outcome === "FAIL" && counts.failed <= 0)
    || (outcome === "SKIP" && counts.skipped + counts.cancelled + counts.todo <= 0)
  ) throw new ReleaseEvidenceTrustError(`${label} outcome disagrees with counts`);
}

function extractRawGateAssertions(output, category) {
  const prefix = "PROSTAR_EVIDENCE_ASSERTION ";
  const assertions = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith(prefix)) continue;
    let event;
    try {
      event = JSON.parse(line.slice(prefix.length));
    } catch {
      throw new ReleaseEvidenceTrustError(`${category} raw assertion log contains malformed JSON`);
    }
    exactKeys(event, ["schemaVersion", "category", "id", "outcome", "provenance", "counts"], `${category} raw assertion`);
    if (event.schemaVersion !== 2 || event.category !== category) {
      throw new ReleaseEvidenceTrustError(`${category} raw assertion binding mismatch`);
    }
    assertions.push({ id: event.id, outcome: event.outcome, provenance: event.provenance, counts: event.counts });
  }
  if (assertions.length === 0) {
    throw new ReleaseEvidenceTrustError(`${category} raw command log emitted zero concrete assertions`);
  }
  return assertions;
}

async function issueGateReceipt({ kind, expectedSubject, keyId }) {
  return issueAzureKeyVaultReceipt({ kind, expectedSubject, keyId });
}

async function executeCommand({ argv, cwd, env }) {
  const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const result = await new Promise((resolveResult, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => resolveResult({ exitCode, signal }));
  });
  const version = await commandVersion(argv[0], cwd, env);
  return {
    ...result,
    stdout: Buffer.concat(stdout),
    stderr: Buffer.concat(stderr),
    toolName: argv[0],
    toolVersion: version,
  };
}

async function runAzureCli(args) {
  const azureConfigDirectory = process.env.AZURE_CONFIG_DIR
    ?? (process.env.RELEASE_PROJECT_ROOT
      ? resolve(process.env.RELEASE_PROJECT_ROOT, "..", ".work", "azure")
      : resolve(process.cwd(), "..", ".work", "azure"));
  const child = spawn("az", args, {
    env: {
      PATH: process.env.PATH ?? "",
      ...(azureConfigDirectory ? { AZURE_CONFIG_DIR: azureConfigDirectory } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const { code, signal } = await new Promise((resolveResult, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveResult({ code, signal }));
  });
  if (code !== 0) {
    throw new ReleaseEvidenceTrustError(
      `Azure Key Vault CLI operation failed (${String(code ?? signal)}): ${Buffer.concat(stderr).toString("utf8").trim()}`,
    );
  }
  return Buffer.concat(stdout).toString("utf8");
}

async function commandVersion(command, cwd, env) {
  const args = command === "node" ? ["--version"] : ["--version"];
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "ignore"] });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(Buffer.from(chunk)));
  const code = await new Promise((resolveResult, reject) => {
    child.once("error", reject);
    child.once("exit", resolveResult);
  });
  if (code !== 0) throw new ReleaseEvidenceTrustError(`unable to read ${command} version`);
  const version = Buffer.concat(output).toString("utf8").trim().replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new ReleaseEvidenceTrustError(`${command} returned a non-semantic version`);
  }
  return version;
}

export function gateEnvironment({
  category,
  executionId,
  resultOutputPath,
  projectRoot,
  deploymentManifestPath,
  e2eReportPath,
  a11yReportPath,
  browserAttestationPath,
  inheritedEnv = process.env,
}) {
  const env = {
    PATH: `${resolve(projectRoot, "node_modules/.bin")}:${inheritedEnv.PATH ?? ""}`,
    NODE_PATH: resolve(projectRoot, "node_modules"),
    ...(inheritedEnv.AZURE_CONFIG_DIR ? { AZURE_CONFIG_DIR: inheritedEnv.AZURE_CONFIG_DIR } : {}),
    RELEASE_PROJECT_ROOT: projectRoot,
    RELEASE_DEPLOYMENT_MANIFEST: deploymentManifestPath,
    RELEASE_E2E_REPORT: e2eReportPath,
    RELEASE_A11Y_REPORT: a11yReportPath,
    RELEASE_BROWSER_ATTESTATION: browserAttestationPath,
    RELEASE_GATE_CATEGORY: category,
    RELEASE_GATE_EXECUTION_ID: executionId,
    RELEASE_GATE_RESULT_PATH: resultOutputPath,
  };
  return env;
}

async function materializeSnapshot(projectRoot, snapshotRoot, entries) {
  for (const entry of entries) {
    const source = resolve(projectRoot, entry.path);
    const target = resolve(snapshotRoot, entry.path);
    if (entry.type === "D") {
      await mkdir(target, { recursive: true });
    } else if (entry.type === "L") {
      await mkdir(dirname(target), { recursive: true });
      await symlink(await readlink(source), target);
    } else {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
    }
  }
}

async function mountIgnoredRuntime(projectRoot, snapshotRoot) {
  await symlink(resolve(projectRoot, "node_modules"), resolve(snapshotRoot, "node_modules"));
  const verification = resolve(projectRoot, "docs/prostar-metrics/verification");
  await mkdir(verification, { recursive: true });
  await symlink(verification, resolve(snapshotRoot, "docs/prostar-metrics/verification"));
}

async function lockSourceEntries(snapshotRoot, entries) {
  const ordered = entries
    .filter((entry) => entry.type !== "L")
    .sort((left, right) => right.path.split("/").length - left.path.split("/").length);
  const locked = [];
  try {
    for (const entry of ordered) {
      const target = resolve(snapshotRoot, entry.path);
      await chmod(target, entry.mode & ~0o222);
      locked.push({ target, mode: entry.mode });
    }
    return locked;
  } catch (error) {
    await unlockSourceEntries(locked);
    throw error;
  }
}

async function unlockSourceEntries(locked) {
  const ordered = [...locked].sort(
    (left, right) => left.target.split(sep).length - right.target.split(sep).length,
  );
  for (const entry of ordered) await chmod(entry.target, entry.mode).catch(() => undefined);
}

function validateDeploymentBinding(deployment, manifestPath, manifestSha256) {
  if (!sha256Pattern.test(manifestSha256 ?? "")) throw new ReleaseEvidenceTrustError("deployment manifest SHA-256 is required");
  for (const field of ["deploymentOperationId", "deploymentRunId", "deploymentNonce", "deployedRevision", "imageDigest", "buildSourceSha256"]) {
    concrete(deployment?.[field], `deployment ${field}`);
  }
  exactKeys(deployment?.evidenceSigningKeyIds, ["gate", "browser", "reviewer"], "deployment evidenceSigningKeyIds");
  for (const [kind, keyId] of Object.entries(deployment.evidenceSigningKeyIds)) {
    if (!versionedKeyIdPattern.test(keyId ?? "")) {
      throw new ReleaseEvidenceTrustError(`deployment ${kind} evidence signing key must pin an Azure Key Vault key version`);
    }
  }
  concrete(manifestPath, "deployment manifest path");
}

function normalizeOutputDirectory(projectRoot, outputDirectory, revision, executionId) {
  const candidate = outputDirectory
    ?? `docs/prostar-metrics/verification/gates/${revision}/${executionId}`;
  if (typeof candidate !== "string" || !candidate.trim()) throw new ReleaseEvidenceTrustError("gate output directory is required");
  const absolute = resolve(projectRoot, candidate);
  const allowed = resolve(projectRoot, "docs/prostar-metrics/verification/gates");
  const fromAllowed = relative(allowed, absolute);
  if (fromAllowed === ".." || fromAllowed.startsWith(`..${sep}`)) {
    throw new ReleaseEvidenceTrustError("gate output directory must be under docs/prostar-metrics/verification/gates");
  }
  return relative(projectRoot, absolute).split(sep).join("/");
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ReleaseEvidenceTrustError(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new ReleaseEvidenceTrustError(`${label} has unexpected fields: expected ${wanted.join(", ")}; received ${actual.join(", ")}`);
  }
}

function equal(actual, expected, label) {
  if (actual !== expected) throw new ReleaseEvidenceTrustError(`${label} mismatch: expected ${String(expected)}, received ${String(actual)}`);
}

function concrete(value, label) {
  if (typeof value !== "string" || value.trim().length < 8 || /^(?:tbd|todo|pending|unknown|none|null|n\/a)$/i.test(value.trim())) {
    throw new ReleaseEvidenceTrustError(`${label} must be concrete`);
  }
}

function parseTimestamp(value, label) {
  if (typeof value !== "string" || !value.endsWith("Z") || !Number.isFinite(Date.parse(value))) {
    throw new ReleaseEvidenceTrustError(`${label} must be an ISO-8601 UTC timestamp`);
  }
  return Date.parse(value);
}

function decodeJwtClaims(token, label) {
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 3) throw new ReleaseEvidenceTrustError(`${label} is not a JWT`);
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!claims || typeof claims !== "object" || Array.isArray(claims)) throw new Error("claims are not an object");
    return claims;
  } catch {
    throw new ReleaseEvidenceTrustError(`${label} contains invalid claims`);
  }
}
