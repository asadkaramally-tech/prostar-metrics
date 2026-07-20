import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildCommissionReadModel } from "../../src/lib/metrics/commissions";
import {
  buildCommissionSourceEvidence,
  buildManifest,
  type BackfillRow,
  type ConfigRow,
  type ReconciliationRow,
  type RosterRow,
} from "../../src/lib/store/commission-rebuild";
import type { CommissionSourceJob, CommissionSourceVersion } from "../../src/lib/store/technician-read-model-inputs";

const config = {
  poolPercent: 0.5,
  minBonusPercent: 5,
  efficiencyEnabled: true,
  maxEfficiencyAdjustmentPercent: 20,
};

const reconciliationManifestFamilies = {
  jobs: ["jobs", "job_nested"],
  technicians: [
    "jobs", "job_nested", "employees", "timesheets", "jobs_from_timesheets",
    "schedules", "mobile_status",
  ],
  quotes: ["quotes", "quote_nested"],
} as const;

test("commission reconciliation loading uses only authoritative checks with positive-page manifest proof", async () => {
  const source = await readFile(new URL("../../src/lib/store/commission-rebuild.ts", import.meta.url), "utf8");
  assert.match(source, /from metrics\.authoritative_reconciliation_checks authority/);
  assert.doesNotMatch(source, /from metrics\.reconciliation_checks/);
  assert.match(source, /authority\.complete_traversal/);
  assert.match(source, /authority\.generation is not null/);
  assert.match(source, /authority\.source_manifest_generations <> '\{\}'::jsonb/);
  assert.match(source, /manifest\.expected_page_count > 0/);
  assert.match(source, /manifest\.completed_page_count = manifest\.expected_page_count/);
});

test("current authoritative reconciliation rows satisfy commission evidence", () => {
  const evidence = buildCommissionSourceEvidence(completeEvidenceArgs());
  assert.equal(evidence.complete, true);
  assert.equal(evidence.units.reconciliation.status, "complete");
  assert.deepEqual(evidence.matchedReconciliations.map((row) => row.scope), ["jobs", "technicians", "quotes"]);
});

for (const [name, mutate] of [
  ["legacy raw matched row", (row: ReconciliationRow) => {
    row.generation = null;
    row.complete_traversal = true;
    row.source_manifest_generations = {};
    row.source_manifests = [];
  }],
  ["generationless authoritative row", (row: ReconciliationRow) => { row.generation = null; }],
  ["incomplete authoritative traversal", (row: ReconciliationRow) => { row.complete_traversal = false; }],
  ["empty source-manifest generation map", (row: ReconciliationRow) => { row.source_manifest_generations = {}; }],
  ["zero-page source manifest", (row: ReconciliationRow) => {
    const manifests = row.source_manifests as Array<Record<string, unknown>>;
    manifests[0].expected_page_count = 0;
    manifests[0].completed_page_count = 0;
  }],
] as const) {
  test(`${name} cannot satisfy commission reconciliation evidence`, () => {
    const args = completeEvidenceArgs();
    const jobs = args.reconciliationRows.find((row) => row.scope === "jobs");
    assert.ok(jobs);
    mutate(jobs);
    const evidence = buildCommissionSourceEvidence(args);
    assert.equal(evidence.complete, false);
    assert.equal(evidence.units.reconciliation.status, "error");
    assert.equal(evidence.matchedReconciliations.some((row) => row.scope === "jobs"), false);
  });
}

test("an incomplete authoritative scope remains unavailable to commission publication", () => {
  const args = completeEvidenceArgs();
  args.reconciliationRows = args.reconciliationRows.filter((row) => row.scope !== "technicians");
  const evidence = buildCommissionSourceEvidence(args);
  assert.equal(evidence.complete, false);
  assert.equal(evidence.status, "missing");
  assert.equal(evidence.units.reconciliation.status, "missing");
  assert.deepEqual(evidence.units.reconciliation.detail.missingScopes, ["technicians"]);
  assert.equal(evidence.matchedReconciliations.some((row) => row.scope === "technicians"), false);
});

test("period evidence and manifest retain every source row needed to replay field allocation cents", () => {
  const args = completeEvidenceArgs();
  const evidence = buildCommissionSourceEvidence(args);
  assert.equal(evidence.complete, true);
  assert.equal(evidence.units.quoteLabor.status, "complete");
  assert.equal(evidence.units.peopleFieldMapping.detail.nonFieldHours, 2);
  assert.deepEqual(evidence.matchedReconciliations.map((row) => row.scope), ["jobs", "technicians", "quotes"]);

  const manifest = buildManifest({
    sourceJobs: args.sourceJobs,
    roster: args.roster,
    config: args.config,
    configRow: args.configRow,
    overrides: [],
    backfillRows: args.backfillRows,
    reconciliationRows: args.reconciliationRows,
    sourceEvidence: evidence,
  });
  assert.equal(manifest.filter((row) => row.inputType === "timesheet").length, 3);
  assert.equal(manifest.filter((row) => row.inputType === "person_field_mapping").length, 3);
  assert.equal(manifest.filter((row) => row.inputType === "quote_labor").length, 1);
  assert.ok(manifest.every((row) => /^[a-f0-9]{64}$/.test(row.sourceHash)));
  assert.equal(manifest.find((row) => row.inputType === "job")?.sourceIdentity, "100");
  assert.equal((manifest.find((row) => row.inputType === "job")?.input as { stageName: string }).stageName, "Archived");
  assert.deepEqual(
    manifest.filter((row) => row.inputType === "timesheet").map((row) => row.sourceIdentity),
    ["10:ts-eligible", "20:ts-ineligible", "30:ts-office"],
  );

  const model = buildCommissionReadModel({
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    config,
    roster: args.roster,
    jobs: args.sourceJobs.map((job) => ({
      jobId: job.jobId,
      completedDate: job.completedDate,
      stageName: job.stageName,
      sellValue: job.sellValue,
      quoteId: job.quoteId,
      quotedHours: job.quotedHours,
      quoteLaborRows: job.quoteLabor.length,
      quoteLaborCoverageStatus: evidence.units.quoteLabor.status,
      timesheets: job.timesheets.map((timesheet) => ({
        employeeId: timesheet.employeeId,
        mapped: timesheet.mapped,
        fieldTechnician: timesheet.fieldTechnician,
        hours: timesheet.hours,
      })),
    })),
  });
  assert.equal(model.coverage.nonFieldTechnicianHours, 2);
  assert.equal(model.coverage.eligibleAllocatedWorkValue, 900);
  assert.equal(model.coverage.ineligibleAllocatedWorkValue, 300);
  assert.equal(model.technicians[0].finalBonus, model.poolAmount);
});

test("efficiency quote evidence distinguishes no qualifying work from missing, loading, and error", () => {
  const noWork = completeEvidenceArgs();
  noWork.sourceJobs[0].quoteLabor = [];
  noWork.sourceJobs[0].quotedHours = 0;
  assert.equal(buildCommissionSourceEvidence(noWork).units.quoteLabor.status, "complete_no_qualifying_work");

  const missing = completeEvidenceArgs();
  missing.backfillRows = missing.backfillRows.filter((row) => row.source_family !== "quote_nested");
  assert.equal(buildCommissionSourceEvidence(missing).units.quoteLabor.status, "missing");
  assert.equal(buildCommissionSourceEvidence(missing).complete, false);

  const loading = completeEvidenceArgs();
  const quoteNested = loading.backfillRows.find((row) => row.source_family === "quote_nested");
  assert.ok(quoteNested);
  quoteNested.status = "running";
  quoteNested.reconciliation_status = "pending";
  assert.equal(buildCommissionSourceEvidence(loading).units.quoteLabor.status, "loading");

  const failed = completeEvidenceArgs();
  const quoteReconciliation = failed.reconciliationRows.find((row) => row.scope === "quotes");
  assert.ok(quoteReconciliation);
  quoteReconciliation.status = "mismatch";
  assert.equal(buildCommissionSourceEvidence(failed).units.quoteLabor.status, "error");
});

function completeEvidenceArgs() {
  const sourceJobs = [sourceJob()];
  const roster: RosterRow[] = [
    rosterRow("1", "10", true, "Eligible Field"),
    rosterRow("2", "20", false, "Ineligible Field"),
  ];
  const configRow: ConfigRow = {
    period_id: "9",
    revision: 2,
    pool_pct: "0.5",
    min_bonus_pct: "5",
    efficiency_enabled: true,
    max_efficiency_adjustment_pct: "20",
    config_json: config,
    config_hash: hashJson(config),
    actor_email: "admin@example.test",
    active: true,
    created_at: "2026-05-20T00:00:00Z",
  };
  return {
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    generatedDefault: false,
    config,
    configRow,
    sourceJobs,
    roster,
    overrides: [],
    backfillRows: backfillRows(),
    reconciliationRows: reconciliationRows(),
  };
}

function sourceJob(): CommissionSourceJob {
  return {
    jobId: "100",
    jobNo: "J-100",
    jobName: "Archived source job",
    completedDate: "2026-06-15",
    stageName: "Archived",
    sellValue: 1200,
    grossProfit: 400,
    quoteId: "50",
    quotedHours: 6,
    source: source("job-snapshot", "job-source-hash", "job-v3"),
    timesheets: [
      timesheet("ts-eligible", "10", 3, true, "1", true, "101", "Service Technician"),
      timesheet("ts-ineligible", "20", 1, true, "2", false, "102", "Installer"),
      timesheet("ts-office", "30", 2, false, null, null, "103", "Dispatcher"),
    ],
    quoteLabor: [{
      quoteId: "50", sectionId: "1", costCenterId: "2", laborId: "3",
      laborTypeId: "4", laborTypeName: "HVAC", quantityHours: 6, sellExTax: 0, actualCost: 300,
      source: source("labor-snapshot", "labor-source-hash", null),
    }],
  };
}

function timesheet(
  timesheetId: string,
  employeeId: string,
  hours: number,
  fieldTechnician: boolean,
  rosterId: string | null,
  rosterIncluded: boolean | null,
  personId: string,
  position: string,
) {
  return {
    timesheetId,
    employeeId,
    displayName: `Employee ${employeeId}`,
    mapped: true,
    hours,
    workDate: "2026-06-14",
    referenceType: "Job",
    referenceId: "100",
    parseStatus: "parsed",
    fieldTechnician,
    fieldClassification: {
      verified: true,
      basis: fieldTechnician ? "effective_commission_roster" as const : "no_effective_commission_roster" as const,
      rosterId,
      rosterIncluded,
      effectiveStart: rosterId ? "2026-01-01" : null,
      effectiveEnd: null,
    },
    person: {
      personId,
      employeeId,
      displayName: `Employee ${employeeId}`,
      roleType: "employee",
      position,
      active: true,
      sourceModifiedAt: "2026-05-01T00:00:00Z",
      lastSeenAt: "2026-07-01T00:00:00Z",
    },
    source: source(`timesheet-${timesheetId}`, `${timesheetId}-source-hash`, null),
  };
}

function rosterRow(rosterId: string, employeeId: string, included: boolean, displayName: string): RosterRow {
  return {
    rosterId,
    employeeId,
    displayName,
    included,
    effectiveStart: "2026-01-01",
    effectiveEnd: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-05-01T00:00:00Z",
  };
}

function backfillRows(): BackfillRow[] {
  return ["jobs", "job_nested", "employees", "timesheets", "jobs_from_timesheets", "quotes", "quote_nested"]
    .map((sourceFamily, index) => ({
      id: String(index + 1),
      source_family: sourceFamily,
      month_start: "2026-06-01",
      month_end_exclusive: "2026-07-01",
      required_for_completion: true,
      status: "completed",
      work_phase: "reconcile",
      reconciliation_status: "matched",
      reconciliation_detail: { matched: true },
      continuation_token: null,
      actual_requests: 1,
      snapshot_count: 1,
      normalized_count: 1,
      plan_hash: `${sourceFamily}-plan-hash`,
      completed_at: "2026-07-01T00:00:00Z",
      updated_at: "2026-07-01T00:00:00Z",
      last_error: null,
    }));
}

function reconciliationRows(): ReconciliationRow[] {
  return (["jobs", "technicians", "quotes"] as const).map((scope, index) => {
    const generation = String(100 + index);
    const families = reconciliationManifestFamilies[scope];
    const sourceManifestGenerations = Object.fromEntries(families.map((family) => [family, Number(generation)]));
    return {
      id: String(index + 11),
      scope,
      period_start: "2026-06-01",
      period_end: "2026-06-30",
      generation,
      complete_traversal: true,
      source_manifest_generations: sourceManifestGenerations,
      source_manifests: families.map((sourceFamily) => ({
        source_family: sourceFamily,
        period_start: "2026-06-01",
        period_end: "2026-06-30",
        coverage_status: "complete",
        reconciliation_status: "matched",
        continuation_token: null,
        manifest_generation: generation,
        reconciliation_generation: generation,
        expected_page_count: 1,
        completed_page_count: 1,
        reconciled_at: "2026-07-02T00:00:00Z",
      })),
      rollup_value: "1200",
      snapshot_value: "1200",
      upstream_sample_value: "1200",
      status: "matched",
      detail: { matched: true },
      checked_at: "2026-07-02T00:00:00Z",
    };
  });
}

function source(snapshot: string, upstreamSourceHash: string, version: string | null): CommissionSourceVersion {
  return {
    sourceSnapshotId: snapshot,
    upstreamSourceHash,
    sourceVersion: version,
    fetchedAt: "2026-07-01T00:00:00Z",
    updatedFromSourceAt: "2026-07-01T00:00:01Z",
  };
}

function hashJson(value: unknown) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
