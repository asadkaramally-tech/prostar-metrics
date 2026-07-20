import type { FreshnessState } from "@/lib/metrics/freshness";

export type AggregateFreshnessPageKey = "quotes" | "jobs" | "technicians" | "commissions";
export type SourceCoverageRole = "core" | "secondary";
export type EvaluatedSourceState = "successful" | "missing" | "building" | "stale" | "suspect" | "failed";

export type SourceRequirement = {
  sourceFamily: string;
  role: SourceCoverageRole;
  maxAgeHours: number | null;
  requiresCompleteWindow?: boolean;
  requiresCurrentManifest?: boolean;
};

export type SourceFreshnessEvidence = {
  sourceFamily: string;
  lastSuccessfulRunAt?: Date | string | null;
  lastFailedRunAt?: Date | string | null;
  lastChangeAt?: Date | string | null;
  dataThrough?: Date | string | null;
  pendingCount?: number;
  failedCount?: number;
  completeWindow?: boolean | null;
  manifestGeneration?: number | null;
  reconciliationGeneration?: number | null;
  expectedPageCount?: number | null;
  completedPageCount?: number | null;
  manifestCompletedAt?: Date | string | null;
  manifestReconciledAt?: Date | string | null;
  suspectReason?: string | null;
};

export type ReconciliationFreshnessEvidence = {
  status: "matched" | "mismatch" | "sample_missing" | "running" | "failed" | "missing";
  checkedAt?: Date | string | null;
};

export type RollupFreshnessEvidence = {
  status: "ready" | "building" | "failed" | "suspect" | "missing";
  rebuiltAt?: Date | string | null;
  detail?: string | null;
};

export type ProfitCapacityCompletenessEvidence = {
  completedJobsMissing: number;
  activeCompletedCostCentersMissing: number;
  peopleMissing: number;
};

export type AggregateFreshnessInput = {
  pageKey: AggregateFreshnessPageKey;
  requirements?: readonly SourceRequirement[];
  sources: SourceFreshnessEvidence[];
  reconciliation: ReconciliationFreshnessEvidence;
  rollup: RollupFreshnessEvidence;
  profitCapacityCompleteness?: ProfitCapacityCompletenessEvidence | null;
  explicitState?: FreshnessState | null;
  explicitDetail?: string | null;
  explicitFailedAt?: Date | string | null;
  explicitReconciledAt?: Date | string | null;
  sealedHistoricalPeriod?: boolean;
  now?: Date;
};

export type AggregateFreshnessEvaluation = {
  state: Exclude<FreshnessState, "missing">;
  detail: string;
  dataThrough: string | null;
  lastSuccessfulRunAt: string | null;
  lastFailedRunAt: string | null;
  continuationCount: number;
  coverage: {
    requiredSources: string[];
    secondarySources: string[];
    sources: Record<string, {
      role: SourceCoverageRole;
      state: EvaluatedSourceState;
      dataThrough: string | null;
      lastSuccessfulRunAt: string | null;
      lastFailedRunAt: string | null;
      lastChangeAt: string | null;
      pendingCount: number;
      failedCount: number;
      manifestGeneration: number | null;
      reconciliationGeneration: number | null;
      expectedPageCount: number | null;
      completedPageCount: number | null;
      manifestCompletedAt: string | null;
      manifestReconciledAt: string | null;
      detail: string;
    }>;
    rollup: {
      status: RollupFreshnessEvidence["status"];
      rebuiltAt: string | null;
      detail: string | null;
    };
    reconciliation: {
      status: ReconciliationFreshnessEvidence["status"];
      checkedAt: string | null;
    };
    profitCapacityCompleteness: ProfitCapacityCompletenessEvidence | null;
  };
};

const requirementsByPage: Record<AggregateFreshnessPageKey, readonly SourceRequirement[]> = {
  quotes: [
    source("quotes", "core", 8),
    incrementalSource("quote_logs", "core", 1),
    source("quote_nested", "core", null),
  ],
  jobs: [
    source("jobs", "core", 8),
    incrementalSource("job_logs", "core", 1),
    source("job_nested", "core", null),
    source("jobs_from_timesheets", "secondary", 2),
    source("timesheets", "secondary", 2),
  ],
  technicians: [
    source("jobs", "core", 8),
    incrementalSource("job_logs", "core", 1),
    source("job_nested", "core", null),
    source("jobs_from_timesheets", "core", 2),
    source("employees", "core", 26),
    source("timesheets", "core", 2),
    source("schedules", "secondary", null),
    incrementalSource("schedule_logs", "secondary", 1),
    source("mobile_status", "secondary", 1, true),
  ],
  commissions: [
    source("jobs", "core", 8),
    incrementalSource("job_logs", "core", 1),
    source("job_nested", "core", null),
    source("jobs_from_timesheets", "core", 2),
    source("employees", "core", 26),
    source("timesheets", "core", 2),
  ],
};

export function pageFreshnessRequirements(pageKey: AggregateFreshnessPageKey): readonly SourceRequirement[] {
  return requirementsByPage[pageKey];
}

export function historicalPageFreshnessRequirements(pageKey: AggregateFreshnessPageKey): readonly SourceRequirement[] {
  return requirementsByPage[pageKey]
    .filter((requirement) => !requirement.sourceFamily.endsWith("_logs"))
    .map((requirement) => ({
      ...requirement,
      maxAgeHours: null,
      requiresCompleteWindow: true,
      requiresCurrentManifest: false,
    }));
}

export function isAggregateFreshnessPageKey(pageKey: string): pageKey is AggregateFreshnessPageKey {
  return pageKey === "quotes" || pageKey === "jobs" || pageKey === "technicians" || pageKey === "commissions";
}

export function evaluatePageFreshness(input: AggregateFreshnessInput): AggregateFreshnessEvaluation {
  const now = input.now ?? new Date();
  const requirements = input.requirements ?? pageFreshnessRequirements(input.pageKey);
  const evidenceBySource = new Map(input.sources.map((item) => [item.sourceFamily, item]));
  const evaluatedSources = requirements.map((requirement) =>
    evaluateSource(requirement, evidenceBySource.get(requirement.sourceFamily), now),
  );
  const failedSources = evaluatedSources.filter((item) => item.state === "failed");
  const suspectSources = evaluatedSources.filter((item) => item.state === "suspect");
  const staleSources = evaluatedSources.filter((item) => item.state === "stale");
  const incompleteCoreSources = evaluatedSources.filter(
    (item) => item.requirement.role === "core" && (item.state === "missing" || item.state === "building"),
  );
  const incompleteSecondarySources = evaluatedSources.filter(
    (item) => item.requirement.role === "secondary" && (item.state === "missing" || item.state === "building"),
  );
  const latestChangeAt = maxDate(evaluatedSources.map((item) => item.lastChangeAt));
  const rollupRebuiltAt = toDate(input.rollup.rebuiltAt);
  const reconciliationCheckedAt = toDate(input.reconciliation.checkedAt);
  const lastFailedRunAt = maxDate(evaluatedSources.map((item) => item.lastFailedRunAt));
  const coverage = buildCoverage(
    requirements,
    evaluatedSources,
    input.rollup,
    input.reconciliation,
    input.profitCapacityCompleteness ?? null,
  );
  const common = {
    dataThrough: minimumDataThrough(evaluatedSources),
    lastSuccessfulRunAt: toIso(reconciliationCheckedAt),
    lastFailedRunAt: toIso(lastFailedRunAt),
    continuationCount: evaluatedSources.reduce((total, item) => total + item.pendingCount, 0),
    coverage,
  };

  if (
    failedSources.length > 0
    || input.reconciliation.status === "failed"
    || input.rollup.status === "failed"
    || preserveExplicitFailed(input, evaluatedSources, reconciliationCheckedAt, rollupRebuiltAt)
  ) {
    const detail = failedSources.length > 0
      ? `Required freshness work failed for ${sourceList(failedSources)}.`
      : input.reconciliation.status === "failed"
        ? "The latest required reconciliation failed."
        : input.rollup.status === "failed"
          ? input.rollup.detail ?? "A required current-period rollup failed."
          : input.explicitDetail ?? "The explicit failed state has not been superseded by successful source evidence.";
    return { state: "failed", detail, ...common };
  }

  if (
    suspectSources.length > 0
    || input.reconciliation.status === "mismatch"
    || input.rollup.status === "suspect"
    || preserveExplicitSuspect(input, reconciliationCheckedAt)
  ) {
    const detail = suspectSources.length > 0
      ? `Source coverage is suspect for ${sourceList(suspectSources)}.`
      : input.reconciliation.status === "mismatch"
        ? "The latest current-period reconciliation found count or money drift."
        : input.rollup.status === "suspect"
          ? input.rollup.detail ?? "The current-period rollup is marked suspect."
          : input.explicitDetail ?? "The explicit suspect state has not been cleared by a newer matched reconciliation.";
    return { state: "suspect", detail, ...common };
  }

  if (staleSources.length > 0) {
    return {
      state: "stale",
      detail: `Source freshness exceeded its allowed age for ${sourceList(staleSources)}.`,
      ...common,
    };
  }

  if (input.pageKey === "jobs" || input.pageKey === "technicians") {
    const completeness = input.profitCapacityCompleteness;
    if (!completeness) {
      return {
        state: "building",
        detail: "Migration 026 profit and capacity completeness evidence is unavailable.",
        ...common,
      };
    }
    const totalMissing = completeness.completedJobsMissing
      + completeness.activeCompletedCostCentersMissing
      + completeness.peopleMissing;
    if (totalMissing > 0) {
      return {
        state: "building",
        detail: `Migration 026 is incomplete: ${completeness.completedJobsMissing} completed jobs, ${completeness.activeCompletedCostCentersMissing} active completed cost centers, and ${completeness.peopleMissing} people remain.`,
        ...common,
      };
    }
  }

  if (incompleteCoreSources.length > 0) {
    return {
      state: "building",
      detail: `Core source coverage is incomplete for ${sourceList(incompleteCoreSources)}.`,
      ...common,
    };
  }

  if (input.rollup.status !== "ready" || !rollupRebuiltAt) {
    return {
      state: "building",
      detail: input.rollup.detail ?? "The current-period rollup has not completed successfully.",
      ...common,
    };
  }

  if (input.reconciliation.status !== "matched" || !reconciliationCheckedAt) {
    return {
      state: "building",
      detail: "A matched current-period reconciliation is still required.",
      ...common,
    };
  }

  if (input.pageKey === "commissions") {
    if (latestChangeAt && reconciliationCheckedAt < latestChangeAt) {
      return {
        state: "building",
        detail: "The matched job reconciliation predates the latest successful source change.",
        ...common,
      };
    }
    if (rollupRebuiltAt < reconciliationCheckedAt) {
      return {
        state: "building",
        detail: "The commission calculation predates the latest matched job reconciliation.",
        ...common,
      };
    }
  } else if (input.sealedHistoricalPeriod) {
    if (latestChangeAt && reconciliationCheckedAt < latestChangeAt) {
      return {
        state: "building",
        detail: "The matched historical reconciliation predates its sealed source evidence.",
        ...common,
      };
    }
  } else if (latestChangeAt && reconciliationCheckedAt < latestChangeAt) {
    return {
      state: "building",
      detail: "The latest matched reconciliation predates the current source generation.",
      ...common,
    };
  }

  if (incompleteSecondarySources.length > 0) {
    return {
      state: "partial",
      detail: `Core sources are complete and reconciled; secondary coverage is incomplete for ${sourceList(incompleteSecondarySources)}.`,
      ...common,
    };
  }

  return {
    state: "current",
    detail: "All source windows are complete, the current-period rollup is ready, and reconciliation is matched.",
    ...common,
  };
}

function source(
  sourceFamily: string,
  role: SourceCoverageRole,
  maxAgeHours: number | null,
  requiresCompleteWindow = false,
): SourceRequirement {
  return {
    sourceFamily,
    role,
    maxAgeHours,
    requiresCompleteWindow,
    requiresCurrentManifest: true,
  };
}

function incrementalSource(
  sourceFamily: string,
  role: SourceCoverageRole,
  maxAgeHours: number,
): SourceRequirement {
  return {
    sourceFamily,
    role,
    maxAgeHours,
    requiresCompleteWindow: true,
    requiresCurrentManifest: false,
  };
}

function evaluateSource(requirement: SourceRequirement, evidence: SourceFreshnessEvidence | undefined, now: Date) {
  const lastSuccessfulRunAt = toDate(evidence?.lastSuccessfulRunAt);
  const lastFailedRunAt = toDate(evidence?.lastFailedRunAt);
  const lastChangeAt = toDate(evidence?.lastChangeAt);
  const dataThrough = toDate(evidence?.dataThrough) ?? lastSuccessfulRunAt;
  const manifestCompletedAt = toDate(evidence?.manifestCompletedAt);
  const manifestReconciledAt = toDate(evidence?.manifestReconciledAt);
  const pendingCount = nonNegativeInteger(evidence?.pendingCount);
  const failedCount = nonNegativeInteger(evidence?.failedCount);
  const manifestGeneration = positiveIntegerOrNull(evidence?.manifestGeneration);
  const reconciliationGeneration = positiveIntegerOrNull(evidence?.reconciliationGeneration);
  const expectedPageCount = positiveIntegerOrNull(evidence?.expectedPageCount);
  const completedPageCount = positiveIntegerOrNull(evidence?.completedPageCount);
  const completeCurrentManifest = Boolean(
    manifestGeneration
    && reconciliationGeneration === manifestGeneration
    && expectedPageCount
    && completedPageCount === expectedPageCount
    && manifestCompletedAt
    && manifestReconciledAt
    && evidence?.completeWindow === true,
  );
  let state: EvaluatedSourceState;
  let detail: string;

  const hasCompleteServingEvidence = requirement.requiresCurrentManifest
    ? completeCurrentManifest
    : Boolean(lastSuccessfulRunAt && evidence?.completeWindow === true);

  if (
    (failedCount > 0 || (lastFailedRunAt && (!lastSuccessfulRunAt || lastFailedRunAt > lastSuccessfulRunAt)))
    && !hasCompleteServingEvidence
  ) {
    state = "failed";
    detail = failedCount > 0
      ? `${failedCount} source job${failedCount === 1 ? " is" : "s are"} dead-lettered.`
      : "The latest source run failed without a later success.";
  } else if (evidence?.suspectReason) {
    state = "suspect";
    detail = evidence.suspectReason;
  } else if (requirement.requiresCurrentManifest && !manifestGeneration) {
    state = lastSuccessfulRunAt ? "building" : "missing";
    detail = "No complete current-period source/page manifest is recorded.";
  } else if (requirement.requiresCurrentManifest && !completeCurrentManifest) {
    state = "building";
    detail = reconciliationGeneration !== manifestGeneration || !manifestReconciledAt
      ? "The current manifest has no matched reconciliation from the same generation."
      : "The current source/page manifest is incomplete.";
  } else if (
    requirement.maxAgeHours !== null
    && dataThrough
    && now.getTime() - dataThrough.getTime() > requirement.maxAgeHours * 36e5
  ) {
    state = "stale";
    detail = `Data-through exceeds the ${requirement.maxAgeHours}-hour source limit.`;
  } else if (!lastSuccessfulRunAt) {
    state = "missing";
    detail = "No successful complete source run is recorded.";
  } else if (pendingCount > 0 || (requirement.requiresCompleteWindow && evidence?.completeWindow !== true)) {
    state = "building";
    detail = pendingCount > 0
      ? `${pendingCount} source job${pendingCount === 1 ? " remains" : "s remain"} queued or running.`
      : "The declared source window is not complete.";
  } else {
    state = "successful";
    detail = "Successful complete source coverage is recorded.";
  }

  return {
    requirement,
    state,
    detail,
    dataThrough,
    lastSuccessfulRunAt,
    lastFailedRunAt,
    lastChangeAt,
    pendingCount,
    failedCount,
    manifestGeneration,
    reconciliationGeneration,
    expectedPageCount,
    completedPageCount,
    manifestCompletedAt,
    manifestReconciledAt,
  };
}

function buildCoverage(
  requirements: readonly SourceRequirement[],
  sources: ReturnType<typeof evaluateSource>[],
  rollup: RollupFreshnessEvidence,
  reconciliation: ReconciliationFreshnessEvidence,
  profitCapacityCompleteness: ProfitCapacityCompletenessEvidence | null,
): AggregateFreshnessEvaluation["coverage"] {
  return {
    requiredSources: requirements.filter((item) => item.role === "core").map((item) => item.sourceFamily),
    secondarySources: requirements.filter((item) => item.role === "secondary").map((item) => item.sourceFamily),
    sources: Object.fromEntries(sources.map((item) => [
      item.requirement.sourceFamily,
      {
        role: item.requirement.role,
        state: item.state,
        dataThrough: toIso(item.dataThrough),
        lastSuccessfulRunAt: toIso(item.lastSuccessfulRunAt),
        lastFailedRunAt: toIso(item.lastFailedRunAt),
        lastChangeAt: toIso(item.lastChangeAt),
        pendingCount: item.pendingCount,
        failedCount: item.failedCount,
        manifestGeneration: item.manifestGeneration,
        reconciliationGeneration: item.reconciliationGeneration,
        expectedPageCount: item.expectedPageCount,
        completedPageCount: item.completedPageCount,
        manifestCompletedAt: toIso(item.manifestCompletedAt),
        manifestReconciledAt: toIso(item.manifestReconciledAt),
        detail: item.detail,
      },
    ])),
    rollup: {
      status: rollup.status,
      rebuiltAt: toIso(toDate(rollup.rebuiltAt)),
      detail: rollup.detail ?? null,
    },
    reconciliation: {
      status: reconciliation.status,
      checkedAt: toIso(toDate(reconciliation.checkedAt)),
    },
    profitCapacityCompleteness,
  };
}

function preserveExplicitFailed(
  input: AggregateFreshnessInput,
  sources: ReturnType<typeof evaluateSource>[],
  reconciliationCheckedAt: Date | null,
  rollupRebuiltAt: Date | null,
) {
  if (input.explicitState !== "failed") return false;
  const failedAt = toDate(input.explicitFailedAt);
  if (!failedAt) return true;
  if (sources.some((item) => item.lastSuccessfulRunAt && item.lastSuccessfulRunAt > failedAt)) return false;
  if (
    input.reconciliation.status === "matched"
    && input.rollup.status === "ready"
    && reconciliationCheckedAt
    && rollupRebuiltAt
    && reconciliationCheckedAt > failedAt
    && rollupRebuiltAt > failedAt
  ) return false;
  return true;
}

function preserveExplicitSuspect(input: AggregateFreshnessInput, reconciliationCheckedAt: Date | null) {
  if (input.explicitState !== "suspect") return false;
  const explicitReconciledAt = toDate(input.explicitReconciledAt);
  return !(
    explicitReconciledAt
    && input.reconciliation.status === "matched"
    && reconciliationCheckedAt
    && reconciliationCheckedAt > explicitReconciledAt
  );
}

function minimumDataThrough(sources: ReturnType<typeof evaluateSource>[]) {
  const values = sources
    .filter((item) => item.state === "successful")
    .map((item) => item.dataThrough)
    .filter((value): value is Date => Boolean(value));
  if (values.length === 0) return null;
  return toIso(new Date(Math.min(...values.map((value) => value.getTime()))));
}

function sourceList(sources: Array<ReturnType<typeof evaluateSource>>) {
  return sources.map((item) => item.requirement.sourceFamily).join(", ");
}

function nonNegativeInteger(value: number | undefined) {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : 0;
}

function positiveIntegerOrNull(value: number | null | undefined) {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function maxDate(values: Array<Date | null>) {
  const dates = values.filter((value): value is Date => Boolean(value));
  return dates.length > 0 ? new Date(Math.max(...dates.map((value) => value.getTime()))) : null;
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toIso(value: Date | null) {
  return value ? value.toISOString() : null;
}
