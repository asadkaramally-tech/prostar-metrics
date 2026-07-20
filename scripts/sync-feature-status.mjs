import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { validateReleaseEvidence } from "./check-release-evidence.mjs";

import {
  FEATURE_LEDGER_SCHEMA_VERSION,
  PLAN_REVISION,
  PLAN_SHA256,
  expectedTestIdsForFeature,
  parseAuthoritativePlan,
  preserveMutableField,
  resolveExecutionStatus,
} from "./lib/feature-status-sync.mjs";

const root = resolve(import.meta.dirname, "..");
const planPath = resolve(root, "docs/prostar-metrics/execution-plan.md");
const outputPath = resolve(root, "docs/prostar-metrics/feature-status.json");
const checkOnly = process.argv.includes("--check");
const plan = await readFile(planPath, "utf8");
const rows = parseAuthoritativePlan(plan);

const allowedStatuses = [
  "VERIFIED DONE",
  "IN PROGRESS",
  "PARTIAL",
  "NOT STARTED",
  "TECHNICALLY BLOCKED",
  "DEFERRED BY ASAD",
  "REMOVED BY OWNER DECISION",
];
const existingDocument = await readExistingDocument();
const releaseEvidenceValidated = await completeReleaseEvidenceIsValid(existingDocument);
const existingFeatures = new Map(
  (existingDocument?.features ?? []).map((feature) => [feature.id, feature]),
);

const features = await Promise.all(rows.map(async (row) => {
  if (!allowedStatuses.includes(row.baselineStatus)) {
    throw new Error(`${row.id} has unsupported baseline status ${row.baselineStatus}`);
  }
  const assignment = assignmentFor(row.id);
  const existing = existingFeatures.get(row.id);
  const existingStatus = existing?.executionStatus;
  if (existingStatus !== undefined && !allowedStatuses.includes(existingStatus)) {
    throw new Error(`${row.id} has unsupported execution status ${existingStatus}`);
  }

  const executionStatus = resolveExecutionStatus({
    baselineStatus: row.baselineStatus,
    existingStatus,
    releaseEvidenceValidated,
  });

  const evidenceArtifactPath = preserveMutableField(
    existing,
    "evidenceArtifactPath",
    `docs/prostar-metrics/verification/${assignment.gate}/${row.id}/evidence.json`,
  );

  return {
    id: row.id,
    requirement: row.requirement,
    baselineStatus: row.baselineStatus,
    executionStatus,
    priority: priorityFor(row.id),
    accountableWorkPackage: assignment.workPackage,
    acceptingGate: assignment.gate,
    owner: ownerFor(assignment.workPackage),
    worktree: worktreeFor(assignment.workPackage),
    dependencies: dependenciesFor(row.id),
    technicalInvestigations: investigationsFor(row.id),
    codePaths: pathsFor(row.id),
    apiContracts: apiContractsFor(row.id),
    databaseTables: databaseTablesFor(row.id),
    testIds: preserveMutableField(existing, "testIds", expectedTestIdsForFeature(row.id)),
    evidencePaths: preserveMutableField(existing, "evidencePaths", [
      `docs/prostar-metrics/verification/${assignment.gate}/${row.id}/`,
      `docs/prostar-metrics/reconciliation/${row.id}.json`,
    ]),
    evidenceArtifactPath,
    evidenceArtifactSha256: preserveMutableField(existing, "evidenceArtifactSha256", null),
    buildSourceSha256: preserveMutableField(existing, "buildSourceSha256", null),
    deployedRevision: preserveMutableField(existing, "deployedRevision", null),
    imageDigest: preserveMutableField(existing, "imageDigest", null),
    independentReviewer: preserveMutableField(existing, "independentReviewer", null),
    reviewResult: preserveMutableField(existing, "reviewResult", null),
  };
}));

const document = {
  schemaVersion: FEATURE_LEDGER_SCHEMA_VERSION,
  planRevision: PLAN_REVISION,
  planSha256: PLAN_SHA256,
  deploymentManifestPath: preserveMutableField(
    existingDocument,
    "deploymentManifestPath",
    null,
  ),
  deploymentManifestSha256: preserveMutableField(
    existingDocument,
    "deploymentManifestSha256",
    null,
  ),
  e2eReportPath: preserveMutableField(existingDocument, "e2eReportPath", null),
  e2eReportSha256: preserveMutableField(existingDocument, "e2eReportSha256", null),
  a11yReportPath: preserveMutableField(existingDocument, "a11yReportPath", null),
  a11yReportSha256: preserveMutableField(existingDocument, "a11yReportSha256", null),
  reviewerAttestationPath: preserveMutableField(
    existingDocument,
    "reviewerAttestationPath",
    null,
  ),
  reviewerAttestationSha256: preserveMutableField(
    existingDocument,
    "reviewerAttestationSha256",
    null,
  ),
  allowedStatuses,
  features,
};

const serialized = `${JSON.stringify(document, null, 2)}\n`;
if (checkOnly) {
  const existing = await readFile(outputPath, "utf8");
  if (existing !== serialized) {
    throw new Error("feature-status.json is out of sync with execution-plan.md");
  }
} else {
  await writeFile(outputPath, serialized, "utf8");
}

console.log(`Validated ${features.length} feature records${checkOnly ? "" : " and synchronized feature-status.json"}.`);

async function readExistingDocument() {
  try {
    return JSON.parse(await readFile(outputPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function completeReleaseEvidenceIsValid(existingDocument) {
  if (!(existingDocument?.features ?? []).some((feature) => feature.executionStatus === "VERIFIED DONE")) {
    return false;
  }
  try {
    await validateReleaseEvidence({
      root,
      document: existingDocument,
      skipPlanSynchronizationCheck: true,
    });
    return true;
  } catch {
    return false;
  }
}

function numberOf(id) {
  return Number(id.slice(2));
}

function assignmentFor(id) {
  const n = numberOf(id);
  if (id.startsWith("F-")) {
    const map = {
      1: ["WP-00", "G-0"], 2: ["WP-02", "G-2"], 3: ["WP-01", "G-1"],
      4: ["WP-02", "G-2"], 5: ["WP-03", "G-3"], 6: ["WP-03", "G-3"],
      7: ["WP-03", "G-3"], 8: ["WP-00", "G-0"], 9: ["WP-11", "G-10"],
      10: ["WP-03", "G-3"], 11: ["WP-03", "G-3"], 12: ["WP-04", "G-4"],
      13: ["WP-03", "G-3"], 14: ["WP-10", "G-9"], 15: ["WP-10", "G-9"],
      16: ["WP-11", "G-10"], 17: ["WP-03", "G-3"], 18: ["WP-11", "G-10"],
    };
    return pair(map[n]);
  }
  if (id.startsWith("Q-")) {
    if ([17, 18, 19, 23, 24].includes(n)) return pair(["WP-05A", "G-5"]);
    if (n <= 14) return pair(["WP-05B", "G-5"]);
    return pair(["WP-05C", "G-5"]);
  }
  if (id.startsWith("J-")) return pair(n >= 11 && n <= 13 ? ["WP-06B", "G-6"] : ["WP-06A", "G-6"]);
  if (id.startsWith("T-")) return pair(["WP-07", "G-7"]);
  if (id.startsWith("C-")) {
    if ((n >= 10 && n <= 14) || n === 26) return pair(["WP-08", "G-8"]);
    if (n <= 9) return pair(["WP-09A", "G-8"]);
    if (n >= 19 && n <= 23) return pair(["WP-09B", "G-8"]);
    return pair(["WP-09C", "G-8"]);
  }
  throw new Error(`Unknown feature ${id}`);
}

function pair([workPackage, gate]) {
  return { workPackage, gate };
}

function priorityFor(id) {
  if (["F-03", "F-04", "F-07", "F-10", "F-12", "Q-18", "Q-19", "Q-24", "C-12"].includes(id)) return "P0";
  return "P1";
}

function dependenciesFor(id) {
  if (id.startsWith("F-")) {
    const map = {
      "F-02": ["F-01"],
      "F-03": ["F-01"],
      "F-05": ["F-02", "F-04", "F-06"],
      "F-07": ["F-02", "F-05", "F-10"],
      "F-09": ["F-01", "F-08"],
      "F-10": ["F-02", "F-04", "F-05"],
      "F-11": ["F-05", "F-06"],
      "F-12": ["F-04", "F-05", "F-10", "F-11"],
      "F-13": ["F-07", "F-10"],
      "F-14": ["F-07", "F-10", "F-11"],
      "F-15": ["F-02"],
      "F-16": ["F-01", "F-03"],
      "F-17": ["F-03", "F-05", "F-06"],
      "F-18": ["F-02", "F-07"],
    };
    return map[id] ?? [];
  }
  if (id.startsWith("Q-")) return ["F-02", "F-04", "F-07", "F-10", "F-12"];
  if (id.startsWith("J-")) return ["F-02", "F-04", "F-07", "F-10", "F-12"];
  if (id.startsWith("T-")) return ["F-02", "F-04", "F-07", "F-10", "F-12", "J-09"];
  if (id.startsWith("C-")) return ["F-02", "F-04", "F-07", "F-10", "F-12", "J-09", "T-03"];
  return [];
}

function investigationsFor(id) {
  if (id.startsWith("Q-")) return ["TI-01", "TI-02"];
  if (id.startsWith("J-")) return ["TI-02", "TI-05"];
  if (id.startsWith("T-")) return ["TI-02", "TI-03", "TI-04", "TI-05"];
  if (id.startsWith("C-")) return ["TI-02", "TI-03", "TI-05", "TI-06"];
  return [];
}

function pathsFor(id) {
  if (id.startsWith("Q-")) return ["src/lib/metrics/quotes.ts", "src/lib/store/quote-dashboard-read-model.ts", "src/components/quotes/**", "src/app/api/quotes/**"];
  if (id.startsWith("J-")) return ["src/lib/metrics/jobs.ts", "src/components/jobs-dashboard.tsx", "src/app/api/jobs/**"];
  if (id.startsWith("T-")) return ["src/lib/metrics/technicians.ts", "src/components/technicians-dashboard.tsx", "src/app/api/technicians/**"];
  if (id.startsWith("C-")) return ["src/lib/metrics/commissions.ts", "src/lib/store/commission-*.ts", "src/components/commissions-dashboard.tsx", "src/app/api/commissions/**"];
  return ["See docs/prostar-metrics/ownership.md"];
}

function apiContractsFor(id) {
  if (id.startsWith("Q-")) return ["GET /api/quotes", "POST /api/quotes/overrides"];
  if (id.startsWith("J-")) return ["GET /api/jobs"];
  if (id.startsWith("T-")) return ["GET /api/technicians"];
  if (id.startsWith("C-")) return ["GET /api/commissions", "POST /api/commissions/rebuild", "POST /api/commissions/overrides", "POST /api/commissions/exports"];
  if (["F-03", "F-16"].includes(id)) return ["/.auth/login/aad", "/.auth/me"];
  if (["F-07", "F-10", "F-13"].includes(id)) return ["GET /api/health"];
  return [];
}

function databaseTablesFor(id) {
  if (id.startsWith("Q-")) return ["metrics.metrics_quotes", "metrics.metrics_quote_cost_centers", "metrics.quote_classification_overrides", "metrics.metric_rollups"];
  if (id.startsWith("J-")) return ["metrics.metrics_jobs", "metrics.metrics_job_cost_centers", "metrics.metric_rollups"];
  if (id.startsWith("T-")) return ["metrics.dim_people", "metrics.timesheet_snapshots", "metrics.schedule_snapshots", "metrics.mobile_status_snapshots", "metrics.metric_rollups"];
  if (id.startsWith("C-")) return ["metrics.commission_periods", "metrics.commission_calculation_runs", "metrics.commission_run_inputs", "metrics.commission_employee_results", "metrics.commission_job_allocations", "metrics.commission_overrides", "metrics.report_exports"];
  if (["F-05", "F-06", "F-11", "F-12", "F-17"].includes(id)) return ["metrics.ingestion_jobs", "metrics.ingestion_runs", "metrics.ingestion_watermarks"];
  if (["F-07", "F-10", "F-13", "F-14"].includes(id)) return ["metrics.source_freshness", "metrics.reconciliation_runs", "metrics.reconciliation_differences"];
  return [];
}

function ownerFor(workPackage) {
  if (workPackage === "WP-00" || workPackage === "WP-11") return "Codex Integration/Verification Owner";
  if (workPackage === "WP-01") return "Plato Production Entry Agent";
  if (workPackage === "WP-02") return "Data Contract Agent";
  if (["WP-03", "WP-04"].includes(workPackage)) return "Pipeline Agent";
  if (workPackage.startsWith("WP-05")) return "Quote Metrics Agent";
  if (workPackage.startsWith("WP-06")) return "Job Metrics Agent";
  if (workPackage === "WP-07") return "Technician Performance Agent";
  if (workPackage === "WP-08" || workPackage.startsWith("WP-09")) return "Commission Agent";
  if (workPackage === "WP-10") return "Infrastructure Agent";
  throw new Error(`No owner for ${workPackage}`);
}

function worktreeFor(workPackage) {
  if (workPackage === "WP-00" || workPackage === "WP-11") return "shared main-thread workspace";
  return `codex/${workPackage.toLowerCase()}-${workPackageName(workPackage)}`;
}

function workPackageName(workPackage) {
  if (workPackage === "WP-01") return "production-entry";
  if (workPackage === "WP-02") return "data-contract";
  if (workPackage === "WP-03") return "pipeline";
  if (workPackage === "WP-04") return "backfill";
  if (workPackage.startsWith("WP-05")) return "quotes";
  if (workPackage.startsWith("WP-06")) return "jobs";
  if (workPackage === "WP-07") return "technicians";
  if (workPackage === "WP-08") return "commission-engine";
  if (workPackage.startsWith("WP-09")) return "commission-ui";
  if (workPackage === "WP-10") return "infrastructure";
  return "work";
}
