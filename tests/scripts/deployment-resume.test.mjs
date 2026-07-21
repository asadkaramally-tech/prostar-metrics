import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  computeDependencyTreeSha256,
  createDeploymentCertificationKey,
  readReusableDeploymentCertificate,
  resumeRecordPath,
  validateDeploymentResumeRecord,
  writeDeploymentCertificate,
} from "../../scripts/lib/deployment-resume.mjs";

const sourceSha256 = "a".repeat(64);
const dependencySha256 = "b".repeat(64);
const acrBuild = Object.freeze({
  runId: "cr123",
  createdAt: "2026-07-20T12:00:00.000Z",
  digest: `sha256:${"c".repeat(64)}`,
  imageTag: `deploy-${"a".repeat(16)}-00000000-0000-4000-8000-000000000000`,
});

test("deployment resume certificates are content-addressed by source and materialized dependencies", () => {
  const key = createDeploymentCertificationKey({ sourceSha256, dependencySha256 });
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.notEqual(key, createDeploymentCertificationKey({ sourceSha256: "d".repeat(64), dependencySha256 }));
  assert.notEqual(key, createDeploymentCertificationKey({ sourceSha256, dependencySha256: "e".repeat(64) }));
});

test("deployment resume rejects malformed, mismatched, and unbound ACR certificates", () => {
  const valid = {
    schemaVersion: 1,
    certificationKey: createDeploymentCertificationKey({ sourceSha256, dependencySha256 }),
    sourceSha256,
    dependencySha256,
    preflightSucceededAt: "2026-07-20T11:00:00.000Z",
    acrBuild,
  };
  assert.deepEqual(validateDeploymentResumeRecord(valid, { sourceSha256, dependencySha256 })?.acrBuild, acrBuild);
  assert.equal(validateDeploymentResumeRecord({ ...valid, dependencySha256: "d".repeat(64) }, { sourceSha256, dependencySha256 }), null);
  assert.equal(validateDeploymentResumeRecord({ ...valid, acrBuild: { ...acrBuild, imageTag: `deploy-${"d".repeat(16)}-00000000-0000-4000-8000-000000000000` } }, { sourceSha256, dependencySha256 }), null);
  assert.equal(validateDeploymentResumeRecord({ ...valid, unexpected: true }, { sourceSha256, dependencySha256 }), null);
});

test("deployment resume persists only an exact certificate and ignores corrupted state", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-resume-"));
  try {
    const written = await writeDeploymentCertificate({
      stateDirectory: root,
      sourceSha256,
      dependencySha256,
      preflightSucceededAt: "2026-07-20T11:00:00.000Z",
      acrBuild,
    });
    assert.equal(written.record.acrBuild.digest, acrBuild.digest);
    assert.deepEqual(
      await readReusableDeploymentCertificate({ stateDirectory: root, sourceSha256, dependencySha256 }),
      written.record,
    );
    assert.equal(
      await readReusableDeploymentCertificate({ stateDirectory: root, sourceSha256, dependencySha256: "d".repeat(64) }),
      null,
    );
    await writeFile(resumeRecordPath({ stateDirectory: root, sourceSha256, dependencySha256 }), "not-json\n");
    assert.equal(await readReusableDeploymentCertificate({ stateDirectory: root, sourceSha256, dependencySha256 }), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dependency certification changes when installed dependency bytes, modes, or symlink targets change", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-dependencies-"));
  try {
    await mkdir(join(root, "pkg"), { recursive: true });
    await writeFile(join(root, "pkg", "index.mjs"), "export const release = 1;\n");
    await writeFile(join(root, "pkg", "other.mjs"), "export const release = 1;\n");
    await symlink("pkg/index.mjs", join(root, "tool"));
    const original = await computeDependencyTreeSha256(root);
    await writeFile(join(root, "pkg", "index.mjs"), "export const release = 2;\n");
    assert.notEqual(await computeDependencyTreeSha256(root), original);
    await writeFile(join(root, "pkg", "index.mjs"), "export const release = 1;\n");
    await chmod(join(root, "pkg", "index.mjs"), 0o755);
    assert.notEqual(await computeDependencyTreeSha256(root), original);
    await chmod(join(root, "pkg", "index.mjs"), 0o644);
    await unlink(join(root, "tool"));
    await symlink("pkg/other.mjs", join(root, "tool"));
    assert.notEqual(await computeDependencyTreeSha256(root), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
