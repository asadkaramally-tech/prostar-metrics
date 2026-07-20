import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRoot = resolve(import.meta.dirname, "..");
const manifestRelativePath = "docs/prostar-metrics/reference/manifest.json";
const sidecarRelativePath = "docs/prostar-metrics/reference/manifest.sha256";
const authoritativeCopies = [
  "docs/prostar-metrics/reference/simpro-swagger.json",
  "docs/prostar-metrics/reference/quote-dashboard.html",
  "docs/prostar-metrics/reference/commissions-dashboard.html",
  "docs/prostar-metrics/execution-plan.md",
];

export async function validateReferenceManifest({ root = defaultRoot } = {}) {
  const projectRoot = await realpath(resolve(root));
  const manifestPath = resolve(projectRoot, manifestRelativePath);
  const referenceDirectory = resolve(projectRoot, "docs/prostar-metrics/reference");
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (!Array.isArray(manifest.artifacts)) {
    throw new Error("reference manifest artifacts must be an array");
  }

  const copies = manifest.artifacts.map((artifact) => artifact?.copy);
  if (JSON.stringify(copies) !== JSON.stringify(authoritativeCopies)) {
    throw new Error(
      `reference manifest authoritative inventory mismatch: expected ${JSON.stringify(authoritativeCopies)}, received ${JSON.stringify(copies)}`,
    );
  }

  const expectedSidecar = [{
    sha256: sha256(manifestBytes),
    path: "manifest.json",
  }];
  for (const artifact of manifest.artifacts) {
    if (!artifact || typeof artifact !== "object") {
      throw new Error("reference manifest artifact must be an object");
    }
    if (!/^[a-f0-9]{64}$/.test(artifact.sha256 ?? "")) {
      throw new Error(`${String(artifact.copy)} manifest sha256 must be 64 lowercase hex characters`);
    }
    const artifactPath = resolve(projectRoot, artifact.copy);
    if (!isWithin(projectRoot, artifactPath)) {
      throw new Error(`${artifact.copy} escapes the project root`);
    }
    const bytes = await readFile(artifactPath);
    const actual = sha256(bytes);
    if (actual !== artifact.sha256) {
      throw new Error(
        `${artifact.copy} hash mismatch: expected ${artifact.sha256}, received ${actual}`,
      );
    }
    expectedSidecar.push({
      sha256: actual,
      path: normalizePath(relative(referenceDirectory, artifactPath)),
    });
  }

  const sidecar = parseSidecar(await readFile(resolve(projectRoot, sidecarRelativePath), "utf8"));
  const duplicatePaths = sidecar
    .map((entry) => entry.path)
    .filter((path, index, paths) => paths.indexOf(path) !== index);
  if (duplicatePaths.length) {
    throw new Error(`reference sidecar contains duplicate paths: ${[...new Set(duplicatePaths)].join(", ")}`);
  }
  if (JSON.stringify(sidecar) !== JSON.stringify(expectedSidecar)) {
    throw new Error(
      `reference sidecar is stale or incomplete: expected ${JSON.stringify(expectedSidecar)}, received ${JSON.stringify(sidecar)}`,
    );
  }

  return { artifacts: manifest.artifacts.length, sidecarEntries: sidecar.length };
}

function parseSidecar(text) {
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  if (lines.length === 1 && lines[0] === "") throw new Error("reference sidecar is empty");
  return lines.map((line, index) => {
    const match = /^([a-f0-9]{64})  (\S+)$/.exec(line);
    if (!match) throw new Error(`reference sidecar line ${index + 1} is malformed`);
    return { sha256: match[1], path: match[2] };
  });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizePath(path) {
  return path.split(sep).join("/");
}

function isWithin(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..");
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    const result = await validateReferenceManifest();
    console.log(
      `Validated ${result.artifacts} authoritative reference artifacts and ${result.sidecarEntries} sidecar hashes.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
