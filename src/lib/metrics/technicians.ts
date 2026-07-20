import {
  DEFAULT_ON_TIME_THRESHOLD_MINUTES,
  matchTechnicianVisits,
  type TechnicianMobileEventInput,
  type TechnicianScheduleVisitInput,
  type TechnicianVisitMatch,
} from "@/lib/metrics/technician-visits";

export {
  DEFAULT_ON_TIME_THRESHOLD_MINUTES,
  VISIT_MATCH_WINDOW_AFTER_HOURS,
  VISIT_MATCH_WINDOW_BEFORE_HOURS,
  matchTechnicianVisits,
} from "@/lib/metrics/technician-visits";
export type {
  TechnicianMobileEventInput,
  TechnicianMobileEventKind,
  TechnicianScheduleVisitInput,
  TechnicianVisitMatch,
  TechnicianVisitMatchingResult,
} from "@/lib/metrics/technician-visits";

export type TechnicianTimesheetWorkDate = {
  timesheetId: string | null;
  workDate: string | null;
  hours: number;
};

export type TechnicianTimesheetShare = {
  employeeId: string;
  displayName?: string | null;
  mapped?: boolean;
  hours: number;
  /** Hours from this (job, employee) pair whose source work_date falls inside the selected work month. */
  inPeriodHours?: number;
  /** Source timesheet identities and work dates backing these hours (allocation evidence). */
  workDates?: TechnicianTimesheetWorkDate[];
};

/**
 * Verified Simpro field positions (trim + case-insensitive) that define the
 * effective technician roster. Verified live from the Simpro employees
 * endpoint on 2026-07-15; the source value for Service Technician carries a
 * trailing space, so matching must trim. Keep in sync with
 * infra/db/migrations/039_effective_technician_roster.sql.
 */
export const FIELD_TECHNICIAN_POSITIONS = ["service technician", "apprentice"] as const;

export function isFieldTechnicianPosition(position: string | null | undefined): boolean {
  const normalized = position?.trim().toLowerCase() ?? "";
  return (FIELD_TECHNICIAN_POSITIONS as readonly string[]).includes(normalized);
}

/** One member of the effective technician roster, evaluated for the selected month. */
export type TechnicianRosterMemberInput = {
  employeeId: string;
  displayName?: string | null;
  position?: string | null;
  dateOfHire?: string | null;
  archived?: boolean;
  isFieldTechnician?: boolean;
  hasInPeriodWork?: boolean;
};

/**
 * Disclosure aggregate for a dim_people-mapped employee who received completed-job
 * allocation but is not on the effective technician roster for the month.
 * Never promoted into the technician scorecard/leaderboard.
 */
export type TechnicianOutsideRosterAllocation = {
  employeeId: string;
  displayName: string;
  allocatedJobs: number;
  completedJobCredit: number;
  actualJobHours: number;
  allocatedSellValue: number;
  allocatedGrossProfit: number;
  allocatedNetProfit: number | null;
  totalRecordedHours: number;
};

export const TECHNICIAN_ACTIVITY_IDS = {
  sickPersonal: "2",
  lunch: "9",
  travel: "45",
  holiday: "47",
  pickupParts: "48",
  pto: "181",
} as const;

export const TECHNICIAN_ALLOCATION_TOLERANCE = 1e-9;

export type TechnicianWeekday = "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";

export type TechnicianAvailabilityDayInput = {
  startTime?: string | null;
  endTime?: string | null;
  workHours?: number | null;
  unavailable?: boolean;
};

export type TechnicianAvailabilityInput = Partial<Record<TechnicianWeekday, TechnicianAvailabilityDayInput | null>>;

export type TechnicianCapacityProfileInput = {
  employeeId: string;
  displayName?: string | null;
  dateOfHire?: string | null;
  position?: string | null;
  archived?: boolean;
  archiveEvidenceAt?: string | null;
  availability?: TechnicianAvailabilityInput | null;
};

export type TechnicianJobSource = "quote_generated" | "recurring" | "other";

export type TechnicianLaborEfficiencySummary = {
  quotedHours: number;
  actualHours: number;
  jobs: number;
  efficiencyPercent: number | null;
};

export type TechnicianCrewLaborEfficiency = TechnicianLaborEfficiencySummary & {
  jobId: string;
  jobNo: string | null;
  jobName: string | null;
  source: Exclude<TechnicianJobSource, "other">;
  technicianIds: string[];
  technicianNames: string[];
};

export type TechnicianPunctualityDistribution = {
  early: number;
  onTime: number;
  late1To15: number;
  late16To30: number;
  lateOver30: number;
  coveredVisits: number;
  scheduledVisits: number;
};

export type TechnicianAllocation = {
  employeeId: string;
  hours: number;
  share: number;
  allocatedSellValue: number;
  allocatedGrossProfit: number | null;
  allocatedNetProfit: number | null;
  completedJobCredit: number;
};

export type TechnicianJobInput = {
  jobId: string;
  jobNo?: string | null;
  jobName?: string | null;
  completedDate: string;
  sellValue: number;
  sellValueCovered?: boolean;
  grossProfit?: number | null;
  netProfit?: number | null;
  jobSource?: TechnicianJobSource | string | null;
  recurringJobId?: string | null;
  quoteId?: string | null;
  quotedHours?: number | null;
  quoteLaborCovered?: boolean;
  timesheets: TechnicianTimesheetShare[];
};

export type TechnicianRecordedTimeInput = {
  timesheetId: string;
  employeeId: string;
  displayName?: string | null;
  personMapped?: boolean;
  workDate: string;
  hours: number;
  referenceType?: string | null;
  referenceId?: string | null;
  activityId?: string | null;
  parseStatus?: string | null;
  jobSupported?: boolean;
};

export type TechnicianJobAllocationDetail = {
  jobId: string;
  jobNo: string | null;
  jobName: string | null;
  completedDate: string;
  employeeId: string;
  displayName: string;
  actualHours: number;
  /** Allocation-basis hours whose source work_date is inside the selected work month; null when work-date evidence is unavailable. */
  actualHoursInPeriod: number | null;
  /** Allocation-basis hours whose source work_date is outside the selected work month (pre/post-month timesheets); null when work-date evidence is unavailable. */
  actualHoursOutsidePeriod: number | null;
  /** Source timesheet identities and work dates backing this allocation. */
  workDates: TechnicianTimesheetWorkDate[] | null;
  share: number;
  completedJobCredit: number;
  sellValue: number;
  sellValueCovered: boolean;
  allocatedSellValue: number;
  grossProfit: number | null;
  allocatedGrossProfit: number | null;
  netProfit: number | null;
  allocatedNetProfit: number | null;
  quoteId: string | null;
  quotedHours: number | null;
  allocatedQuotedHours: number | null;
  laborEfficiencyCovered: boolean;
  laborEfficiencyScope: "individual" | "crew" | null;
  jobSource: TechnicianJobSource;
};

export type TechnicianPerformance = {
  employeeId: string;
  displayName: string;
  completedJobCredit: number;
  allocatedSellValue: number;
  allocatedGrossProfit: number;
  allocatedNetProfit: number | null;
  actualJobHours: number;
  /** Allocation-basis hours recorded inside the selected work month; null when work-date evidence is unavailable. */
  actualJobHoursInPeriod: number | null;
  /** Allocation-basis hours recorded outside the selected work month (disclosed completed-cohort hours); null when work-date evidence is unavailable. */
  actualJobHoursOutsidePeriod: number | null;
  /** True when this technician's completed-cohort allocation rests on hours worked outside the selected month (the July-2026 contradiction, disclosed). */
  allocationOutsideWorkMonth: boolean;
  jobHours: number;
  travelHours: number;
  pickupPartsHours: number;
  supportHours: number;
  holidayHours: number;
  sickPersonalHours: number;
  ptoHours: number;
  lunchHours: number;
  grossCapacityHours: number;
  adjustedCapacityHours: number;
  workingRecordedHours: number;
  unrecordedHours: number;
  overCapacityHours: number;
  jobCapacityUsePercent: number | null;
  fieldDeploymentPercent: number | null;
  eligibleWorkdays: number;
  availabilitySource: "simpro" | "default";
  dateOfHire: string | null;
  /** Simpro position (e.g. "Service Technician", "Apprentice") from the effective roster evidence. */
  position: string | null;
  archived: boolean;
  archiveEvidenceAt: string | null;
  productiveHours: number;
  totalRecordedHours: number;
  nonJobHours: number;
  unmappedReferenceHours: number;
  utilizationPercent: number | null;
  quotedHours: number;
  laborEfficiencyActualHours: number;
  laborEfficiencyPercent: number | null;
  laborEfficiencyJobs: number;
  laborEfficiency: {
    quoteGenerated: TechnicianLaborEfficiencySummary;
    recurring: TechnicianLaborEfficiencySummary;
  };
  revenueCoveredHours: number;
  grossProfitCoveredHours: number;
  netProfitCoveredHours: number;
  revenuePerHour: number | null;
  grossProfitPerHour: number | null;
  netProfitPerHour: number | null;
  scheduledVisits: number;
  arrivalCoveredVisits: number;
  completionCoveredVisits: number;
  onTimeVisits: number;
  onTimeRate: number | null;
  averageArrivalVarianceMinutes: number | null;
  averageDurationVarianceMinutes: number | null;
  punctuality: TechnicianPunctualityDistribution;
  coverage: {
    allocatedJobs: number;
    sellValueJobs: number;
    grossProfitJobs: number;
    netProfitJobs: number;
    revenueSupportedJobs: number;
    revenueSupportedHours: number;
    grossProfitSupportedJobs: number;
    grossProfitSupportedHours: number;
    netProfitSupportedJobs: number;
    netProfitSupportedHours: number;
    utilizationProductiveHours: number;
    utilizationAllRecordedHours: number;
    laborEfficiencyJobs: number;
    quoteGeneratedLaborJobs: number;
    quoteGeneratedAllocatedQuotedHours: number;
    quoteGeneratedActualHours: number;
    recurringLaborJobs: number;
    recurringAllocatedQuotedHours: number;
    recurringActualHours: number;
    recordedRows: number;
    unmappedReferenceRows: number;
    scheduledVisits: number;
    arrivalCoveredVisits: number;
    completionCoveredVisits: number;
    arrivalExcludedVisits: number;
    completionExcludedVisits: number;
  };
};

export type TechnicianMonthlyTrend = {
  periodStart: string;
  periodEnd: string;
  employeeId: string;
  displayName: string;
  completedJobCredit: number;
  allocatedSellValue: number;
  allocatedGrossProfit: number;
  allocatedNetProfit?: number | null;
  actualJobHours: number;
  jobHours?: number;
  travelHours?: number;
  pickupPartsHours?: number;
  supportHours?: number;
  grossCapacityHours?: number;
  adjustedCapacityHours?: number;
  workingRecordedHours?: number;
  unrecordedHours?: number;
  overCapacityHours?: number;
  productiveHours: number;
  totalRecordedHours: number;
  quotedHours: number;
  laborEfficiencyActualHours: number;
  scheduledVisits: number;
  arrivalCoveredVisits: number;
  onTimeVisits: number;
  reconciliation: {
    status: "matched" | "mismatch" | "missing";
    reason: "matched" | "check_mismatch" | "check_missing" | "stale" | "source_manifest_missing" | "source_manifest_mismatch";
    checkedAt: string | null;
    sourceCount: number | null;
    servedCount: number | null;
    sourceValue: number | null;
    servedValue: number | null;
    sourceHours: number | null;
    servedHours: number | null;
    sourceManifestCount: number;
    expectedSourceManifestCount: number;
  };
};

export type TechnicianPerformanceReadModel = {
  netProfitBasis: "simpro_job_net_profit_actual";
  periodStart: string;
  periodEnd: string;
  onTimeThresholdMinutes: number;
  /** True when the effective technician roster was supplied and the technician population is gated on it. */
  rosterApplied: boolean;
  technicians: TechnicianPerformance[];
  /** Non-roster employees with completed-job allocation, reconciled and disclosed separately from the scorecard. */
  outsideRoster: TechnicianOutsideRosterAllocation[];
  history: TechnicianMonthlyTrend[];
  allocations: TechnicianJobAllocationDetail[];
  visits: TechnicianVisitMatch[];
  crewLaborEfficiency: TechnicianCrewLaborEfficiency[];
  punctuality: TechnicianPunctualityDistribution;
  coverage: {
    totalJobs: number;
    jobsWithTimesheets: number;
    jobsMissingTimesheets: number;
    jobsWithUnmappedTimesheets: number;
    unmappedCompletedJobHours: number;
    jobsWithSellValue: number;
    jobsWithGrossProfit: number;
    jobsWithNetProfit: number;
    revenueSupportedJobs: number;
    revenueSupportedHours: number;
    grossProfitSupportedJobs: number;
    grossProfitSupportedHours: number;
    netProfitSupportedJobs: number;
    netProfitSupportedHours: number;
    quoteSourcedJobs: number;
    quoteGeneratedJobs: number;
    recurringJobs: number;
    jobsWithQuotedLabor: number;
    quoteGeneratedJobsWithLabor: number;
    recurringJobsWithLabor: number;
    quoteSourcedJobsMissingLabor: number;
    laborEfficiencyIncludedJobs: number;
    laborEfficiencyExcludedJobs: number;
    individualLaborEfficiencyJobs: number;
    crewLaborEfficiencyJobs: number;
    quoteGeneratedAllocatedQuotedHours: number;
    quoteGeneratedActualHours: number;
    recurringAllocatedQuotedHours: number;
    recurringActualHours: number;
    timesheetRows: number;
    validRecordedRows: number;
    invalidRecordedRows: number;
    totalRecordedHours: number;
    productiveHours: number;
    utilizationProductiveHours: number;
    utilizationAllRecordedHours: number;
    utilizationExcludedRows: number;
    utilizationUnattributedHours: number;
    nonJobHours: number;
    unmappedReferenceHours: number;
    unmappedPersonHours: number;
    jobHours: number;
    travelHours: number;
    pickupPartsHours: number;
    supportHours: number;
    holidayHours: number;
    sickPersonalHours: number;
    ptoHours: number;
    lunchHours: number;
    grossCapacityHours: number;
    adjustedCapacityHours: number;
    workingRecordedHours: number;
    unrecordedHours: number;
    overCapacityHours: number;
    scheduleCoveredJobs: number;
    mobileStatusCoveredJobs: number;
    scheduledVisits: number;
    arrivalCoveredVisits: number;
    completionCoveredVisits: number;
    onTimeVisits: number;
    uncoveredVisits: number;
    completionUncoveredVisits: number;
    cancelledScheduleBlocks: number;
    invalidScheduleBlocks: number;
    scheduleExcludedBlocks: number;
    unmatchedMobileEvents: number;
    unverifiedMobileEvents: number;
    invalidMobileEvents: number;
    duplicateMobileEvents: number;
    outsideRosterEmployees: number;
    outsideRosterAllocatedSellValue: number;
    outsideRosterActualJobHours: number;
  };
};

type MutableTechnician = Omit<
  TechnicianPerformance,
  | "allocatedNetProfit"
  | "actualJobHoursInPeriod"
  | "actualJobHoursOutsidePeriod"
  | "allocationOutsideWorkMonth"
  | "utilizationPercent"
  | "jobCapacityUsePercent"
  | "laborEfficiencyPercent"
  | "revenuePerHour"
  | "grossProfitPerHour"
  | "netProfitPerHour"
  | "onTimeRate"
  | "averageArrivalVarianceMinutes"
  | "averageDurationVarianceMinutes"
> & {
  allocatedNetProfit: number;
  actualJobHoursInPeriod: number;
  actualJobHoursOutsidePeriod: number;
  allocationEvidenceCovered: boolean;
  arrivalVarianceTotal: number;
  arrivalVarianceCount: number;
  durationVarianceTotal: number;
  durationVarianceCount: number;
};

type MutableOutsideRoster = Omit<TechnicianOutsideRosterAllocation, "allocatedNetProfit"> & {
  allocatedNetProfit: number;
  netProfitJobs: number;
};

export function allocateJobCreditByHours(
  totalSellValue: number,
  timesheets: TechnicianTimesheetShare[],
  grossProfit: number | null = null,
  netProfit: number | null = null,
): TechnicianAllocation[] {
  const hoursByEmployee = new Map<string, number>();
  for (const entry of timesheets) {
    if (entry.mapped === false || !entry.employeeId || !Number.isFinite(entry.hours) || entry.hours <= 0) continue;
    hoursByEmployee.set(entry.employeeId, (hoursByEmployee.get(entry.employeeId) ?? 0) + entry.hours);
  }

  const totalHours = [...hoursByEmployee.values()].reduce((sum, hours) => sum + hours, 0);
  if (totalHours <= 0) return [];

  const entries = [...hoursByEmployee.entries()].sort(([left], [right]) => compareEmployeeIds(left, right));
  let assignedShare = 0;
  let assignedSellValue = 0;
  let assignedGrossProfit = 0;
  let assignedNetProfit = 0;
  return entries.map(([employeeId, hours], index) => {
    const last = index === entries.length - 1;
    const share = cleanResidual(last ? 1 - assignedShare : hours / totalHours);
    const allocatedSellValue = cleanResidual(last ? totalSellValue - assignedSellValue : totalSellValue * share);
    const allocatedGrossProfit = grossProfit === null
      ? null
      : cleanResidual(last ? grossProfit - assignedGrossProfit : grossProfit * share);
    const allocatedNetProfit = netProfit === null
      ? null
      : cleanResidual(last ? netProfit - assignedNetProfit : netProfit * share);
    assignedShare += share;
    assignedSellValue += allocatedSellValue;
    assignedGrossProfit += allocatedGrossProfit ?? 0;
    assignedNetProfit += allocatedNetProfit ?? 0;
    return {
      employeeId,
      hours,
      share,
      allocatedSellValue,
      allocatedGrossProfit,
      allocatedNetProfit,
      completedJobCredit: share,
    };
  });
}

const technicianWeekdays: TechnicianWeekday[] = [
  "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
];

const defaultAvailabilityHours: Record<TechnicianWeekday, number> = {
  monday: 8,
  tuesday: 8,
  wednesday: 8,
  thursday: 8,
  friday: 8,
  saturday: 0,
  sunday: 0,
};

export function resolveTechnicianAvailability(availability?: TechnicianAvailabilityInput | null) {
  const hours = { ...defaultAvailabilityHours };
  let hasExplicitAvailability = false;
  for (const weekday of technicianWeekdays) {
    const day = availability?.[weekday];
    if (!day || availabilityDayIsBlank(day)) continue;
    const explicitHours = availabilityDayHours(day);
    if (explicitHours === null) continue;
    hours[weekday] = explicitHours;
    hasExplicitAvailability = true;
  }
  return {
    hours,
    source: hasExplicitAvailability ? "simpro" as const : "default" as const,
  };
}

export function calculateTechnicianCapacity(params: {
  profile: TechnicianCapacityProfileInput;
  periodStart: string;
  periodEnd: string;
  holidayHours?: number;
  sickPersonalHours?: number;
  ptoHours?: number;
  jobHours?: number;
  travelHours?: number;
  pickupPartsHours?: number;
  supportHours?: number;
}) {
  const availability = resolveTechnicianAvailability(params.profile.availability);
  const hireDate = validIsoDate(params.profile.dateOfHire) ? params.profile.dateOfHire! : null;
  const archived = params.profile.archived === true;
  // Archived people accrue zero capacity for the archived-effective portion of
  // the period. Without a verified archive-date boundary the whole period is
  // archived-effective; history rows stay visible but never earn capacity.
  const archiveEvidenceDate = params.profile.archiveEvidenceAt?.slice(0, 10);
  const archivedFrom: string | null = archived && validIsoDate(archiveEvidenceDate) ? archiveEvidenceDate : null;
  let eligibleWorkdays = 0;
  let grossCapacityHours = 0;
  for (const workDate of eachIsoDate(params.periodStart, params.periodEnd)) {
    if (hireDate && workDate < hireDate) continue;
    if (archived && (archivedFrom === null || workDate >= archivedFrom)) continue;
    const weekday = technicianWeekdays[new Date(`${workDate}T00:00:00Z`).getUTCDay()];
    const workHours = availability.hours[weekday];
    if (workHours <= 0) continue;
    eligibleWorkdays += 1;
    grossCapacityHours += workHours;
  }
  const holidayHours = nonnegative(params.holidayHours);
  const sickPersonalHours = nonnegative(params.sickPersonalHours);
  const ptoHours = nonnegative(params.ptoHours);
  const leaveHours = holidayHours + sickPersonalHours + ptoHours;
  const adjustedCapacityHours = Math.max(grossCapacityHours - leaveHours, 0);
  const jobHours = nonnegative(params.jobHours);
  const travelHours = nonnegative(params.travelHours);
  const pickupPartsHours = nonnegative(params.pickupPartsHours);
  const supportHours = nonnegative(params.supportHours);
  const workingRecordedHours = jobHours + travelHours + pickupPartsHours + supportHours;
  return {
    eligibleWorkdays,
    availabilitySource: availability.source,
    dateOfHire: hireDate,
    position: params.profile.position ?? null,
    archived: params.profile.archived === true,
    archiveEvidenceAt: params.profile.archiveEvidenceAt ?? null,
    grossCapacityHours,
    holidayHours,
    sickPersonalHours,
    ptoHours,
    adjustedCapacityHours,
    workingRecordedHours,
    unrecordedHours: Math.max(adjustedCapacityHours - workingRecordedHours, 0),
    overCapacityHours: Math.max(workingRecordedHours - adjustedCapacityHours, 0),
    jobCapacityUsePercent: ratioPercent(jobHours, adjustedCapacityHours),
    fieldDeploymentPercent: ratioPercent(jobHours + travelHours + pickupPartsHours, adjustedCapacityHours),
  };
}

function availabilityDayIsBlank(day: TechnicianAvailabilityDayInput) {
  return day.unavailable !== true
    && !isFiniteNumber(day.workHours)
    && !day.startTime?.trim()
    && !day.endTime?.trim();
}

function availabilityDayHours(day: TechnicianAvailabilityDayInput) {
  if (day.unavailable === true) return 0;
  if (isFiniteNumber(day.workHours) && day.workHours >= 0) return day.workHours;
  const start = timeMinutes(day.startTime);
  const end = timeMinutes(day.endTime);
  if (start === null || end === null || end < start) return null;
  if (end === start) return 0;
  return Math.max((end - start) / 60 - 0.5, 0);
}

function timeMinutes(value: string | null | undefined) {
  const match = value?.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59 ? hours * 60 + minutes : null;
}

function eachIsoDate(start: string, end: string) {
  if (!validIsoDate(start) || !validIsoDate(end) || start > end) return [];
  const dates: string[] = [];
  const current = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (current <= last) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

function validIsoDate(value: string | null | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function nonnegative(value: number | null | undefined) {
  return isFiniteNumber(value) ? Math.max(value, 0) : 0;
}

export function calculateTechnicianUtilization(params: {
  timesheets: TechnicianRecordedTimeInput[];
  periodStart: string;
  periodEnd: string;
}) {
  const technicians = new Map<string, {
    employeeId: string;
    displayName: string;
    productiveHours: number;
    totalRecordedHours: number;
    nonJobHours: number;
    unmappedReferenceHours: number;
    jobHours: number;
    travelHours: number;
    pickupPartsHours: number;
    supportHours: number;
    holidayHours: number;
    sickPersonalHours: number;
    ptoHours: number;
    lunchHours: number;
    recordedRows: number;
    unmappedReferenceRows: number;
  }>();
  const coverage = {
    timesheetRows: 0,
    validRecordedRows: 0,
    invalidRecordedRows: 0,
    totalRecordedHours: 0,
    productiveHours: 0,
    nonJobHours: 0,
    unmappedReferenceHours: 0,
    unmappedPersonHours: 0,
    jobHours: 0,
    travelHours: 0,
    pickupPartsHours: 0,
    supportHours: 0,
    holidayHours: 0,
    sickPersonalHours: 0,
    ptoHours: 0,
    lunchHours: 0,
  };

  for (const timesheet of params.timesheets) {
    if (!isDateInRange(timesheet.workDate, params.periodStart, params.periodEnd)) continue;
    coverage.timesheetRows += 1;
    if (!Number.isFinite(timesheet.hours) || timesheet.hours <= 0) {
      coverage.invalidRecordedRows += 1;
      continue;
    }

    coverage.validRecordedRows += 1;
    coverage.totalRecordedHours += timesheet.hours;
    const category = recordedTimeCategory(timesheet);
    if (category === "job") {
      coverage.productiveHours += timesheet.hours;
      coverage.jobHours += timesheet.hours;
    } else {
      coverage.nonJobHours += timesheet.hours;
    }
    if (category === "travel") coverage.travelHours += timesheet.hours;
    if (category === "pickup_parts") coverage.pickupPartsHours += timesheet.hours;
    if (category === "support" || category === "unmapped_reference") coverage.supportHours += timesheet.hours;
    if (category === "holiday") coverage.holidayHours += timesheet.hours;
    if (category === "sick_personal") coverage.sickPersonalHours += timesheet.hours;
    if (category === "pto") coverage.ptoHours += timesheet.hours;
    if (category === "lunch") coverage.lunchHours += timesheet.hours;
    if (category === "unmapped_reference") coverage.unmappedReferenceHours += timesheet.hours;

    if (timesheet.personMapped === false || !timesheet.employeeId) {
      coverage.unmappedPersonHours += timesheet.hours;
      continue;
    }

    const current = technicians.get(timesheet.employeeId) ?? {
      employeeId: timesheet.employeeId,
      displayName: resolvedDisplayName(timesheet.displayName, timesheet.employeeId),
      productiveHours: 0,
      totalRecordedHours: 0,
      nonJobHours: 0,
      unmappedReferenceHours: 0,
      jobHours: 0,
      travelHours: 0,
      pickupPartsHours: 0,
      supportHours: 0,
      holidayHours: 0,
      sickPersonalHours: 0,
      ptoHours: 0,
      lunchHours: 0,
      recordedRows: 0,
      unmappedReferenceRows: 0,
    };
    current.displayName = preferredDisplayName(current.displayName, timesheet.displayName, timesheet.employeeId);
    current.totalRecordedHours += timesheet.hours;
    current.recordedRows += 1;
    if (category === "job") {
      current.productiveHours += timesheet.hours;
      current.jobHours += timesheet.hours;
    } else {
      current.nonJobHours += timesheet.hours;
    }
    if (category === "travel") current.travelHours += timesheet.hours;
    if (category === "pickup_parts") current.pickupPartsHours += timesheet.hours;
    if (category === "support" || category === "unmapped_reference") current.supportHours += timesheet.hours;
    if (category === "holiday") current.holidayHours += timesheet.hours;
    if (category === "sick_personal") current.sickPersonalHours += timesheet.hours;
    if (category === "pto") current.ptoHours += timesheet.hours;
    if (category === "lunch") current.lunchHours += timesheet.hours;
    if (category === "unmapped_reference") {
      current.unmappedReferenceHours += timesheet.hours;
      current.unmappedReferenceRows += 1;
    }
    technicians.set(timesheet.employeeId, current);
  }

  return { technicians, coverage };
}

export function buildTechnicianPerformanceReadModel(params: {
  jobs: TechnicianJobInput[];
  periodStart: string;
  periodEnd: string;
  recordedTimesheets?: TechnicianRecordedTimeInput[];
  scheduleVisits?: TechnicianScheduleVisitInput[];
  mobileEvents?: TechnicianMobileEventInput[];
  onTimeThresholdMinutes?: number;
  historicalTechnicians?: TechnicianMonthlyTrend[];
  capacityProfiles?: TechnicianCapacityProfileInput[];
  /**
   * Effective technician roster for the selected month. When provided (always,
   * in production), the technician population is gated on it: identities off
   * the roster never enter the scorecard; their allocation is disclosed in
   * `outsideRoster`. When omitted (pure calculation helpers/tests), the legacy
   * ungated population is kept.
   */
  roster?: TechnicianRosterMemberInput[];
}): TechnicianPerformanceReadModel {
  const byEmployee = new Map<string, MutableTechnician>();
  const rosterIds = params.roster ? new Set(params.roster.map((member) => member.employeeId)) : null;
  const outsideRosterByEmployee = new Map<string, MutableOutsideRoster>();
  const allocations: TechnicianJobAllocationDetail[] = [];
  const crewLaborEfficiency: TechnicianCrewLaborEfficiency[] = [];
  const jobCoverage = {
    totalJobs: 0,
    jobsWithTimesheets: 0,
    jobsMissingTimesheets: 0,
    jobsWithUnmappedTimesheets: 0,
    unmappedCompletedJobHours: 0,
    jobsWithSellValue: 0,
    jobsWithGrossProfit: 0,
    jobsWithNetProfit: 0,
    revenueSupportedJobs: 0,
    revenueSupportedHours: 0,
    grossProfitSupportedJobs: 0,
    grossProfitSupportedHours: 0,
    netProfitSupportedJobs: 0,
    netProfitSupportedHours: 0,
    quoteSourcedJobs: 0,
    quoteGeneratedJobs: 0,
    recurringJobs: 0,
    jobsWithQuotedLabor: 0,
    quoteGeneratedJobsWithLabor: 0,
    recurringJobsWithLabor: 0,
    quoteSourcedJobsMissingLabor: 0,
    laborEfficiencyIncludedJobs: 0,
    laborEfficiencyExcludedJobs: 0,
    individualLaborEfficiencyJobs: 0,
    crewLaborEfficiencyJobs: 0,
    quoteGeneratedAllocatedQuotedHours: 0,
    quoteGeneratedActualHours: 0,
    recurringAllocatedQuotedHours: 0,
    recurringActualHours: 0,
  };

  for (const job of params.jobs) {
    if (!isDateInRange(job.completedDate, params.periodStart, params.periodEnd)) continue;
    jobCoverage.totalJobs += 1;
    const jobSource = technicianJobSource(job);
    const quoteSourced = jobSource === "quote_generated";
    const recurring = jobSource === "recurring";
    const efficiencyEligible = quoteSourced || recurring;
    const laborCovered = efficiencyEligible && job.quoteLaborCovered !== false && isPositiveNumber(job.quotedHours);
    if (quoteSourced) {
      jobCoverage.quoteSourcedJobs += 1;
      jobCoverage.quoteGeneratedJobs += 1;
    }
    if (recurring) jobCoverage.recurringJobs += 1;
    if (laborCovered) {
      jobCoverage.jobsWithQuotedLabor += 1;
      if (quoteSourced) jobCoverage.quoteGeneratedJobsWithLabor += 1;
      if (recurring) jobCoverage.recurringJobsWithLabor += 1;
    }
    if (efficiencyEligible && !laborCovered) jobCoverage.quoteSourcedJobsMissingLabor += 1;

    const unmappedHours = job.timesheets
      .filter((entry) => entry.mapped === false && Number.isFinite(entry.hours) && entry.hours > 0)
      .reduce((sum, entry) => sum + entry.hours, 0);
    if (unmappedHours > 0) {
      jobCoverage.jobsWithUnmappedTimesheets += 1;
      jobCoverage.unmappedCompletedJobHours += unmappedHours;
    }

    const supportedGrossProfit = isFiniteNumber(job.grossProfit) ? job.grossProfit : null;
    const supportedNetProfit = isFiniteNumber(job.netProfit) ? job.netProfit : null;
    const supportedAllocations = allocateJobCreditByHours(
      Number.isFinite(job.sellValue) ? job.sellValue : 0,
      job.timesheets,
      supportedGrossProfit,
      supportedNetProfit,
    );
    if (efficiencyEligible && (!laborCovered || supportedAllocations.length === 0)) {
      jobCoverage.laborEfficiencyExcludedJobs += 1;
    }
    if (supportedAllocations.length === 0) {
      jobCoverage.jobsMissingTimesheets += 1;
      continue;
    }
    const actualHours = supportedAllocations.reduce((total, allocation) => total + allocation.hours, 0);
    const sellCovered = job.sellValueCovered !== false && Number.isFinite(job.sellValue);
    const grossProfitCovered = supportedGrossProfit !== null;
    const netProfitCovered = supportedNetProfit !== null;
    jobCoverage.jobsWithTimesheets += 1;
    if (sellCovered) {
      jobCoverage.jobsWithSellValue += 1;
      jobCoverage.revenueSupportedJobs += 1;
      jobCoverage.revenueSupportedHours += actualHours;
    }
    if (grossProfitCovered) {
      jobCoverage.jobsWithGrossProfit += 1;
      jobCoverage.grossProfitSupportedJobs += 1;
      jobCoverage.grossProfitSupportedHours += actualHours;
    }
    if (netProfitCovered) {
      jobCoverage.jobsWithNetProfit += 1;
      jobCoverage.netProfitSupportedJobs += 1;
      jobCoverage.netProfitSupportedHours += actualHours;
    }
    const individualEfficiency = laborCovered && supportedAllocations.length === 1;
    const crewEfficiency = laborCovered && supportedAllocations.length > 1;
    if (laborCovered) {
      jobCoverage.laborEfficiencyIncludedJobs += 1;
      if (quoteSourced) {
        jobCoverage.quoteGeneratedAllocatedQuotedHours += job.quotedHours ?? 0;
        jobCoverage.quoteGeneratedActualHours += actualHours;
      } else {
        jobCoverage.recurringAllocatedQuotedHours += job.quotedHours ?? 0;
        jobCoverage.recurringActualHours += actualHours;
      }
    }
    if (individualEfficiency) jobCoverage.individualLaborEfficiencyJobs += 1;
    if (crewEfficiency) {
      jobCoverage.crewLaborEfficiencyJobs += 1;
      crewLaborEfficiency.push({
        jobId: job.jobId,
        jobNo: job.jobNo ?? null,
        jobName: job.jobName ?? null,
        source: jobSource as Exclude<TechnicianJobSource, "other">,
        technicianIds: supportedAllocations.map((allocation) => allocation.employeeId),
        technicianNames: supportedAllocations.map((allocation) => resolvedDisplayName(
          job.timesheets.find((timesheet) => timesheet.employeeId === allocation.employeeId)?.displayName,
          allocation.employeeId,
        )),
        quotedHours: job.quotedHours ?? 0,
        actualHours,
        jobs: 1,
        efficiencyPercent: ratioPercent(job.quotedHours ?? 0, actualHours),
      });
    }

    let assignedQuotedHours = 0;
    for (const [allocationIndex, allocation] of supportedAllocations.entries()) {
      const sourceTimesheet = job.timesheets.find((entry) => entry.employeeId === allocation.employeeId && entry.mapped !== false);
      const allocatedQuotedHours = laborCovered
        ? cleanResidual(allocationIndex === supportedAllocations.length - 1
          ? (job.quotedHours ?? 0) - assignedQuotedHours
          : (job.quotedHours ?? 0) * allocation.share)
        : null;
      assignedQuotedHours += allocatedQuotedHours ?? 0;
      const evidence = allocationWorkEvidence(job.timesheets, allocation.employeeId, params.periodStart, params.periodEnd);

      if (rosterIds && !rosterIds.has(allocation.employeeId)) {
        // Never promote non-roster employee allocation into the technician
        // scorecard; reconcile and disclose it separately.
        const disclosure = getOrCreateOutsideRoster(outsideRosterByEmployee, allocation.employeeId, sourceTimesheet?.displayName);
        disclosure.allocatedJobs += 1;
        disclosure.completedJobCredit += allocation.completedJobCredit;
        disclosure.actualJobHours += allocation.hours;
        if (sellCovered) disclosure.allocatedSellValue += allocation.allocatedSellValue;
        if (grossProfitCovered && allocation.allocatedGrossProfit !== null) {
          disclosure.allocatedGrossProfit += allocation.allocatedGrossProfit;
        }
        if (netProfitCovered && allocation.allocatedNetProfit !== null) {
          disclosure.allocatedNetProfit += allocation.allocatedNetProfit;
          disclosure.netProfitJobs += 1;
        }
        continue;
      }

      const technician = getOrCreateTechnician(byEmployee, allocation.employeeId, sourceTimesheet?.displayName);
      if (evidence.covered) {
        technician.actualJobHoursInPeriod += evidence.inPeriodHours;
        technician.actualJobHoursOutsidePeriod += evidence.outsidePeriodHours;
      } else {
        technician.allocationEvidenceCovered = false;
      }

      technician.completedJobCredit += allocation.completedJobCredit;
      technician.actualJobHours += allocation.hours;
      technician.coverage.allocatedJobs += 1;
      if (sellCovered) {
        technician.allocatedSellValue += allocation.allocatedSellValue;
        technician.revenueCoveredHours += allocation.hours;
        technician.coverage.sellValueJobs += 1;
        technician.coverage.revenueSupportedJobs += 1;
        technician.coverage.revenueSupportedHours += allocation.hours;
      }
      if (grossProfitCovered && allocation.allocatedGrossProfit !== null) {
        technician.allocatedGrossProfit += allocation.allocatedGrossProfit;
        technician.grossProfitCoveredHours += allocation.hours;
        technician.coverage.grossProfitJobs += 1;
        technician.coverage.grossProfitSupportedJobs += 1;
        technician.coverage.grossProfitSupportedHours += allocation.hours;
      }
      if (netProfitCovered && allocation.allocatedNetProfit !== null) {
        technician.allocatedNetProfit += allocation.allocatedNetProfit;
        technician.netProfitCoveredHours += allocation.hours;
        technician.coverage.netProfitJobs += 1;
        technician.coverage.netProfitSupportedJobs += 1;
        technician.coverage.netProfitSupportedHours += allocation.hours;
      }
      if (laborCovered && allocatedQuotedHours !== null) {
        technician.quotedHours += allocatedQuotedHours;
        technician.laborEfficiencyActualHours += allocation.hours;
        technician.laborEfficiencyJobs += 1;
        technician.coverage.laborEfficiencyJobs += 1;
        const sourceSummary = jobSource === "recurring"
          ? technician.laborEfficiency.recurring
          : technician.laborEfficiency.quoteGenerated;
        sourceSummary.quotedHours += allocatedQuotedHours;
        sourceSummary.actualHours += allocation.hours;
        sourceSummary.jobs += 1;
        if (jobSource === "recurring") {
          technician.coverage.recurringLaborJobs += 1;
          technician.coverage.recurringAllocatedQuotedHours += allocatedQuotedHours;
          technician.coverage.recurringActualHours += allocation.hours;
        } else {
          technician.coverage.quoteGeneratedLaborJobs += 1;
          technician.coverage.quoteGeneratedAllocatedQuotedHours += allocatedQuotedHours;
          technician.coverage.quoteGeneratedActualHours += allocation.hours;
        }
      }

      allocations.push({
        jobId: job.jobId,
        jobNo: job.jobNo ?? null,
        jobName: job.jobName ?? null,
        completedDate: job.completedDate,
        employeeId: allocation.employeeId,
        displayName: technician.displayName,
        actualHours: allocation.hours,
        actualHoursInPeriod: evidence.covered ? evidence.inPeriodHours : null,
        actualHoursOutsidePeriod: evidence.covered ? evidence.outsidePeriodHours : null,
        workDates: evidence.workDates,
        share: allocation.share,
        completedJobCredit: allocation.completedJobCredit,
        sellValue: job.sellValue,
        sellValueCovered: sellCovered,
        allocatedSellValue: sellCovered ? allocation.allocatedSellValue : 0,
        grossProfit: grossProfitCovered ? supportedGrossProfit : null,
        allocatedGrossProfit: grossProfitCovered ? allocation.allocatedGrossProfit : null,
        netProfit: netProfitCovered ? supportedNetProfit : null,
        allocatedNetProfit: netProfitCovered ? allocation.allocatedNetProfit : null,
        quoteId: job.quoteId ?? null,
        quotedHours: laborCovered ? job.quotedHours ?? 0 : null,
        allocatedQuotedHours,
        laborEfficiencyCovered: laborCovered,
        laborEfficiencyScope: individualEfficiency ? "individual" : crewEfficiency ? "crew" : null,
        jobSource,
      });
    }
  }

  const utilization = calculateTechnicianUtilization({
    timesheets: params.recordedTimesheets ?? [],
    periodStart: params.periodStart,
    periodEnd: params.periodEnd,
  });
  for (const row of utilization.technicians.values()) {
    if (rosterIds && !rosterIds.has(row.employeeId)) {
      // Non-roster recorded time never creates a scorecard row. Keep the
      // recorded-hours context on an existing allocation disclosure so the
      // outside-roster aggregate stays coherent.
      const disclosure = outsideRosterByEmployee.get(row.employeeId);
      if (disclosure) disclosure.totalRecordedHours = row.totalRecordedHours;
      continue;
    }
    const technician = getOrCreateTechnician(byEmployee, row.employeeId, row.displayName);
    technician.productiveHours = row.productiveHours;
    technician.totalRecordedHours = row.totalRecordedHours;
    technician.nonJobHours = row.nonJobHours;
    technician.unmappedReferenceHours = row.unmappedReferenceHours;
    technician.jobHours = row.jobHours;
    technician.travelHours = row.travelHours;
    technician.pickupPartsHours = row.pickupPartsHours;
    technician.supportHours = row.supportHours;
    technician.holidayHours = row.holidayHours;
    technician.sickPersonalHours = row.sickPersonalHours;
    technician.ptoHours = row.ptoHours;
    technician.lunchHours = row.lunchHours;
    technician.coverage.recordedRows = row.recordedRows;
    technician.coverage.unmappedReferenceRows = row.unmappedReferenceRows;
    technician.coverage.utilizationProductiveHours = row.productiveHours;
    technician.coverage.utilizationAllRecordedHours = row.totalRecordedHours;
  }

  const threshold = validThreshold(params.onTimeThresholdMinutes);
  const visitMatching = matchTechnicianVisits({
    visits: params.scheduleVisits ?? [],
    events: params.mobileEvents ?? [],
    onTimeThresholdMinutes: threshold,
  });
  for (const visit of visitMatching.visits) {
    if (rosterIds && !rosterIds.has(visit.employeeId)) continue;
    const technician = getOrCreateTechnician(byEmployee, visit.employeeId, visit.displayName);
    technician.scheduledVisits += 1;
    technician.punctuality.scheduledVisits += 1;
    technician.coverage.scheduledVisits += 1;
    if (visit.arrivalCovered) {
      technician.arrivalCoveredVisits += 1;
      technician.coverage.arrivalCoveredVisits += 1;
    } else technician.coverage.arrivalExcludedVisits += 1;
    if (visit.completionCovered) {
      technician.completionCoveredVisits += 1;
      technician.coverage.completionCoveredVisits += 1;
    } else technician.coverage.completionExcludedVisits += 1;
    if (visit.onTime === true) technician.onTimeVisits += 1;
    if (visit.arrivalVarianceMinutes !== null) {
      technician.arrivalVarianceTotal += visit.arrivalVarianceMinutes;
      technician.arrivalVarianceCount += 1;
      addPunctualityVisit(technician.punctuality, visit.arrivalVarianceMinutes);
    }
    if (visit.durationVarianceMinutes !== null) {
      technician.durationVarianceTotal += visit.durationVarianceMinutes;
      technician.durationVarianceCount += 1;
    }
  }

  for (const member of params.roster ?? []) {
    getOrCreateTechnician(byEmployee, member.employeeId, member.displayName);
  }
  const capacityProfiles = new Map((params.capacityProfiles ?? []).map((profile) => [profile.employeeId, profile]));
  for (const profile of params.capacityProfiles ?? []) {
    if (rosterIds && !rosterIds.has(profile.employeeId)) continue;
    getOrCreateTechnician(byEmployee, profile.employeeId, profile.displayName);
  }
  for (const technician of byEmployee.values()) {
    const profile = capacityProfiles.get(technician.employeeId);
    if (!profile) continue;
    const capacity = calculateTechnicianCapacity({
      profile,
      periodStart: params.periodStart,
      periodEnd: params.periodEnd,
      holidayHours: technician.holidayHours,
      sickPersonalHours: technician.sickPersonalHours,
      ptoHours: technician.ptoHours,
      jobHours: technician.jobHours,
      travelHours: technician.travelHours,
      pickupPartsHours: technician.pickupPartsHours,
      supportHours: technician.supportHours,
    });
    technician.grossCapacityHours = capacity.grossCapacityHours;
    technician.adjustedCapacityHours = capacity.adjustedCapacityHours;
    technician.workingRecordedHours = capacity.workingRecordedHours;
    technician.unrecordedHours = capacity.unrecordedHours;
    technician.overCapacityHours = capacity.overCapacityHours;
    technician.fieldDeploymentPercent = capacity.fieldDeploymentPercent;
    technician.eligibleWorkdays = capacity.eligibleWorkdays;
    technician.availabilitySource = capacity.availabilitySource;
    technician.dateOfHire = capacity.dateOfHire;
    technician.archived = capacity.archived;
    technician.archiveEvidenceAt = capacity.archiveEvidenceAt;
  }

  const technicians = [...byEmployee.values()]
    .map(finalizeTechnician)
    .sort((left, right) => right.allocatedSellValue - left.allocatedSellValue || left.displayName.localeCompare(right.displayName));
  const scheduledJobIds = new Set(visitMatching.visits.map((visit) => visit.jobId));
  const mobileCoveredJobIds = new Set(
    visitMatching.visits.filter((visit) => visit.arrivalCovered).map((visit) => visit.jobId),
  );
  const selectedMonthReconciliation = new Map(
    (params.historicalTechnicians ?? [])
      .filter((row) => row.periodStart === params.periodStart)
      .map((row) => [row.employeeId, row.reconciliation]),
  );
  const currentHistory = technicians.map((technician): TechnicianMonthlyTrend => ({
    periodStart: params.periodStart,
    periodEnd: params.periodEnd,
    employeeId: technician.employeeId,
    displayName: technician.displayName,
    completedJobCredit: technician.completedJobCredit,
    allocatedSellValue: technician.allocatedSellValue,
    allocatedGrossProfit: technician.allocatedGrossProfit,
    allocatedNetProfit: technician.allocatedNetProfit,
    actualJobHours: technician.actualJobHours,
    jobHours: technician.jobHours,
    travelHours: technician.travelHours,
    pickupPartsHours: technician.pickupPartsHours,
    supportHours: technician.supportHours,
    grossCapacityHours: technician.grossCapacityHours,
    adjustedCapacityHours: technician.adjustedCapacityHours,
    workingRecordedHours: technician.workingRecordedHours,
    unrecordedHours: technician.unrecordedHours,
    overCapacityHours: technician.overCapacityHours,
    productiveHours: technician.productiveHours,
    totalRecordedHours: technician.totalRecordedHours,
    quotedHours: technician.quotedHours,
    laborEfficiencyActualHours: technician.laborEfficiencyActualHours,
    scheduledVisits: technician.scheduledVisits,
    arrivalCoveredVisits: technician.arrivalCoveredVisits,
    onTimeVisits: technician.onTimeVisits,
    reconciliation: selectedMonthReconciliation.get(technician.employeeId) ?? missingTechnicianReconciliation(),
  }));
  const punctuality = technicians.reduce<TechnicianPunctualityDistribution>((total, technician) => ({
    early: total.early + technician.punctuality.early,
    onTime: total.onTime + technician.punctuality.onTime,
    late1To15: total.late1To15 + technician.punctuality.late1To15,
    late16To30: total.late16To30 + technician.punctuality.late16To30,
    lateOver30: total.lateOver30 + technician.punctuality.lateOver30,
    coveredVisits: total.coveredVisits + technician.punctuality.coveredVisits,
    scheduledVisits: total.scheduledVisits + technician.punctuality.scheduledVisits,
  }), emptyPunctuality());

  const outsideRoster = [...outsideRosterByEmployee.values()]
    .map((entry): TechnicianOutsideRosterAllocation => ({
      employeeId: entry.employeeId,
      displayName: entry.displayName,
      allocatedJobs: entry.allocatedJobs,
      completedJobCredit: entry.completedJobCredit,
      actualJobHours: entry.actualJobHours,
      allocatedSellValue: entry.allocatedSellValue,
      allocatedGrossProfit: entry.allocatedGrossProfit,
      allocatedNetProfit: entry.netProfitJobs > 0 ? entry.allocatedNetProfit : null,
      totalRecordedHours: entry.totalRecordedHours,
    }))
    .sort((left, right) => right.allocatedSellValue - left.allocatedSellValue || left.displayName.localeCompare(right.displayName));

  return {
    netProfitBasis: "simpro_job_net_profit_actual",
    periodStart: params.periodStart,
    periodEnd: params.periodEnd,
    onTimeThresholdMinutes: threshold,
    rosterApplied: rosterIds !== null,
    technicians,
    outsideRoster,
    history: [
      ...(params.historicalTechnicians ?? []).filter((row) => row.periodStart !== params.periodStart),
      ...currentHistory,
    ].sort((left, right) => left.periodStart.localeCompare(right.periodStart) || left.displayName.localeCompare(right.displayName)),
    allocations: allocations.sort((left, right) =>
      right.completedDate.localeCompare(left.completedDate) || left.jobId.localeCompare(right.jobId),
    ),
    visits: visitMatching.visits,
    crewLaborEfficiency: crewLaborEfficiency.sort((left, right) => left.jobId.localeCompare(right.jobId)),
    punctuality,
    coverage: {
      ...jobCoverage,
      ...utilization.coverage,
      utilizationProductiveHours: utilization.coverage.productiveHours,
      utilizationAllRecordedHours: utilization.coverage.totalRecordedHours,
      utilizationExcludedRows: utilization.coverage.invalidRecordedRows,
      utilizationUnattributedHours: utilization.coverage.unmappedPersonHours,
      grossCapacityHours: sumTechnicianValues(technicians, "grossCapacityHours"),
      adjustedCapacityHours: sumTechnicianValues(technicians, "adjustedCapacityHours"),
      workingRecordedHours: sumTechnicianValues(technicians, "workingRecordedHours"),
      unrecordedHours: sumTechnicianValues(technicians, "unrecordedHours"),
      overCapacityHours: sumTechnicianValues(technicians, "overCapacityHours"),
      scheduleCoveredJobs: scheduledJobIds.size,
      mobileStatusCoveredJobs: mobileCoveredJobIds.size,
      scheduledVisits: visitMatching.scheduledVisits,
      arrivalCoveredVisits: visitMatching.arrivalCoveredVisits,
      completionCoveredVisits: visitMatching.completionCoveredVisits,
      onTimeVisits: visitMatching.onTimeVisits,
      uncoveredVisits: visitMatching.scheduledVisits - visitMatching.arrivalCoveredVisits,
      completionUncoveredVisits: visitMatching.scheduledVisits - visitMatching.completionCoveredVisits,
      cancelledScheduleBlocks: visitMatching.cancelledVisits,
      invalidScheduleBlocks: visitMatching.invalidVisits,
      scheduleExcludedBlocks: visitMatching.cancelledVisits + visitMatching.invalidVisits,
      unmatchedMobileEvents: visitMatching.unmatchedEvents.filter((event) => event.kind !== "unverified").length,
      unverifiedMobileEvents: visitMatching.unverifiedEvents,
      invalidMobileEvents: visitMatching.invalidEvents,
      duplicateMobileEvents: visitMatching.duplicateEvents,
      outsideRosterEmployees: outsideRoster.length,
      outsideRosterAllocatedSellValue: outsideRoster.reduce((total, entry) => total + entry.allocatedSellValue, 0),
      outsideRosterActualJobHours: outsideRoster.reduce((total, entry) => total + entry.actualJobHours, 0),
    },
  };
}

function recordedTimeCategory(timesheet: TechnicianRecordedTimeInput) {
  const referenceType = timesheet.referenceType?.trim().toLowerCase() ?? "";
  const parseStatus = timesheet.parseStatus?.trim().toLowerCase() ?? "parsed";
  if (
    referenceType === "job" &&
    Boolean(timesheet.referenceId) &&
    parseStatus === "parsed" &&
    timesheet.jobSupported === true
  ) {
    return "job" as const;
  }
  if (referenceType === "job") return "unmapped_reference" as const;
  const activityId = timesheet.activityId?.trim()
    || (referenceType === "activity" ? timesheet.referenceId?.trim() : "")
    || "";
  if (activityId === TECHNICIAN_ACTIVITY_IDS.travel) return "travel" as const;
  if (activityId === TECHNICIAN_ACTIVITY_IDS.pickupParts) return "pickup_parts" as const;
  if (activityId === TECHNICIAN_ACTIVITY_IDS.holiday) return "holiday" as const;
  if (activityId === TECHNICIAN_ACTIVITY_IDS.sickPersonal) return "sick_personal" as const;
  if (activityId === TECHNICIAN_ACTIVITY_IDS.pto) return "pto" as const;
  if (activityId === TECHNICIAN_ACTIVITY_IDS.lunch) return "lunch" as const;
  if (referenceType) return "support" as const;
  return "unmapped_reference" as const;
}

type AllocationWorkEvidence =
  | { covered: true; inPeriodHours: number; outsidePeriodHours: number; workDates: TechnicianTimesheetWorkDate[] | null }
  | { covered: false; workDates: TechnicianTimesheetWorkDate[] | null };

/**
 * Splits one employee's allocation-basis hours on a job into in-month and
 * out-of-month portions using preserved source work dates. The allocation
 * SHARE stays hours-over-all-timesheets (completed-job cohort); this evidence
 * only makes the work-month cohort explicit and separate.
 */
function allocationWorkEvidence(
  timesheets: TechnicianTimesheetShare[],
  employeeId: string,
  periodStart: string,
  periodEnd: string,
): AllocationWorkEvidence {
  const entries = timesheets.filter((entry) =>
    entry.employeeId === employeeId
    && entry.mapped !== false
    && Number.isFinite(entry.hours)
    && entry.hours > 0);
  let inPeriodHours = 0;
  let totalHours = 0;
  let covered = true;
  let hasWorkDates = false;
  const workDates: TechnicianTimesheetWorkDate[] = [];
  for (const entry of entries) {
    totalHours += entry.hours;
    if (entry.workDates) {
      hasWorkDates = true;
      workDates.push(...entry.workDates);
    }
    if (isFiniteNumber(entry.inPeriodHours)) {
      inPeriodHours += Math.min(Math.max(entry.inPeriodHours, 0), entry.hours);
    } else if (entry.workDates) {
      inPeriodHours += entry.workDates
        .filter((detail) => detail.workDate !== null && isDateInRange(detail.workDate, periodStart, periodEnd))
        .reduce((total, detail) => total + (isFiniteNumber(detail.hours) ? Math.max(detail.hours, 0) : 0), 0);
    } else {
      covered = false;
    }
  }
  if (!covered) return { covered: false, workDates: hasWorkDates ? workDates : null };
  return {
    covered: true,
    inPeriodHours,
    outsidePeriodHours: Math.max(totalHours - inPeriodHours, 0),
    workDates: hasWorkDates ? workDates : null,
  };
}

function getOrCreateOutsideRoster(
  byEmployee: Map<string, MutableOutsideRoster>,
  employeeId: string,
  displayName?: string | null,
) {
  const current = byEmployee.get(employeeId);
  if (current) {
    current.displayName = preferredDisplayName(current.displayName, displayName, employeeId);
    return current;
  }
  const entry: MutableOutsideRoster = {
    employeeId,
    displayName: resolvedDisplayName(displayName, employeeId),
    allocatedJobs: 0,
    completedJobCredit: 0,
    actualJobHours: 0,
    allocatedSellValue: 0,
    allocatedGrossProfit: 0,
    allocatedNetProfit: 0,
    netProfitJobs: 0,
    totalRecordedHours: 0,
  };
  byEmployee.set(employeeId, entry);
  return entry;
}

function getOrCreateTechnician(
  byEmployee: Map<string, MutableTechnician>,
  employeeId: string,
  displayName?: string | null,
) {
  const current = byEmployee.get(employeeId);
  if (current) {
    current.displayName = preferredDisplayName(current.displayName, displayName, employeeId);
    return current;
  }

  const technician: MutableTechnician = {
    employeeId,
    displayName: resolvedDisplayName(displayName, employeeId),
    position: null,
    completedJobCredit: 0,
    allocatedSellValue: 0,
    allocatedGrossProfit: 0,
    allocatedNetProfit: 0,
    actualJobHours: 0,
    actualJobHoursInPeriod: 0,
    actualJobHoursOutsidePeriod: 0,
    allocationEvidenceCovered: true,
    jobHours: 0,
    travelHours: 0,
    pickupPartsHours: 0,
    supportHours: 0,
    holidayHours: 0,
    sickPersonalHours: 0,
    ptoHours: 0,
    lunchHours: 0,
    grossCapacityHours: 0,
    adjustedCapacityHours: 0,
    workingRecordedHours: 0,
    unrecordedHours: 0,
    overCapacityHours: 0,
    fieldDeploymentPercent: null,
    eligibleWorkdays: 0,
    availabilitySource: "default",
    dateOfHire: null,
    archived: false,
    archiveEvidenceAt: null,
    productiveHours: 0,
    totalRecordedHours: 0,
    nonJobHours: 0,
    unmappedReferenceHours: 0,
    quotedHours: 0,
    laborEfficiencyActualHours: 0,
    laborEfficiencyJobs: 0,
    laborEfficiency: {
      quoteGenerated: emptyLaborEfficiency(),
      recurring: emptyLaborEfficiency(),
    },
    scheduledVisits: 0,
    arrivalCoveredVisits: 0,
    completionCoveredVisits: 0,
    onTimeVisits: 0,
    punctuality: emptyPunctuality(),
    revenueCoveredHours: 0,
    grossProfitCoveredHours: 0,
    netProfitCoveredHours: 0,
    arrivalVarianceTotal: 0,
    arrivalVarianceCount: 0,
    durationVarianceTotal: 0,
    durationVarianceCount: 0,
    coverage: {
      allocatedJobs: 0,
      sellValueJobs: 0,
      grossProfitJobs: 0,
      netProfitJobs: 0,
      revenueSupportedJobs: 0,
      revenueSupportedHours: 0,
      grossProfitSupportedJobs: 0,
      grossProfitSupportedHours: 0,
      netProfitSupportedJobs: 0,
      netProfitSupportedHours: 0,
      utilizationProductiveHours: 0,
      utilizationAllRecordedHours: 0,
      laborEfficiencyJobs: 0,
      quoteGeneratedLaborJobs: 0,
      quoteGeneratedAllocatedQuotedHours: 0,
      quoteGeneratedActualHours: 0,
      recurringLaborJobs: 0,
      recurringAllocatedQuotedHours: 0,
      recurringActualHours: 0,
      recordedRows: 0,
      unmappedReferenceRows: 0,
      scheduledVisits: 0,
      arrivalCoveredVisits: 0,
      completionCoveredVisits: 0,
      arrivalExcludedVisits: 0,
      completionExcludedVisits: 0,
    },
  };
  byEmployee.set(employeeId, technician);
  return technician;
}

function finalizeTechnician(technician: MutableTechnician): TechnicianPerformance {
  const {
    arrivalVarianceTotal,
    arrivalVarianceCount,
    durationVarianceTotal,
    durationVarianceCount,
    allocationEvidenceCovered,
    ...row
  } = technician;
  return {
    ...row,
    allocatedNetProfit: technician.coverage.netProfitJobs > 0 ? technician.allocatedNetProfit : null,
    actualJobHoursInPeriod: allocationEvidenceCovered ? technician.actualJobHoursInPeriod : null,
    actualJobHoursOutsidePeriod: allocationEvidenceCovered ? technician.actualJobHoursOutsidePeriod : null,
    allocationOutsideWorkMonth: allocationEvidenceCovered
      && technician.actualJobHoursOutsidePeriod > TECHNICIAN_ALLOCATION_TOLERANCE,
    utilizationPercent: ratioPercent(technician.productiveHours, technician.totalRecordedHours),
    jobCapacityUsePercent: ratioPercent(technician.jobHours, technician.adjustedCapacityHours),
    laborEfficiencyPercent: ratioPercent(technician.quotedHours, technician.laborEfficiencyActualHours),
    laborEfficiency: {
      quoteGenerated: finalizeLaborEfficiency(technician.laborEfficiency.quoteGenerated),
      recurring: finalizeLaborEfficiency(technician.laborEfficiency.recurring),
    },
    revenuePerHour: ratio(technician.allocatedSellValue, technician.revenueCoveredHours),
    grossProfitPerHour: ratio(technician.allocatedGrossProfit, technician.grossProfitCoveredHours),
    netProfitPerHour: ratio(technician.allocatedNetProfit, technician.netProfitCoveredHours),
    onTimeRate: ratioPercent(technician.onTimeVisits, technician.arrivalCoveredVisits),
    averageArrivalVarianceMinutes: ratio(arrivalVarianceTotal, arrivalVarianceCount),
    averageDurationVarianceMinutes: ratio(durationVarianceTotal, durationVarianceCount),
  };
}

function technicianJobSource(job: TechnicianJobInput): TechnicianJobSource {
  const source = job.jobSource?.trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
  if (source === "recurring" || source === "recurring_job") return "recurring";
  if (source === "quote" || source === "quote_generated" || source === "generated_from_quote") return "quote_generated";
  return job.quoteId ? "quote_generated" : job.recurringJobId ? "recurring" : "other";
}

function emptyLaborEfficiency(): TechnicianLaborEfficiencySummary {
  return { quotedHours: 0, actualHours: 0, jobs: 0, efficiencyPercent: null };
}

function finalizeLaborEfficiency(summary: TechnicianLaborEfficiencySummary): TechnicianLaborEfficiencySummary {
  return { ...summary, efficiencyPercent: ratioPercent(summary.quotedHours, summary.actualHours) };
}

function emptyPunctuality(): TechnicianPunctualityDistribution {
  return { early: 0, onTime: 0, late1To15: 0, late16To30: 0, lateOver30: 0, coveredVisits: 0, scheduledVisits: 0 };
}

function missingTechnicianReconciliation(): TechnicianMonthlyTrend["reconciliation"] {
  return {
    status: "missing",
    reason: "check_missing",
    checkedAt: null,
    sourceCount: null,
    servedCount: null,
    sourceValue: null,
    servedValue: null,
    sourceHours: null,
    servedHours: null,
    sourceManifestCount: 0,
    expectedSourceManifestCount: 7,
  };
}

function addPunctualityVisit(distribution: TechnicianPunctualityDistribution, varianceMinutes: number) {
  distribution.coveredVisits += 1;
  if (varianceMinutes < 0) distribution.early += 1;
  else if (varianceMinutes === 0) distribution.onTime += 1;
  else if (varianceMinutes <= 15) distribution.late1To15 += 1;
  else if (varianceMinutes <= 30) distribution.late16To30 += 1;
  else distribution.lateOver30 += 1;
}

function sumTechnicianValues<K extends keyof TechnicianPerformance>(technicians: TechnicianPerformance[], key: K) {
  return technicians.reduce((total, technician) => total + (typeof technician[key] === "number" ? Number(technician[key]) : 0), 0);
}

function validThreshold(value: number | undefined) {
  return Number.isFinite(value) && (value ?? -1) >= 0 ? Number(value) : DEFAULT_ON_TIME_THRESHOLD_MINUTES;
}

function ratio(numerator: number, denominator: number) {
  return denominator > 0 ? numerator / denominator : null;
}

function ratioPercent(numerator: number, denominator: number) {
  const value = ratio(numerator, denominator);
  return value === null ? null : value * 100;
}

function isFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveNumber(value: number | null | undefined): value is number {
  return isFiniteNumber(value) && value > 0;
}

function isDateInRange(value: string, start: string, end: string): boolean {
  return value >= start && value <= end;
}

function resolvedDisplayName(value: string | null | undefined, employeeId: string) {
  return value?.trim() || `Employee ${employeeId}`;
}

function preferredDisplayName(current: string, candidate: string | null | undefined, employeeId: string) {
  const fallback = `Employee ${employeeId}`;
  return current === fallback && candidate?.trim() ? candidate.trim() : current;
}

function compareEmployeeIds(left: string, right: string) {
  return left.localeCompare(right, "en", { numeric: true });
}

function cleanResidual(value: number) {
  return Math.abs(value) <= TECHNICIAN_ALLOCATION_TOLERANCE ? 0 : value;
}
