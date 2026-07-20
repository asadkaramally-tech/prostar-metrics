import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import { assertCredentialSafeEvidence } from "../check-release-evidence.mjs";
import { ReleaseEvidenceTrustError, jsonBytes } from "./release-evidence-trust.mjs";

export const EVIDENCE_BUNDLE_SCHEMA_VERSION = 1;
export const EVIDENCE_KINDS = Object.freeze(["gate", "browser", "reviewer"]);
export const MAX_EVIDENCE_BUNDLE_BYTES = 64 * 1024 * 1024;
export const MAX_EVIDENCE_FILES = 128;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256Pattern = /^[a-f0-9]{64}$/;

export async function createEvidenceBundle({
  root,
  kind,
  direction = "input",
  runId,
  sourceSha256,
  files,
  request,
  createdAt = new Date().toISOString(),
}) {
  validateHeader({ kind, direction, runId, sourceSha256, createdAt });
  if (!Array.isArray(files) || files.length < 1 || files.length > MAX_EVIDENCE_FILES) {
    throw new ReleaseEvidenceTrustError(`evidence bundle must contain 1-${MAX_EVIDENCE_FILES} files`);
  }
  const projectRoot = resolve(root);
  const seen = new Set();
  const entries = [];
  let contentBytes = 0;
  for (const file of files) {
    const path = normalizeEvidencePath(projectRoot, file);
    if (seen.has(path)) throw new ReleaseEvidenceTrustError(`evidence bundle contains duplicate path ${path}`);
    seen.add(path);
    const bytes = await readFile(resolve(projectRoot, path));
    assertCredentialSafeEvidence(bytes, `handoff artifact ${path}`);
    contentBytes += bytes.length;
    if (contentBytes > MAX_EVIDENCE_BUNDLE_BYTES) throw new ReleaseEvidenceTrustError("evidence bundle content exceeds 64 MiB");
    entries.push({
      path,
      sha256: hashBytes(bytes),
      bytes: bytes.length,
      bodyBase64: bytes.toString("base64"),
    });
  }
  const document = {
    schemaVersion: EVIDENCE_BUNDLE_SCHEMA_VERSION,
    kind,
    direction,
    runId,
    sourceSha256,
    createdAt,
    request,
    files: entries,
  };
  const bytes = jsonBytes(document);
  if (bytes.length > MAX_EVIDENCE_BUNDLE_BYTES) throw new ReleaseEvidenceTrustError("encoded evidence bundle exceeds 64 MiB");
  assertCredentialSafeEvidence(bytes, `${kind} ${direction} handoff bundle`);
  return { document, bytes, sha256: hashBytes(bytes) };
}

export function parseEvidenceBundle(bytes, {
  expectedKind,
  expectedDirection,
  expectedRunId,
  expectedSha256,
  expectedSourceSha256,
}) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > MAX_EVIDENCE_BUNDLE_BYTES) {
    throw new ReleaseEvidenceTrustError("evidence handoff bundle has an invalid byte length");
  }
  if (hashBytes(bytes) !== expectedSha256) throw new ReleaseEvidenceTrustError("evidence handoff bundle SHA-256 mismatch");
  assertCredentialSafeEvidence(bytes, `${expectedKind} ${expectedDirection} handoff bundle`);
  let document;
  try {
    document = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ReleaseEvidenceTrustError("evidence handoff bundle is invalid JSON");
  }
  exactKeys(document, [
    "schemaVersion", "kind", "direction", "runId", "sourceSha256", "createdAt", "request", "files",
  ], "evidence handoff bundle");
  if (document.schemaVersion !== EVIDENCE_BUNDLE_SCHEMA_VERSION) throw new ReleaseEvidenceTrustError("evidence handoff schemaVersion mismatch");
  validateHeader(document);
  if (
    document.kind !== expectedKind
    || document.direction !== expectedDirection
    || document.runId !== expectedRunId
    || document.sourceSha256 !== expectedSourceSha256
  ) throw new ReleaseEvidenceTrustError("evidence handoff binding mismatch");
  if (!Array.isArray(document.files) || document.files.length < 1 || document.files.length > MAX_EVIDENCE_FILES) {
    throw new ReleaseEvidenceTrustError("evidence handoff file inventory is invalid");
  }
  const decodedFiles = new Map();
  let total = 0;
  for (const [index, file] of document.files.entries()) {
    exactKeys(file, ["path", "sha256", "bytes", "bodyBase64"], `evidence handoff file ${index + 1}`);
    const path = normalizeRelativeEvidencePath(file.path);
    if (decodedFiles.has(path)) throw new ReleaseEvidenceTrustError(`evidence handoff contains duplicate path ${path}`);
    if (!sha256Pattern.test(file.sha256 ?? "") || !Number.isInteger(file.bytes) || file.bytes < 0) {
      throw new ReleaseEvidenceTrustError(`evidence handoff file ${path} has invalid metadata`);
    }
    let content;
    try {
      content = Buffer.from(file.bodyBase64, "base64");
    } catch {
      throw new ReleaseEvidenceTrustError(`evidence handoff file ${path} is invalid base64`);
    }
    if (content.length !== file.bytes || hashBytes(content) !== file.sha256) {
      throw new ReleaseEvidenceTrustError(`evidence handoff file ${path} failed byte/hash verification`);
    }
    assertCredentialSafeEvidence(content, `handoff artifact ${path}`);
    total += content.length;
    if (total > MAX_EVIDENCE_BUNDLE_BYTES) throw new ReleaseEvidenceTrustError("evidence handoff decoded content exceeds 64 MiB");
    decodedFiles.set(path, content);
  }
  return { document, files: decodedFiles };
}

export async function materializeEvidenceFiles(root, files, { exclusive = true } = {}) {
  for (const [path, bytes] of files.entries()) {
    const target = resolve(root, normalizeRelativeEvidencePath(path));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: exclusive ? "wx" : "w", mode: 0o400 });
  }
}

export function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateHeader({ kind, direction, runId, sourceSha256, createdAt }) {
  if (!EVIDENCE_KINDS.includes(kind)) throw new ReleaseEvidenceTrustError(`unsupported evidence kind ${String(kind)}`);
  if (!['input', 'output'].includes(direction)) throw new ReleaseEvidenceTrustError("invalid evidence handoff direction");
  if (!uuidPattern.test(runId ?? "")) throw new ReleaseEvidenceTrustError("evidence handoff runId must be a UUID");
  if (!sha256Pattern.test(sourceSha256 ?? "")) throw new ReleaseEvidenceTrustError("evidence handoff source SHA-256 is invalid");
  if (typeof createdAt !== "string" || !createdAt.endsWith("Z") || !Number.isFinite(Date.parse(createdAt))) {
    throw new ReleaseEvidenceTrustError("evidence handoff createdAt must be an ISO-8601 UTC timestamp");
  }
}

function normalizeEvidencePath(root, input) {
  if (typeof input !== "string" || !input) throw new ReleaseEvidenceTrustError("evidence file path is required");
  const absolute = resolve(root, input);
  const relativePath = relative(root, absolute);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    throw new ReleaseEvidenceTrustError("evidence file path escapes the project root");
  }
  return normalizeRelativeEvidencePath(relativePath);
}

function normalizeRelativeEvidencePath(value) {
  const path = String(value).split(sep).join("/");
  if (
    path.startsWith("/")
    || path.includes("../")
    || !path.startsWith("docs/prostar-metrics/")
    || /(?:^|\/)\.\.?($|\/)/.test(path)
  ) throw new ReleaseEvidenceTrustError(`unsafe evidence path ${path}`);
  return path;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ReleaseEvidenceTrustError(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new ReleaseEvidenceTrustError(`${label} has unexpected fields`);
}
