import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { releaseGateAssertionEvent } from "./lib/release-gate-assertions.mjs";

const root = resolve(import.meta.dirname, "..");
const buildRoot = resolve(root, ".next");
const startedAt = Date.now();
const child = spawn(process.execPath, [resolve(root, "node_modules/next/dist/bin/next"), "build"], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
});
const exitCode = await new Promise((resolveExit, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (signal) reject(new Error(`Next build exited from signal ${signal}`));
    else resolveExit(code ?? 1);
  });
});
if (exitCode !== 0) {
  process.exitCode = exitCode;
} else {
  const buildIdPath = resolve(buildRoot, "BUILD_ID");
  const [buildIdBytes, buildIdStat, routesBytes, requiredBytes] = await Promise.all([
    readFile(buildIdPath),
    stat(buildIdPath),
    readFile(resolve(buildRoot, "routes-manifest.json")),
    readFile(resolve(buildRoot, "required-server-files.json")),
  ]);
  const buildId = buildIdBytes.toString("utf8").trim();
  if (!buildId || buildIdStat.mtimeMs < startedAt - 2_000) {
    throw new Error("Next build did not produce a fresh concrete BUILD_ID");
  }
  const routes = JSON.parse(routesBytes.toString("utf8"));
  const routeCount = [routes.staticRoutes, routes.dynamicRoutes, routes.redirects]
    .reduce((count, values) => count + (Array.isArray(values) ? values.length : 0), 0);
  const required = JSON.parse(requiredBytes.toString("utf8"));
  const requiredFileCount = Array.isArray(required.files) ? required.files.length : 0;
  if (routeCount <= 0 || requiredFileCount <= 0) {
    throw new Error("Next build manifests contain no concrete routes or required server files");
  }
  emitBuildClaim({
    source: ".next/BUILD_ID",
    assertion: `fresh Next build ID ${buildId} sha256=${sha256(buildIdBytes)}`,
    count: 1,
  });
  emitBuildClaim({
    source: ".next/routes-manifest.json",
    assertion: `validated ${routeCount} generated route records sha256=${sha256(routesBytes)}`,
    count: routeCount,
  });
  emitBuildClaim({
    source: ".next/required-server-files.json",
    assertion: `validated ${requiredFileCount} generated server-file records sha256=${sha256(requiredBytes)}`,
    count: requiredFileCount,
  });
}

function emitBuildClaim({ source, assertion, count }) {
  process.stdout.write(releaseGateAssertionEvent({
    category: "build",
    outcome: "PASS",
    provenance: { runner: "build-check", source, assertion },
    counts: { total: count, passed: count, failed: 0, skipped: 0, cancelled: 0, todo: 0 },
  }));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
