import { randomBytes, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { AzureCliCredential } from "@azure/identity";

import {
  createEvidenceBundle,
  materializeEvidenceFiles,
  parseEvidenceBundle,
} from "./lib/release-evidence-bundle.mjs";
import { createEvidenceStorageClient } from "./lib/release-evidence-storage.mjs";
import {
  MAX_HANDOFF_AGE_MS,
  browserArtifactReferences,
  handoffReceiptBinding,
  validateHandoffReceiptBinding,
  validateReceiptFreshness,
  verifyServiceReceipt,
} from "./lib/release-evidence-trust.mjs";
import {
  computeDockerBuildContext,
  validateDeploymentManifestDocument,
} from "./lib/deployment-provenance.mjs";

const storageAccount = "stprostarmetricsexports";
const handoffTargets = Object.freeze({
  gate: Object.freeze({ container: "release-evidence-gate", queue: "release-evidence-gate" }),
  browser: Object.freeze({ container: "release-evidence-browser", queue: "release-evidence-browser" }),
  reviewer: Object.freeze({ container: "release-evidence-reviewer", queue: "release-evidence-reviewer" }),
});

export async function orchestrateReleaseEvidenceJob({
  root = process.cwd(),
  kind,
  paths,
  storageClient,
  receiptVerifier = verifyServiceReceipt,
  pollIntervalMs = 10_000,
  timeoutMs = 2 * 60 * 60 * 1000,
  sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
  now = () => Date.now(),
}) {
  if (!handoffTargets[kind]) throw new Error("evidence handoff kind must be gate, browser, or reviewer");
  const projectRoot = await realpath(resolve(root));
  const deployment = await readJson(projectRoot, paths.deploymentManifestPath, "deployment manifest");
  await validateDeploymentManifestDocument(deployment);
  const source = await computeDockerBuildContext(projectRoot);
  if (source.sha256 !== deployment.buildSourceSha256) {
    throw new Error("local evidence source does not match the pinned candidate source");
  }
  const runId = randomUUID();
  const issuedAtMs = now();
  if (!Number.isFinite(issuedAtMs)) throw new Error("evidence handoff clock returned an invalid value");
  const handoffRequest = {
    messageId: randomUUID(),
    nonce: randomBytes(32).toString("hex"),
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: new Date(issuedAtMs + MAX_HANDOFF_AGE_MS).toISOString(),
  };
  const { request, files } = await buildHandoff({
    projectRoot, kind, paths, deployment, runId, handoff: handoffRequest,
  });
  const input = await createEvidenceBundle({
    root: projectRoot,
    kind,
    direction: "input",
    runId,
    sourceSha256: source.sha256,
    files,
    request,
    createdAt: handoffRequest.issuedAt,
  });
  const storage = storageClient ?? createEvidenceStorageClient({
    accountName: storageAccount,
    credential: new AzureCliCredential(),
  });
  const { container, queue } = handoffTargets[kind];
  const inputName = `runs/${runId}/input.json`;
  const outputName = `runs/${runId}/output.json`;
  let inputEtag;
  let outputEtag;
  let operationError;
  let operationFailed = false;
  try {
    inputEtag = (await storage.putBlob({
      container, name: inputName, bytes: input.bytes, sha256: input.sha256,
    })).etag;
    await storage.enqueue({
      queue,
      message: {
        schemaVersion: 1,
        kind,
        runId,
        inputSha256: input.sha256,
        sourceSha256: source.sha256,
        ...handoffRequest,
      },
    });
    const deadline = now() + timeoutMs;
    let downloaded;
    while (now() < deadline) {
      downloaded = await storage.getBlob({ container, name: outputName });
      if (downloaded) break;
      await sleep(pollIntervalMs);
    }
    if (!downloaded) throw new Error(`${kind} evidence job did not return within the bounded timeout`);
    outputEtag = downloaded.etag;
    const output = parseEvidenceBundle(downloaded.bytes, {
      expectedKind: kind,
      expectedDirection: "output",
      expectedRunId: runId,
      expectedSha256: downloaded.metadataSha256,
      expectedSourceSha256: source.sha256,
    });
    const signedHandoff = handoffReceiptBinding(handoffRequest, input.sha256);
    validateOutputEnvelope(output.document.request, input.sha256, signedHandoff, now());
    if (output.document.request.status !== "PASS") {
      throw new Error(`${kind} evidence runner rejected the handoff: ${output.document.request.code}`);
    }
    const result = output.document.request.result;
    const receiptPath = kind === "gate" ? result.runnerReceiptPath : result.outputPath;
    const receiptBytes = output.files.get(receiptPath);
    if (!receiptBytes) throw new Error(`${kind} evidence output omitted its signed receipt`);
    const receipt = JSON.parse(receiptBytes.toString("utf8"));
    validateHandoffReceiptBinding(receipt.subject?.handoff, { nowMs: now() });
    if (JSON.stringify(receipt.subject.handoff) !== JSON.stringify(signedHandoff)) {
      throw new Error(`${kind} evidence receipt does not bind the submitted nonce and message ID`);
    }
    validateReceiptFreshness(receipt, { kind, nowMs: now() });
    await receiptVerifier({
      kind,
      receipt,
      expectedSubject: receipt.subject,
      expectedKeyId: deployment.evidenceSigningKeyIds[kind],
    });
    await materializeEvidenceFiles(projectRoot, output.files, { exclusive: true });
    return {
      kind,
      runId,
      receiptId: receipt.receiptId,
      receiptPath,
      ...result,
    };
  } catch (error) {
    operationError = error;
    operationFailed = true;
    throw error;
  } finally {
    const cleanup = await Promise.allSettled([
      Promise.resolve().then(() => storage.deleteBlob({ container, name: inputName, etag: inputEtag ?? null })),
      Promise.resolve().then(() => storage.deleteBlob({ container, name: outputName, etag: outputEtag ?? null })),
    ]);
    const cleanupErrors = cleanup.filter(({ status }) => status === "rejected").map(({ reason }) => reason);
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        operationFailed ? [operationError, ...cleanupErrors] : cleanupErrors,
        operationFailed
          ? "evidence handoff operation failed and blob cleanup was incomplete"
          : "evidence handoff blob cleanup failed",
      );
    }
  }
}

async function buildHandoff({ projectRoot, kind, paths, deployment, runId, handoff }) {
  const [e2e, a11y] = await Promise.all([
    readJson(projectRoot, paths.e2eReportPath, "E2E report"),
    readJson(projectRoot, paths.a11yReportPath, "accessibility report"),
  ]);
  const files = new Set([
    paths.deploymentManifestPath,
    paths.e2eReportPath,
    paths.a11yReportPath,
    ...Object.values(deployment.monitoringEvidence ?? {}).map(({ path }) => path),
    ...browserArtifactReferences(e2e, a11y).map(({ path }) => path),
  ]);
  if (kind === "browser") {
    if (e2e.browserAttestationPath !== a11y.browserAttestationPath) throw new Error("browser reports disagree on receipt output path");
    files.add(paths.producerResultPath);
    return {
      request: {
        schemaVersion: 1,
        handoff,
        deploymentManifestPath: paths.deploymentManifestPath,
        e2eReportPath: paths.e2eReportPath,
        a11yReportPath: paths.a11yReportPath,
        producerResultPath: paths.producerResultPath,
        outputPath: e2e.browserAttestationPath,
      },
      files: [...files],
    };
  }
  files.add(paths.browserAttestationPath);
  if (kind === "gate") {
    return {
      request: {
        schemaVersion: 1,
        handoff,
        deploymentManifestPath: paths.deploymentManifestPath,
        e2eReportPath: paths.e2eReportPath,
        a11yReportPath: paths.a11yReportPath,
        browserAttestationPath: paths.browserAttestationPath,
        outputDirectory: `docs/prostar-metrics/verification/gates/${deployment.deployedRevision}/${runId}`,
      },
      files: [...files],
    };
  }
  const gateReport = await readJson(projectRoot, paths.gateReportPath, "gate report");
  files.add(paths.gateReportPath);
  files.add(paths.gateRunnerReceiptPath);
  files.add(paths.reviewerReportPath);
  for (const run of gateReport.runs ?? []) {
    files.add(run.stdout?.path);
    files.add(run.stderr?.path);
    files.add(run.resultArtifact?.path);
  }
  return {
    request: {
      schemaVersion: 1,
      handoff,
      deploymentManifestPath: paths.deploymentManifestPath,
      e2eReportPath: paths.e2eReportPath,
      a11yReportPath: paths.a11yReportPath,
      browserAttestationPath: paths.browserAttestationPath,
      gateReportPath: paths.gateReportPath,
      gateRunnerReceiptPath: paths.gateRunnerReceiptPath,
      reviewerReportPath: paths.reviewerReportPath,
      outputPath: paths.outputPath ?? `docs/prostar-metrics/verification/reviewer/${deployment.deployedRevision}-${runId}.receipt.json`,
    },
    files: [...files],
  };
}

function validateOutputEnvelope(envelope, inputSha256, expectedHandoff, nowMs) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw new Error("evidence output envelope is invalid");
  const common = ["schemaVersion", "status", "inputSha256", "handoff", "completedAt"];
  const expected = envelope.status === "PASS" ? [...common, "result"] : [...common, "code"];
  if (JSON.stringify(Object.keys(envelope).sort()) !== JSON.stringify(expected.sort())) {
    throw new Error("evidence output envelope has unexpected fields");
  }
  if (
    envelope.schemaVersion !== 1
    || !["PASS", "FAIL"].includes(envelope.status)
    || envelope.inputSha256 !== inputSha256
    || !Number.isFinite(Date.parse(envelope.completedAt))
  ) throw new Error("evidence output envelope binding is invalid");
  validateHandoffReceiptBinding(envelope.handoff, { nowMs });
  if (JSON.stringify(envelope.handoff) !== JSON.stringify(expectedHandoff)) {
    throw new Error("evidence output envelope handoff binding mismatch");
  }
  if (Date.parse(envelope.completedAt) > Date.parse(envelope.handoff.expiresAt)) {
    throw new Error("evidence output envelope completed after the handoff expired");
  }
}

async function readJson(root, path, label) {
  if (typeof path !== "string" || !path.startsWith("docs/prostar-metrics/") || path.includes("../")) {
    throw new Error(`${label} path is unsafe or missing`);
  }
  try {
    return JSON.parse(await readFile(resolve(root, path), "utf8"));
  } catch (error) {
    throw new Error(`${label} is unavailable or invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseArguments(argv) {
  const names = new Map([
    ["--root", "root"],
    ["--kind", "kind"],
    ["--deployment-manifest", "deploymentManifestPath"],
    ["--e2e-report", "e2eReportPath"],
    ["--a11y-report", "a11yReportPath"],
    ["--producer-result", "producerResultPath"],
    ["--browser-attestation", "browserAttestationPath"],
    ["--gate-report", "gateReportPath"],
    ["--gate-runner-receipt", "gateRunnerReceiptPath"],
    ["--reviewer-report", "reviewerReportPath"],
    ["--output", "outputPath"],
  ]);
  const parsed = { paths: {} };
  for (let index = 0; index < argv.length; index += 2) {
    const field = names.get(argv[index]);
    if (!field || index + 1 >= argv.length) throw new Error(`unknown or incomplete argument: ${String(argv[index])}`);
    if (field === "root" || field === "kind") parsed[field] = argv[index + 1];
    else parsed.paths[field] = argv[index + 1];
  }
  const required = ["deploymentManifestPath", "e2eReportPath", "a11yReportPath"];
  if (parsed.kind === "browser") required.push("producerResultPath");
  else required.push("browserAttestationPath");
  if (parsed.kind === "reviewer") required.push("gateReportPath", "gateRunnerReceiptPath", "reviewerReportPath");
  if (!handoffTargets[parsed.kind] || required.some((field) => !parsed.paths[field])) {
    throw new Error("evidence submit command is missing required kind-specific paths");
  }
  return parsed;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  orchestrateReleaseEvidenceJob(parseArguments(process.argv.slice(2))).then((result) => {
    console.log(JSON.stringify(result, null, 2));
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
