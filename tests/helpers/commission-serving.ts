import { buildCommissionReadModel, type CommissionReadModel } from "../../src/lib/metrics/commissions";
import type { FreshnessStatus } from "../../src/lib/metrics/freshness";
import {
  commissionCalculationHash,
  commissionFieldBasis,
  commissionHashJson,
  commissionInputManifestHash,
  commissionSourceHash,
  type CommissionHashManifestEntry,
} from "../../src/lib/store/commission-integrity";
import type { CommissionPeriodRunRow } from "../../src/lib/store/commissions-read-model";
import type { CommissionRebuildArtifact } from "../../src/lib/store/commission-rebuild";
import type { PostgresQuery, QueryResult } from "../../src/lib/store/postgres";

export const commissionFreshness: FreshnessStatus = {
  pageKey: "commissions",
  state: "current",
  label: "Data current",
  detail: "Commission source data is current.",
  dataThrough: "2026-06-30T23:59:59.000Z",
  lastSuccessfulRunAt: "2026-07-01T01:00:00.000Z",
  lastFailedRunAt: null,
};

const defaultConfig = {
  poolPercent: 0.5,
  minBonusPercent: 5,
  efficiencyEnabled: false,
  maxEfficiencyAdjustmentPercent: 20,
  tierMultipliers: { Gold: 1.3, Silver: 1.2, Bronze: 1.1, Standard: 1 },
};

export function commissionServingRow(overrides: Partial<CommissionPeriodRunRow> = {}): CommissionPeriodRunRow {
  const periodStart = overrides.period_start ?? "2026-06-01";
  const periodEnd = overrides.period_end ?? "2026-06-30";
  const readModel: CommissionReadModel = {
    periodStart,
    periodEnd,
    config: defaultConfig,
    completedJobs: 0,
    totalWorkValue: 0,
    poolAmount: 0,
    insidePoolTotal: 0,
    outsidePoolTotal: 0,
    payrollTotal: 0,
    activeTechnicians: 0,
    technicians: [],
    jobAllocations: [],
    coverage: {
      ...emptyCoverage(),
      ineligibleTechnicians: 1,
      technicianWork: [{
        employeeId: "999", displayName: "No qualifying work", included: false,
        allocatedWorkValue: 0, effectiveAllocatedWorkValue: 0, mappedHours: 0, jobCount: 0,
      }],
    },
    diagnostics: [{ code: "COMMISSION_INVARIANTS_VERIFIED", severity: "info", message: "The valid detailed run reconciles at zero." }],
    invariants: allTrueInvariants(),
  };
  return buildCommissionServingRow({ readModel, inputRows: [], overrides });
}

export function commissionZeroUnknownPayoutOverrideRow(
  overrides: Partial<CommissionPeriodRunRow> = {},
): CommissionPeriodRunRow {
  const zero = commissionServingRow();
  return buildCommissionServingRow({
    readModel: zero.read_model as CommissionReadModel,
    inputRows: [input("override", "9001", {
      id: "9001", period_id: zero.period_id, employee_id: "404", field_name: "final_bonus",
      before_value: null, after_value: 10, reason: "Adversarial unknown employee payout.",
      pool_treatment: "inside_pool", revision: 1, active: true,
    })],
    overrides,
  });
}

export function commissionPayoutServingRow(
  overrides: Partial<CommissionPeriodRunRow> = {},
  hours: { first: number; second: number } = { first: 6, second: 4 },
): CommissionPeriodRunRow {
  const periodStart = overrides.period_start ?? "2026-06-01";
  const periodEnd = overrides.period_end ?? "2026-06-30";
  const readModel = buildCommissionReadModel({
    periodStart, periodEnd, config: defaultConfig,
    roster: [
      { employeeId: "1", displayName: "Alex", included: true },
      { employeeId: "2", displayName: "Jordan", included: true },
    ],
    jobs: [
      { jobId: "100", completedDate: periodStart, stageName: "Complete", sellValue: 10000, quoteId: null, quotedHours: null, timesheets: [
        { employeeId: "1", hours: hours.first, mapped: true, fieldTechnician: true },
        { employeeId: "2", hours: hours.second, mapped: true, fieldTechnician: true },
      ] },
      { jobId: "200", completedDate: periodStart, stageName: "Complete", sellValue: 0, quoteId: null, quotedHours: null, timesheets: [] },
    ],
  });
  const inputRows = [
    input("job", "100", { jobId: "100", completedDate: periodStart, stageName: "Complete", sellValue: 10000, quoteId: null, quotedHours: null }),
    input("job", "200", { jobId: "200", completedDate: periodStart, stageName: "Complete", sellValue: 0, quoteId: null, quotedHours: null }),
    input("timesheet", "1:1", { jobId: "100", timesheetId: "1", employeeId: "1", hours: hours.first, mapped: true, fieldTechnician: true }),
    input("timesheet", "2:2", { jobId: "100", timesheetId: "2", employeeId: "2", hours: hours.second, mapped: true, fieldTechnician: true }),
  ];
  return buildCommissionServingRow({ readModel, inputRows, overrides });
}

export function buildCommissionServingRow(params: {
  readModel: CommissionReadModel;
  inputRows: CommissionHashManifestEntry[];
  overrides?: Partial<CommissionPeriodRunRow>;
  configSource?: Record<string, unknown>;
}): CommissionPeriodRunRow {
  const overrides = params.overrides ?? {};
  const config = params.readModel.config;
  const periodId = overrides.period_id ?? "61";
  const configRevision = overrides.period_config_revision ?? 1;
  const configHash = commissionHashJson(config);
  const configSource = params.configSource ?? {
    period_id: periodId, revision: configRevision, pool_pct: String(config.poolPercent),
    min_bonus_pct: String(config.minBonusPercent), efficiency_enabled: config.efficiencyEnabled,
    max_efficiency_adjustment_pct: String(config.maxEfficiencyAdjustmentPercent),
    config_json: config, config_hash: configHash, actor_email: "admin@example.test",
    active: true, created_at: "2026-07-01T00:00:00Z",
  };
  const sourceRows = canonicalFixtureInputs(params.inputRows, params.readModel);
  const backfills = fixtureBackfills(params.readModel.periodStart, params.readModel.periodEnd, config.efficiencyEnabled);
  const reconciliations = fixtureReconciliations(params.readModel.periodStart, params.readModel.periodEnd, config.efficiencyEnabled);
  const preliminary = [
    ...sourceRows,
    input("config", `${periodId}:${configRevision}`, { normalizedConfig: config, sourceRow: configSource }, configHash),
    ...backfills.map((value) => input("backfill_unit", `${value.source_family}:${value.month_start}`, value)),
    ...reconciliations.map((value) => input("reconciliation", value.id, value)),
    input("field_basis", "commission-v2-period-evidence", commissionFieldBasis, "2"),
  ];
  const sourceEvidence = completeSourceEvidence(
    params.readModel.periodStart,
    params.readModel.periodEnd,
    config.efficiencyEnabled,
    preliminary,
    reconciliations,
  );
  const manifest = [...preliminary, input(
    "evidence_summary",
    `${params.readModel.periodStart}:${params.readModel.periodEnd}`,
    sourceEvidence,
    "commission-evidence-v2",
  )].sort((a, b) => a.inputType.localeCompare(b.inputType) || a.sourceIdentity.localeCompare(b.sourceIdentity));
  const inputManifestHash = commissionInputManifestHash(manifest);
  const sourceHash = commissionSourceHash(manifest);
  const overrideRows = sourceRows.filter((entry) => entry.inputType === "override")
    .map((entry) => entry.input as Record<string, unknown>)
    .sort((left, right) => String(left.employee_id).localeCompare(String(right.employee_id), undefined, { numeric: true })
      || String(left.field_name).localeCompare(String(right.field_name)));
  const overrideHash = commissionHashJson(overrideRows);
  const calculationHash = commissionCalculationHash({ readModel: params.readModel, inputManifestHash, configHash, overrideHash });
  const base: CommissionPeriodRunRow = {
    period_id: periodId, period_start: params.readModel.periodStart, period_end: params.readModel.periodEnd,
    status: "reviewed", revision: 2, edit_revision: 4,
    period_config_revision: configRevision, period_config: config, period_config_source: configSource,
    period_watermarks: {}, period_override_hash: overrideHash, current_run_id: "801",
    calculation_stale: false, source_changed_after_export: false,
    reviewed_by: "owner@example.test", reviewed_at: "2026-07-01T02:00:00.000Z",
    exported_by: null, exported_at: null, locked_by: null, locked_at: null,
    created_by: "worker@example.test", period_created_at: "2026-07-01T01:00:00.000Z", revision_reason: null,
    run_id: "801", run_revision: 3, run_status: "succeeded", run_config: config,
    run_config_revision: 1, run_watermarks: {}, run_override_hash: overrideHash,
    read_model: params.readModel, calculated_by: "worker@example.test", calculated_at: "2026-07-01T01:30:00.000Z",
    source_complete: true, source_evidence: sourceEvidence, config_hash: configHash,
    source_hash: sourceHash, input_manifest_hash: inputManifestHash, calculation_hash: calculationHash,
    immutable: true, run_completed_jobs: params.readModel.completedJobs,
    run_total_work_value: params.readModel.totalWorkValue, run_pool_amount: params.readModel.poolAmount,
    run_inside_pool_total: params.readModel.insidePoolTotal, run_outside_pool_total: params.readModel.outsidePoolTotal,
    run_payroll_total: params.readModel.payrollTotal, run_coverage: params.readModel.coverage,
    run_diagnostics: params.readModel.diagnostics, run_invariants: params.readModel.invariants,
    employee_results: params.readModel.technicians.map((employee) => {
      const persisted = { ...employee } as Record<string, unknown>;
      delete persisted.tierMultiplier;
      return persisted;
    }),
    job_allocations: params.readModel.jobAllocations, input_manifest: manifest, export_count: 0,
  };
  return {
    ...base,
    ...overrides,
    calculation_hash: overrides.calculation_hash === undefined ? base.calculation_hash : overrides.calculation_hash,
  };
}

export function rehashCommissionServingRow(row: CommissionPeriodRunRow): CommissionPeriodRunRow {
  const manifest = row.input_manifest as CommissionHashManifestEntry[];
  const configHash = commissionHashJson(row.run_config);
  const inputManifestHash = commissionInputManifestHash(manifest);
  const sourceHash = commissionSourceHash(manifest);
  return {
    ...row,
    config_hash: configHash,
    input_manifest_hash: inputManifestHash,
    source_hash: sourceHash,
    calculation_hash: commissionCalculationHash({
      readModel: row.read_model, inputManifestHash, configHash,
      overrideHash: row.run_override_hash!,
    }),
  };
}

export function commissionArtifactFromServingRow(row: CommissionPeriodRunRow): CommissionRebuildArtifact {
  return {
    periodId: Number(row.period_id), periodStart: row.period_start, periodEnd: row.period_end,
    periodRevision: row.revision, editRevision: row.edit_revision,
    configRevision: row.period_config_revision,
    config: row.run_config as CommissionRebuildArtifact["config"],
    sourceWatermarks: row.run_watermarks as Record<string, unknown>,
    sourceEvidence: row.source_evidence as CommissionRebuildArtifact["sourceEvidence"],
    sourceComplete: row.source_complete === true,
    manifest: row.input_manifest as CommissionRebuildArtifact["manifest"],
    inputManifestHash: row.input_manifest_hash!, sourceHash: row.source_hash!,
    configHash: row.config_hash!, overrideHash: row.run_override_hash!,
    calculationHash: row.calculation_hash!, readModel: row.read_model as CommissionReadModel,
  };
}

export function commissionQuery(params: {
  selectedRows?: CommissionPeriodRunRow[];
  summaryRows?: CommissionPeriodRunRow[];
  error?: Error;
}): PostgresQuery {
  return async <T>(sql: string): Promise<QueryResult<T>> => {
    if (params.error) throw params.error;
    if (sql.includes("p.period_start >= $1::date")) return result(params.summaryRows ?? []);
    if (sql.includes("limit 1")) return result(params.selectedRows ?? []);
    if (sql.includes("from metrics.commission_periods p") && sql.includes("order by p.revision desc")) return result(params.selectedRows ?? []);
    return result([]);
  };
}

function result<T>(rows: unknown[]): QueryResult<T> {
  return { rows: rows as T[], rowCount: rows.length };
}

function input(inputType: string, sourceIdentity: string, value: unknown, sourceVersion = `v:${sourceIdentity}`): CommissionHashManifestEntry {
  return { inputType, sourceIdentity, sourceVersion, sourceHash: commissionHashJson(value), input: value };
}

function emptyCoverage(): CommissionReadModel["coverage"] {
  return {
    jobsWithTimesheets: 0, jobsWithoutTimesheets: 0, completedJobs: 0,
    positiveValueJobs: 0, nonPositiveValueJobs: 0, commissionSupportedJobs: 0,
    excludedJobs: 0, jobsWithEligibleWork: 0, jobsWithOnlyIneligibleWork: 0,
    mappedHours: 0, unmappedHours: 0, nonFieldTechnicianHours: 0,
    unmappedTimesheetEntries: 0, mappedTechnicians: 0, eligibleTechnicians: 0,
    ineligibleTechnicians: 0, eligibleAllocatedWorkValue: 0, ineligibleAllocatedWorkValue: 0,
    excludedWorkValue: 0, excludedJobDetails: [],
    quoteLabor: {
      status: "complete_no_qualifying_work", required: false, quoteSourcedJobs: 0,
      jobsWithLaborRows: 0, qualifyingJobs: 0, jobsWithNoQualifyingWork: 0,
      laborRows: 0, incompleteJobIds: [],
    },
    technicianWork: [],
  };
}

function allTrueInvariants(): CommissionReadModel["invariants"] {
  return {
    insidePoolReconciles: true, outsidePoolReconciles: true,
    jobAllocationsReconcile: true, unsupportedJobsUnallocated: true,
    forfeitureReconciles: true, efficiencyReconciles: true, nonnegativePayroll: true,
  };
}

function canonicalFixtureInputs(rows: CommissionHashManifestEntry[], readModel: CommissionReadModel) {
  const sourceVersion = {
    sourceSnapshotId: null, upstreamSourceHash: null, sourceVersion: "fixture",
    fetchedAt: "2026-07-01T00:00:00Z", updatedFromSourceAt: "2026-07-01T00:00:00Z",
  };
  const roster = readModel.coverage.technicianWork.map((technician) => ({
    employeeId: technician.employeeId, displayName: technician.displayName, included: technician.included,
    rosterId: technician.employeeId, effectiveStart: readModel.periodStart, effectiveEnd: null,
    createdAt: "2026-06-01T00:00:00Z", updatedAt: "2026-06-01T00:00:00Z",
  }));
  const names = new Map(roster.map((entry) => [entry.employeeId, entry.displayName]));
  const jobs = rows.filter((entry) => entry.inputType === "job").map((entry) => {
    const value = entry.input as Record<string, unknown>;
    const jobId = String(value.jobId ?? entry.sourceIdentity);
    return input("job", jobId, {
      jobId, jobNo: null, jobName: null, completedDate: value.completedDate,
      stageName: value.stageName, sellValue: value.sellValue, grossProfit: null,
      quoteId: value.quoteId ?? null, quotedHours: value.quotedHours ?? null, source: sourceVersion,
    });
  });
  const people = new Map<string, CommissionHashManifestEntry>();
  const timesheets = rows.filter((entry) => entry.inputType === "timesheet").map((entry, index) => {
    const value = entry.input as Record<string, unknown>;
    const employeeId = value.employeeId === null || value.employeeId === undefined ? null : String(value.employeeId);
    const timesheetId = /^\d+$/.test(String(value.timesheetId ?? "")) ? String(value.timesheetId) : String(index + 1);
    const personId = employeeId ?? `employee:unmapped:unmapped`;
    const person = employeeId ? {
      personId, employeeId, displayName: names.get(employeeId) ?? `Employee ${employeeId}`,
      roleType: "employee", position: "Field Technician", active: true,
      sourceModifiedAt: "2026-06-01T00:00:00Z", lastSeenAt: "2026-06-01T00:00:00Z",
    } : null;
    const fieldClassification = {
      verified: true, basis: employeeId ? "effective_commission_roster" : "unmapped_person",
      rosterId: employeeId, rosterIncluded: employeeId ? true : null,
      effectiveStart: employeeId ? readModel.periodStart : null, effectiveEnd: null,
    };
    const fieldTechnician = value.fieldTechnician !== false;
    const mapping = { employeeId, person, fieldClassification, fieldTechnician };
    if (!people.has(personId)) people.set(personId, input("person_field_mapping", personId, mapping, "2026-06-01T00:00:00Z"));
    return input("timesheet", `${employeeId ?? "unmapped"}:${timesheetId}`, {
      jobId: String(value.jobId), timesheetId, employeeId,
      displayName: employeeId ? names.get(employeeId) ?? `Employee ${employeeId}` : null,
      mapped: value.mapped !== false, hours: Number(value.hours), workDate: readModel.periodStart,
      referenceType: "job", referenceId: String(value.jobId), parseStatus: "parsed",
      fieldTechnician, fieldClassification, person, source: sourceVersion,
    });
  });
  const quoteLabor = rows.filter((entry) => entry.inputType === "quote_labor").map((entry) => {
    const value = entry.input as Record<string, unknown>;
    const normalized = { ...value, source: sourceVersion };
    return input(
      "quote_labor",
      `${value.quoteId}:${value.sectionId}:${value.costCenterId}:${value.laborId}`,
      normalized,
    );
  });
  const overrides = rows.filter((entry) => entry.inputType === "override").map((entry) => {
    const value = entry.input as Record<string, unknown>;
    return input("override", String(value.id ?? entry.sourceIdentity), value, entry.sourceVersion);
  });
  return [
    ...jobs, ...timesheets, ...people.values(),
    ...roster.map((value) => input("roster", value.rosterId, value)),
    ...quoteLabor, ...overrides,
  ];
}

function fixtureBackfills(periodStart: string, periodEnd: string, efficiencyEnabled: boolean) {
  const families = ["jobs", "job_nested", "employees", "timesheets", "jobs_from_timesheets"];
  if (efficiencyEnabled) families.push("quotes", "quote_nested");
  const monthStart = `${periodStart.slice(0, 7)}-01`;
  const next = new Date(`${monthStart}T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return families.map((sourceFamily, index) => ({
    id: String(2000 + index), source_family: sourceFamily, month_start: monthStart,
    month_end_exclusive: next.toISOString().slice(0, 10), required_for_completion: true,
    status: "completed", work_phase: "complete", reconciliation_status: "matched",
    reconciliation_detail: {}, continuation_token: null, actual_requests: 1,
    snapshot_count: 1, normalized_count: 1,
    plan_hash: commissionHashJson({ sourceFamily, periodStart, periodEnd }),
    completed_at: "2026-07-01T00:00:00Z", updated_at: "2026-07-01T00:00:00Z", last_error: null,
  }));
}

function fixtureReconciliations(periodStart: string, periodEnd: string, efficiencyEnabled: boolean) {
  const scopes = efficiencyEnabled ? ["jobs", "technicians", "quotes"] : ["jobs", "technicians"];
  return scopes.map((scope, index) => ({
    id: String(3000 + index), scope, period_start: periodStart, period_end: periodEnd,
    rollup_value: "0", snapshot_value: "0", upstream_sample_value: "0",
    status: "matched", detail: {}, checked_at: "2026-07-01T00:00:00Z",
  }));
}

function completeSourceEvidence(
  periodStart: string,
  periodEnd: string,
  efficiencyEnabled: boolean,
  rows: CommissionHashManifestEntry[],
  reconciliations: ReturnType<typeof fixtureReconciliations>,
) {
  const identities = (type: string) => rows.filter((entry) => entry.inputType === type).map((entry) => entry.sourceIdentity);
  const timesheets = rows.filter((entry) => entry.inputType === "timesheet");
  const quoteLaborHours = rows.filter((entry) => entry.inputType === "quote_labor")
    .reduce((total, entry) => total + Number((entry.input as Record<string, unknown>).quantityHours ?? 0), 0);
  const units = {
    completedJobs: unit(true, identities("job")),
    timesheets: unit(true, identities("timesheet")),
    peopleFieldMapping: unit(true, identities("person_field_mapping"), timesheets.filter((entry) => Number((entry.input as Record<string, unknown>).hours) > 0).length),
    roster: unit(true, identities("roster")),
    config: unit(true, identities("config")),
    overrides: unit(true, identities("override")),
    quoteLabor: unit(efficiencyEnabled, identities("quote_labor"), undefined, quoteLaborHours > 0 ? "complete" : "complete_no_qualifying_work"),
    backfill: unit(true, identities("backfill_unit")),
    reconciliation: unit(true, identities("reconciliation"), undefined, "complete", {
      requiredScopes: reconciliations.map((row) => row.scope),
    }),
  };
  return {
    schemaVersion: 2 as const, periodStart, periodEnd, status: "complete" as const, complete: true, units,
    matchedReconciliations: reconciliations.map((row) => ({
      scope: row.scope, id: row.id, hash: commissionHashJson(row),
    })),
  };
}

function unit(
  required: boolean,
  identities: string[],
  rowCount = identities.length,
  status: "complete" | "complete_no_qualifying_work" = "complete",
  detail: Record<string, unknown> = {},
) {
  return { status, required, rowCount, identities: [...new Set(identities)].sort(), detail };
}
