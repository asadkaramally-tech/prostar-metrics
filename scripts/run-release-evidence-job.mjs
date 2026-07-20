import { ManagedIdentityCredential } from "@azure/identity";
import { spawn } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createEvidenceBundle,
  materializeEvidenceFiles,
  parseEvidenceBundle,
} from "./lib/release-evidence-bundle.mjs";
import { createManagedIdentityReceiptDependencies } from "./lib/release-evidence-managed-identity.mjs";
import { validateReviewerRunnerInputs } from "./lib/release-evidence-runner-validation.mjs";
import { createEvidenceStorageClient } from "./lib/release-evidence-storage.mjs";
import {
  handoffReceiptBinding,
  hashBytes,
  issueAzureKeyVaultReceipt,
  validateHandoffRequest,
} from "./lib/release-evidence-trust.mjs";
import { computeDockerBuildContext } from "./lib/deployment-provenance.mjs";
import { runReleaseGates } from "./run-release-gates.mjs";
import { signReleaseReceipt } from "./sign-release-receipt.mjs";

const messageSchemaVersion = 1;

export async function runReleaseEvidenceJob({
  kind,
  sourceRoot = process.cwd(),
  env = process.env,
  storageClient,
  receiptDependencies,
  azureCliInitializer = initializeAzureCliManagedIdentity,
  kindExecutor = executeKind,
  workspaceRemover = removeRunnerWorkspace,
  now = () => new Date(),
}) {
  const config = validateEnvironment(kind, env);
  const credential = new ManagedIdentityCredential(config.clientId);
  const storage = storageClient ?? createEvidenceStorageClient({ accountName: config.storageAccount, credential });
  const receiptDeps = receiptDependencies ?? createManagedIdentityReceiptDependencies({
    kind,
    clientId: config.clientId,
    subscriptionId: config.subscriptionId,
    resourceGroup: config.resourceGroup,
    credential,
  });
  const queued = await storage.receive({ queue: config.queue });
  if (!queued) return { processed: false, reason: "queue-empty" };
  const receivedAtMs = clockMs(now());
  const message = validateQueueMessage(queued.value, {
    kind,
    sourceSha256: config.sourceSha256,
    nowMs: receivedAtMs,
  });
  const signedHandoff = handoffReceiptBinding(message, message.inputSha256);
  const inputName = `runs/${message.runId}/input.json`;
  const outputName = `runs/${message.runId}/output.json`;
  const input = await storage.getBlob({
    container: config.container,
    name: inputName,
    expectedSha256: message.inputSha256,
  });
  if (!input) throw new Error("queued evidence input blob is missing");
  let workspace;
  let workspaceCleanupPath;
  let azureCliSession;
  let azureCliCleanup;
  let result;
  let handledPrimaryError;
  let fatalPrimaryError;
  try {
    const parsed = parseEvidenceBundle(input.bytes, {
      expectedKind: kind,
      expectedDirection: "input",
      expectedRunId: message.runId,
      expectedSha256: message.inputSha256,
      expectedSourceSha256: config.sourceSha256,
    });
    validateHandoffRequest(parsed.document.request?.handoff, { nowMs: receivedAtMs });
    if (parsed.document.createdAt !== message.issuedAt || JSON.stringify(parsed.document.request.handoff) !== JSON.stringify({
      messageId: message.messageId,
      nonce: message.nonce,
      issuedAt: message.issuedAt,
      expiresAt: message.expiresAt,
    })) throw new Error("evidence input bundle does not bind the queued nonce and message ID");
    await storage.createReplayClaim({
      container: config.container,
      messageId: message.messageId,
      record: {
        schemaVersion: 1,
        kind,
        runId: message.runId,
        messageId: message.messageId,
        inputSha256: message.inputSha256,
        nonceSha256: hashBytes(Buffer.from(message.nonce, "utf8")),
        issuedAt: message.issuedAt,
        expiresAt: message.expiresAt,
        claimedAt: new Date(receivedAtMs).toISOString(),
      },
    });
    workspace = await createRunnerWorkspace(sourceRoot, parsed.files, config.sourceSha256, {
      registerCleanup(path) {
        workspaceCleanupPath = path;
      },
    });
    if (kind === "gate") {
      azureCliSession = await azureCliInitializer({
        clientId: config.clientId,
        subscriptionId: config.subscriptionId,
        registerCleanup(cleanup) {
          azureCliCleanup = cleanup;
        },
      });
      azureCliCleanup ??= azureCliSession?.cleanup;
    }
    const outcome = await kindExecutor({
      kind,
      root: workspace,
      request: parsed.document.request,
      receiptDependencies: receiptDeps,
      runId: message.runId,
      handoffBinding: signedHandoff,
      gateInheritedEnv: {
        ...env,
        ...(azureCliSession ? { AZURE_CONFIG_DIR: azureCliSession.configDirectory } : {}),
      },
    });
    const outputFiles = await outputFileInventory(workspace, kind, outcome);
    const completedAt = new Date(clockMs(now())).toISOString();
    const output = await createEvidenceBundle({
      root: workspace,
      kind,
      direction: "output",
      runId: message.runId,
      sourceSha256: config.sourceSha256,
      files: outputFiles,
      request: {
        schemaVersion: 1,
        status: "PASS",
        inputSha256: message.inputSha256,
        handoff: signedHandoff,
        result: outcome,
        completedAt,
      },
      createdAt: completedAt,
    });
    await storage.putBlob({ container: config.container, name: outputName, bytes: output.bytes, sha256: output.sha256 });
    await storage.deleteMessage({ queue: config.queue, id: queued.id, popReceipt: queued.popReceipt });
    result = { processed: true, runId: message.runId, outputSha256: output.sha256 };
  } catch (error) {
    handledPrimaryError = error;
    try {
      const failure = await createSanitizedFailureBundle({
        kind,
        runId: message.runId,
        sourceSha256: config.sourceSha256,
        inputSha256: message.inputSha256,
        handoffBinding: signedHandoff,
        now,
      });
      await storage.putBlob({
        container: config.container,
        name: outputName,
        bytes: failure.bytes,
        sha256: failure.sha256,
      });
      await storage.deleteMessage({ queue: config.queue, id: queued.id, popReceipt: queued.popReceipt });
      result = {
        processed: true,
        runId: message.runId,
        outputSha256: failure.sha256,
        status: "FAIL",
        code: "EVIDENCE_VALIDATION_FAILED",
      };
    } catch (failureReportingError) {
      fatalPrimaryError = new AggregateError(
        flattenErrors([handledPrimaryError, failureReportingError]),
        "evidence runner operation and sanitized failure reporting both failed",
      );
    }
  }

  const cleanup = await Promise.allSettled([
    Promise.resolve().then(() => azureCliCleanup?.()),
    Promise.resolve().then(() => workspaceCleanupPath ? workspaceRemover(workspaceCleanupPath) : undefined),
  ]);
  const cleanupErrors = cleanup.flatMap((entry) => (
    entry.status === "rejected" ? flattenErrors([entry.reason]) : []
  ));
  if (cleanupErrors.length > 0) {
    const primaryErrors = fatalPrimaryError instanceof AggregateError
      ? flattenErrors(fatalPrimaryError.errors)
      : handledPrimaryError === undefined ? [] : flattenErrors([handledPrimaryError]);
    throw new AggregateError(
      [...primaryErrors, ...cleanupErrors],
      primaryErrors.length > 0
        ? "evidence runner operation failed and cleanup was incomplete"
        : "evidence runner cleanup was incomplete",
    );
  }
  if (fatalPrimaryError) throw fatalPrimaryError;
  return result;
}

function removeRunnerWorkspace(path) {
  return rm(path, { recursive: true, force: true });
}

async function executeKind({ kind, root, request, receiptDependencies, runId, handoffBinding, gateInheritedEnv }) {
  if (kind === "browser") {
    exactKeys(request, [
      "schemaVersion", "handoff", "deploymentManifestPath", "e2eReportPath", "a11yReportPath",
      "producerResultPath", "outputPath",
    ], "browser evidence request");
    if (request.schemaVersion !== 1) throw new Error("browser evidence request schemaVersion mismatch");
    return signReleaseReceipt({
      root,
      kind,
      deploymentManifestPath: request.deploymentManifestPath,
      e2eReportPath: request.e2eReportPath,
      a11yReportPath: request.a11yReportPath,
      producerResultPath: request.producerResultPath,
      outputPath: request.outputPath,
      handoffBinding,
      receiptDependencies,
    });
  }
  if (kind === "reviewer") {
    exactKeys(request, [
      "schemaVersion", "handoff", "deploymentManifestPath", "e2eReportPath", "a11yReportPath",
      "browserAttestationPath", "gateReportPath", "gateRunnerReceiptPath",
      "reviewerReportPath", "outputPath",
    ], "reviewer evidence request");
    if (request.schemaVersion !== 1) throw new Error("reviewer evidence request schemaVersion mismatch");
    await validateReviewerRunnerInputs({
      root,
      request,
      keyResolver: receiptDependencies.publicKeyResolver,
    });
    return signReleaseReceipt({
      root,
      kind,
      deploymentManifestPath: request.deploymentManifestPath,
      e2eReportPath: request.e2eReportPath,
      a11yReportPath: request.a11yReportPath,
      browserAttestationPath: request.browserAttestationPath,
      gateReportPath: request.gateReportPath,
      gateRunnerReceiptPath: request.gateRunnerReceiptPath,
      reviewerReportPath: request.reviewerReportPath,
      outputPath: request.outputPath,
      handoffBinding,
      receiptDependencies,
    });
  }
  exactKeys(request, [
    "schemaVersion", "handoff", "deploymentManifestPath", "e2eReportPath", "a11yReportPath",
    "browserAttestationPath", "outputDirectory",
  ], "gate evidence request");
  if (request.schemaVersion !== 1) throw new Error("gate evidence request schemaVersion mismatch");
  return runReleaseGates({
    root,
    deploymentManifestPath: request.deploymentManifestPath,
    e2eReportPath: request.e2eReportPath,
    a11yReportPath: request.a11yReportPath,
    browserAttestationPath: request.browserAttestationPath,
    outputDirectory: request.outputDirectory ?? `docs/prostar-metrics/verification/gates/remote/${runId}`,
    handoffBinding,
    inheritedEnv: gateInheritedEnv,
    receiptIssuer: ({ kind: receiptKind, expectedSubject, keyId }) => issueAzureKeyVaultReceipt({
      kind: receiptKind,
      expectedSubject,
      keyId,
      ...receiptDependencies,
    }),
  });
}

async function initializeAzureCliManagedIdentity({ clientId, subscriptionId, registerCleanup }) {
  const configDirectory = await mkdtemp(resolve(tmpdir(), "prostar-evidence-azure-cli-"));
  const cleanup = () => rm(configDirectory, { recursive: true, force: true });
  registerCleanup(cleanup);
  const env = {
    HOME: configDirectory,
    PATH: process.env.PATH ?? "",
    AZURE_CONFIG_DIR: configDirectory,
  };
  await runCommand("az", [
    "login", "--identity", "--client-id", clientId,
    "--allow-no-subscriptions", "--output", "none", "--only-show-errors",
  ], env);
  await runCommand("az", ["account", "set", "--subscription", subscriptionId, "--only-show-errors"], env);
  return { configDirectory, cleanup };
}

async function runCommand(command, args, env) {
  const child = spawn(command, args, { env, stdio: ["ignore", "ignore", "ignore"] });
  const { exitCode, signal } = await new Promise((resolveStatus, reject) => {
    child.once("error", reject);
    child.once("exit", (code, exitSignal) => resolveStatus({ exitCode: code, signal: exitSignal }));
  });
  if (exitCode !== 0 || signal !== null) throw new Error("managed-identity Azure CLI initialization failed");
}

async function outputFileInventory(root, kind, outcome) {
  if (kind !== "gate") return [outcome.outputPath];
  const report = JSON.parse(await readFile(resolve(root, outcome.gateReportPath), "utf8"));
  return [
    outcome.gateReportPath,
    outcome.runnerReceiptPath,
    ...report.runs.flatMap((run) => [run.stdout.path, run.stderr.path, run.resultArtifact.path]),
  ];
}

async function createSanitizedFailureBundle({ kind, runId, sourceSha256, inputSha256, handoffBinding, now }) {
  const root = await mkdtemp(resolve(tmpdir(), "prostar-evidence-failure-"));
  try {
    const path = `docs/prostar-metrics/verification/evidence-runners/${runId}/failure.json`;
    const completedAt = new Date(clockMs(now())).toISOString();
    await mkdir(dirname(resolve(root, path)), { recursive: true });
    await writeFile(resolve(root, path), `${JSON.stringify({
      schemaVersion: 1,
      kind,
      runId,
      outcome: "FAIL",
      code: "EVIDENCE_VALIDATION_FAILED",
        inputSha256,
        handoff: handoffBinding,
        completedAt,
    }, null, 2)}\n`, { flag: "wx", mode: 0o400 });
    return createEvidenceBundle({
      root,
      kind,
      direction: "output",
      runId,
      sourceSha256,
      files: [path],
      request: {
        schemaVersion: 1,
        status: "FAIL",
        inputSha256,
        handoff: handoffBinding,
        code: "EVIDENCE_VALIDATION_FAILED",
        completedAt,
      },
      createdAt: completedAt,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function createRunnerWorkspace(sourceRoot, evidenceFiles, expectedSourceSha256, { registerCleanup }) {
  const source = await computeDockerBuildContext(sourceRoot);
  if (source.sha256 !== expectedSourceSha256) throw new Error("evidence runner image source does not match the candidate source hash");
  const root = await mkdtemp(resolve(tmpdir(), "prostar-evidence-job-"));
  registerCleanup(root);
  for (const entry of source.entries) {
    const from = resolve(sourceRoot, entry.path);
    const to = resolve(root, entry.path);
    if (entry.type === "D") await mkdir(to, { recursive: true });
    else if (entry.type === "L") {
      await mkdir(dirname(to), { recursive: true });
      await symlink(await readlink(from), to);
    } else {
      await mkdir(dirname(to), { recursive: true });
      await copyFile(from, to);
    }
  }
  const nodeModules = resolve(root, "node_modules");
  try {
    await lstat(nodeModules);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await symlink(resolve(sourceRoot, "node_modules"), nodeModules);
  }
  await materializeEvidenceFiles(root, evidenceFiles, { exclusive: false });
  return root;
}

function flattenErrors(values) {
  return values.flatMap((value) => (
    value instanceof AggregateError ? flattenErrors(value.errors) : [value]
  ));
}

function validateEnvironment(kind, env) {
  const expected = {
    RELEASE_EVIDENCE_KIND: kind,
  };
  for (const [name, value] of Object.entries(expected)) {
    if (env[name] !== value) throw new Error(`${name} does not match the fixed job kind`);
  }
  const config = {
    clientId: env.AZURE_CLIENT_ID,
    subscriptionId: env.AZURE_SUBSCRIPTION_ID,
    resourceGroup: env.AZURE_RESOURCE_GROUP,
    storageAccount: env.RELEASE_EVIDENCE_STORAGE_ACCOUNT,
    container: env.RELEASE_EVIDENCE_CONTAINER,
    queue: env.RELEASE_EVIDENCE_QUEUE,
    sourceSha256: env.RELEASE_EVIDENCE_SOURCE_SHA256,
  };
  if (!/^[0-9a-f-]{36}$/i.test(config.clientId ?? "") || !/^[0-9a-f-]{36}$/i.test(config.subscriptionId ?? "")) {
    throw new Error("evidence job identity/subscription configuration is invalid");
  }
  if (!/^[a-f0-9]{64}$/.test(config.sourceSha256 ?? "")) throw new Error("evidence job source hash is invalid");
  for (const name of ["resourceGroup", "storageAccount", "container", "queue"]) {
    if (typeof config[name] !== "string" || !config[name]) throw new Error(`evidence job ${name} is missing`);
  }
  return config;
}

function validateQueueMessage(value, { kind, sourceSha256, nowMs }) {
  exactKeys(value, [
    "schemaVersion", "kind", "runId", "inputSha256", "sourceSha256",
    "messageId", "nonce", "issuedAt", "expiresAt",
  ], "evidence queue message");
  if (value.schemaVersion !== messageSchemaVersion || value.kind !== kind || value.sourceSha256 !== sourceSha256) {
    throw new Error("evidence queue message binding mismatch");
  }
  if (!/^[0-9a-f-]{36}$/i.test(value.runId ?? "") || !/^[a-f0-9]{64}$/.test(value.inputSha256 ?? "")) {
    throw new Error("evidence queue message identifiers are invalid");
  }
  validateHandoffRequest({
    messageId: value.messageId,
    nonce: value.nonce,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
  }, { nowMs });
  return value;
}

function clockMs(value) {
  const result = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(result)) throw new Error("evidence runner clock returned an invalid timestamp");
  return result;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`${label} has unexpected fields`);
}

function parseKind(argv) {
  if (argv.length !== 2 || argv[0] !== "--kind" || !["gate", "browser", "reviewer"].includes(argv[1])) {
    throw new Error("usage: node scripts/run-release-evidence-job.mjs --kind <gate|browser|reviewer>");
  }
  return argv[1];
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  runReleaseEvidenceJob({ kind: parseKind(process.argv.slice(2)) }).then((result) => {
    console.log(JSON.stringify(result));
  }).catch(() => {
    console.error("release evidence job failed; inspect sanitized job telemetry");
    process.exitCode = 1;
  });
}
