import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { assertCredentialSafeEvidence } from "./check-release-evidence.mjs";
import {
  BROWSER_ARTIFACT_VALIDATION_SCHEMA_VERSION,
  BROWSER_ARTIFACT_VALIDATOR_NAME,
  BROWSER_ARTIFACT_VALIDATOR_VERSION,
  browserArtifactReferences,
  jsonBytes,
  validateBrowserArtifactValidationResult,
} from "./lib/release-evidence-trust.mjs";

export async function validateBrowserArtifacts({
  root = process.cwd(),
  deploymentManifestPath,
  e2eReportPath,
  a11yReportPath,
  outputPath,
  executionId = randomUUID(),
}) {
  const projectRoot = resolve(root);
  const [deployment, e2e, a11y] = await Promise.all([
    readJson(projectRoot, deploymentManifestPath, "deployment manifest"),
    readJson(projectRoot, e2eReportPath, "E2E report"),
    readJson(projectRoot, a11yReportPath, "accessibility report"),
  ]);
  const artifactReferences = browserArtifactReferences(e2e, a11y);
  await verifyArtifacts(projectRoot, artifactReferences);
  const [e2eReportSha256, a11yReportSha256] = await Promise.all([
    fileSha256(projectRoot, e2eReportPath),
    fileSha256(projectRoot, a11yReportPath),
  ]);
  const document = {
    schemaVersion: BROWSER_ARTIFACT_VALIDATION_SCHEMA_VERSION,
    producer: { name: BROWSER_ARTIFACT_VALIDATOR_NAME, version: BROWSER_ARTIFACT_VALIDATOR_VERSION, executionId },
    outcome: "PASS",
    sessionId: e2e.sessionId,
    deploymentNonce: e2e.deploymentNonce,
    deployedRevision: e2e.deployedRevision,
    imageDigest: e2e.imageDigest,
    authenticatedActor: e2e.authenticatedActor,
    startedAt: new Date(Math.min(Date.parse(e2e.startedAt), Date.parse(a11y.startedAt))).toISOString(),
    completedAt: new Date(Math.max(Date.parse(e2e.completedAt), Date.parse(a11y.completedAt))).toISOString(),
    e2eReport: { path: e2eReportPath, sha256: e2eReportSha256 },
    a11yReport: { path: a11yReportPath, sha256: a11yReportSha256 },
    artifacts: artifactReferences,
  };
  validateBrowserArtifactValidationResult(document, {
    deployment,
    e2e,
    a11y,
    e2eReportPath,
    e2eReportSha256,
    a11yReportPath,
    a11yReportSha256,
    artifactReferences,
  });
  const bytes = jsonBytes(document);
  assertCredentialSafeEvidence(bytes, "browser artifact validation result");
  await writeAtomic(projectRoot, outputPath, bytes);
  return { outputPath, sha256: createHash("sha256").update(bytes).digest("hex"), executionId };
}

async function verifyArtifacts(root, references) {
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
    const bytes = await readFile(resolve(root, reference.path));
    assertCredentialSafeEvidence(bytes, `browser artifact ${reference.path}`);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== reference.sha256) throw new Error(`browser raw artifact hash mismatch: ${reference.path}`);
  }
}

async function readJson(root, path, label) {
  try {
    const bytes = await readFile(resolve(root, path));
    assertCredentialSafeEvidence(bytes, label);
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is unavailable or invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function fileSha256(root, path) {
  return createHash("sha256").update(await readFile(resolve(root, path))).digest("hex");
}

async function writeAtomic(root, path, bytes) {
  if (!path) throw new Error("browser artifact validation output path is required");
  const target = resolve(root, path);
  const temporary = `${target}.partial-${process.pid}-${Date.now()}`;
  await mkdir(dirname(target), { recursive: true });
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o400 });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

function parseArguments(argv) {
  const fields = new Map([
    ["--root", "root"],
    ["--deployment-manifest", "deploymentManifestPath"],
    ["--e2e-report", "e2eReportPath"],
    ["--a11y-report", "a11yReportPath"],
    ["--output", "outputPath"],
  ]);
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const field = fields.get(argv[index]);
    if (!field || index + 1 >= argv.length) throw new Error(`unknown or incomplete argument: ${String(argv[index])}`);
    result[field] = argv[index + 1];
  }
  for (const field of ["deploymentManifestPath", "e2eReportPath", "a11yReportPath", "outputPath"]) {
    if (!result[field]) throw new Error(`missing required argument for ${field}`);
  }
  return result;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  validateBrowserArtifacts(parseArguments(process.argv.slice(2))).then((result) => {
    console.log(JSON.stringify(result, null, 2));
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
