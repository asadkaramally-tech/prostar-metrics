import type {
  CommissionCoverage,
  CommissionDiagnostic,
  CommissionEfficiencyResult,
  CommissionInvariants,
  CommissionPeriodConfig,
  CommissionReadModel,
} from "@/lib/metrics/commissions";
import type { FreshnessStatus } from "@/lib/metrics/freshness";
import { requireCommissionDashboardPeriod } from "@/lib/commissions/period";
import { getCommissionExportBlobStatus } from "@/lib/store/blob-exports";
import {
  verifyCommissionCanonicalRun,
  type CommissionCanonicalRunRow,
} from "@/lib/store/commission-integrity";
import {
  type CommissionAuditRecord,
} from "@/lib/store/commission-lifecycle";
import { getPageFreshness } from "@/lib/store/freshness";
import { queryPostgres, type PostgresQuery } from "@/lib/store/postgres";
import { plainDisplayText } from "@/lib/text/plain-display-text";

export type CommissionPeriodStatus = "draft" | "reviewed" | "exported" | "locked" | "revised" | "missing";
export type CommissionSummaryView = "monthly" | "quarterly" | "annual";

export type CommissionConfig = CommissionPeriodConfig & {
  tierMultipliers: { Gold: number; Silver: number; Bronze: number; Standard: number };
};

export type CommissionJobAllocation = {
  employeeId: string;
  jobId: string;
  jobName: string;
  customer: string;
  jobTotal: number;
  employeeHours: number;
  jobTotalHours: number;
  share: number;
  allocatedValue: number;
  included: boolean;
};

export type CommissionTechnicianRow = {
  employeeId: string;
  displayName: string;
  rank: number;
  tier: string;
  included: boolean;
  belowMinimum: boolean;
  finalBonusLocked: boolean;
  jobCount: number;
  allocatedValue: number;
  effectiveAllocatedValue: number;
  baseBonus: number;
  rawBonus: number;
  forfeitedBonus: number;
  reallocationReceived: number;
  postForfeitureBonus: number;
  insidePoolAdjustment: number;
  overrideRedistribution: number;
  outsidePoolAdjustment: number;
  finalBonus: number;
  payrollBonus: number;
  notes: string[];
  jobAllocations: CommissionJobAllocation[];
  efficiency?: CommissionEfficiencyResult;
};

export type CommissionOverrideRow = {
  id: string;
  periodId: string;
  periodRevision: number;
  employeeId: string;
  fieldName: string;
  beforeValue: unknown;
  afterValue: unknown;
  valueType: string;
  reason: string;
  evidenceUrl: string | null;
  actorEmail: string;
  poolTreatment: string;
  revision: number;
  active: boolean;
  createdAt: string;
  supersededAt: string | null;
};

export type CommissionExportRow = {
  id: string;
  periodId: string;
  periodRevision: number;
  runId: string;
  runRevision: number;
  type: "payroll_csv" | "worksheet_pdf" | "calculation_detail_csv";
  filename: string;
  storageKey: string;
  fileHash: string;
  calculationHash: string;
  contentType: string;
  size: number;
  status: string;
  protected: boolean;
  downloadable: boolean;
  exportedBy: string;
  exportedAt: string;
  retainedUntil: string;
  downloadCount: number;
  lastDownloadedAt: string | null;
};

export type CommissionExportGate = {
  allowed: boolean;
  reason: string | null;
  reasons: string[];
};

export type CommissionRevisionHistoryRow = {
  periodId: string;
  revision: number;
  editRevision: number;
  status: CommissionPeriodStatus;
  runId: string | null;
  runRevision: number | null;
  createdBy: string;
  createdAt: string;
  revisionReason: string | null;
  exportCount: number;
  protected: boolean;
};

export type CommissionServingStatus = "ready" | "building" | "unavailable";

type CommissionWorksheetBase = {
  servingStatus: CommissionServingStatus;
  servingCode: string | null;
  servingMessage: string | null;
  year: number;
  month: number;
  periodLabel: string;
  periodStart: string;
  periodEnd: string;
  status: CommissionPeriodStatus;
  periodId: string | null;
  runId: string | null;
  runStatus: string | null;
  revision: number | null;
  editRevision: number;
  runRevision: number | null;
  calculatedAt: string | null;
  calculatedBy: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  exportedBy: string | null;
  exportedAt: string | null;
  lockedBy: string | null;
  lockedAt: string | null;
  protected: boolean;
  calculationStale: boolean;
  sourceComplete: boolean;
  sourceChangedAfterExport: boolean;
  config: CommissionConfig;
  configHash: string | null;
  sourceHash: string | null;
  inputManifestHash: string | null;
  sourceWatermarks: Record<string, unknown>;
  overrideHash: string | null;
  diagnostics: CommissionDiagnostic[];
  overrides: CommissionOverrideRow[];
  exports: CommissionExportRow[];
  exportGate: CommissionExportGate;
  auditHistory: CommissionAuditRecord[];
  revisionHistory: CommissionRevisionHistoryRow[];
};

export type CommissionReadyWorksheetModel = CommissionWorksheetBase & {
  servingStatus: "ready";
  servingCode: null;
  servingMessage: null;
  completedJobs: number;
  totalWorkValue: number;
  commissionPool: number;
  insidePoolTotal: number;
  outsidePoolTotal: number;
  payrollTotal: number;
  activeTechnicians: number;
  zeroPayoutTechnicians: number;
  allocationBasis: "equal-split" | "hours-share";
  technicians: CommissionTechnicianRow[];
  coverage: CommissionCoverage;
  invariants: CommissionInvariants;
};

export type CommissionUnavailableWorksheetModel = CommissionWorksheetBase & {
  servingStatus: "building" | "unavailable";
  servingCode: string;
  servingMessage: string;
  completedJobs: null;
  totalWorkValue: null;
  commissionPool: null;
  insidePoolTotal: null;
  outsidePoolTotal: null;
  payrollTotal: null;
  activeTechnicians: null;
  zeroPayoutTechnicians: null;
  technicians: [];
  coverage: null;
  invariants: null;
};

export type CommissionWorksheetModel = CommissionReadyWorksheetModel | CommissionUnavailableWorksheetModel;

export type CommissionSummaryTechnician = {
  employeeId: string;
  displayName: string;
  totalBonus: number;
  totalPayroll: number;
  allocatedValue: number;
  jobCount: number;
  activePeriods: number;
  averageBonus: number | null;
  rank: number;
  trend: Array<number | null>;
};

export type CommissionSummaryPeriod = {
  key: string;
  label: string;
  status: CommissionPeriodStatus | "mixed";
  finalized: boolean;
  loadedMonths: number;
  expectedMonths: number;
  commissionPool: number | null;
  payrollTotal: number | null;
  totalWorkValue: number | null;
  completedJobs: number | null;
  supportedJobs: number | null;
  excludedJobs: number | null;
  activeTechnicians: number | null;
  technicians: CommissionSummaryTechnician[];
  teamTechnicianBonus: number | null;
  reconciles: boolean | null;
  diagnostics: string[];
};

export type CommissionSummaryMonth = CommissionSummaryPeriod & {
  month: number;
  runId: string | null;
  revision: number | null;
};

export type CommissionDashboardReadModel = {
  freshness: FreshnessStatus;
  worksheet: CommissionWorksheetModel;
  /** Previous calendar month's immutable pool, used for the January cross-year comparison. */
  priorMonthCommissionPool?: number | null;
  summary: {
    year: number;
    loadedFinalizedMonths: number;
    progressPercent: number;
    months: CommissionSummaryMonth[];
    quarters: CommissionSummaryPeriod[];
    annual: CommissionSummaryPeriod;
    totalAnnualPool: number | null;
    averageMonthlyPool: number | null;
    peakMonth: { label: string; value: number } | null;
    activeTechnicians: number | null;
    diagnostics: string[];
  };
  warnings: string[];
  dataContractGaps: string[];
};

export type CommissionPeriodRunRow = Omit<CommissionCanonicalRunRow, "status"> & {
  status: CommissionPeriodStatus;
};

type PeriodRunRow = CommissionPeriodRunRow;
type CommissionSummaryRunRow = Pick<CommissionPeriodRunRow,
  "period_id" | "period_start" | "period_end" | "status" | "revision" | "edit_revision"
  | "period_watermarks" | "period_override_hash" | "current_run_id" | "calculation_stale"
  | "source_changed_after_export" | "reviewed_by" | "reviewed_at" | "exported_by" | "exported_at"
  | "locked_by" | "locked_at" | "created_by" | "period_created_at" | "revision_reason"
  | "run_id" | "run_revision" | "run_status" | "run_watermarks" | "run_override_hash"
  | "read_model" | "calculated_by" | "calculated_at" | "source_complete" | "config_hash"
  | "source_hash" | "input_manifest_hash" | "calculation_hash" | "immutable"
  | "run_completed_jobs" | "run_total_work_value" | "run_pool_amount" | "run_inside_pool_total"
  | "run_outside_pool_total" | "run_payroll_total" | "run_coverage" | "run_invariants"
  | "export_count"
>;
type CommissionSummarySourceRow = PeriodRunRow | CommissionSummaryRunRow;

export type CommissionReadModelDependencies = {
  query?: PostgresQuery;
  getFreshness?: typeof getPageFreshness;
  now?: Date;
};

const defaultConfig: CommissionConfig = {
  poolPercent: 0.5,
  minBonusPercent: 5,
  efficiencyEnabled: false,
  maxEfficiencyAdjustmentPercent: 20,
  tierMultipliers: { Gold: 1.3, Silver: 1.2, Bronze: 1.1, Standard: 1 },
};

export async function getCommissionDashboardReadModel(params: {
  year: number;
  month: number;
  summaryYear: number;
  includeAllocationDetails?: boolean;
}, dependencies: CommissionReadModelDependencies = {}): Promise<CommissionDashboardReadModel> {
  const period = requireCommissionDashboardPeriod({
    year: String(params.year),
    month: String(params.month),
    summaryYear: String(params.summaryYear),
  }, dependencies.now);
  const { year, month, summaryYear } = period;
  const query = dependencies.query ?? queryPostgres;
  const freshnessPromise = (dependencies.getFreshness ?? getPageFreshness)(
    "commissions",
    `${year}-${String(month).padStart(2, "0")}-01`,
  );
  const [freshness, settledReadResults] = await Promise.all([
    freshnessPromise,
    Promise.allSettled([
      getWorksheet(year, month, query),
      getSummaryRows(summaryYear, query),
      month === 1 && year > 2023 ? getPriorMonthCommissionPool(year, month, query) : Promise.resolve(null),
    ]),
  ]);
  const [worksheetResult, summaryRowsResult, priorMonthPoolResult] = settledReadResults;
  const worksheet = worksheetResult.status === "fulfilled"
    ? worksheetResult.value
    : unavailableWorksheet(year, month, {
      servingStatus: "unavailable",
      code: "READ_MODEL_UNAVAILABLE",
      message: errorMessage(worksheetResult.reason),
    });
  const summary = summaryRowsResult.status === "fulfilled"
    ? buildCommissionSummary(summaryYear, summaryRowsResult.value)
    : buildCommissionSummary(summaryYear, [], [
      `Annual commission summary is unavailable: ${errorMessage(summaryRowsResult.reason)}`,
    ]);
  const dashboard = {
    freshness,
    worksheet,
    priorMonthCommissionPool: priorMonthPoolResult.status === "fulfilled" ? priorMonthPoolResult.value : null,
    summary,
    warnings: buildWarnings(worksheet),
    dataContractGaps: buildDataContractGaps(worksheet),
  };
  return params.includeAllocationDetails === false ? withoutCommissionAllocationDetails(dashboard) : dashboard;
}

/** Removes expandable job detail from the page payload; totals remain intact. */
export function withoutCommissionAllocationDetails(model: CommissionDashboardReadModel): CommissionDashboardReadModel {
  if (model.worksheet.servingStatus !== "ready") return model;
  return {
    ...model,
    worksheet: {
      ...model.worksheet,
      technicians: model.worksheet.technicians.map((technician) => ({ ...technician, jobAllocations: [] })),
    },
  };
}

/** Detail is fetched only after its technician row is opened. */
export async function getCommissionTechnicianAllocations(params: {
  year: number; month: number; employeeId: string;
}, dependencies: CommissionReadModelDependencies = {}): Promise<CommissionJobAllocation[]> {
  const period = requireCommissionDashboardPeriod({
    year: String(params.year),
    month: String(params.month),
  }, dependencies.now);
  const worksheet = await getWorksheet(period.year, period.month, dependencies.query ?? queryPostgres);
  if (worksheet.servingStatus !== "ready") return [];
  return worksheet.technicians.find((technician) => technician.employeeId === params.employeeId)?.jobAllocations ?? [];
}

async function getWorksheet(year: number, month: number, query: PostgresQuery): Promise<CommissionWorksheetModel> {
  const periodStart = periodStartDate(year, month);
  const result = await query<CommissionSummaryRunRow>(`${periodRunSelect()}
      where p.period_start = $1::date
      order by p.revision desc
      limit 1`, [periodStart]);
  const row = result.rows[0];
  if (!row) {
    return unavailableWorksheet(year, month, {
      servingStatus: "unavailable",
      code: "PERIOD_MISSING",
      message: "No commission period revision exists for this month.",
    });
  }

  return worksheetFromRow(year, month, row, [], [], [], [revisionHistoryRow(row)]);
}

async function getSummaryRows(year: number, query: PostgresQuery) {
  const result = await query<CommissionSummaryRunRow>(`${summaryRunSelect({ distinctByPeriod: true, slim: true })}
      where p.period_start >= $1::date
        and p.period_start < $2::date
      order by p.period_start, p.revision desc`, [`${year}-01-01`, `${year + 1}-01-01`]);
  return result.rows;
}

async function getPriorMonthCommissionPool(year: number, month: number, query: PostgresQuery): Promise<number | null> {
  const prior = new Date(Date.UTC(year, month - 2, 1));
  const priorYear = prior.getUTCFullYear();
  const priorMonth = prior.getUTCMonth() + 1;
  const periodStart = `${priorYear}-${String(priorMonth).padStart(2, "0")}-01`;
  const result = await query<CommissionSummaryRunRow>(`${summaryRunSelect({ slim: true })}
      where p.period_start = $1::date
      order by p.revision desc
      limit 1`, [periodStart]);
  const row = result.rows[0];
  if (!row) return null;
  const serving = summaryWorksheetFromRow(priorYear, priorMonth, row);
  return serving.ready ? serving.worksheet.commissionPool : null;
}

function periodRunSelect() {
  return summaryRunSelect();
}

function summaryRunSelect(options: { distinctByPeriod?: boolean; slim?: boolean } = {}) {
  return `select ${options.distinctByPeriod ? "distinct on (p.period_start)" : ""} p.id::text as period_id, p.period_start::text, p.period_end::text,
                 p.status::text as status, p.revision, p.edit_revision,
                 p.source_watermarks as period_watermarks, p.override_hash as period_override_hash,
                 p.current_run_id::text, p.calculation_stale, p.source_changed_after_export,
                 p.reviewed_by, p.reviewed_at::text, p.exported_by, p.exported_at::text,
                 p.locked_by, p.locked_at::text, p.created_by,
                 p.created_at::text as period_created_at, p.revision_reason,
                 r.id::text as run_id, r.revision as run_revision, r.run_status,
                 r.source_watermarks as run_watermarks, r.override_hash as run_override_hash,
                 ${options.slim ? "r.read_model - 'jobAllocations' as read_model" : "r.read_model"}, r.created_by as calculated_by, r.created_at::text as calculated_at,
                 r.source_complete, r.config_hash, r.source_hash,
                 r.input_manifest_hash, r.calculation_hash, r.immutable,
                 r.completed_jobs as run_completed_jobs,
                 r.total_work_value::double precision as run_total_work_value,
                 r.pool_amount::double precision as run_pool_amount,
                 r.inside_pool_total::double precision as run_inside_pool_total,
                 r.outside_pool_total::double precision as run_outside_pool_total,
                 r.payroll_total::double precision as run_payroll_total,
                 r.coverage_json as run_coverage, r.invariants_json as run_invariants,
                 coalesce((select count(*) from metrics.commission_exports e where e.calculation_run_id = r.id), 0)::integer as export_count
            from metrics.commission_periods p
            left join metrics.commission_calculation_runs r on r.id = p.current_run_id`;
}

function revisionHistoryRow(row: CommissionSummarySourceRow): CommissionRevisionHistoryRow {
  return {
    periodId: row.period_id,
    revision: row.revision,
    editRevision: row.edit_revision,
    status: row.status,
    runId: row.run_id,
    runRevision: row.run_revision,
    createdBy: row.created_by,
    createdAt: row.period_created_at,
    revisionReason: row.revision_reason,
    exportCount: row.export_count,
    protected: row.status === "exported" || row.status === "locked",
  };
}

function worksheetFromRow(
  year: number,
  month: number,
  row: CommissionSummarySourceRow,
  overrides: CommissionOverrideRow[] = [],
  exports: CommissionExportRow[] = [],
  auditHistory: CommissionAuditRecord[] = [],
  revisionHistory: CommissionRevisionHistoryRow[] = [],
): CommissionWorksheetModel {
  const serving = evaluateCommissionRunForServing(row);
  if (!serving.ready) {
    return unavailableWorksheet(year, month, {
      servingStatus: serving.servingStatus,
      code: serving.code,
      message: serving.message,
      row,
      overrides,
      exports,
      auditHistory,
      revisionHistory,
    });
  }
  const readModel = serving.readModel;
  const allocations = normalizeJobAllocations(readModel.jobAllocations);
  const allocationsByEmployee = groupAllocations(allocations);
  const technicians = readModel.technicians.map((entry, index) => normalizeTechnician(entry, index, allocationsByEmployee));
  const exportGate = buildCommissionExportGate({
    periodStatus: row.status,
    calculationStale: row.calculation_stale,
    currentRunId: row.current_run_id,
    runId: row.run_id,
    runStatus: row.run_status,
    sourceComplete: Boolean(row.source_complete),
    inputManifestHash: row.input_manifest_hash,
    sourceHash: row.source_hash,
    configHash: row.config_hash,
    periodOverrideHash: row.period_override_hash,
    runOverrideHash: row.run_override_hash,
    invariants: readModel.invariants,
  });
  const diagnostics = [...readModel.diagnostics];
  if (!row.run_id) diagnostics.push(diagnostic("RUN_MISSING", "This period revision has no immutable calculation run."));
  if (row.calculation_stale) diagnostics.push(diagnostic("RUN_STALE", "A calculation-affecting change is awaiting rebuild."));
  if (row.source_changed_after_export) diagnostics.push(diagnostic("SOURCE_CHANGED_AFTER_EXPORT", "Source facts changed after this revision was exported."));
  return {
    servingStatus: "ready",
    servingCode: null,
    servingMessage: null,
    year,
    month,
    periodLabel: formatPeriod(year, month),
    periodStart: row.period_start,
    periodEnd: row.period_end,
    status: row.status,
    periodId: row.period_id,
    runId: row.run_id,
    runStatus: row.run_status,
    revision: row.revision,
    editRevision: row.edit_revision,
    runRevision: row.run_revision,
    calculatedAt: row.calculated_at,
    calculatedBy: row.calculated_by,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    exportedBy: row.exported_by,
    exportedAt: row.exported_at,
    lockedBy: row.locked_by,
    lockedAt: row.locked_at,
    protected: row.status === "exported" || row.status === "locked",
    calculationStale: row.calculation_stale,
    sourceComplete: Boolean(row.source_complete),
    sourceChangedAfterExport: row.source_changed_after_export,
    config: {
      ...normalizeConfig(readModel.config),
    },
    configHash: row.config_hash,
    sourceHash: row.source_hash,
    inputManifestHash: row.input_manifest_hash,
    sourceWatermarks: asRecord(row.run_watermarks ?? row.period_watermarks),
    overrideHash: row.run_override_hash ?? row.period_override_hash,
    completedJobs: readModel.completedJobs,
    totalWorkValue: readModel.totalWorkValue,
    commissionPool: readModel.poolAmount,
    insidePoolTotal: readModel.insidePoolTotal,
    outsidePoolTotal: readModel.outsidePoolTotal,
    payrollTotal: readModel.payrollTotal,
    activeTechnicians: technicians.length,
    zeroPayoutTechnicians: technicians.filter((technician) => technician.payrollBonus === 0).length,
    allocationBasis: allocationBasisFromAllocations(allocations),
    technicians,
    coverage: readModel.coverage,
    invariants: readModel.invariants,
    diagnostics,
    overrides,
    exports,
    exportGate,
    auditHistory,
    revisionHistory,
  };
}

function allocationBasisFromAllocations(allocations: CommissionJobAllocation[]): "equal-split" | "hours-share" {
  const byJob = groupAllocations(allocations);
  const multiTech = [...byJob.values()].filter((entries) => entries.length > 1);
  return multiTech.length > 0 && multiTech.every((entries) => entries.every((entry) => Math.abs(entry.share - entries[0].share) < 1e-9))
    ? "equal-split"
    : "hours-share";
}

export function buildCommissionExportGate(params: {
  periodStatus: CommissionPeriodStatus;
  calculationStale: boolean;
  currentRunId: string | null;
  runId: string | null;
  runStatus: string | null;
  sourceComplete: boolean;
  inputManifestHash: string | null;
  sourceHash: string | null;
  configHash: string | null;
  periodOverrideHash: string | null;
  runOverrideHash: string | null;
  invariants: CommissionInvariants;
}): CommissionExportGate {
  const reasons: string[] = [];
  if (!params.runId || params.currentRunId !== params.runId) {
    reasons.push("No current immutable calculation run is available.");
  } else if (params.runStatus !== "succeeded") {
    reasons.push("The current calculation run has not succeeded.");
  }
  if (params.calculationStale) reasons.push("The current calculation run is stale and must be rebuilt.");
  if (!params.sourceComplete) reasons.push("Source evidence is incomplete.");
  if (!["reviewed", "exported", "locked"].includes(params.periodStatus)) {
    reasons.push(`Period status ${params.periodStatus} is not exportable.`);
  }
  if (!params.inputManifestHash || !params.sourceHash || !params.configHash || !params.runOverrideHash) {
    reasons.push("The current run is missing immutable provenance hashes.");
  }
  if (params.runOverrideHash !== params.periodOverrideHash) {
    reasons.push("The current run does not match the period override revision.");
  }
  if (!params.invariants.insidePoolReconciles) reasons.push("Inside-pool payouts do not reconcile to the commission pool.");
  if (!params.invariants.nonnegativePayroll) reasons.push("Payroll contains a negative payout.");
  return { allowed: reasons.length === 0, reason: reasons[0] ?? null, reasons };
}

export function buildCommissionSummary(
  year: number,
  rows: CommissionSummarySourceRow[],
  additionalDiagnostics: string[] = [],
): CommissionDashboardReadModel["summary"] {
  const byMonth = new Map<number, CommissionSummarySourceRow>();
  for (const row of rows) {
    const month = new Date(`${row.period_start}T00:00:00Z`).getUTCMonth() + 1;
    if (!byMonth.has(month)) byMonth.set(month, row);
  }
  const months: CommissionSummaryMonth[] = Array.from({ length: 12 }, (_, index) => {
    const month = index + 1;
    const row = byMonth.get(month);
    if (!row) return emptySummaryMonth(year, month);
    const summaryWorksheet = summaryWorksheetFromRow(year, month, row);
    if (!summaryWorksheet.ready) {
      return {
        ...emptySummaryMonth(year, month),
        diagnostics: [`${summaryWorksheet.code}: ${summaryWorksheet.message}`],
      };
    }
    const period = aggregateSummaryPeriod(`${year}-${String(month).padStart(2, "0")}`, shortMonth(year, month), [summaryWorksheet.worksheet], 1);
    return {
      ...period,
      finalized: isFinalizedCommissionStatus(summaryWorksheet.worksheet.status),
      month,
      runId: row.run_id,
      revision: row.revision,
    };
  });
  const quarters = Array.from({ length: 4 }, (_, index) => aggregateSummaryPeriod(
    `${year}-Q${index + 1}`,
    `Q${index + 1} ${year}`,
    months.slice(index * 3, index * 3 + 3)
      .filter((month) => month.finalized)
      .map((month) => summaryMonthToWorksheet(month, month.month - index * 3 - 1)),
    3,
  ));
  const loadedWorksheets = months
    .filter((month) => month.finalized)
    .map((month) => summaryMonthToWorksheet(month, month.month - 1));
  const annual = aggregateSummaryPeriod(String(year), `${year} Annual`, loadedWorksheets, 12);
  const loadedFinalizedMonths = loadedWorksheets.length;
  const finalizedMonths = months.filter((month) => month.finalized);
  const loadedPools = finalizedMonths.flatMap((month) => month.commissionPool === null ? [] : [month.commissionPool]);
  const peak = finalizedMonths.reduce<CommissionSummaryMonth | null>((current, month) => {
    if (month.commissionPool === null) return current;
    return !current || (current.commissionPool ?? -Infinity) < month.commissionPool ? month : current;
  }, null);
  return {
    year,
    loadedFinalizedMonths,
    progressPercent: loadedFinalizedMonths / 12 * 100,
    months,
    quarters,
    annual,
    totalAnnualPool: loadedPools.length ? roundMoney(sum(loadedPools)) : null,
    averageMonthlyPool: loadedPools.length ? roundMoney(sum(loadedPools) / loadedPools.length) : null,
    peakMonth: peak?.commissionPool === null || peak?.commissionPool === undefined ? null : { label: peak.label, value: peak.commissionPool },
    activeTechnicians: loadedFinalizedMonths
      ? annual.technicians.filter((technician) => technician.totalBonus > 0).length
      : null,
    diagnostics: [
      ...additionalDiagnostics,
      `${loadedFinalizedMonths}/12 finalized monthly runs loaded.`,
      "Draft runs are shown in monthly detail but excluded from finalized quarterly and annual totals; genuinely missing months are N/A.",
      annual.reconciles === null
        ? "Annual reconciliation is N/A because no finalized monthly runs are loaded."
        : annual.reconciles
          ? "Annual team totals reconcile to immutable monthly runs."
          : "Annual team technician totals do not reconcile.",
    ],
  };
}

function isFinalizedCommissionStatus(status: CommissionPeriodStatus) {
  return status === "reviewed" || status === "exported" || status === "locked";
}

type SummaryWorksheet = Pick<CommissionReadyWorksheetModel,
  "status" | "commissionPool" | "payrollTotal" | "totalWorkValue" | "completedJobs" | "coverage" | "technicians" | "periodLabel"
> & { trendSlot?: number };

function summaryWorksheetFromRow(
  year: number,
  month: number,
  row: CommissionSummarySourceRow,
): { ready: true; worksheet: SummaryWorksheet } | { ready: false; code: string; message: string } {
  const serving = evaluateCommissionSummaryRunForServing(row);
  if (!serving.ready) {
    return { ready: false, code: serving.code, message: serving.message };
  }
  const readModel = serving.readModel;
  const jobCountByEmployee = new Map(readModel.coverage.technicianWork.map((entry) => [entry.employeeId, entry.jobCount]));
  const technicians = readModel.technicians.map((entry, index) => normalizeSummaryTechnician(entry, index, jobCountByEmployee));
  return {
    ready: true,
    worksheet: {
      status: row.status,
      commissionPool: readModel.poolAmount,
      payrollTotal: readModel.payrollTotal,
      totalWorkValue: readModel.totalWorkValue,
      completedJobs: readModel.completedJobs,
      coverage: readModel.coverage,
      technicians,
      periodLabel: formatPeriod(year, month),
    },
  };
}

type CommissionSummaryRunServingEvaluation =
  | { ready: true; readModel: CommissionReadModel }
  | { ready: false; code: string; message: string };

function evaluateCommissionSummaryRunForServing(row: CommissionSummarySourceRow): CommissionSummaryRunServingEvaluation {
  if (hasCanonicalCommissionEvidence(row)) {
    const strict = evaluateCommissionRunForServing(row);
    return strict.ready
      ? { ready: true, readModel: strict.readModel }
      : { ready: false, code: strict.code, message: strict.message };
  }
  if (!row.run_id) return summaryServingFailure("RUN_BUILDING", "The selected period has no completed calculation run yet.");
  if (!row.current_run_id || row.current_run_id !== row.run_id) {
    return summaryServingFailure("RUN_NOT_CURRENT", "The selected calculation is not the period's current immutable run.");
  }
  if (row.run_status !== "succeeded") {
    return summaryServingFailure(row.run_status === "pending" || row.run_status === "queued" || row.run_status === "running"
      ? "RUN_BUILDING"
      : "RUN_FAILED",
    row.run_status === "pending" || row.run_status === "queued" || row.run_status === "running"
      ? "The immutable commission calculation is still building."
      : `The current commission calculation did not succeed${row.run_status ? ` (${row.run_status})` : ""}.`);
  }
  if (row.calculation_stale) return summaryServingFailure("RUN_STALE", "The current commission calculation is stale and must be rebuilt.");
  if (row.source_changed_after_export) {
    return summaryServingFailure("SOURCE_CHANGED_AFTER_EXPORT", "Source facts changed after export; a current revision is still being prepared.");
  }
  if (!row.source_complete) return summaryServingFailure("SOURCE_INCOMPLETE", "Required period-specific source evidence is incomplete.");
  if (row.immutable !== true) return summaryServingFailure("READ_MODEL_INVALID", "The persisted commission summary is not immutable.");
  if (!row.input_manifest_hash || !row.source_hash || !row.config_hash || !row.calculation_hash || !row.run_override_hash) {
    return summaryServingFailure("READ_MODEL_INVALID", "The persisted commission summary is missing provenance hashes.");
  }
  if (row.run_override_hash !== row.period_override_hash) {
    return summaryServingFailure("READ_MODEL_INVALID", "The persisted commission summary does not match the current override revision.");
  }

  const readModel = coerceCommissionSummaryReadModel(row.read_model, true);
  if (!readModel) return summaryServingFailure("READ_MODEL_INVALID", "The persisted commission read model has an invalid summary shape.");
  if (!commissionSummaryInvariantsPass(readModel.invariants)) {
    return summaryServingFailure("READ_MODEL_INVALID", "The persisted commission summary has failed invariants.");
  }
  if (!commissionSummaryScalarsMatch(row, readModel)) {
    return summaryServingFailure("READ_MODEL_INVALID", "The persisted commission summary does not match stored run totals.");
  }
  return { ready: true, readModel };
}

function summaryServingFailure(code: string, message: string): CommissionSummaryRunServingEvaluation {
  return { ready: false, code, message };
}

function hasCanonicalCommissionEvidence(row: CommissionSummarySourceRow): row is PeriodRunRow {
  const candidate = row as Partial<PeriodRunRow>;
  return Array.isArray(candidate.employee_results)
    && Array.isArray(candidate.job_allocations)
    && Array.isArray(candidate.input_manifest);
}

const commissionInvariantKeys = [
  "insidePoolReconciles",
  "outsidePoolReconciles",
  "jobAllocationsReconcile",
  "unsupportedJobsUnallocated",
  "forfeitureReconciles",
  "efficiencyReconciles",
  "nonnegativePayroll",
] as const satisfies ReadonlyArray<keyof CommissionInvariants>;

function coerceCommissionSummaryReadModel(value: unknown, allowSlim = false): CommissionReadModel | null {
  const row = asRecordOrNull(value);
  if (!row) return null;
  if (
    !isFiniteNumber(row.completedJobs)
    || !isFiniteNumber(row.totalWorkValue)
    || !isFiniteNumber(row.poolAmount)
    || !isFiniteNumber(row.insidePoolTotal)
    || !isFiniteNumber(row.outsidePoolTotal)
    || !isFiniteNumber(row.payrollTotal)
  ) return null;
  if (!Array.isArray(row.technicians) || !Array.isArray(row.diagnostics)) return null;
  if (!allowSlim && !Array.isArray(row.jobAllocations)) return null;
  if (!isSummaryCoverage(row.coverage) || !isSummaryInvariants(row.invariants)) return null;
  if (!row.technicians.every(isSummaryTechnician)) return null;
  if (Array.isArray(row.jobAllocations) && !row.jobAllocations.every(isSummaryAllocation)) return null;
  return value as CommissionReadModel;
}

function isSummaryCoverage(value: unknown): value is CommissionCoverage {
  const row = asRecordOrNull(value);
  return Boolean(row
    && isFiniteNumber(row.completedJobs)
    && isFiniteNumber(row.commissionSupportedJobs)
    && isFiniteNumber(row.excludedJobs)
    && Array.isArray(row.excludedJobDetails)
    && Array.isArray(row.technicianWork));
}

function isSummaryInvariants(value: unknown): value is CommissionInvariants {
  const row = asRecordOrNull(value);
  return Boolean(row && commissionInvariantKeys.every((key) => typeof row[key] === "boolean"));
}

function isSummaryTechnician(value: unknown) {
  const row = asRecordOrNull(value);
  return Boolean(row
    && stringValue(row.employeeId)
    && stringValue(row.displayName)
    && isFiniteNumber(row.allocatedWorkValue)
    && isFiniteNumber(row.effectiveAllocatedWorkValue)
    && isFiniteNumber(row.rawBonus)
    && isFiniteNumber(row.forfeitedBonus)
    && isFiniteNumber(row.reallocationReceived)
    && isFiniteNumber(row.postForfeitureBonus)
    && isFiniteNumber(row.insidePoolAdjustment)
    && isFiniteNumber(row.overrideRedistribution)
    && isFiniteNumber(row.outsidePoolAdjustment)
    && isFiniteNumber(row.finalBonus)
    && isFiniteNumber(row.payrollBonus)
    && Array.isArray(row.notes));
}

function isSummaryAllocation(value: unknown) {
  const row = asRecordOrNull(value);
  return Boolean(row
    && stringValue(row.employeeId)
    && stringValue(row.jobId)
    && isFiniteNumber(row.jobTotal)
    && isFiniteNumber(row.employeeHours)
    && isFiniteNumber(row.jobTotalHours)
    && isFiniteNumber(row.share)
    && isFiniteNumber(row.allocatedValue)
    && typeof row.included === "boolean");
}

function commissionSummaryInvariantsPass(invariants: CommissionInvariants) {
  return commissionInvariantKeys.every((key) => invariants[key] === true);
}

function commissionSummaryScalarsMatch(row: CommissionSummarySourceRow, readModel: CommissionReadModel) {
  return integerMatches(row.run_completed_jobs, readModel.completedJobs)
    && moneyMatches(row.run_total_work_value, readModel.totalWorkValue)
    && moneyMatches(row.run_pool_amount, readModel.poolAmount)
    && moneyMatches(row.run_inside_pool_total, readModel.insidePoolTotal)
    && moneyMatches(row.run_outside_pool_total, readModel.outsidePoolTotal)
    && moneyMatches(row.run_payroll_total, readModel.payrollTotal);
}

function integerMatches(left: unknown, right: unknown) {
  const a = finiteNumberOrNull(left);
  const b = finiteNumberOrNull(right);
  return a !== null && b !== null && Math.trunc(a) === Math.trunc(b);
}

function moneyMatches(left: unknown, right: unknown) {
  const a = finiteNumberOrNull(left);
  const b = finiteNumberOrNull(right);
  return a !== null && b !== null && Math.round(a * 100) === Math.round(b * 100);
}

function aggregateSummaryPeriod(key: string, label: string, worksheets: SummaryWorksheet[], expectedMonths: number): CommissionSummaryPeriod {
  if (!worksheets.length) {
    return {
      key, label, status: "missing", finalized: false, loadedMonths: 0, expectedMonths,
      commissionPool: null, payrollTotal: null, totalWorkValue: null, completedJobs: null,
      supportedJobs: null, excludedJobs: null, activeTechnicians: null, technicians: [],
      teamTechnicianBonus: null, reconciles: null,
      diagnostics: ["No finalized immutable run is available for this period."],
    };
  }
  const byEmployee = new Map<string, { displayName: string; bonus: number; payroll: number; work: number; jobs: number; active: number; trend: Array<number | null> }>();
  for (const worksheet of worksheets) {
    for (const technician of worksheet.technicians) {
      if (!byEmployee.has(technician.employeeId)) {
        byEmployee.set(technician.employeeId, {
          displayName: technician.displayName, bonus: 0, payroll: 0, work: 0, jobs: 0, active: 0,
          trend: Array.from({ length: expectedMonths }, () => null),
        });
      }
    }
  }
  worksheets.forEach((worksheet, worksheetIndex) => {
    const trendSlot = worksheet.trendSlot ?? worksheetIndex;
    for (const current of byEmployee.values()) current.trend[trendSlot] = 0;
    for (const technician of worksheet.technicians) {
      const current = byEmployee.get(technician.employeeId)!;
      current.displayName = technician.displayName;
      current.bonus += technician.finalBonus;
      current.payroll += technician.payrollBonus;
      current.work += technician.allocatedValue;
      current.jobs += technician.jobCount;
      if (technician.finalBonus > 0) current.active += 1;
      current.trend[trendSlot] = technician.finalBonus;
    }
  });
  const technicians = [...byEmployee].map(([employeeId, value]) => ({
    employeeId,
    displayName: value.displayName,
    totalBonus: roundMoney(value.bonus),
    totalPayroll: roundMoney(value.payroll),
    allocatedValue: roundMoney(value.work),
    jobCount: value.jobs,
    activePeriods: value.active,
    averageBonus: roundMoney(value.bonus / worksheets.length),
    rank: 0,
    trend: value.trend,
  })).sort((a, b) => b.totalBonus - a.totalBonus || a.employeeId.localeCompare(b.employeeId))
    .map((technician, index) => ({ ...technician, rank: index + 1 }));
  const commissionPool = roundMoney(sum(worksheets.map((worksheet) => worksheet.commissionPool)));
  const payrollTotal = roundMoney(sum(worksheets.map((worksheet) => worksheet.payrollTotal)));
  const teamTechnicianBonus = roundMoney(sum(technicians.map((technician) => technician.totalBonus)));
  const statuses = new Set(worksheets.map((worksheet) => worksheet.status));
  return {
    key,
    label,
    status: statuses.size === 1 ? worksheets[0].status : "mixed",
    finalized: worksheets.length > 0,
    loadedMonths: worksheets.length,
    expectedMonths,
    commissionPool,
    payrollTotal,
    totalWorkValue: roundMoney(sum(worksheets.map((worksheet) => worksheet.totalWorkValue))),
    completedJobs: sum(worksheets.map((worksheet) => worksheet.completedJobs)),
    supportedJobs: sum(worksheets.map((worksheet) => worksheet.coverage.commissionSupportedJobs)),
    excludedJobs: sum(worksheets.map((worksheet) => worksheet.coverage.excludedJobs)),
    activeTechnicians: technicians.filter((technician) => technician.totalBonus > 0).length,
    technicians,
    teamTechnicianBonus,
    reconciles: Math.round(teamTechnicianBonus * 100) === Math.round(commissionPool * 100),
    diagnostics: worksheets.length < expectedMonths ? [`${worksheets.length}/${expectedMonths} finalized months loaded; missing months remain N/A.`] : [],
  };
}

function summaryMonthToWorksheet(month: CommissionSummaryMonth, trendSlot?: number): SummaryWorksheet {
  if (
    month.commissionPool === null
    || month.payrollTotal === null
    || month.totalWorkValue === null
    || month.completedJobs === null
    || month.supportedJobs === null
    || month.excludedJobs === null
  ) {
    throw new Error(`Commission summary month ${month.key} is not a loaded immutable run.`);
  }
  return {
    status: month.status === "mixed" ? "reviewed" : month.status,
    commissionPool: month.commissionPool,
    payrollTotal: month.payrollTotal,
    totalWorkValue: month.totalWorkValue,
    completedJobs: month.completedJobs,
    coverage: { ...emptyCoverage(), commissionSupportedJobs: month.supportedJobs, excludedJobs: month.excludedJobs },
    technicians: month.technicians.map((technician) => summaryTechnicianToRow(technician)),
    periodLabel: month.label,
    trendSlot,
  };
}

function summaryTechnicianToRow(technician: CommissionSummaryTechnician): CommissionTechnicianRow {
  return {
    employeeId: technician.employeeId, displayName: technician.displayName, rank: technician.rank,
    tier: "", included: true, belowMinimum: false, finalBonusLocked: false,
    jobCount: technician.jobCount, allocatedValue: technician.allocatedValue,
    effectiveAllocatedValue: technician.allocatedValue, baseBonus: 0, rawBonus: 0,
    forfeitedBonus: 0, reallocationReceived: 0, postForfeitureBonus: 0,
    insidePoolAdjustment: 0, overrideRedistribution: 0,
    outsidePoolAdjustment: roundMoney(technician.totalPayroll - technician.totalBonus),
    finalBonus: technician.totalBonus, payrollBonus: technician.totalPayroll,
    notes: [], jobAllocations: [],
  };
}

function emptySummaryMonth(year: number, month: number): CommissionSummaryMonth {
  return {
    ...aggregateSummaryPeriod(`${year}-${String(month).padStart(2, "0")}`, shortMonth(year, month), [], 1),
    month, runId: null, revision: null,
  };
}

function unavailableWorksheet(year: number, month: number, params: {
  servingStatus: "building" | "unavailable";
  code: string;
  message: string;
  row?: CommissionSummarySourceRow;
  overrides?: CommissionOverrideRow[];
  exports?: CommissionExportRow[];
  auditHistory?: CommissionAuditRecord[];
  revisionHistory?: CommissionRevisionHistoryRow[];
}): CommissionUnavailableWorksheetModel {
  const row = params.row;
  const periodStart = periodStartDate(year, month);
  const periodEnd = periodEndDate(year, month);
  return {
    servingStatus: params.servingStatus,
    servingCode: params.code,
    servingMessage: params.message,
    year, month, periodLabel: formatPeriod(year, month), periodStart, periodEnd,
    status: row?.status ?? "missing", periodId: row?.period_id ?? null,
    runId: row?.run_id ?? null, revision: row?.revision ?? null, editRevision: row?.edit_revision ?? 0,
    runRevision: row?.run_revision ?? null, runStatus: row?.run_status ?? null,
    calculatedAt: row?.calculated_at ?? null, calculatedBy: row?.calculated_by ?? null,
    reviewedBy: row?.reviewed_by ?? null, reviewedAt: row?.reviewed_at ?? null,
    exportedBy: row?.exported_by ?? null, exportedAt: row?.exported_at ?? null,
    lockedBy: row?.locked_by ?? null, lockedAt: row?.locked_at ?? null,
    protected: row?.status === "exported" || row?.status === "locked",
    calculationStale: row?.calculation_stale ?? true,
    sourceComplete: row ? sourceCompleteForDisplay(row) : false,
    sourceChangedAfterExport: row?.source_changed_after_export ?? false,
    config: normalizeConfig(row && hasCanonicalCommissionEvidence(row) ? row.period_config : undefined),
    configHash: row?.config_hash ?? null, sourceHash: row?.source_hash ?? null,
    inputManifestHash: row?.input_manifest_hash ?? null,
    sourceWatermarks: asRecord(row?.run_watermarks ?? row?.period_watermarks),
    overrideHash: row?.run_override_hash ?? row?.period_override_hash ?? null,
    completedJobs: null, totalWorkValue: null, commissionPool: null,
    insidePoolTotal: null, outsidePoolTotal: null, payrollTotal: null,
    activeTechnicians: null, zeroPayoutTechnicians: null, technicians: [],
    coverage: null, invariants: null,
    diagnostics: [diagnostic(params.code, params.message)],
    overrides: params.overrides ?? [], exports: params.exports ?? [],
    exportGate: {
      allowed: false,
      reason: params.message,
      reasons: [params.message],
    },
    auditHistory: params.auditHistory ?? [], revisionHistory: params.revisionHistory ?? [],
  };
}

function sourceCompleteForDisplay(row: CommissionSummarySourceRow) {
  return hasCanonicalCommissionEvidence(row) ? verifyCommissionCanonicalRun(row).ok : row.source_complete === true;
}

type CommissionRunServingEvaluation =
  | { ready: true; readModel: CommissionReadModel }
  | {
    ready: false;
    servingStatus: "building" | "unavailable";
    code: string;
    message: string;
  };

export function evaluateCommissionRunForServing(row: CommissionSummarySourceRow): CommissionRunServingEvaluation {
  if (!row.run_id) {
    return servingFailure("building", "RUN_BUILDING", "The selected period has no completed calculation run yet.");
  }
  if (!row.current_run_id || row.current_run_id !== row.run_id) {
    return servingFailure("unavailable", "RUN_NOT_CURRENT", "The selected calculation is not the period's current immutable run.");
  }
  if (row.run_status !== "succeeded") {
    const building = row.run_status === "pending" || row.run_status === "queued" || row.run_status === "running";
    return servingFailure(
      building ? "building" : "unavailable",
      building ? "RUN_BUILDING" : "RUN_FAILED",
      building
        ? "The immutable commission calculation is still building."
        : `The current commission calculation did not succeed${row.run_status ? ` (${row.run_status})` : ""}.`,
    );
  }
  if (row.calculation_stale) {
    return servingFailure("building", "RUN_STALE", "The current commission calculation is stale and must be rebuilt.");
  }
  if (row.source_changed_after_export) {
    return servingFailure("building", "SOURCE_CHANGED_AFTER_EXPORT", "Source facts changed after export; a current revision is still being prepared.");
  }
  if (!row.source_complete) {
    return servingFailure("building", "SOURCE_INCOMPLETE", "Required period-specific source evidence is incomplete.");
  }
  if (!hasCanonicalCommissionEvidence(row)) {
    return evaluatePersistedCommissionRunForServing(row);
  }
  const canonical = verifyCommissionCanonicalRun(row);
  if (!canonical.ok) {
    return servingFailure("unavailable", "READ_MODEL_INVALID", `The persisted commission result is invalid: ${canonical.error}`);
  }
  return { ready: true, readModel: canonical.readModel };
}

function evaluatePersistedCommissionRunForServing(row: CommissionSummaryRunRow): CommissionRunServingEvaluation {
  if (row.immutable !== true) return servingFailure("unavailable", "READ_MODEL_INVALID", "The persisted commission result is invalid: the run is not immutable.");
  if (!row.input_manifest_hash || !row.source_hash || !row.config_hash || !row.calculation_hash || !row.run_override_hash) {
    return servingFailure("unavailable", "READ_MODEL_INVALID", "The persisted commission result is invalid: provenance hashes are missing.");
  }
  if (row.run_override_hash !== row.period_override_hash) {
    return servingFailure("unavailable", "READ_MODEL_INVALID", "The persisted commission result is invalid: override revision mismatch.");
  }
  const readModel = coerceCommissionSummaryReadModel(row.read_model);
  if (!readModel) return servingFailure("unavailable", "READ_MODEL_INVALID", "The persisted commission result is invalid: read model shape is invalid.");
  if (!commissionSummaryInvariantsPass(readModel.invariants)) {
    return servingFailure("unavailable", "READ_MODEL_INVALID", "The persisted commission result is invalid: persisted invariants failed.");
  }
  if (!commissionSummaryScalarsMatch(row, readModel)) {
    return servingFailure("unavailable", "READ_MODEL_INVALID", "The persisted commission result is invalid: totals do not match the run columns.");
  }
  return { ready: true, readModel };
}

function servingFailure(
  servingStatus: "building" | "unavailable",
  code: string,
  message: string,
): CommissionRunServingEvaluation {
  return { ready: false, servingStatus, code, message };
}

function normalizeTechnician(entry: CommissionReadModel["technicians"][number], index: number, grouped: Map<string, CommissionJobAllocation[]>): CommissionTechnicianRow {
  const employeeId = String(entry.employeeId);
  const allocations = grouped.get(employeeId) ?? [];
  return {
    employeeId,
    displayName: entry.displayName,
    rank: entry.rank ?? index + 1,
    tier: entry.tier as string,
    included: entry.included as boolean,
    belowMinimum: entry.belowMinimum as boolean,
    finalBonusLocked: entry.finalBonusLocked as boolean,
    jobCount: allocations.length,
    allocatedValue: entry.allocatedWorkValue as number,
    effectiveAllocatedValue: entry.effectiveAllocatedWorkValue as number,
    baseBonus: entry.baseBonus as number,
    rawBonus: entry.rawBonus,
    forfeitedBonus: entry.forfeitedBonus,
    reallocationReceived: entry.reallocationReceived,
    postForfeitureBonus: entry.postForfeitureBonus as number,
    insidePoolAdjustment: entry.insidePoolAdjustment as number,
    overrideRedistribution: entry.overrideRedistribution as number,
    outsidePoolAdjustment: entry.outsidePoolAdjustment as number,
    finalBonus: entry.finalBonus,
    payrollBonus: entry.payrollBonus as number,
    notes: entry.notes as string[],
    jobAllocations: allocations,
    efficiency: entry.efficiency,
  };
}

function normalizeSummaryTechnician(
  entry: CommissionReadModel["technicians"][number], index: number, jobCountByEmployee: Map<string, number>,
): CommissionTechnicianRow {
  return {
    ...normalizeTechnician(entry, index, new Map()),
    jobCount: jobCountByEmployee.get(String(entry.employeeId)) ?? 0,
    jobAllocations: [],
  };
}

function normalizeJobAllocations(value: CommissionReadModel["jobAllocations"]): CommissionJobAllocation[] {
  return value.map((entry) => {
    const row = entry as CommissionReadModel["jobAllocations"][number] & {
      jobName?: string;
      customer?: string;
      customerName?: string;
    };
    return {
      employeeId: entry.employeeId,
      jobId: entry.jobId,
      jobName: plainDisplayText(
        row.jobName,
        `Job ${entry.jobId}`,
      ),
      customer: plainDisplayText(row.customer ?? row.customerName, "Customer unavailable"),
      jobTotal: entry.jobTotal,
      employeeHours: entry.employeeHours,
      jobTotalHours: entry.jobTotalHours,
      share: entry.share,
      allocatedValue: entry.allocatedValue,
      included: entry.included,
    };
  });
}

function normalizeConfig(value: unknown): CommissionConfig {
  const row = asRecord(value);
  const storedTierMultipliers = asRecord(row.tierMultipliers ?? row.tier_multipliers);
  return {
    poolPercent: numberValue(row.poolPercent ?? row.pool_pct, defaultConfig.poolPercent),
    minBonusPercent: numberValue(row.minBonusPercent ?? row.min_bonus_pct, defaultConfig.minBonusPercent),
    efficiencyEnabled: booleanValue(row.efficiencyEnabled ?? row.efficiency_enabled, defaultConfig.efficiencyEnabled),
    maxEfficiencyAdjustmentPercent: numberValue(row.maxEfficiencyAdjustmentPercent ?? row.max_efficiency_adjustment_pct, defaultConfig.maxEfficiencyAdjustmentPercent),
    tierMultipliers: {
      Gold: numberValue(storedTierMultipliers.Gold, defaultConfig.tierMultipliers.Gold),
      Silver: numberValue(storedTierMultipliers.Silver, defaultConfig.tierMultipliers.Silver),
      Bronze: numberValue(storedTierMultipliers.Bronze, defaultConfig.tierMultipliers.Bronze),
      Standard: numberValue(storedTierMultipliers.Standard, defaultConfig.tierMultipliers.Standard),
    },
  };
}

function groupAllocations(allocations: CommissionJobAllocation[]) {
  const grouped = new Map<string, CommissionJobAllocation[]>();
  for (const allocation of allocations) grouped.set(allocation.employeeId, [...(grouped.get(allocation.employeeId) ?? []), allocation]);
  return grouped;
}

function buildWarnings(worksheet: CommissionWorksheetModel) {
  const warnings: string[] = [];
  if (worksheet.servingStatus !== "ready") {
    warnings.push(worksheet.servingMessage);
    return warnings;
  }
  if (worksheet.sourceChangedAfterExport) warnings.push("Source facts changed after export; the protected revision remains immutable while a new draft is prepared.");
  return warnings;
}

function buildDataContractGaps(worksheet: CommissionWorksheetModel) {
  const gaps: string[] = [];
  if (!worksheet.inputManifestHash) gaps.push("Immutable input manifest is unavailable.");
  if (!worksheet.sourceHash) gaps.push("Immutable source hash is unavailable.");
  if (!worksheet.configHash) gaps.push("Versioned config hash is unavailable.");
  if (!getCommissionExportBlobStatus().configured) gaps.push("Azure Blob export replication is not configured; PostgreSQL retained bytes remain the re-download authority.");
  return gaps;
}

function emptyCoverage(): CommissionCoverage {
  return {
    jobsWithTimesheets: 0, jobsWithoutTimesheets: 0, completedJobs: 0,
    positiveValueJobs: 0, nonPositiveValueJobs: 0, commissionSupportedJobs: 0,
    excludedJobs: 0, jobsWithEligibleWork: 0, jobsWithOnlyIneligibleWork: 0,
    mappedHours: 0, unmappedHours: 0, nonFieldTechnicianHours: 0,
    unmappedTimesheetEntries: 0, mappedTechnicians: 0, eligibleTechnicians: 0,
    ineligibleTechnicians: 0, eligibleAllocatedWorkValue: 0,
    ineligibleAllocatedWorkValue: 0, excludedWorkValue: 0,
    excludedJobDetails: [], technicianWork: [],
  };
}

function diagnostic(code: string, message: string): CommissionDiagnostic {
  return { code, severity: "error", message };
}

function periodStartDate(year: number, month: number) {
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

function periodEndDate(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

function formatPeriod(year: number, month: number) {
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(year, month - 1, 1)));
}

function shortMonth(year: number, month: number) {
  return new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(year, month - 1, 1)));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asRecordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value: unknown) {
  return Number.isFinite(Number(value));
}

function finiteNumberOrNull(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function numberValue(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function booleanValue(value: unknown, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function sum(values: Iterable<number>) {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unable to read the commission store.";
}
