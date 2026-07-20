import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { validateReferenceManifest } from "../../scripts/check-reference-manifest.mjs";

const copies = [
  "docs/prostar-metrics/reference/simpro-swagger.json",
  "docs/prostar-metrics/reference/quote-dashboard.html",
  "docs/prostar-metrics/reference/commissions-dashboard.html",
  "docs/prostar-metrics/execution-plan.md",
];

test("validates manifest metadata, all authoritative files, and the exact sidecar", async () => {
  const root = await referenceFixture();
  assert.deepEqual(
    await validateReferenceManifest({ root }),
    { artifacts: 4, sidecarEntries: 5 },
  );
});

test("rejects a sidecar made stale by a manifest-only edit", async () => {
  const root = await referenceFixture();
  const path = join(root, "docs/prostar-metrics/reference/manifest.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  manifest.copiedAt = "2026-07-14T00:00:00Z";
  await writeJson(path, manifest);
  await assert.rejects(validateReferenceManifest({ root }), /sidecar is stale or incomplete/);
});

test("rejects an authoritative file changed after the manifest was written", async () => {
  const root = await referenceFixture();
  await writeFile(join(root, copies[1]), "changed reference\n");
  await assert.rejects(validateReferenceManifest({ root }), /quote-dashboard\.html hash mismatch/);
});

test("rejects missing, extra, duplicate, and reordered sidecar entries", async (t) => {
  const root = await referenceFixture();
  const path = join(root, "docs/prostar-metrics/reference/manifest.sha256");
  const original = (await readFile(path, "utf8")).trimEnd().split("\n");
  const cases = [
    ["missing", original.slice(0, -1), /stale or incomplete/],
    ["extra", [...original, `${"a".repeat(64)}  extra.txt`], /stale or incomplete/],
    ["duplicate", [...original, original[0]], /duplicate paths: manifest\.json/],
    ["reordered", [original[1], original[0], ...original.slice(2)], /stale or incomplete/],
  ];
  for (const [name, lines, pattern] of cases) {
    await t.test(name, async () => {
      await writeFile(path, `${lines.join("\n")}\n`);
      await assert.rejects(validateReferenceManifest({ root }), pattern);
      await writeFile(path, `${original.join("\n")}\n`);
    });
  }
});

async function referenceFixture() {
  const root = await mkdtemp(join(tmpdir(), "reference-manifest-"));
  const artifacts = [];
  for (const [index, copy] of copies.entries()) {
    const bytes = `authoritative-${index}\n`;
    await writeFileAt(root, copy, bytes);
    artifacts.push({
      source: `/source/${index}`,
      copy,
      sha256: hash(bytes),
    });
  }
  const manifestPath = "docs/prostar-metrics/reference/manifest.json";
  await writeFileAt(root, manifestPath, `${JSON.stringify({
    copiedAt: "2026-07-13T00:00:00Z",
    artifacts,
  }, null, 2)}\n`);
  const manifestBytes = await readFile(join(root, manifestPath));
  const sidecar = [
    `${hash(manifestBytes)}  manifest.json`,
    ...artifacts.map((artifact) => {
      const relativePath = artifact.copy.endsWith("execution-plan.md")
        ? "../execution-plan.md"
        : artifact.copy.split("/").at(-1);
      return `${artifact.sha256}  ${relativePath}`;
    }),
  ];
  await writeFileAt(
    root,
    "docs/prostar-metrics/reference/manifest.sha256",
    `${sidecar.join("\n")}\n`,
  );
  return root;
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeFileAt(root, relativePath, value) {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value);
}
