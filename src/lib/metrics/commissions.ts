import { isCompletedJobStage } from "@/lib/metrics/jobs";

export type CommissionTier = "Gold" | "Silver" | "Bronze" | "Standard";
export type CommissionTierMultipliers = Record<CommissionTier, number>;
export type CommissionOverridePoolTreatment = "neutral" | "inside_pool" | "outside_pool";

export type CommissionPeriodConfig = {
  poolPercent: number;
  minBonusPercent: number;
  efficiencyEnabled: boolean;
  maxEfficiencyAdjustmentPercent: number;
  tierMultipliers?: CommissionTierMultipliers;
};

export type CommissionTechnicianInput = {
  employeeId: string;
  displayName: string;
  included: boolean;
  allocatedWorkValue: number;
  tierMultiplier: number;
  efficiencyMultiplier?: number;
  efficiency?: CommissionEfficiencyResult;
  adjustment: number;
  belowMinimum: boolean;
};

type CommissionOverrideBase = {
  employeeId: string;
  reason: string;
};

export type CommissionTypedOverrideInput =
  | (CommissionOverrideBase & { field: "included"; value: boolean; poolTreatment: "neutral" })
  | (CommissionOverrideBase & { field: "allocated_value"; value: number; poolTreatment: "neutral" })
  | (CommissionOverrideBase & { field: "tier"; value: CommissionTier; poolTreatment: "neutral" })
  | (CommissionOverrideBase & { field: "inside_pool_adjustment"; value: number; poolTreatment: "inside_pool" })
  | (CommissionOverrideBase & { field: "outside_pool_adjustment"; value: number; poolTreatment: "outside_pool" })
  | (CommissionOverrideBase & { field: "final_bonus"; value: number; poolTreatment: "inside_pool" })
  | (CommissionOverrideBase & { field: "notes"; value: string; poolTreatment: "neutral" });

/** Compatibility shape for persisted adjustments created before typed overrides. */
export type CommissionLegacyOverrideInput = {
  employeeId: string;
  amount: number;
  poolTreatment: "inside_pool" | "outside_pool_adjustment";
  reason?: string;
};

export type CommissionOverrideInput = CommissionTypedOverrideInput | CommissionLegacyOverrideInput;

export type CommissionTechnicianResult = {
  employeeId: string;
  displayName: string;
  rank?: number;
  tier?: CommissionTier;
  tierMultiplier?: number;
  included?: boolean;
  allocatedWorkValue?: number;
  effectiveAllocatedWorkValue?: number;
  baseBonus?: number;
  rawBonus: number;
  belowMinimum?: boolean;
  forfeitedBonus: number;
  reallocationReceived: number;
  postForfeitureBonus?: number;
  efficiency?: CommissionEfficiencyResult;
  insidePoolAdjustment?: number;
  overrideRedistribution?: number;
  finalBonusLocked?: boolean;
  outsidePoolAdjustment?: number;
  finalBonus: number;
  payrollBonus?: number;
  notes?: string[];
};

export type CommissionTimesheetInput = {
  employeeId?: string | null;
  hours: number;
  mapped?: boolean;
  /**
   * Deprecated and ignored (owner rule 2026-07-20): ALL mapped recorded hours
   * on a period job count in the job's allocation denominator and earn shares.
   * The flag is retained for input compatibility only.
   */
  fieldTechnician?: boolean;
};

export type CommissionQuoteLaborCoverageState =
  | "complete"
  | "complete_no_qualifying_work"
  | "missing"
  | "loading"
  | "error";

export type CommissionJobInput = {
  jobId: string;
  completedDate: string;
  stageName?: string | null;
  sellValue: number;
  quoteId?: string | null;
  quotedHours?: number | null;
  quoteLaborRows?: number;
  quoteLaborCoverageStatus?: CommissionQuoteLaborCoverageState;
  timesheets: CommissionTimesheetInput[];
};

export type CommissionEfficiencyResult = {
  enabled?: boolean;
  maxAdjustmentPercent?: number;
  quoteJobs: number;
  quotedHours: number;
  actualHours: number;
  efficiencyRatio: number | null;
  potentialMultiplier?: number;
  multiplier: number;
  effect: number;
  neutralReason?: "disabled" | "no_qualifying_quote_work";
};

export type CommissionRosterEntry = {
  employeeId: string;
  displayName: string;
  /**
   * Deprecated and ignored (owner rule 2026-07-20): the roster is a display
   * directory (names, positions, dates of hire) ONLY — it never gates
   * membership or earning. Anyone with mapped recorded hours on a period job
   * is included by default; the only exclusion mechanism is an operator
   * `included` override (the saved session-checkbox state).
   */
  included: boolean;
  /** Deprecated and ignored. Section 6.4 derives tiers from period rank. */
  tier?: CommissionTier;
  notes?: string;
};

export type CommissionDiagnostic = {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  jobId?: string;
  employeeId?: string;
  amount?: number;
  hours?: number;
};

export type CommissionCoverage = {
  jobsWithTimesheets: number;
  jobsWithoutTimesheets: number;
  completedJobs: number;
  positiveValueJobs: number;
  nonPositiveValueJobs: number;
  commissionSupportedJobs: number;
  excludedJobs: number;
  jobsWithEligibleWork: number;
  jobsWithOnlyIneligibleWork: number;
  mappedHours: number;
  unmappedHours: number;
  nonFieldTechnicianHours: number;
  unmappedTimesheetEntries: number;
  mappedTechnicians: number;
  eligibleTechnicians: number;
  ineligibleTechnicians: number;
  eligibleAllocatedWorkValue: number;
  ineligibleAllocatedWorkValue: number;
  excludedWorkValue: number;
  excludedJobDetails: Array<{
    jobId: string;
    sellValue: number;
    reason: "no_mapped_technician_hours";
    unmappedHours: number;
    nonFieldTechnicianHours: number;
  }>;
  quoteLabor?: {
    status: CommissionQuoteLaborCoverageState;
    required: boolean;
    quoteSourcedJobs: number;
    jobsWithLaborRows: number;
    qualifyingJobs: number;
    jobsWithNoQualifyingWork: number;
    laborRows: number;
    incompleteJobIds: string[];
  };
  technicianWork: Array<{
    employeeId: string;
    displayName: string;
    included: boolean;
    allocatedWorkValue: number;
    effectiveAllocatedWorkValue: number;
    mappedHours: number;
    jobCount: number;
  }>;
};

export type CommissionInvariants = {
  insidePoolReconciles: boolean;
  outsidePoolReconciles: boolean;
  jobAllocationsReconcile: boolean;
  unsupportedJobsUnallocated: boolean;
  forfeitureReconciles: boolean;
  efficiencyReconciles: boolean;
  nonnegativePayroll: boolean;
};

export type CommissionJobAllocationResult = {
  jobId: string;
  employeeId: string;
  jobTotal: number;
  employeeHours: number;
  jobTotalHours: number;
  share: number;
  allocatedValue: number;
  included: boolean;
};

export type CommissionReadModel = {
  periodStart: string;
  periodEnd: string;
  config: CommissionPeriodConfig;
  completedJobs: number;
  totalWorkValue: number;
  poolAmount: number;
  insidePoolTotal: number;
  outsidePoolTotal: number;
  payrollTotal: number;
  activeTechnicians: number;
  technicians: CommissionTechnicianResult[];
  jobAllocations: CommissionJobAllocationResult[];
  coverage: CommissionCoverage;
  diagnostics: CommissionDiagnostic[];
  invariants: CommissionInvariants;
};

export type CommissionCalculationErrorCode =
  | "INVALID_INPUT"
  | "NO_ELIGIBLE_TECHNICIANS"
  | "ZERO_ELIGIBLE_BASIS"
  | "ZERO_POOL"
  | "OVERRIDE_CONFLICT"
  | "INVARIANT_VIOLATION";

export class CommissionCalculationError extends Error {
  readonly code: CommissionCalculationErrorCode;
  readonly diagnostics: CommissionDiagnostic[];

  constructor(code: CommissionCalculationErrorCode, message: string, diagnostics: CommissionDiagnostic[] = []) {
    super(message);
    this.name = "CommissionCalculationError";
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

type OverrideState = {
  included?: boolean;
  allocatedValue?: number;
  tier?: CommissionTier;
  insidePoolAdjustment?: number;
  outsidePoolAdjustment?: number;
  finalBonus?: number;
  notes?: string;
  fields: Set<string>;
};

type EfficiencyAccumulator = {
  quoteJobs: Set<string>;
  quotedHours: number;
  actualHours: number;
};

type RankedTechnician = {
  employeeId: string;
  displayName: string;
  rank: number;
  tier: CommissionTier;
  tierMultiplier: number;
  allocatedWorkValueCents: number;
  effectiveAllocatedWorkValue: number;
  efficiency: CommissionEfficiencyResult;
  notes: string[];
};

const DEFAULT_CONFIG: CommissionPeriodConfig = {
  poolPercent: 0.5,
  minBonusPercent: 5,
  efficiencyEnabled: false,
  maxEfficiencyAdjustmentPercent: 20,
  tierMultipliers: { Gold: 1.3, Silver: 1.2, Bronze: 1.1, Standard: 1 },
};

const TIER_MULTIPLIERS: Record<CommissionTier, number> = {
  Gold: 1.3,
  Silver: 1.2,
  Bronze: 1.1,
  Standard: 1,
};

export function calculateCommissionPool(totalWorkValue: number, poolPercent: number): number {
  return fromCents(toCents(Math.max(0, totalWorkValue) * Math.max(0, poolPercent)));
}

export function calculateCommissionPoolFromPercent(totalWorkValue: number, poolPercent: number): number {
  return fromCents(toCents(Math.max(0, totalWorkValue) * (Math.max(0, poolPercent) / 100)));
}

/**
 * Low-level compatibility allocator. The normative period engine is
 * buildCommissionReadModel, which derives tiers and applies efficiency in order.
 */
export function allocateCommissionPool(
  poolAmount: number,
  technicians: CommissionTechnicianInput[],
): CommissionTechnicianResult[] {
  if (technicians.some((technician) => technician.adjustment !== 0)) {
    throw new CommissionCalculationError(
      "INVALID_INPUT",
      "Untyped technician adjustments are not supported; use a typed commission override.",
    );
  }

  const poolCents = toCents(Math.max(0, poolAmount));
  const included = technicians.filter(
    (technician) => technician.included && technician.allocatedWorkValue > 0 && commissionWeight(technician) > 0,
  );
  const weights = included.map((technician) => ({
    id: technician.employeeId,
    weight: commissionWeight(technician),
  }));
  const rawCents = allocateLargestRemainder(poolCents, weights);
  const below = new Set(included.filter((technician) => technician.belowMinimum).map((technician) => technician.employeeId));
  if (below.size === included.length) {
    below.clear();
  }
  const remainingWeights = weights.filter((entry) => !below.has(entry.id));
  const finalCents = remainingWeights.length > 0
    ? allocateLargestRemainder(poolCents, remainingWeights)
    : new Map<string, number>();

  return technicians.map((technician) => {
    const raw = rawCents.get(technician.employeeId) ?? 0;
    const final = finalCents.get(technician.employeeId) ?? 0;
    return {
      employeeId: technician.employeeId,
      displayName: technician.displayName,
      included: technician.included,
      allocatedWorkValue: technician.allocatedWorkValue,
      efficiency: technician.efficiency,
      rawBonus: fromCents(raw),
      belowMinimum: below.has(technician.employeeId),
      forfeitedBonus: fromCents(below.has(technician.employeeId) ? raw : 0),
      reallocationReceived: fromCents(Math.max(0, final - raw)),
      insidePoolAdjustment: 0,
      overrideRedistribution: 0,
      outsidePoolAdjustment: 0,
      finalBonus: fromCents(final),
      payrollBonus: fromCents(final),
    };
  });
}

export function buildCommissionReadModel(params: {
  jobs: CommissionJobInput[];
  roster: CommissionRosterEntry[];
  periodStart: string;
  periodEnd: string;
  config?: CommissionPeriodConfig;
  poolPercent?: number;
  minBonusPercent?: number;
  efficiencyEnabled?: boolean;
  maxEfficiencyAdjustmentPercent?: number;
  overrides?: CommissionOverrideInput[];
}): CommissionReadModel {
  validatePeriod(params.periodStart, params.periodEnd);
  const config = resolveConfig(params);
  validateConfig(config);
  const diagnostics: CommissionDiagnostic[] = [];
  const rosterByEmployee = buildRosterMap(params.roster);
  const overridesByEmployee = parseOverrides(params.overrides ?? []);

  const actualAllocationExact = new Map<string, number>();
  const actualAllocationCents = new Map<string, number>();
  const mappedHoursByEmployee = new Map<string, number>();
  const jobsByEmployee = new Map<string, Set<string>>();
  const efficiencyByEmployee = new Map<string, EfficiencyAccumulator>();
  const jobAllocations: CommissionJobAllocationResult[] = [];
  const excludedJobDetails: CommissionCoverage["excludedJobDetails"] = [];
  const supportedJobIds = new Set<string>();
  const jobIdsWithEligibleWork = new Set<string>();
  const jobIdsWithOnlyIneligibleWork = new Set<string>();
  const seenJobIds = new Set<string>();
  let completedJobs = 0;
  let positiveValueJobs = 0;
  let nonPositiveValueJobs = 0;
  let totalWorkValueCents = 0;
  let excludedWorkValueCents = 0;
  let mappedHours = 0;
  let unmappedHours = 0;
  let unmappedTimesheetEntries = 0;
  const quoteLaborCoverageByJob: Array<{
    jobId: string;
    status: CommissionQuoteLaborCoverageState;
    laborRows: number;
    qualifying: boolean;
  }> = [];

  for (const job of [...params.jobs].sort((left, right) => compareNumericIds(left.jobId, right.jobId))) {
    validateJob(job);
    if (seenJobIds.has(job.jobId)) {
      throw invalidInput(`Duplicate commission job ID ${job.jobId}.`);
    }
    seenJobIds.add(job.jobId);

    if (!isDateInRange(job.completedDate, params.periodStart, params.periodEnd) || !isCompletedJobStage(job.stageName)) {
      continue;
    }

    completedJobs += 1;
    const quoteSourced = Boolean(job.quoteId) || job.quotedHours !== null && job.quotedHours !== undefined;
    if (quoteSourced) {
      const inferredRows = job.quoteLaborRows ?? ((job.quotedHours ?? 0) > 0 ? 1 : 0);
      quoteLaborCoverageByJob.push({
        jobId: job.jobId,
        status: job.quoteLaborCoverageStatus
          ?? ((job.quotedHours ?? 0) > 0 ? "complete" : "complete_no_qualifying_work"),
        laborRows: inferredRows,
        qualifying: (job.quotedHours ?? 0) > 0,
      });
    }
    const positiveSellValue = job.sellValue > 0;
    const sellValueCents = positiveSellValue ? toCents(job.sellValue) : 0;
    if (positiveSellValue) {
      positiveValueJobs += 1;
      totalWorkValueCents += sellValueCents;
    } else {
      nonPositiveValueJobs += 1;
      diagnostics.push({
        code: "NON_POSITIVE_WORK_VALUE",
        severity: "info",
        message: `Completed job ${job.jobId} has no positive commission work value.`,
        jobId: job.jobId,
        amount: fromCents(sellValueCents),
      });
    }

    const hoursByEmployee = new Map<string, number>();
    let jobUnmappedHours = 0;
    for (const timesheet of job.timesheets) {
      if (!Number.isFinite(timesheet.hours)) {
        throw invalidInput(`Job ${job.jobId} contains a non-finite timesheet hour value.`);
      }
      if (timesheet.hours <= 0) {
        continue;
      }

      const employeeId = normalizeEmployeeId(timesheet.employeeId);
      if (!employeeId || timesheet.mapped === false) {
        jobUnmappedHours += timesheet.hours;
        unmappedHours += timesheet.hours;
        unmappedTimesheetEntries += 1;
        continue;
      }
      // Owner rule (2026-07-20): every mapped recorded hour on a period job
      // counts in jobTotalHours and earns a share — the former
      // "non-field-technician" exclusion path is deleted.
      hoursByEmployee.set(employeeId, (hoursByEmployee.get(employeeId) ?? 0) + timesheet.hours);
      mappedHours += timesheet.hours;
    }

    if (jobUnmappedHours > 0) {
      diagnostics.push({
        code: "UNMAPPED_TIMESHEET_WORK",
        severity: "warning",
        message: `Job ${job.jobId} has positive timesheet hours without a mapped employee.`,
        jobId: job.jobId,
        hours: jobUnmappedHours,
      });
    }

    const jobTotalHours = sum(hoursByEmployee.values());
    if (!positiveSellValue || jobTotalHours <= 0) {
      if (positiveSellValue && jobTotalHours <= 0) {
        excludedWorkValueCents += sellValueCents;
        excludedJobDetails.push({
          jobId: job.jobId,
          sellValue: fromCents(sellValueCents),
          reason: "no_mapped_technician_hours",
          unmappedHours: jobUnmappedHours,
          nonFieldTechnicianHours: 0,
        });
        diagnostics.push({
          code: "EXCLUDED_JOB_NO_MAPPED_HOURS",
          severity: "warning",
          message: `Job ${job.jobId} remains in work value and pool but has no mapped field-technician hours.`,
          jobId: job.jobId,
          amount: fromCents(sellValueCents),
        });
      }
      continue;
    }

    supportedJobIds.add(job.jobId);
    const allocationCents = allocateLargestRemainder(
      sellValueCents,
      [...hoursByEmployee].map(([employeeId, hours]) => ({ id: employeeId, weight: hours })),
    );
    for (const [employeeId, employeeHours] of hoursByEmployee) {
      const share = employeeHours / jobTotalHours;
      const exactAllocatedValue = job.sellValue * share;
      const allocatedValueCents = allocationCents.get(employeeId) ?? 0;
      actualAllocationExact.set(employeeId, (actualAllocationExact.get(employeeId) ?? 0) + exactAllocatedValue);
      actualAllocationCents.set(employeeId, (actualAllocationCents.get(employeeId) ?? 0) + allocatedValueCents);
      mappedHoursByEmployee.set(employeeId, (mappedHoursByEmployee.get(employeeId) ?? 0) + employeeHours);
      const employeeJobs = jobsByEmployee.get(employeeId) ?? new Set<string>();
      employeeJobs.add(job.jobId);
      jobsByEmployee.set(employeeId, employeeJobs);

      if ((job.quotedHours ?? 0) > 0) {
        const efficiency = efficiencyByEmployee.get(employeeId) ?? {
          quoteJobs: new Set<string>(),
          quotedHours: 0,
          actualHours: 0,
        };
        efficiency.quoteJobs.add(job.jobId);
        efficiency.quotedHours += (job.quotedHours ?? 0) * share;
        efficiency.actualHours += employeeHours;
        efficiencyByEmployee.set(employeeId, efficiency);
      }

      jobAllocations.push({
        jobId: job.jobId,
        employeeId,
        jobTotal: fromCents(sellValueCents),
        employeeHours,
        jobTotalHours,
        share,
        allocatedValue: fromCents(allocatedValueCents),
        included: false,
      });
    }
  }

  const knownEmployeeIds = new Set([...rosterByEmployee.keys(), ...actualAllocationExact.keys()]);
  for (const employeeId of overridesByEmployee.keys()) {
    if (!knownEmployeeIds.has(employeeId)) {
      throw invalidInput(`Override targets unknown employee ${employeeId}.`);
    }
  }

  /* FINAL OWNER RULE (2026-07-20, stated three times): worksheet membership
     and allocation shares come ONLY from recorded hours on the schedule for
     the period. Anyone with mapped recorded hours on a period job appears as
     a row and earns their hours-share, INCLUDED BY DEFAULT. The roster is a
     display directory and never gates membership; the only exclusion is an
     operator `included` override (saved session-checkbox state). */
  const inclusionByEmployee = new Map<string, boolean>();
  for (const employeeId of knownEmployeeIds) {
    inclusionByEmployee.set(employeeId, overridesByEmployee.get(employeeId)?.included ?? true);
  }

  for (const allocation of jobAllocations) {
    allocation.included = inclusionByEmployee.get(allocation.employeeId) ?? false;
    if (allocation.included) {
      jobIdsWithEligibleWork.add(allocation.jobId);
    }
  }
  for (const jobId of supportedJobIds) {
    if (!jobIdsWithEligibleWork.has(jobId)) {
      jobIdsWithOnlyIneligibleWork.add(jobId);
      diagnostics.push({
        code: "JOB_WITH_ONLY_INELIGIBLE_WORK",
        severity: "warning",
        message: `Job ${jobId} is allocated only to operator-excluded technicians; its pool value redistributes through the included technicians' weights.`,
        jobId,
      });
    }
  }

  const includedWithWork = [...knownEmployeeIds].filter((employeeId) => {
    const override = overridesByEmployee.get(employeeId);
    const effectiveValue = override?.allocatedValue ?? actualAllocationExact.get(employeeId) ?? 0;
    return inclusionByEmployee.get(employeeId) === true && effectiveValue > 0;
  });
  const includedCount = [...knownEmployeeIds].filter((employeeId) => inclusionByEmployee.get(employeeId) === true).length;
  if (includedWithWork.length === 0) {
    const coverageDiagnostics = [...diagnostics, {
      code: includedCount === 0 ? "NO_ELIGIBLE_TECHNICIANS" : "ZERO_ELIGIBLE_BASIS",
      severity: "error" as const,
      message: includedCount === 0
        ? "Every technician is excluded from the commission payout."
        : "Included technicians have zero effective allocated work value.",
    }];
    throw new CommissionCalculationError(
      includedCount === 0 ? "NO_ELIGIBLE_TECHNICIANS" : "ZERO_ELIGIBLE_BASIS",
      coverageDiagnostics.at(-1)?.message ?? "Commission calculation has no payout basis.",
      coverageDiagnostics,
    );
  }

  const poolCents = toCents(fromCents(totalWorkValueCents) * (config.poolPercent / 100));
  if (poolCents <= 0) {
    throw new CommissionCalculationError(
      "ZERO_POOL",
      "The completed cohort produces a zero-cent pool; a successful payout run cannot be created.",
      diagnostics,
    );
  }

  const ranked = includedWithWork
    .map((employeeId) => {
      const roster = rosterByEmployee.get(employeeId);
      const override = overridesByEmployee.get(employeeId);
      return {
        employeeId,
        displayName: roster?.displayName ?? `Employee ${employeeId}`,
        allocatedWorkValueCents: actualAllocationCents.get(employeeId) ?? 0,
        effectiveAllocatedWorkValue: override?.allocatedValue ?? actualAllocationExact.get(employeeId) ?? 0,
        notes: [roster?.notes, override?.notes].filter((note): note is string => Boolean(note)),
      };
    })
    .sort((a, b) => b.effectiveAllocatedWorkValue - a.effectiveAllocatedWorkValue || compareEmployeeIds(a.employeeId, b.employeeId))
    .map<RankedTechnician>((technician, index) => {
      const derivedTier = tierForRank(index + 1);
      const tier = overridesByEmployee.get(technician.employeeId)?.tier ?? derivedTier;
      return {
        ...technician,
        rank: index + 1,
        tier,
        tierMultiplier: tierMultiplier(tier, config.tierMultipliers),
        efficiency: efficiencyForEmployee(
          efficiencyByEmployee.get(technician.employeeId),
          config.efficiencyEnabled,
          config.maxEfficiencyAdjustmentPercent,
        ),
      };
    });

  const rankedEmployeeIds = new Set(ranked.map((technician) => technician.employeeId));
  for (const [employeeId, override] of overridesByEmployee) {
    const requiresPayoutRow = override.finalBonus !== undefined
      || override.insidePoolAdjustment !== undefined
      || override.outsidePoolAdjustment !== undefined;
    if (requiresPayoutRow && !rankedEmployeeIds.has(employeeId)) {
      throw new CommissionCalculationError(
        "OVERRIDE_CONFLICT",
        `Payout override targets excluded or zero-basis employee ${employeeId}.`,
        diagnostics,
      );
    }
  }

  if (params.roster.some((entry) => entry.tier !== undefined)) {
    diagnostics.push({
      code: "PERMANENT_ROSTER_TIER_IGNORED",
      severity: "info",
      message: "Roster tiers were ignored; Gold, Silver, Bronze, and Standard were derived from period rank.",
    });
  }
  if (params.roster.some((entry) => entry.included === false)) {
    diagnostics.push({
      code: "ROSTER_INCLUSION_IGNORED",
      severity: "info",
      message: "Roster inclusion flags were ignored; anyone with mapped recorded hours is included unless an operator override excludes them.",
    });
  }

  const baseWeights = ranked.map((technician) => ({
    id: technician.employeeId,
    weight: technician.effectiveAllocatedWorkValue,
  }));
  const tierWeights = ranked.map((technician) => ({
    id: technician.employeeId,
    weight: technician.effectiveAllocatedWorkValue * technician.tierMultiplier,
  }));
  const baseCents = allocateLargestRemainder(poolCents, baseWeights);
  const rawCents = allocateLargestRemainder(poolCents, tierWeights);
  const rawExactCents = normalizedExactShares(poolCents, tierWeights);
  const thresholdCents = (poolCents / ranked.length) * (config.minBonusPercent / 100);
  const belowMinimum = new Set(
    ranked
      .filter((technician) => (rawExactCents.get(technician.employeeId) ?? 0) < thresholdCents)
      .map((technician) => technician.employeeId),
  );
  if (belowMinimum.size === ranked.length && belowMinimum.size > 0) {
    belowMinimum.clear();
    diagnostics.push({
      code: "FORFEITURE_WAIVED_NO_SURVIVOR",
      severity: "warning",
      message: "All eligible technicians fell below the threshold, so forfeiture was waived and pre-threshold bonuses were retained.",
    });
  }

  const postForfeitureWeights = tierWeights.filter((entry) => !belowMinimum.has(entry.id));
  const forfeitedPoolCents = sum(
    [...belowMinimum].map((employeeId) => rawCents.get(employeeId) ?? 0),
  );
  const reallocationCents = allocateLargestRemainder(forfeitedPoolCents, postForfeitureWeights);
  const postForfeitureCents = new Map(
    ranked.map((technician) => {
      const employeeId = technician.employeeId;
      return [
        employeeId,
        belowMinimum.has(employeeId)
          ? 0
          : (rawCents.get(employeeId) ?? 0) + (reallocationCents.get(employeeId) ?? 0),
      ];
    }),
  );
  const postForfeitureExactCents = normalizedExactShares(poolCents, postForfeitureWeights);
  const efficiencyWeights = ranked.map((technician) => ({
    id: technician.employeeId,
    weight: (postForfeitureExactCents.get(technician.employeeId) ?? 0) * technician.efficiency.multiplier,
  }));
  const hasEfficiencyAdjustment = ranked.some(
    (technician) => Math.abs(technician.efficiency.multiplier - 1) > Number.EPSILON,
  );
  const efficiencyCents = hasEfficiencyAdjustment
    ? allocateLargestRemainder(poolCents, efficiencyWeights)
    : new Map(postForfeitureCents);
  const efficiencyExactCents = hasEfficiencyAdjustment
    ? normalizedExactShares(poolCents, efficiencyWeights)
    : new Map(postForfeitureCents);

  for (const technician of ranked) {
    technician.efficiency.effect = fromCents(
      (efficiencyCents.get(technician.employeeId) ?? 0)
      - (postForfeitureCents.get(technician.employeeId) ?? 0),
    );
  }

  const finalAllocation = applyFinalAndInsidePoolOverrides({
    poolCents,
    ranked,
    efficiencyCents,
    efficiencyExactCents,
    overridesByEmployee,
  });

  let outsidePoolTotalCents = 0;
  const technicians: CommissionTechnicianResult[] = ranked.map((technician) => {
    const employeeId = technician.employeeId;
    const override = overridesByEmployee.get(employeeId);
    const outsideCents = toCents(override?.outsidePoolAdjustment ?? 0);
    const finalCents = finalAllocation.finalCents.get(employeeId) ?? 0;
    if (finalCents + outsideCents < 0) {
      throw new CommissionCalculationError(
        "OVERRIDE_CONFLICT",
        `Outside-pool adjustment would make employee ${employeeId}'s payroll amount negative.`,
        diagnostics,
      );
    }
    outsidePoolTotalCents += outsideCents;
    const raw = rawCents.get(employeeId) ?? 0;
    const postForfeiture = postForfeitureCents.get(employeeId) ?? 0;
    return {
      employeeId,
      displayName: technician.displayName,
      rank: technician.rank,
      tier: technician.tier,
      tierMultiplier: technician.tierMultiplier,
      included: true,
      allocatedWorkValue: fromCents(technician.allocatedWorkValueCents),
      effectiveAllocatedWorkValue: roundForDisclosure(technician.effectiveAllocatedWorkValue),
      baseBonus: fromCents(baseCents.get(employeeId) ?? 0),
      rawBonus: fromCents(raw),
      belowMinimum: belowMinimum.has(employeeId),
      forfeitedBonus: fromCents(belowMinimum.has(employeeId) ? raw : 0),
      reallocationReceived: fromCents(reallocationCents.get(employeeId) ?? 0),
      postForfeitureBonus: fromCents(postForfeiture),
      efficiency: technician.efficiency,
      insidePoolAdjustment: fromCents(finalAllocation.insideAdjustments.get(employeeId) ?? 0),
      overrideRedistribution: fromCents(
        finalCents
        - (efficiencyCents.get(employeeId) ?? 0)
        - (finalAllocation.insideAdjustments.get(employeeId) ?? 0),
      ),
      finalBonusLocked: override?.finalBonus !== undefined,
      outsidePoolAdjustment: fromCents(outsideCents),
      finalBonus: fromCents(finalCents),
      payrollBonus: fromCents(finalCents + outsideCents),
      notes: technician.notes,
    };
  });

  const eligibleAllocatedWorkValueCents = sum(
    [...actualAllocationCents].filter(([employeeId]) => inclusionByEmployee.get(employeeId) === true).map(([, cents]) => cents),
  );
  const ineligibleAllocatedWorkValueCents = sum(
    [...actualAllocationCents].filter(([employeeId]) => inclusionByEmployee.get(employeeId) !== true).map(([, cents]) => cents),
  );
  for (const [employeeId, cents] of actualAllocationCents) {
    if (inclusionByEmployee.get(employeeId) !== true && cents > 0) {
      diagnostics.push({
        code: "INELIGIBLE_TECHNICIAN_WORK",
        severity: "warning",
        message: `Employee ${employeeId}'s allocated work is disclosed but excluded from payout weights.`,
        employeeId,
        amount: fromCents(cents),
      });
    }
  }

  const technicianWork = [...knownEmployeeIds]
    .sort(compareEmployeeIds)
    .map((employeeId) => ({
      employeeId,
      displayName: rosterByEmployee.get(employeeId)?.displayName ?? `Employee ${employeeId}`,
      included: inclusionByEmployee.get(employeeId) ?? false,
      allocatedWorkValue: fromCents(actualAllocationCents.get(employeeId) ?? 0),
      effectiveAllocatedWorkValue: roundForDisclosure(
        overridesByEmployee.get(employeeId)?.allocatedValue ?? actualAllocationExact.get(employeeId) ?? 0,
      ),
      mappedHours: mappedHoursByEmployee.get(employeeId) ?? 0,
      jobCount: jobsByEmployee.get(employeeId)?.size ?? 0,
    }));

  const forfeitedCents = sum(technicians.map((technician) => toCents(technician.forfeitedBonus)));
  const reallocatedCents = sum(technicians.map((technician) => toCents(technician.reallocationReceived)));
  const efficiencyEffectCents = sum(technicians.map((technician) => toCents(technician.efficiency?.effect ?? 0)));
  const finalBonusCents = sum(technicians.map((technician) => toCents(technician.finalBonus)));
  const payrollTotalCents = sum(technicians.map((technician) => toCents(technician.payrollBonus ?? 0)));
  const jobAllocationsReconcile = [...supportedJobIds].every((jobId) => {
    const allocations = jobAllocations.filter((allocation) => allocation.jobId === jobId);
    return sum(allocations.map((allocation) => toCents(allocation.allocatedValue)))
      === toCents(allocations[0]?.jobTotal ?? 0);
  });
  const unsupportedJobsUnallocated = excludedJobDetails.every(
    (excluded) => !jobAllocations.some((allocation) => allocation.jobId === excluded.jobId),
  );
  const invariants: CommissionInvariants = {
    insidePoolReconciles: finalBonusCents === poolCents,
    outsidePoolReconciles: payrollTotalCents === poolCents + outsidePoolTotalCents,
    jobAllocationsReconcile,
    unsupportedJobsUnallocated,
    forfeitureReconciles: forfeitedCents === reallocatedCents,
    efficiencyReconciles: efficiencyEffectCents === 0,
    nonnegativePayroll: technicians.every((technician) => (technician.payrollBonus ?? 0) >= 0),
  };
  if (Object.values(invariants).some((value) => !value)) {
    throw new CommissionCalculationError(
      "INVARIANT_VIOLATION",
      "Commission calculation failed deterministic reconciliation invariants.",
      diagnostics,
    );
  }
  diagnostics.push({
    code: "COMMISSION_INVARIANTS_VERIFIED",
    severity: "info",
    message: `Inside-pool payouts reconcile to ${fromCents(poolCents).toFixed(2)} and outside-pool adjustments reconcile separately.`,
    amount: fromCents(poolCents),
  });

  const mappedTechnicians = actualAllocationCents.size;
  const eligibleTechnicians = technicianWork.filter((technician) => technician.included).length;
  const quoteLabor = summarizeQuoteLaborCoverage(quoteLaborCoverageByJob, config.efficiencyEnabled);
  if (config.efficiencyEnabled && isIncompleteQuoteLaborState(quoteLabor.status)) {
    diagnostics.push({
      code: "QUOTE_LABOR_COVERAGE_INCOMPLETE",
      severity: "error",
      message: `Efficiency is enabled, but quote-labor evidence is ${quoteLabor.status}; review and export are blocked.`,
    });
  }
  const coverage: CommissionCoverage = {
    jobsWithTimesheets: supportedJobIds.size,
    jobsWithoutTimesheets: excludedJobDetails.length,
    completedJobs,
    positiveValueJobs,
    nonPositiveValueJobs,
    commissionSupportedJobs: supportedJobIds.size,
    excludedJobs: excludedJobDetails.length,
    jobsWithEligibleWork: jobIdsWithEligibleWork.size,
    jobsWithOnlyIneligibleWork: jobIdsWithOnlyIneligibleWork.size,
    mappedHours,
    unmappedHours,
    /* Always 0 since 2026-07-20 — no hours are excluded on a "non-field" basis. */
    nonFieldTechnicianHours: 0,
    unmappedTimesheetEntries,
    mappedTechnicians,
    eligibleTechnicians,
    ineligibleTechnicians: technicianWork.filter((technician) => !technician.included).length,
    eligibleAllocatedWorkValue: fromCents(eligibleAllocatedWorkValueCents),
    ineligibleAllocatedWorkValue: fromCents(ineligibleAllocatedWorkValueCents),
    excludedWorkValue: fromCents(excludedWorkValueCents),
    excludedJobDetails,
    quoteLabor,
    technicianWork,
  };

  return {
    periodStart: params.periodStart,
    periodEnd: params.periodEnd,
    config,
    completedJobs,
    totalWorkValue: fromCents(totalWorkValueCents),
    poolAmount: fromCents(poolCents),
    insidePoolTotal: fromCents(finalBonusCents),
    outsidePoolTotal: fromCents(outsidePoolTotalCents),
    payrollTotal: fromCents(payrollTotalCents),
    activeTechnicians: ranked.length,
    technicians,
    jobAllocations,
    coverage,
    diagnostics,
    invariants,
  };
}

function summarizeQuoteLaborCoverage(
  rows: Array<{
    jobId: string;
    status: CommissionQuoteLaborCoverageState;
    laborRows: number;
    qualifying: boolean;
  }>,
  required: boolean,
): NonNullable<CommissionCoverage["quoteLabor"]> {
  const incomplete = rows.filter((row) => isIncompleteQuoteLaborState(row.status));
  const status = incomplete.some((row) => row.status === "error")
    ? "error"
    : incomplete.some((row) => row.status === "loading")
      ? "loading"
      : incomplete.length > 0
        ? "missing"
        : rows.some((row) => row.qualifying)
          ? "complete"
          : "complete_no_qualifying_work";
  return {
    status,
    required,
    quoteSourcedJobs: rows.length,
    jobsWithLaborRows: rows.filter((row) => row.laborRows > 0).length,
    qualifyingJobs: rows.filter((row) => row.qualifying).length,
    jobsWithNoQualifyingWork: rows.filter((row) => !row.qualifying && !isIncompleteQuoteLaborState(row.status)).length,
    laborRows: sum(rows.map((row) => row.laborRows)),
    incompleteJobIds: incomplete.map((row) => row.jobId),
  };
}

function isIncompleteQuoteLaborState(value: CommissionQuoteLaborCoverageState) {
  return value === "missing" || value === "loading" || value === "error";
}

/** Compatibility adapter for legacy adjustment-only consumers. */
export function applyCommissionOverrides(
  results: CommissionTechnicianResult[],
  overrides: CommissionOverrideInput[],
): CommissionTechnicianResult[] {
  const typedUnsupported = overrides.find(
    (override) => "field" in override && !["inside_pool_adjustment", "outside_pool_adjustment"].includes(override.field),
  );
  if (typedUnsupported) {
    throw invalidInput("Eligibility, allocation, tier, final-bonus, and notes overrides require buildCommissionReadModel.");
  }
  const parsed = parseOverrides(overrides);
  const poolCents = sum(results.map((result) => toCents(result.finalBonus)));
  const finalCents = new Map(results.map((result) => [result.employeeId, toCents(result.finalBonus)]));
  const targets = results.filter((result) => parsed.get(result.employeeId)?.insidePoolAdjustment !== undefined);
  let delta = 0;
  for (const result of targets) {
    const current = finalCents.get(result.employeeId) ?? 0;
    const next = Math.max(0, current + toCents(parsed.get(result.employeeId)?.insidePoolAdjustment ?? 0));
    finalCents.set(result.employeeId, next);
    delta += next - current;
  }
  if (delta !== 0) {
    const targetIds = new Set(targets.map((result) => result.employeeId));
    const absorbers = results.filter((result) => !targetIds.has(result.employeeId));
    redistributeInverse(finalCents, absorbers.map((result) => result.employeeId), delta);
  }
  if (sum(finalCents.values()) !== poolCents) {
    throw new CommissionCalculationError("OVERRIDE_CONFLICT", "Inside-pool adjustments do not reconcile to the pool.");
  }
  return results.map((result) => {
    const state = parsed.get(result.employeeId);
    const outsideCents = toCents(state?.outsidePoolAdjustment ?? 0);
    const final = finalCents.get(result.employeeId) ?? 0;
    if (final + outsideCents < 0) {
      throw new CommissionCalculationError("OVERRIDE_CONFLICT", `Outside-pool adjustment makes employee ${result.employeeId} negative.`);
    }
    return {
      ...result,
      insidePoolAdjustment: fromCents(toCents(state?.insidePoolAdjustment ?? 0)),
      outsidePoolAdjustment: fromCents(outsideCents),
      finalBonus: fromCents(final),
      payrollBonus: fromCents(final + outsideCents),
    };
  });
}

export function tierMultiplier(tier: CommissionTier, multipliers?: CommissionTierMultipliers): number {
  return multipliers?.[tier] ?? TIER_MULTIPLIERS[tier];
}

export function efficiencyMultiplier(efficiencyRatio: number, maxAdjustmentPercent = 20): number {
  if (!Number.isFinite(efficiencyRatio) || efficiencyRatio <= 0) {
    return 1;
  }
  const adjustment = maxAdjustmentPercent / 100;
  const boundedRatio = Math.min(1.5, Math.max(0.5, efficiencyRatio));
  return 1 + (boundedRatio - 1) * (2 * adjustment);
}

export function allocateLargestRemainder(
  totalCents: number,
  entries: Array<{ id: string; weight: number }>,
): Map<string, number> {
  if (!Number.isSafeInteger(totalCents) || totalCents < 0) {
    throw invalidInput("Largest-remainder total must be a nonnegative safe integer number of cents.");
  }
  const positive = entries.filter((entry) => {
    if (!Number.isFinite(entry.weight) || entry.weight < 0) {
      throw invalidInput(`Largest-remainder weight for ${entry.id} must be finite and nonnegative.`);
    }
    return entry.weight > 0;
  });
  if (positive.length === 0) {
    return new Map(entries.map((entry) => [entry.id, 0]));
  }
  const totalWeight = sum(positive.map((entry) => entry.weight));
  const shares = positive.map((entry) => {
    const exact = (totalCents * entry.weight) / totalWeight;
    const floor = Math.floor(exact);
    return { ...entry, exact, floor, remainder: exact - floor };
  });
  let remaining = totalCents - sum(shares.map((entry) => entry.floor));
  shares.sort((a, b) => compareRemainders(a, b));
  const result = new Map(entries.map((entry) => [entry.id, 0]));
  for (const share of shares) {
    result.set(share.id, share.floor);
  }
  for (let index = 0; index < remaining; index += 1) {
    const share = shares[index % shares.length];
    result.set(share.id, (result.get(share.id) ?? 0) + 1);
  }
  remaining = totalCents - sum(result.values());
  if (remaining !== 0) {
    throw new CommissionCalculationError("INVARIANT_VIOLATION", "Largest-remainder allocation did not conserve cents.");
  }
  return result;
}

function applyFinalAndInsidePoolOverrides(params: {
  poolCents: number;
  ranked: RankedTechnician[];
  efficiencyCents: Map<string, number>;
  efficiencyExactCents: Map<string, number>;
  overridesByEmployee: Map<string, OverrideState>;
}) {
  const finalCents = new Map<string, number>();
  const insideAdjustments = new Map<string, number>();
  const locked = params.ranked.filter(
    (technician) => params.overridesByEmployee.get(technician.employeeId)?.finalBonus !== undefined,
  );
  const unlocked = params.ranked.filter(
    (technician) => params.overridesByEmployee.get(technician.employeeId)?.finalBonus === undefined,
  );
  let lockedTotal = 0;
  for (const technician of locked) {
    const cents = toCents(params.overridesByEmployee.get(technician.employeeId)?.finalBonus ?? 0);
    finalCents.set(technician.employeeId, cents);
    lockedTotal += cents;
  }
  if (lockedTotal > params.poolCents) {
    throw new CommissionCalculationError("OVERRIDE_CONFLICT", "Final-bonus locks exceed the inside-pool amount.");
  }
  const remainingPool = params.poolCents - lockedTotal;
  if (remainingPool > 0 && unlocked.length === 0) {
    throw new CommissionCalculationError("OVERRIDE_CONFLICT", "Final-bonus locks leave pool cents with no unlocked technician.");
  }
  const unlockedWeights = unlocked.map((technician) => ({
    id: technician.employeeId,
    weight: params.efficiencyExactCents.get(technician.employeeId) ?? 0,
  }));
  if (remainingPool > 0 && sum(unlockedWeights.map((entry) => entry.weight)) <= 0) {
    throw new CommissionCalculationError("OVERRIDE_CONFLICT", "Remaining pool cannot be distributed across zero-weight unlocked technicians.");
  }
  const unlockedCents = allocateLargestRemainder(remainingPool, unlockedWeights);
  for (const technician of unlocked) {
    finalCents.set(technician.employeeId, unlockedCents.get(technician.employeeId) ?? 0);
  }

  const adjustmentTargets = unlocked.filter(
    (technician) => params.overridesByEmployee.get(technician.employeeId)?.insidePoolAdjustment !== undefined,
  );
  let totalDelta = 0;
  for (const technician of adjustmentTargets) {
    const current = finalCents.get(technician.employeeId) ?? 0;
    const requested = toCents(params.overridesByEmployee.get(technician.employeeId)?.insidePoolAdjustment ?? 0);
    const next = Math.max(0, current + requested);
    const applied = next - current;
    finalCents.set(technician.employeeId, next);
    insideAdjustments.set(technician.employeeId, applied);
    totalDelta += applied;
  }
  if (totalDelta !== 0) {
    const targetIds = new Set(adjustmentTargets.map((technician) => technician.employeeId));
    const absorbers = unlocked.filter((technician) => !targetIds.has(technician.employeeId));
    if (absorbers.length === 0) {
      throw new CommissionCalculationError(
        "OVERRIDE_CONFLICT",
        "Inside-pool adjustment has no other unlocked eligible technician to absorb the inverse change.",
      );
    }
    redistributeInverse(finalCents, absorbers.map((technician) => technician.employeeId), totalDelta);
  }
  if (sum(finalCents.values()) !== params.poolCents) {
    throw new CommissionCalculationError("INVARIANT_VIOLATION", "Final and inside-pool overrides did not conserve the pool.");
  }
  return { finalCents, insideAdjustments };
}

function redistributeInverse(finalCents: Map<string, number>, absorberIds: string[], targetDelta: number) {
  const amount = Math.abs(targetDelta);
  if (amount === 0) {
    return;
  }
  const available = sum(absorberIds.map((employeeId) => finalCents.get(employeeId) ?? 0));
  if (targetDelta > 0 && available < amount) {
    throw new CommissionCalculationError(
      "OVERRIDE_CONFLICT",
      "Inside-pool increase cannot be absorbed without producing a negative bonus.",
    );
  }
  const weightedAbsorbers = targetDelta > 0
    ? absorberIds.filter((employeeId) => (finalCents.get(employeeId) ?? 0) > 0)
    : absorberIds;
  if (weightedAbsorbers.length === 0) {
    throw new CommissionCalculationError("OVERRIDE_CONFLICT", "Inside-pool change has no technician able to absorb it.");
  }
  const weights = weightedAbsorbers.map((employeeId) => ({
    id: employeeId,
    weight: targetDelta > 0 ? finalCents.get(employeeId) ?? 0 : (finalCents.get(employeeId) ?? 0) || 1,
  }));
  const redistributed = allocateLargestRemainder(amount, weights);
  for (const employeeId of weightedAbsorbers) {
    const current = finalCents.get(employeeId) ?? 0;
    const change = redistributed.get(employeeId) ?? 0;
    finalCents.set(employeeId, targetDelta > 0 ? current - change : current + change);
  }
}

function buildRosterMap(roster: CommissionRosterEntry[]) {
  const result = new Map<string, CommissionRosterEntry>();
  for (const entry of roster) {
    const employeeId = normalizeEmployeeId(entry.employeeId);
    if (!employeeId) {
      throw invalidInput("Commission roster contains an empty employee ID.");
    }
    if (result.has(employeeId)) {
      throw invalidInput(`Commission roster has overlapping effective entries for employee ${employeeId}.`);
    }
    result.set(employeeId, { ...entry, employeeId });
  }
  return result;
}

function parseOverrides(overrides: CommissionOverrideInput[]) {
  const result = new Map<string, OverrideState>();
  for (const override of overrides) {
    const employeeId = normalizeEmployeeId(override.employeeId);
    if (!employeeId) {
      throw invalidInput("Commission override contains an empty employee ID.");
    }
    if (!override.reason?.trim()) {
      throw invalidInput(`Commission override for employee ${employeeId} requires a reason.`);
    }
    const state = result.get(employeeId) ?? { fields: new Set<string>() };
    let field: string;
    let value: unknown;
    if ("field" in override) {
      field = override.field;
      value = override.value;
      validatePoolTreatment(override.field, override.poolTreatment);
    } else {
      field = override.poolTreatment === "inside_pool" ? "inside_pool_adjustment" : "outside_pool_adjustment";
      value = override.amount;
    }
    if (state.fields.has(field)) {
      throw new CommissionCalculationError("OVERRIDE_CONFLICT", `Duplicate ${field} override for employee ${employeeId}.`);
    }
    state.fields.add(field);

    switch (field) {
      case "included":
        if (typeof value !== "boolean") throw invalidInput(`Included override for ${employeeId} must be boolean.`);
        state.included = value;
        break;
      case "allocated_value":
        state.allocatedValue = nonnegativeFiniteOverride(value, field, employeeId);
        break;
      case "tier":
        if (!isCommissionTier(value)) throw invalidInput(`Tier override for ${employeeId} is unknown.`);
        state.tier = value;
        break;
      case "inside_pool_adjustment":
        state.insidePoolAdjustment = finiteOverride(value, field, employeeId);
        break;
      case "outside_pool_adjustment":
        state.outsidePoolAdjustment = finiteOverride(value, field, employeeId);
        break;
      case "final_bonus":
        state.finalBonus = nonnegativeFiniteOverride(value, field, employeeId);
        break;
      case "notes":
        if (typeof value !== "string") throw invalidInput(`Notes override for ${employeeId} must be text.`);
        state.notes = value;
        break;
      default:
        throw invalidInput(`Unknown commission override field ${field}.`);
    }
    if (state.finalBonus !== undefined && state.insidePoolAdjustment !== undefined) {
      throw new CommissionCalculationError(
        "OVERRIDE_CONFLICT",
        `Employee ${employeeId} cannot have both final_bonus and inside_pool_adjustment overrides.`,
      );
    }
    result.set(employeeId, state);
  }
  return result;
}

function validatePoolTreatment(field: CommissionTypedOverrideInput["field"], treatment: CommissionOverridePoolTreatment) {
  const expected: Record<CommissionTypedOverrideInput["field"], CommissionOverridePoolTreatment> = {
    included: "neutral",
    allocated_value: "neutral",
    tier: "neutral",
    inside_pool_adjustment: "inside_pool",
    outside_pool_adjustment: "outside_pool",
    final_bonus: "inside_pool",
    notes: "neutral",
  };
  if (treatment !== expected[field]) {
    throw invalidInput(`${field} override requires ${expected[field]} pool treatment.`);
  }
}

function resolveConfig(params: {
  config?: CommissionPeriodConfig;
  poolPercent?: number;
  minBonusPercent?: number;
  efficiencyEnabled?: boolean;
  maxEfficiencyAdjustmentPercent?: number;
}) {
  const config = params.config ?? {
    poolPercent: params.poolPercent ?? DEFAULT_CONFIG.poolPercent,
    minBonusPercent: params.minBonusPercent ?? DEFAULT_CONFIG.minBonusPercent,
    efficiencyEnabled: params.efficiencyEnabled ?? DEFAULT_CONFIG.efficiencyEnabled,
    maxEfficiencyAdjustmentPercent:
      params.maxEfficiencyAdjustmentPercent ?? DEFAULT_CONFIG.maxEfficiencyAdjustmentPercent,
    tierMultipliers: DEFAULT_CONFIG.tierMultipliers,
  };
  return {
    ...config,
    tierMultipliers: { ...TIER_MULTIPLIERS, ...(config.tierMultipliers ?? {}) },
  };
}

function validateConfig(config: CommissionPeriodConfig) {
  if (!Number.isFinite(config.poolPercent)
    || config.poolPercent < 0.25
    || config.poolPercent > 1
    || Math.abs((config.poolPercent - 0.25) / 0.05 - Math.round((config.poolPercent - 0.25) / 0.05)) > 1e-8) {
    throw invalidInput("Pool percent must be 0.25 through 1.00 in 0.05-point increments.");
  }
  if (!Number.isFinite(config.minBonusPercent) || config.minBonusPercent < 0) {
    throw invalidInput("Minimum bonus percent must be finite and nonnegative.");
  }
  if (typeof config.efficiencyEnabled !== "boolean") {
    throw invalidInput("Efficiency enabled must be a persisted boolean value.");
  }
  if (!Number.isInteger(config.maxEfficiencyAdjustmentPercent)
    || config.maxEfficiencyAdjustmentPercent < 5
    || config.maxEfficiencyAdjustmentPercent > 50) {
    throw invalidInput("Maximum efficiency adjustment must be an integer from 5 through 50 percent.");
  }
  for (const [tier, multiplier] of Object.entries(config.tierMultipliers ?? TIER_MULTIPLIERS)) {
    if (!Number.isFinite(multiplier) || multiplier < 0.5 || multiplier > 2) {
      throw invalidInput(`${tier} tier multiplier must be between 0.50 and 2.00.`);
    }
  }
}

function validateJob(job: CommissionJobInput) {
  if (!job.jobId.trim()) throw invalidInput("Commission job contains an empty job ID.");
  if (!Number.isFinite(job.sellValue)) throw invalidInput(`Job ${job.jobId} has a non-finite sell value.`);
  if (job.quotedHours !== null && job.quotedHours !== undefined && !Number.isFinite(job.quotedHours)) {
    throw invalidInput(`Job ${job.jobId} has non-finite quoted hours.`);
  }
}

function validatePeriod(start: string, end: string) {
  const isoDate = /^\d{4}-\d{2}-\d{2}$/;
  if (!isoDate.test(start) || !isoDate.test(end) || start > end) {
    throw invalidInput("Commission period must use an ordered YYYY-MM-DD date range.");
  }
}

function efficiencyForEmployee(
  value: EfficiencyAccumulator | undefined,
  enabled: boolean,
  maxAdjustmentPercent: number,
): CommissionEfficiencyResult {
  if (!value || value.actualHours <= 0 || value.quotedHours <= 0) {
    return {
      enabled,
      maxAdjustmentPercent,
      quoteJobs: value?.quoteJobs.size ?? 0,
      quotedHours: value?.quotedHours ?? 0,
      actualHours: value?.actualHours ?? 0,
      efficiencyRatio: null,
      potentialMultiplier: 1,
      multiplier: 1,
      effect: 0,
      neutralReason: "no_qualifying_quote_work",
    };
  }
  const ratio = value.quotedHours / value.actualHours;
  const potentialMultiplier = efficiencyMultiplier(ratio, maxAdjustmentPercent);
  return {
    enabled,
    maxAdjustmentPercent,
    quoteJobs: value.quoteJobs.size,
    quotedHours: value.quotedHours,
    actualHours: value.actualHours,
    efficiencyRatio: ratio,
    potentialMultiplier,
    multiplier: enabled ? potentialMultiplier : 1,
    effect: 0,
    neutralReason: enabled ? undefined : "disabled",
  };
}

function normalizedExactShares(totalCents: number, entries: Array<{ id: string; weight: number }>) {
  const result = new Map<string, number>();
  const totalWeight = sum(entries.map((entry) => entry.weight));
  for (const entry of entries) {
    result.set(entry.id, totalWeight > 0 ? (totalCents * entry.weight) / totalWeight : 0);
  }
  return result;
}

function compareRemainders(
  a: { id: string; remainder: number },
  b: { id: string; remainder: number },
) {
  const difference = b.remainder - a.remainder;
  return Math.abs(difference) <= 1e-12 ? compareEmployeeIds(a.id, b.id) : difference;
}

function compareEmployeeIds(a: string | { employeeId: string }, b: string | { employeeId: string }) {
  const left = typeof a === "string" ? a : a.employeeId;
  const right = typeof b === "string" ? b : b.employeeId;
  return compareNumericIds(left, right);
}

function compareNumericIds(left: string, right: string) {
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    const numericLeft = BigInt(left);
    const numericRight = BigInt(right);
    if (numericLeft < numericRight) return -1;
    if (numericLeft > numericRight) return 1;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

function tierForRank(rank: number): CommissionTier {
  if (rank === 1) return "Gold";
  if (rank === 2) return "Silver";
  if (rank === 3) return "Bronze";
  return "Standard";
}

function commissionWeight(technician: CommissionTechnicianInput) {
  return technician.allocatedWorkValue * technician.tierMultiplier * (technician.efficiencyMultiplier ?? 1);
}

function finiteOverride(value: unknown, field: string, employeeId: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalidInput(`${field} override for ${employeeId} must be finite.`);
  }
  return value;
}

function nonnegativeFiniteOverride(value: unknown, field: string, employeeId: string) {
  const finite = finiteOverride(value, field, employeeId);
  if (finite < 0) throw invalidInput(`${field} override for ${employeeId} cannot be negative.`);
  return finite;
}

function isCommissionTier(value: unknown): value is CommissionTier {
  return value === "Gold" || value === "Silver" || value === "Bronze" || value === "Standard";
}

function normalizeEmployeeId(value: string | null | undefined) {
  return value?.trim() ?? "";
}

function toCents(value: number) {
  if (!Number.isFinite(value)) throw invalidInput("Money value must be finite.");
  const cents = Math.round((value + Math.sign(value) * Number.EPSILON) * 100);
  if (!Number.isSafeInteger(cents)) throw invalidInput("Money value exceeds safe cent precision.");
  return cents;
}

function fromCents(cents: number) {
  return cents / 100;
}

function roundForDisclosure(value: number) {
  return fromCents(toCents(value));
}

function sum(values: Iterable<number>) {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

function invalidInput(message: string) {
  return new CommissionCalculationError("INVALID_INPUT", message);
}

function isDateInRange(value: string, start: string, end: string): boolean {
  return value >= start && value <= end;
}
