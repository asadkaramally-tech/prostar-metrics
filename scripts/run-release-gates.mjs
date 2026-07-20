import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  AUTHORITATIVE_FEATURE_IDS,
  parseAuthoritativePlan,
} from "./lib/feature-status-sync.mjs";
import { executeImmutableGateRun } from "./lib/release-evidence-trust.mjs";

export async function runReleaseGates({
  root = process.cwd(),
  deploymentManifestPath,
  e2eReportPath,
  a11yReportPath,
  browserAttestationPath,
  outputDirectory,
  ...injected
}) {
  const projectRoot = await realpath(resolve(root));
  const deploymentBytes = await readFile(resolve(projectRoot, deploymentManifestPath));
  const deployment = JSON.parse(deploymentBytes.toString("utf8"));
  const plan = await readFile(resolve(projectRoot, "docs/prostar-metrics/execution-plan.md"), "utf8");
  const rows = parseAuthoritativePlan(plan);
  const removed = new Set(rows.filter((row) => row.baselineStatus === "REMOVED BY OWNER DECISION").map((row) => row.id));
  const mandatoryIds = AUTHORITATIVE_FEATURE_IDS.filter((id) => !removed.has(id));
  return executeImmutableGateRun({
    root: projectRoot,
    deployment,
    deploymentManifestPath,
    deploymentManifestSha256: createHash("sha256").update(deploymentBytes).digest("hex"),
    e2eReportPath,
    a11yReportPath,
    browserAttestationPath,
    mandatoryIds,
    outputDirectory,
    ...injected,
  });
}

function parseArguments(argv) {
  const names = new Map([
    ["--root", "root"],
    ["--deployment-manifest", "deploymentManifestPath"],
    ["--e2e-report", "e2eReportPath"],
    ["--a11y-report", "a11yReportPath"],
    ["--browser-attestation", "browserAttestationPath"],
    ["--output-directory", "outputDirectory"],
  ]);
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const field = names.get(argv[index]);
    if (!field || index + 1 >= argv.length) throw new Error(`unknown or incomplete argument: ${String(argv[index])}`);
    parsed[field] = argv[index + 1];
  }
  for (const field of ["deploymentManifestPath", "e2eReportPath", "a11yReportPath", "browserAttestationPath"]) {
    if (!parsed[field]) throw new Error(`missing required argument for ${field}`);
  }
  return parsed;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  runReleaseGates(parseArguments(process.argv.slice(2))).then((result) => {
    console.log(JSON.stringify(result, null, 2));
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
