import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, readlink, rename, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

export const DEPLOYMENT_RESUME_SCHEMA_VERSION = 2;
const sha256Pattern = /^[a-f0-9]{64}$/;
const imageDigestPattern = /^sha256:[a-f0-9]{64}$/;
const imageTagPattern = /^deploy-[a-f0-9]{16}-[0-9a-f-]{36}$/;
const certificateDomain = "prostar-deploy-certification-v1\0";
const dependenciesDomain = "prostar-deploy-dependencies-v1\0";

function hashParts(domain, parts) {
  const hash = createHash("sha256").update(domain);
  for (const part of parts) {
    hash.update(String(Buffer.byteLength(part, "utf8"))).update(":").update(part).update("\0");
  }
  return hash.digest("hex");
}

function assertSha256(value, label) {
  if (!sha256Pattern.test(value ?? "")) throw new Error(`${label} must be a canonical SHA-256`);
}

export function createDeploymentCertificationKey({ sourceSha256, dependencySha256 }) {
  assertSha256(sourceSha256, "Deployment source SHA-256");
  assertSha256(dependencySha256, "Deployment dependency SHA-256");
  return hashParts(certificateDomain, [sourceSha256, dependencySha256]);
}

export function resumeRecordPath({ stateDirectory, sourceSha256, dependencySha256 }) {
  const certificationKey = createDeploymentCertificationKey({ sourceSha256, dependencySha256 });
  return resolve(stateDirectory, `${certificationKey}.json`);
}

export async function computeDependencyTreeSha256(dependencyRoot) {
  const root = resolve(dependencyRoot);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Deployment dependencies must be a real directory before certification");
  }
  const entries = [];
  async function visit(directory) {
    const names = await readdir(directory);
    for (const name of names.sort()) {
      const candidate = resolve(directory, name);
      const stat = await lstat(candidate);
      const entryPath = relative(root, candidate).split(sep).join("/");
      if (!entryPath || entryPath.startsWith("../")) throw new Error("Dependency path escaped its certification root");
      if (stat.isDirectory()) {
        entries.push({ path: entryPath, type: "D", mode: stat.mode & 0o777 });
        await visit(candidate);
      } else if (stat.isSymbolicLink()) {
        entries.push({ path: entryPath, type: "L", mode: stat.mode & 0o777, bytes: await readlink(candidate) });
      } else if (stat.isFile()) {
        entries.push({ path: entryPath, type: "F", mode: stat.mode & 0o777, bytes: await readFile(candidate) });
      } else {
        throw new Error(`Unsupported dependency entry in deployment certification: ${entryPath}`);
      }
    }
  }
  await visit(root);
  const hash = createHash("sha256").update(dependenciesDomain);
  for (const entry of entries) {
    hash.update(`${entry.type}\0${entry.path}\0${entry.mode.toString(8)}\0`);
    if (entry.bytes !== undefined) {
      const bytes = Buffer.isBuffer(entry.bytes) ? entry.bytes : Buffer.from(entry.bytes, "utf8");
      hash.update(String(bytes.length)).update("\0").update(bytes).update("\0");
    }
  }
  return hash.digest("hex");
}

export function validateDeploymentResumeRecord(record, { sourceSha256, dependencySha256 }) {
  const certificationKey = createDeploymentCertificationKey({ sourceSha256, dependencySha256 });
  const keys = ["schemaVersion", "certificationKey", "sourceSha256", "dependencySha256", "certificationMode", "preflightSucceededAt", "acrBuild"];
  if (!record || typeof record !== "object" || Array.isArray(record)
    || Object.keys(record).some((key) => !keys.includes(key))) return null;
  if (record.schemaVersion !== DEPLOYMENT_RESUME_SCHEMA_VERSION
    || record.certificationKey !== certificationKey
    || record.sourceSha256 !== sourceSha256
    || record.dependencySha256 !== dependencySha256
    || !["routine", "full"].includes(record.certificationMode)
    || !Number.isFinite(Date.parse(record.preflightSucceededAt ?? ""))) return null;
  const build = record.acrBuild;
  if (!build || typeof build !== "object" || Array.isArray(build)
    || JSON.stringify(Object.keys(build).sort()) !== JSON.stringify(["createdAt", "digest", "imageTag", "runId"])) return null;
  if (typeof build.runId !== "string" || !build.runId.trim()
    || !Number.isFinite(Date.parse(build.createdAt ?? ""))
    || !imageDigestPattern.test(build.digest ?? "")
    || !imageTagPattern.test(build.imageTag ?? "")
    || !build.imageTag.startsWith(`deploy-${sourceSha256.slice(0, 16)}-`)) return null;
  return Object.freeze({
    schemaVersion: DEPLOYMENT_RESUME_SCHEMA_VERSION,
    certificationKey,
    sourceSha256,
    dependencySha256,
    certificationMode: record.certificationMode,
    preflightSucceededAt: new Date(buildTimestamp(record.preflightSucceededAt)).toISOString(),
    acrBuild: Object.freeze({
      runId: build.runId,
      createdAt: new Date(buildTimestamp(build.createdAt)).toISOString(),
      digest: build.digest,
      imageTag: build.imageTag,
    }),
  });
}

function buildTimestamp(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("Invalid cached deployment certificate timestamp");
  return timestamp;
}

export async function readReusableDeploymentCertificate({ stateDirectory, sourceSha256, dependencySha256 }) {
  const target = resumeRecordPath({ stateDirectory, sourceSha256, dependencySha256 });
  let document;
  try {
    document = JSON.parse(await readFile(target, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
  return validateDeploymentResumeRecord(document, { sourceSha256, dependencySha256 });
}

export async function writeDeploymentCertificate({ stateDirectory, sourceSha256, dependencySha256, certificationMode, preflightSucceededAt, acrBuild }) {
  const certificationKey = createDeploymentCertificationKey({ sourceSha256, dependencySha256 });
  const record = validateDeploymentResumeRecord({
    schemaVersion: DEPLOYMENT_RESUME_SCHEMA_VERSION,
    certificationKey,
    sourceSha256,
    dependencySha256,
    certificationMode,
    preflightSucceededAt,
    acrBuild,
  }, { sourceSha256, dependencySha256 });
  if (!record) throw new Error("Refusing to write an invalid deployment certificate");
  const target = resumeRecordPath({ stateDirectory, sourceSha256, dependencySha256 });
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.partial-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await chmod(temporary, 0o600);
  await rename(temporary, target);
  return { path: target, record };
}
