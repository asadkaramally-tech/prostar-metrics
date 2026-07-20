import { plainDisplayText } from "@/lib/text/plain-display-text";

export type LaborAccuracyInput = {
  quotedHours: number | null;
  actualHours: number | null;
};

export type LaborAccuracyResult = {
  included: boolean;
  coverageReason: string;
  varianceHours: number | null;
  variancePercent: number | null;
};

export type JobLaborCoverageResult = LaborAccuracyResult & {
  eligible: boolean;
  nestedQuoteLaborCovered: boolean;
  allJobTimesheetsCovered: boolean;
  exclusionReason: JobLaborExclusionReason | null;
  quotedHours: number | null;
  actualHours: number | null;
};

export type JobCostCenterInput = {
  sectionId: string | number;
  costCenterId: string | number;
  configuredCostCenterId?: string | number | null;
  configuredCostCenterName?: string | null;
  name?: string | null;
  category?: string | null;
  sellValue?: number | null;
  grossProfitActual?: number | null;
  netProfitActual?: number | null;
  netMarginActual?: number | null;
  materialsCostActual?: number | null;
  materialsCostEstimate?: number | null;
  laborCostActual?: number | null;
  laborCostEstimate?: number | null;
  laborHoursActual?: number | null;
  laborHoursEstimate?: number | null;
  overheadCostActual?: number | null;
  overheadCostEstimate?: number | null;
  quotedHours?: number | null;
  materialCostValue?: number | null;
  sourceDeletedAt?: string | null;
};

export type JobTimesheetInput = {
  timesheetId: string;
  employeeId?: string | number | null;
  technicianName?: string | null;
  workDate?: string | null;
  actualHours?: number | null;
  sourceDeletedAt?: string | null;
};

export type JobQuoteLaborInput = {
  laborId: string;
  quotedHours?: number | null;
  sourceDeletedAt?: string | null;
};

export type JobLaborExclusionReason =
  | "missing linked quote"
  | "missing active nested quote labor"
  | "invalid nested quote labor hours"
  | "quoted hours are not positive"
  | "missing active job timesheets"
  | "invalid job timesheet hours";

export type NormalizedJobSnapshot = {
  jobId: string | number;
  jobNo?: string | null;
  name?: string | null;
  description?: string | null;
  statusName?: string | null;
  completedDate?: string | null;
  stageName?: string | null;
  siteId?: string | number | null;
  sellValue: number | null;
  grossProfitActual?: number | null;
  grossMarginActual?: number | null;
  netProfitActual?: number | null;
  netMarginActual?: number | null;
  materialsCostActual?: number | null;
  materialsCostEstimate?: number | null;
  laborCostActual?: number | null;
  laborCostEstimate?: number | null;
  laborHoursActual?: number | null;
  laborHoursEstimate?: number | null;
  overheadCostActual?: number | null;
  overheadCostEstimate?: number | null;
  totalResourceCostActual?: number | null;
  totalResourceCostEstimate?: number | null;
  commissionCostActual?: number | null;
  jobSourceType?: string | null;
  jobSourceId?: string | number | null;
  customerName?: string | null;
  siteName?: string | null;
  convertedFromType?: string | null;
  convertedFromId?: string | number | null;
  sourceQuoteId?: string | number | null;
  quotedHours?: number | null;
  actualHours?: number | null;
  category?: string | null;
  materialCoverage?: string | null;
  costCenters?: JobCostCenterInput[];
  quoteLabor?: JobQuoteLaborInput[];
  timesheets?: JobTimesheetInput[];
  sourceDeletedAt?: string | null;
};

export type JobFilters = {
  category?: string | null;
  costCenter?: string | null;
  technician?: string | null;
};

/**
 * DB-shaped issued-quote row (metrics_quotes post-migration-041) used only for
 * the direct-service follow-up linkage. DateIssued basis, never acceptance.
 */
export type IssuedQuoteInput = {
  quoteId: string | number;
  dateIssued: string;
  siteId?: string | number | null;
  siteName?: string | null;
  totalValue?: number | null;
  sourceDeletedAt?: string | null;
};

export type LossClass = "diagnostic_fee" | "execution";

/**
 * Standard diagnostic call fee in dollars. The below-zero-net cohort splits at
 * this ticket size; the boundary is derived from (and verified against) the
 * June 2026 loss cohort: 75 diagnostic-fee losses (-$16,523) vs 36 execution
 * losses (-$9,342) out of 111. Zero-sell losses are execution (no fee was
 * charged, so the loss is job control, not pricing policy).
 */
export const DIAGNOSTIC_FEE_MAX_SELL = 59;

export const LOSS_CLASSIFICATION_RULE =
  "Below-zero-net jobs are diagnostic_fee when the job sell value is above $0 and at most $59 (the standard diagnostic call fee); every other loss, including $0-sell jobs, is execution. Boundary verified against the June 2026 cohort: 75 diagnostic-fee (-$16,523) vs 36 execution (-$9,342) of 111 losses.";

export const QUOTE_LINKED_LABOR_DEFINITION =
  "Quote-linked counts every completed job with a quote conversion, including recurring-plan conversions; hours compare the Simpro job-level labor estimate against job-level actual hours. Work-source Quote-generated is a separate classification that excludes recurring conversions.";

export const FOLLOW_UP_LINK_RULE =
  "A direct-service job links to quotes for the same site (Simpro site identity) issued within 30 days after the job's completion date; day 0 is the completion day and the earliest qualifying quote is the primary link.";

export const FOLLOW_UP_SAME_DAY_RULE =
  "The follow-up conversion stat counts direct-service jobs where a quote for the same site was issued on the completion day itself - the verified June 2026 basis (39 direct-service calls produced a same-day quote).";

export function classifyLoss(sellValue: number | null, netProfit: number | null): LossClass | null {
  if (netProfit === null || !Number.isFinite(netProfit) || netProfit >= 0) return null;
  return sellValue !== null && Number.isFinite(sellValue) && sellValue > 0 && sellValue <= DIAGNOSTIC_FEE_MAX_SELL
    ? "diagnostic_fee"
    : "execution";
}

export type LossBreakdown = {
  rule: string;
  lossJobs: number;
  netTotal: number;
  diagnosticFee: { jobs: number; netTotal: number };
  execution: { jobs: number; netTotal: number };
};

export type QuoteLinkedLaborMetric = {
  definition: string;
  quoteLinkedJobs: number;
  coveredJobs: number;
  actualOnlyJobs: number;
  estimatedHours: number;
  actualHours: number;
  efficiencyRatio: number | null;
  overrunPercent: number | null;
  perJob: Array<{
    jobId: string;
    jobNo: string;
    name: string;
    siteName: string;
    estimatedHours: number;
    actualHours: number;
    varianceHours: number;
  }>;
};

export type DirectServiceFollowUps = {
  linkRule: string;
  sameDayRule: string;
  /**
   * False when the model was built without an issued-quote input at all (for
   * example a rebuild path that has not been taught to load them). Serving
   * rejects persisted models in that state instead of showing zeros.
   */
  quoteEvidenceLoaded: boolean;
  directServiceJobs: number;
  jobsWithSameDayQuote: number;
  jobsWithQuoteWithin30Days: number;
  links: Array<{
    jobId: string;
    quoteId: string;
    dateIssued: string;
    daysAfterCompletion: number;
    sameDay: boolean;
    quoteValue: number | null;
  }>;
};

export type JobReconciliationInput = {
  periodStart: string;
  status: "matched" | "mismatch" | "failed" | "missing";
  sourceCount?: number | null;
  sourceValue?: number | null;
  rollupCount?: number | null;
  rollupValue?: number | null;
  checkedAt?: string | null;
};

export type JobCategoryMetric = {
  label: string;
  distinctJobCount: number;
  primaryJobCount: number;
  sellValue: number;
  grossProfit: number;
  grossMargin: number | null;
  netProfit: number;
  netMargin: number | null;
  quotedHours: number;
  actualHours: number;
  actualHoursCoveredJobs: number;
  actualHoursUncoveredJobs: number;
  sellCoverageRows: number;
  grossProfitCoverageRows: number;
  netProfitCoverageRows: number;
};

export type JobCostCenterMetric = JobCategoryMetric & {
  category: string;
};

export type JobDrilldownRow = {
  jobId: string;
  jobNo: string;
  name: string;
  description: string;
  completedDate: string;
  stage: string;
  status: string;
  inclusionReason: string;
  sellValue: number | null;
  grossProfit: number | null;
  grossMargin: number | null;
  netProfit: number | null;
  netMargin: number | null;
  customerName: string;
  siteName: string;
  jobSourceType: JobSourceType;
  jobSourceId: string | null;
  materialsCostActual: number | null;
  materialsCostEstimate: number | null;
  laborCostActual: number | null;
  laborCostEstimate: number | null;
  laborHoursActual: number | null;
  laborHoursEstimate: number | null;
  overheadCostActual: number | null;
  overheadCostEstimate: number | null;
  totalResourceCostActual: number | null;
  totalResourceCostEstimate: number | null;
  commissionCostActual: number | null;
  financialBasis: string;
  primaryCategory: string;
  categories: string[];
  costCenterSellValue: number;
  unallocatedSellValue: number | null;
  quoteId: string | null;
  quotedHours: number | null;
  actualHours: number | null;
  varianceHours: number | null;
  variancePercent: number | null;
  laborCoverage: string;
  technicians: string[];
  materialCoverage: string;
  costCenters: Array<{ configuredName: string; instanceName: string }>;
  lossClass: LossClass | null;
};

export type JobSourceType = "Quote-generated" | "Recurring" | "Direct service";

export type JobSourceMetric = {
  sourceType: JobSourceType;
  jobs: number;
  revenue: number;
  grossProfit: number;
  netProfit: number;
  grossMargin: number | null;
  netMargin: number | null;
  estimatedHours: number;
  actualHours: number;
  laborCoveredJobs: number;
  laborVariancePercent: number | null;
  netProfitPerActualHour: number | null;
  revenueCoverage: number;
  grossProfitCoverage: number;
  netProfitCoverage: number;
  laborEstimateCoverage: number;
  laborActualCoverage: number;
};

export type ProfitabilityMetric = {
  label: string;
  jobs: number;
  revenue: number;
  grossProfit: number;
  netProfit: number;
  netMargin: number | null;
  netProfitPerActualHour: number | null;
  revenueCoverage: number;
  netProfitCoverage: number;
};

export const JOB_ANALYTICS_FIELDS = [
  "netProfitActual", "netMarginActual",
  "materialsCostActual", "materialsCostEstimate",
  "laborCostActual", "laborCostEstimate",
  "laborHoursActual", "laborHoursEstimate",
  "overheadCostActual", "overheadCostEstimate",
  "totalResourceCostActual", "totalResourceCostEstimate",
  "commissionCostActual", "jobSourceType", "jobSourceId",
  "customerName", "siteName", "configuredCostCenterName",
] as const;

export type JobAnalyticsField = typeof JOB_ANALYTICS_FIELDS[number];
export type FieldCoverage = { total: number; supported: number; missing: number };

export type JobMonthlyReadModel = {
  periodStart: string;
  periodEnd: string;
  completedJobCount: number;
  totalSellValue: number;
  averageJobValue: number | null;
  grossProfitActual: number;
  grossMarginActual: number | null;
  netProfitActual: number;
  netMarginActual: number | null;
  profitBridge: {
    revenue: number;
    materials: number;
    labor: number;
    overhead: number;
    commission: number;
    other: number;
    netProfit: number;
  };
  costVariance: {
    materialsActual: number;
    materialsEstimate: number;
    laborActual: number;
    laborEstimate: number;
    overheadActual: number;
    overheadEstimate: number;
    totalActual: number;
    totalEstimate: number;
    materialsPairedJobs: number;
    laborPairedJobs: number;
    overheadPairedJobs: number;
    totalPairedJobs: number;
  };
  financialCoverage: {
    totalJobs: number;
    sellValueSupported: number;
    sellValueMissing: number;
    grossProfitSupported: number;
    grossProfitMissing: number;
    netProfitSupported: number;
    netProfitMissing: number;
    costTotalsSupported: number;
    grossMarginIncludedJobs: number;
    grossMarginCoveredSellValue: number;
    grossMarginCoveredProfit: number;
    netMarginIncludedJobs: number;
    netMarginCoveredSellValue: number;
    netMarginCoveredProfit: number;
  };
  fieldCoverage: Record<JobAnalyticsField, FieldCoverage>;
  grossMarginCoverage: { fromSimproTotals: number; fallbackOrMissing: number };
  labor: {
    eligibleQuoteSourcedJobs: number;
    jobsWithQuotedHours: number;
    jobsWithActualHours: number;
    nestedQuoteLaborCoveredJobs: number;
    nestedQuoteLaborMissingJobs: number;
    allJobTimesheetsCoveredJobs: number;
    allJobTimesheetsMissingJobs: number;
    includedJobs: number;
    missingQuotedHours: number;
    nonPositiveQuotedHours: number;
    missingActualHours: number;
    quotedHours: number;
    actualHours: number;
    varianceHours: number | null;
    variancePercent: number | null;
    laborOverrunHours: number;
    exclusionReasons: Record<JobLaborExclusionReason, number>;
  };
  laborAccuracy: {
    eligibleQuoteSourcedJobs: number;
    includedJobs: number;
    missingQuotedHours: number;
    missingActualHours: number;
    averageVariancePercent: number | null;
  };
  materialCoverage: {
    totalJobs: number;
    nestedItemsComplete: number;
    coverageOnly: number;
    unknown: number;
  };
  stageCounts: Record<string, number>;
  categoryMix: Record<string, number>;
  categoryRows: JobCategoryMetric[];
  costCenterRows: JobCostCenterMetric[];
  jobSourceRows: JobSourceMetric[];
  customerRows: ProfitabilityMetric[];
  siteRows: ProfitabilityMetric[];
  netMarginDistribution: Array<{ label: string; jobs: number; revenue: number; netProfit: number }>;
  lossMakingJobs: number;
  lossRecords: JobDrilldownRow[];
  lossBreakdown: LossBreakdown;
  quoteLinkedLabor: QuoteLinkedLaborMetric;
  directServiceFollowUps: DirectServiceFollowUps;
  profitPerHourCoveredJobs: number;
  netProfitPerActualHour: number | null;
  records: JobDrilldownRow[];
};

export type JobMetricsDashboardReadModel = {
  generatedAt: string;
  selectedMonth: string;
  selected: JobMonthlyReadModel;
  priorMonth: JobMonthlyReadModel;
  priorYearSameDay: JobMonthlyReadModel;
  priorYearFull: JobMonthlyReadModel;
  provisional: {
    active: boolean;
    elapsedDays: number;
    daysInMonth: number;
    pace: { completedJobs: number; sellValue: number; grossProfit: number; netProfit: number; actualHours: number };
  };
  comparisons: Array<{
    key: "completedJobs" | "sellValue" | "averageJobValue" | "grossProfit" | "grossMargin" | "netProfit" | "netMargin" | "laborVariance";
    label: string;
    format: "count" | "currency" | "percent";
    current: number | null;
    priorMonth: number | null;
    priorYear: number | null;
    priorYearFull: number | null;
    priorMonthDelta: number | null;
    priorYearDelta: number | null;
  }>;
  trailingWindow: { startMonth: string; endMonth: string; monthCount: number };
  trailing: {
    completedJobs: number;
    sellValue: number;
    grossProfit: number;
    grossMargin: number | null;
    netProfit: number;
    netMargin: number | null;
    quotedHours: number;
    actualHours: number;
    laborVariancePercent: number | null;
  };
  trends: Array<{
    month: string;
    label: string;
    provisional: boolean;
    provenance: "verified" | "representative";
    completedJobs: number;
    sellValue: number;
    avgJobValue: number | null;
    grossProfit: number;
    grossMargin: number | null;
    netProfit: number;
    netMargin: number | null;
    quotedHours: number;
    actualHours: number;
    laborVarianceHours: number | null;
    laborVariancePercent: number | null;
  }>;
  history: Array<{
    month: string;
    completedJobs: number;
    sellValue: number;
    provisional: boolean;
    reconciliation: JobReconciliationInput;
  }>;
  filters: Required<JobFilters>;
  filterOptions: { categories: string[]; costCenters: string[]; technicians: string[] };
  warnings: string[];
  methodology: {
    completion: string;
    financial: string;
    labor: string;
    category: string;
    commission: string;
  };
};

export function calculateLaborAccuracy(input: LaborAccuracyInput): LaborAccuracyResult {
  if (input.quotedHours === null) {
    return excludedLabor("missing quoted hours");
  }
  if (input.quotedHours <= 0) {
    return excludedLabor("quoted hours are not positive");
  }
  if (input.actualHours === null || input.actualHours < 0) {
    return excludedLabor("missing actual timesheet hours");
  }

  const varianceHours = input.actualHours - input.quotedHours;
  return {
    included: true,
    coverageReason: "quoted and actual hours present",
    varianceHours,
    variancePercent: percent(varianceHours, input.quotedHours),
  };
}

export function deriveJobLaborCoverage(job: NormalizedJobSnapshot): JobLaborCoverageResult {
  if (jobSourceTypeFor(job) !== "Quote-generated") {
    return {
      eligible: false,
      nestedQuoteLaborCovered: false,
      allJobTimesheetsCovered: false,
      exclusionReason: null,
      quotedHours: null,
      actualHours: null,
      ...excludedLabor("not quote-generated"),
    };
  }

  const quote = nestedQuoteLaborFacts(job);
  const timesheets = allJobTimesheetFacts(job);
  const linkedQuote = linkedQuoteIdFor(job) !== null;
  let exclusionReason: JobLaborExclusionReason | null = null;
  if (!linkedQuote) exclusionReason = "missing linked quote";
  else if (quote.reason) exclusionReason = quote.reason;
  else if ((quote.hours ?? 0) <= 0) exclusionReason = "quoted hours are not positive";
  else if (timesheets.reason) exclusionReason = timesheets.reason;

  if (exclusionReason) {
    return {
      eligible: true,
      nestedQuoteLaborCovered: linkedQuote && quote.covered,
      allJobTimesheetsCovered: timesheets.covered,
      exclusionReason,
      quotedHours: linkedQuote ? quote.hours : null,
      actualHours: timesheets.hours,
      ...excludedLabor(exclusionReason),
    };
  }

  const accuracy = calculateLaborAccuracy({ quotedHours: quote.hours, actualHours: timesheets.hours });
  return {
    eligible: true,
    nestedQuoteLaborCovered: linkedQuote && quote.covered,
    allJobTimesheetsCovered: timesheets.covered,
    exclusionReason: null,
    quotedHours: quote.hours,
    actualHours: timesheets.hours,
    ...accuracy,
  };
}

export function grossMarginPercent(sellValue: number, grossProfit: number): number | null {
  return sellValue > 0 ? percent(grossProfit, sellValue) : null;
}

export function isCompletedJobStage(stageName?: string | null): boolean {
  const normalized = (stageName ?? "").trim().toLowerCase();
  return normalized === "complete" || normalized === "archived";
}

export function buildJobMonthlyReadModel(params: {
  jobs: NormalizedJobSnapshot[];
  periodStart: string;
  periodEnd: string;
  issuedQuotes?: IssuedQuoteInput[];
}): JobMonthlyReadModel {
  const jobs = params.jobs
    .filter((job) => !job.sourceDeletedAt)
    .filter((job) => Boolean(job.completedDate && isDateInRange(job.completedDate, params.periodStart, params.periodEnd)))
    .filter((job) => isCompletedJobStage(job.stageName));
  const stageCounts: Record<string, number> = {};
  let totalSellValue = 0;
  let grossProfitActual = 0;
  let grossMarginCoveredSellValue = 0;
  let grossMarginCoveredProfit = 0;
  let netProfitActual = 0;
  let netMarginCoveredSellValue = 0;
  let netMarginCoveredProfit = 0;
  let sellValueSupported = 0;
  let grossProfitSupported = 0;
  let netProfitSupported = 0;
  let costTotalsSupported = 0;
  const profitBridge = { revenue: 0, materials: 0, labor: 0, overhead: 0, commission: 0, other: 0, netProfit: 0 };
  const costVariance = {
    materialsActual: 0, materialsEstimate: 0,
    laborActual: 0, laborEstimate: 0,
    overheadActual: 0, overheadEstimate: 0,
    totalActual: 0, totalEstimate: 0,
    materialsPairedJobs: 0, laborPairedJobs: 0,
    overheadPairedJobs: 0, totalPairedJobs: 0,
  };

  for (const job of jobs) {
    const stage = display(job.stageName, "Unknown");
    stageCounts[stage] = (stageCounts[stage] ?? 0) + 1;
    const sell = supportedNumber(job.sellValue);
    const profit = supportedNumber(job.grossProfitActual);
    const netProfit = supportedNumber(job.netProfitActual);
    if (sell !== null) {
      sellValueSupported += 1;
      totalSellValue += sell;
    }
    if (profit !== null) {
      grossProfitSupported += 1;
      grossProfitActual += profit;
    }
    if (netProfit !== null) {
      netProfitSupported += 1;
      netProfitActual += netProfit;
    }
    if (sell !== null && profit !== null) {
      grossMarginCoveredSellValue += sell;
      grossMarginCoveredProfit += profit;
    }
    if (sell !== null && netProfit !== null) {
      netMarginCoveredSellValue += sell;
      netMarginCoveredProfit += netProfit;
    }
    const materialsActual = supportedNumber(job.materialsCostActual);
    const materialsEstimate = supportedNumber(job.materialsCostEstimate);
    const laborActual = supportedNumber(job.laborCostActual);
    const laborEstimate = supportedNumber(job.laborCostEstimate);
    const overheadActual = supportedNumber(job.overheadCostActual);
    const overheadEstimate = supportedNumber(job.overheadCostEstimate);
    const totalActual = supportedNumber(job.totalResourceCostActual);
    const totalEstimate = supportedNumber(job.totalResourceCostEstimate);
    const commission = supportedNumber(job.commissionCostActual);
    if ([materialsActual, laborActual, overheadActual, totalActual].some((value) => value !== null)) costTotalsSupported += 1;
    if (sell !== null) profitBridge.revenue += sell;
    profitBridge.materials += materialsActual ?? 0;
    profitBridge.labor += laborActual ?? 0;
    profitBridge.overhead += overheadActual ?? 0;
    profitBridge.commission += commission ?? 0;
    profitBridge.netProfit += netProfit ?? 0;
    if (materialsActual !== null && materialsEstimate !== null) {
      costVariance.materialsActual += materialsActual;
      costVariance.materialsEstimate += materialsEstimate;
      costVariance.materialsPairedJobs += 1;
    }
    if (laborActual !== null && laborEstimate !== null) {
      costVariance.laborActual += laborActual;
      costVariance.laborEstimate += laborEstimate;
      costVariance.laborPairedJobs += 1;
    }
    if (overheadActual !== null && overheadEstimate !== null) {
      costVariance.overheadActual += overheadActual;
      costVariance.overheadEstimate += overheadEstimate;
      costVariance.overheadPairedJobs += 1;
    }
    if (totalActual !== null && totalEstimate !== null) {
      costVariance.totalActual += totalActual;
      costVariance.totalEstimate += totalEstimate;
      costVariance.totalPairedJobs += 1;
    }
  }

  profitBridge.other = profitBridge.revenue - profitBridge.materials - profitBridge.labor - profitBridge.overhead - profitBridge.commission - profitBridge.netProfit;

  const labor = aggregateLabor(jobs);
  const categories = aggregateCategories(jobs);
  const records = jobs.map(buildDrilldownRow).sort((left, right) => right.completedDate.localeCompare(left.completedDate) || right.jobId.localeCompare(left.jobId));
  const materialCoverage = aggregateMaterialCoverage(jobs);
  const categoryMix = Object.fromEntries(categories.categoryRows.map((row) => [row.label, row.distinctJobCount]));
  const jobSourceRows = aggregateJobSources(jobs);
  const customerRows = aggregateProfitability(jobs, (job) => display(job.customerName, "Unclassified"));
  const siteRows = aggregateProfitability(jobs, (job) => display(job.siteName, "Unclassified"));
  const netMarginDistribution = aggregateNetMarginDistribution(jobs);
  let profitPerHourCoveredJobs = 0;
  let profitPerHourProfit = 0;
  let profitPerHourHours = 0;
  for (const job of jobs) {
    const netProfit = supportedNumber(job.netProfitActual);
    const actualHours = actualLaborHoursFor(job);
    if (netProfit === null || actualHours === null || actualHours <= 0) continue;
    profitPerHourCoveredJobs += 1;
    profitPerHourProfit += netProfit;
    profitPerHourHours += actualHours;
  }

  return {
    periodStart: params.periodStart,
    periodEnd: params.periodEnd,
    completedJobCount: jobs.length,
    totalSellValue,
    averageJobValue: jobs.length > 0 ? totalSellValue / jobs.length : null,
    grossProfitActual,
    grossMarginActual: grossMarginPercent(grossMarginCoveredSellValue, grossMarginCoveredProfit),
    netProfitActual,
    netMarginActual: grossMarginPercent(netMarginCoveredSellValue, netMarginCoveredProfit),
    profitBridge,
    costVariance,
    financialCoverage: {
      totalJobs: jobs.length,
      sellValueSupported,
      sellValueMissing: jobs.length - sellValueSupported,
      grossProfitSupported,
      grossProfitMissing: jobs.length - grossProfitSupported,
      netProfitSupported,
      netProfitMissing: jobs.length - netProfitSupported,
      costTotalsSupported,
      grossMarginIncludedJobs: jobs.filter((job) => supportedNumber(job.sellValue) !== null && supportedNumber(job.grossProfitActual) !== null).length,
      grossMarginCoveredSellValue,
      grossMarginCoveredProfit,
      netMarginIncludedJobs: jobs.filter((job) => supportedNumber(job.sellValue) !== null && supportedNumber(job.netProfitActual) !== null).length,
      netMarginCoveredSellValue,
      netMarginCoveredProfit,
    },
    fieldCoverage: aggregateFieldCoverage(jobs),
    grossMarginCoverage: {
      fromSimproTotals: grossProfitSupported,
      fallbackOrMissing: jobs.length - grossProfitSupported,
    },
    labor,
    laborAccuracy: {
      eligibleQuoteSourcedJobs: labor.eligibleQuoteSourcedJobs,
      includedJobs: labor.includedJobs,
      missingQuotedHours: labor.missingQuotedHours + labor.nonPositiveQuotedHours,
      missingActualHours: labor.missingActualHours,
      averageVariancePercent: labor.variancePercent,
    },
    materialCoverage,
    stageCounts,
    categoryMix,
    categoryRows: categories.categoryRows,
    costCenterRows: categories.costCenterRows,
    jobSourceRows,
    customerRows,
    siteRows,
    netMarginDistribution,
    lossMakingJobs: jobs.filter((job) => {
      const netProfit = supportedNumber(job.netProfitActual);
      return netProfit !== null && netProfit < 0;
    }).length,
    lossRecords: records.filter((row) => row.netProfit !== null && row.netProfit < 0),
    lossBreakdown: aggregateLossBreakdown(jobs),
    quoteLinkedLabor: aggregateQuoteLinkedLabor(jobs),
    directServiceFollowUps: aggregateDirectServiceFollowUps(jobs, params.issuedQuotes),
    profitPerHourCoveredJobs,
    netProfitPerActualHour: profitPerHourHours > 0 ? profitPerHourProfit / profitPerHourHours : null,
    records,
  };
}

export function buildJobMetricsDashboard(params: {
  jobs: NormalizedJobSnapshot[];
  selectedMonth?: string;
  filters?: JobFilters;
  reconciliations?: JobReconciliationInput[];
  issuedQuotes?: IssuedQuoteInput[];
  now?: Date;
}): JobMetricsDashboardReadModel {
  const now = params.now ?? new Date();
  const localNow = losAngelesDateParts(now);
  const currentMonth = `${localNow.year}-${pad(localNow.month)}`;
  const selectedMonth = validMonth(params.selectedMonth) ? params.selectedMonth : currentMonth;
  const provisional = selectedMonth === currentMonth;
  const filters = normalizeFilters(params.filters);
  const filteredJobs = params.jobs.filter((job) => matchesFilters(job, filters));
  const selectedRange = provisional
    ? { periodStart: `${selectedMonth}-01`, periodEnd: `${selectedMonth}-${pad(localNow.day)}` }
    : monthRange(selectedMonth);
  const priorMonthKey = shiftMonth(selectedMonth, -1);
  const priorYearKey = shiftMonth(selectedMonth, -12);
  const priorMonthRange = monthRange(priorMonthKey);
  const priorYearRange = monthRange(priorYearKey);
  const sameDayEnd = `${priorYearKey}-${pad(Math.min(localNow.day, daysInMonth(priorYearKey)))}`;
  const issuedQuotes = params.issuedQuotes;
  const selected = buildJobMonthlyReadModel({ jobs: filteredJobs, issuedQuotes, ...selectedRange });
  const priorMonth = buildJobMonthlyReadModel({ jobs: filteredJobs, issuedQuotes, ...priorMonthRange });
  const priorYearFull = buildJobMonthlyReadModel({ jobs: filteredJobs, issuedQuotes, ...priorYearRange });
  const priorYearSameDay = buildJobMonthlyReadModel({
    jobs: filteredJobs,
    issuedQuotes,
    periodStart: priorYearRange.periodStart,
    periodEnd: provisional ? sameDayEnd : priorYearRange.periodEnd,
  });
  const historyStart = "2023-01";
  const historyMonths = selectedMonth >= historyStart ? monthKeys(historyStart, selectedMonth) : [selectedMonth];
  const monthly = historyMonths.map((month) => {
    const range = month === selectedMonth ? selectedRange : monthRange(month);
    const metric = buildJobMonthlyReadModel({ jobs: filteredJobs, issuedQuotes, ...range });
    return { month, metric, provisional: month === currentMonth };
  });
  const trailingEnd = provisional ? shiftMonth(selectedMonth, -1) : selectedMonth;
  const trailingStart = shiftMonth(trailingEnd, -11);
  const trailingMonths = monthly.filter((row) => row.month >= trailingStart && row.month <= trailingEnd);
  const trailing = aggregateTrailing(trailingMonths.map((row) => row.metric));
  const reconciliationByMonth = new Map((params.reconciliations ?? []).map((row) => [row.periodStart.slice(0, 7), row]));
  const elapsedDays = provisional ? localNow.day : daysInMonth(selectedMonth);
  const paceFactor = elapsedDays > 0 ? daysInMonth(selectedMonth) / elapsedDays : 1;
  const comparisonYear = provisional ? priorYearSameDay : priorYearFull;
  const options = buildFilterOptions(params.jobs);
  const warnings = buildDashboardWarnings(selected, historyMonths, reconciliationByMonth);

  return {
    generatedAt: now.toISOString(),
    selectedMonth,
    selected,
    priorMonth,
    priorYearSameDay,
    priorYearFull,
    provisional: {
      active: provisional,
      elapsedDays,
      daysInMonth: daysInMonth(selectedMonth),
      pace: {
        completedJobs: selected.completedJobCount * paceFactor,
        sellValue: selected.totalSellValue * paceFactor,
        grossProfit: selected.grossProfitActual * paceFactor,
        netProfit: selected.netProfitActual * paceFactor,
        actualHours: selected.labor.actualHours * paceFactor,
      },
    },
    comparisons: buildComparisons(selected, priorMonth, comparisonYear, priorYearFull),
    trailingWindow: { startMonth: trailingStart, endMonth: trailingEnd, monthCount: trailingMonths.length },
    trailing,
    // Serve at least the trailing 18 months, and never less than Jan 2025
    // through the selected month (the approved trend chart's fixed window).
    trends: monthly
      .filter(({ month }) => month >= trendWindowStart(selectedMonth, historyStart))
      .map(({ month, metric, provisional: isProvisional }) => ({
        month,
        label: monthLabel(month),
        provisional: isProvisional,
        provenance: trendProvenance(reconciliationByMonth.get(month)),
        completedJobs: metric.completedJobCount,
        sellValue: metric.totalSellValue,
        avgJobValue: metric.averageJobValue,
        grossProfit: metric.grossProfitActual,
        grossMargin: metric.grossMarginActual,
        netProfit: metric.netProfitActual,
        netMargin: metric.netMarginActual,
        quotedHours: metric.labor.quotedHours,
        actualHours: metric.labor.actualHours,
        laborVarianceHours: metric.labor.varianceHours,
        laborVariancePercent: metric.labor.variancePercent,
      })),
    history: monthly.map(({ month, metric, provisional: isProvisional }) => ({
      month,
      completedJobs: metric.completedJobCount,
      sellValue: metric.totalSellValue,
      provisional: isProvisional,
      reconciliation: reconciliationByMonth.get(month) ?? { periodStart: `${month}-01`, status: "missing" },
    })),
    filters,
    filterOptions: options,
    warnings,
    methodology: {
      completion: "CompletedDate in the selected period and Stage exactly Complete or Archived. Status and invoice stage never determine completion.",
      financial: "Revenue is Simpro job Total ex-tax. Gross profit, Net Profit Actual, and Net Margin Actual use persisted Simpro job-cost fields. Aggregate margins are summed covered profit divided by the same covered revenue.",
      labor: "Quote-generated variance uses only active nested labor on the linked quote and all active employee timesheets attached to the completed job, regardless of timesheet month. Recurring estimates remain separate; direct service has actual-hours coverage only.",
      category: "Business-line and cost-center results use the configured Simpro CostCenter ID and Name. The per-job cost-center instance Name is drilldown context only. Unclassified and Unallocated remain visible.",
      commission: "Commission Actual is retained only as a Simpro job-cost input. It is not proof that commission was paid.",
    },
  };
}

function aggregateLabor(jobs: NormalizedJobSnapshot[]): JobMonthlyReadModel["labor"] {
  let eligibleQuoteSourcedJobs = 0;
  let jobsWithQuotedHours = 0;
  let jobsWithActualHours = 0;
  let nestedQuoteLaborCoveredJobs = 0;
  let allJobTimesheetsCoveredJobs = 0;
  let includedJobs = 0;
  let missingQuotedHours = 0;
  let nonPositiveQuotedHours = 0;
  let missingActualHours = 0;
  let quotedHours = 0;
  let actualHours = 0;
  let laborOverrunHours = 0;
  const exclusionReasons: Record<JobLaborExclusionReason, number> = {
    "missing linked quote": 0,
    "missing active nested quote labor": 0,
    "invalid nested quote labor hours": 0,
    "quoted hours are not positive": 0,
    "missing active job timesheets": 0,
    "invalid job timesheet hours": 0,
  };

  for (const job of jobs) {
    const coverage = deriveJobLaborCoverage(job);
    if (!coverage.eligible) continue;
    eligibleQuoteSourcedJobs += 1;
    if (coverage.nestedQuoteLaborCovered) {
      jobsWithQuotedHours += 1;
      nestedQuoteLaborCoveredJobs += 1;
    }
    if (coverage.allJobTimesheetsCovered) {
      jobsWithActualHours += 1;
      allJobTimesheetsCoveredJobs += 1;
    }
    if (!coverage.included) {
      if (coverage.exclusionReason) exclusionReasons[coverage.exclusionReason] += 1;
      if (coverage.exclusionReason === "quoted hours are not positive") nonPositiveQuotedHours += 1;
      else if (coverage.exclusionReason?.includes("quote") || coverage.exclusionReason?.includes("nested")) missingQuotedHours += 1;
      else missingActualHours += 1;
      continue;
    }
    includedJobs += 1;
    quotedHours += coverage.quotedHours ?? 0;
    actualHours += coverage.actualHours ?? 0;
    laborOverrunHours += Math.max((coverage.actualHours ?? 0) - (coverage.quotedHours ?? 0), 0);
  }

  const varianceHours = includedJobs > 0 ? actualHours - quotedHours : null;
  return {
    eligibleQuoteSourcedJobs,
    jobsWithQuotedHours,
    jobsWithActualHours,
    nestedQuoteLaborCoveredJobs,
    nestedQuoteLaborMissingJobs: eligibleQuoteSourcedJobs - nestedQuoteLaborCoveredJobs,
    allJobTimesheetsCoveredJobs,
    allJobTimesheetsMissingJobs: eligibleQuoteSourcedJobs - allJobTimesheetsCoveredJobs,
    includedJobs,
    missingQuotedHours,
    nonPositiveQuotedHours,
    missingActualHours,
    quotedHours,
    actualHours,
    varianceHours,
    variancePercent: varianceHours === null ? null : percent(varianceHours, quotedHours),
    laborOverrunHours,
    exclusionReasons,
  };
}

function aggregateCategories(jobs: NormalizedJobSnapshot[]) {
  type MutableMetric = Omit<JobCategoryMetric, "distinctJobCount" | "primaryJobCount" | "grossMargin" | "netMargin" | "actualHoursCoveredJobs" | "actualHoursUncoveredJobs"> & {
    jobIds: Set<string>;
    primaryJobIds: Set<string>;
    actualHoursCoveredJobIds: Set<string>;
    actualHoursUncoveredJobIds: Set<string>;
    marginSell: number;
    marginProfit: number;
    netMarginSell: number;
    netMarginProfit: number;
  };
  const byCategory = new Map<string, MutableMetric>();
  const byCostCenter = new Map<string, MutableMetric & { category: string }>();
  const mutable = (map: Map<string, MutableMetric>, key: string) => {
    const existing = map.get(key);
    if (existing) return existing;
    const created: MutableMetric = {
      label: key,
      jobIds: new Set(),
      primaryJobIds: new Set(),
      actualHoursCoveredJobIds: new Set(),
      actualHoursUncoveredJobIds: new Set(),
      sellValue: 0,
      grossProfit: 0,
      marginSell: 0,
      marginProfit: 0,
      netProfit: 0,
      netMarginSell: 0,
      netMarginProfit: 0,
      quotedHours: 0,
      actualHours: 0,
      sellCoverageRows: 0,
      grossProfitCoverageRows: 0,
      netProfitCoverageRows: 0,
    };
    map.set(key, created);
    return created;
  };

  for (const job of jobs) {
    const jobId = String(job.jobId);
    const costCenters = activeCostCenters(job);
    const byJobCategory = new Map<string, { sell: number; quoted: number; rows: JobCostCenterInput[] }>();
    for (const row of costCenters) {
      const category = normalizedCategory(row.category);
      const state = byJobCategory.get(category) ?? { sell: 0, quoted: 0, rows: [] };
      state.sell += supportedNumber(row.sellValue) ?? 0;
      state.quoted += Math.max(supportedNumber(row.quotedHours) ?? 0, 0);
      state.rows.push(row);
      byJobCategory.set(category, state);
    }
    if (byJobCategory.size === 0) {
      byJobCategory.set(normalizedCategory(job.category), { sell: 0, quoted: 0, rows: [] });
    }
    const primaryCategory = [...byJobCategory.entries()]
      .sort(([leftName, left], [rightName, right]) => right.sell - left.sell || leftName.localeCompare(rightName))[0][0];
    const actual = actualLaborHoursFor(job);
    const totalQuoted = [...byJobCategory.values()].reduce((sum, row) => sum + row.quoted, 0);
    const allocatedActual = new Map<string, number>();
    if (actual !== null && totalQuoted > 0) {
      for (const [category, row] of byJobCategory) allocatedActual.set(category, actual * row.quoted / totalQuoted);
    } else if (actual !== null && byJobCategory.size === 1) {
      allocatedActual.set(primaryCategory, actual);
    }

    for (const [category, state] of byJobCategory) {
      const metric = mutable(byCategory, category);
      metric.jobIds.add(jobId);
      if (category === primaryCategory) metric.primaryJobIds.add(jobId);
      if (allocatedActual.has(category)) {
        metric.actualHours += allocatedActual.get(category) ?? 0;
        metric.actualHoursCoveredJobIds.add(jobId);
      } else if (actual !== null) {
        metric.actualHoursUncoveredJobIds.add(jobId);
      }
      for (const row of state.rows) addCostCenterValues(metric, row);
    }

    for (const row of costCenters) {
      const category = normalizedCategory(row.category);
      const label = configuredCostCenterLabel(row);
      let metric = byCostCenter.get(label);
      if (!metric) {
        metric = { ...mutable(new Map(), label), category };
        byCostCenter.set(label, metric);
      }
      metric.jobIds.add(jobId);
      if (category === primaryCategory) metric.primaryJobIds.add(jobId);
      addCostCenterValues(metric, row);
      const categoryQuoted = byJobCategory.get(category)?.quoted ?? 0;
      const rowQuoted = Math.max(supportedNumber(row.quotedHours) ?? 0, 0);
      const categoryActual = allocatedActual.get(category);
      if (categoryActual !== undefined && categoryQuoted > 0) {
        metric.actualHours += categoryActual * rowQuoted / categoryQuoted;
        metric.actualHoursCoveredJobIds.add(jobId);
      } else if (categoryActual !== undefined && byJobCategory.get(category)?.rows.length === 1) {
        metric.actualHours += categoryActual;
        metric.actualHoursCoveredJobIds.add(jobId);
      } else if (actual !== null) {
        metric.actualHoursUncoveredJobIds.add(jobId);
      }
    }

    const sell = supportedNumber(job.sellValue);
    const allocatedSell = costCenters.reduce((sum, row) => sum + (supportedNumber(row.sellValue) ?? 0), 0);
    if (sell !== null && Math.abs(sell - allocatedSell) >= 0.005) {
      const difference = sell - allocatedSell;
      const categoryMetric = mutable(byCategory, "Unallocated");
      categoryMetric.jobIds.add(jobId);
      categoryMetric.sellValue += difference;
      categoryMetric.sellCoverageRows += 1;
      let costCenterMetric = byCostCenter.get("Unallocated");
      if (!costCenterMetric) {
        costCenterMetric = { ...mutable(new Map(), "Unallocated"), category: "Unallocated" };
        byCostCenter.set("Unallocated", costCenterMetric);
      }
      costCenterMetric.jobIds.add(jobId);
      costCenterMetric.sellValue += difference;
      costCenterMetric.sellCoverageRows += 1;
    }
  }

  const finalize = (metric: MutableMetric): JobCategoryMetric => ({
    label: metric.label,
    distinctJobCount: metric.jobIds.size,
    primaryJobCount: metric.primaryJobIds.size,
    sellValue: metric.sellValue,
    grossProfit: metric.grossProfit,
    grossMargin: grossMarginPercent(metric.marginSell, metric.marginProfit),
    netProfit: metric.netProfit,
    netMargin: grossMarginPercent(metric.netMarginSell, metric.netMarginProfit),
    quotedHours: metric.quotedHours,
    actualHours: metric.actualHours,
    actualHoursCoveredJobs: metric.actualHoursCoveredJobIds.size,
    actualHoursUncoveredJobs: metric.actualHoursUncoveredJobIds.size,
    sellCoverageRows: metric.sellCoverageRows,
    grossProfitCoverageRows: metric.grossProfitCoverageRows,
    netProfitCoverageRows: metric.netProfitCoverageRows,
  });
  return {
    categoryRows: [...byCategory.values()].map(finalize).sort((left, right) => right.sellValue - left.sellValue || left.label.localeCompare(right.label)),
    costCenterRows: [...byCostCenter.values()].map((metric) => ({ ...finalize(metric), category: metric.category })).sort((left, right) => right.sellValue - left.sellValue || left.label.localeCompare(right.label)),
  };
}

function addCostCenterValues(metric: {
  sellValue: number;
  grossProfit: number;
  marginSell: number;
  marginProfit: number;
  netProfit: number;
  netMarginSell: number;
  netMarginProfit: number;
  quotedHours: number;
  sellCoverageRows: number;
  grossProfitCoverageRows: number;
  netProfitCoverageRows: number;
}, row: JobCostCenterInput) {
  const sell = supportedNumber(row.sellValue);
  const profit = supportedNumber(row.grossProfitActual);
  const quoted = supportedNumber(row.quotedHours);
  const netProfit = supportedNumber(row.netProfitActual);
  if (sell !== null) {
    metric.sellValue += sell;
    metric.sellCoverageRows += 1;
  }
  if (profit !== null) {
    metric.grossProfit += profit;
    metric.grossProfitCoverageRows += 1;
  }
  if (sell !== null && profit !== null) {
    metric.marginSell += sell;
    metric.marginProfit += profit;
  }
  if (netProfit !== null) {
    metric.netProfit += netProfit;
    metric.netProfitCoverageRows += 1;
  }
  if (sell !== null && netProfit !== null) {
    metric.netMarginSell += sell;
    metric.netMarginProfit += netProfit;
  }
  if (quoted !== null) metric.quotedHours += quoted;
}

function aggregateJobSources(jobs: NormalizedJobSnapshot[]): JobSourceMetric[] {
  type MutableSource = JobSourceMetric & {
    grossMarginRevenue: number;
    grossMarginProfit: number;
    netMarginRevenue: number;
    netMarginProfit: number;
    profitPerHourProfit: number;
    profitPerHourHours: number;
    varianceEstimatedHours: number;
    varianceActualHours: number;
  };
  const rows = new Map<JobSourceType, MutableSource>();
  for (const sourceType of ["Quote-generated", "Recurring", "Direct service"] as const) {
    rows.set(sourceType, {
      sourceType, jobs: 0, revenue: 0, grossProfit: 0, netProfit: 0,
      grossMargin: null, netMargin: null, estimatedHours: 0, actualHours: 0,
      laborCoveredJobs: 0, laborVariancePercent: null, netProfitPerActualHour: null,
      revenueCoverage: 0, grossProfitCoverage: 0, netProfitCoverage: 0,
      laborEstimateCoverage: 0, laborActualCoverage: 0,
      grossMarginRevenue: 0, grossMarginProfit: 0,
      netMarginRevenue: 0, netMarginProfit: 0,
      profitPerHourProfit: 0, profitPerHourHours: 0,
      varianceEstimatedHours: 0, varianceActualHours: 0,
    });
  }
  for (const job of jobs) {
    const row = rows.get(jobSourceTypeFor(job))!;
    row.jobs += 1;
    const revenue = supportedNumber(job.sellValue);
    const grossProfit = supportedNumber(job.grossProfitActual);
    const netProfit = supportedNumber(job.netProfitActual);
    const estimatedHours = estimatedLaborHoursFor(job);
    const actualHours = actualLaborHoursFor(job);
    row.revenue += revenue ?? 0;
    row.grossProfit += grossProfit ?? 0;
    row.netProfit += netProfit ?? 0;
    if (revenue !== null) row.revenueCoverage += 1;
    if (grossProfit !== null) row.grossProfitCoverage += 1;
    if (netProfit !== null) row.netProfitCoverage += 1;
    if (estimatedHours !== null) {
      row.laborEstimateCoverage += 1;
      row.estimatedHours += estimatedHours;
    }
    if (actualHours !== null) {
      row.laborActualCoverage += 1;
      row.actualHours += actualHours;
    }
    if (revenue !== null && grossProfit !== null) {
      row.grossMarginRevenue += revenue;
      row.grossMarginProfit += grossProfit;
    }
    if (revenue !== null && netProfit !== null) {
      row.netMarginRevenue += revenue;
      row.netMarginProfit += netProfit;
    }
    if (estimatedHours !== null && estimatedHours > 0 && actualHours !== null && actualHours >= 0) {
      row.laborCoveredJobs += 1;
      row.varianceEstimatedHours += estimatedHours;
      row.varianceActualHours += actualHours;
    }
    if (netProfit !== null && actualHours !== null && actualHours > 0) {
      row.profitPerHourProfit += netProfit;
      row.profitPerHourHours += actualHours;
    }
  }
  return [...rows.values()].map(({
    grossMarginRevenue, grossMarginProfit, netMarginRevenue, netMarginProfit,
    profitPerHourProfit, profitPerHourHours, varianceEstimatedHours, varianceActualHours, ...row
  }) => ({
    ...row,
    grossMargin: grossMarginPercent(grossMarginRevenue, grossMarginProfit),
    netMargin: grossMarginPercent(netMarginRevenue, netMarginProfit),
    laborVariancePercent: varianceEstimatedHours > 0 ? percent(varianceActualHours - varianceEstimatedHours, varianceEstimatedHours) : null,
    netProfitPerActualHour: profitPerHourHours > 0 ? profitPerHourProfit / profitPerHourHours : null,
  }));
}

function aggregateProfitability(jobs: NormalizedJobSnapshot[], labelFor: (job: NormalizedJobSnapshot) => string): ProfitabilityMetric[] {
  type MutableProfitability = ProfitabilityMetric & { marginRevenue: number; marginProfit: number; profitPerHourProfit: number; profitPerHourHours: number };
  const rows = new Map<string, MutableProfitability>();
  for (const job of jobs) {
    const label = labelFor(job);
    const row = rows.get(label) ?? {
      label, jobs: 0, revenue: 0, grossProfit: 0, netProfit: 0, netMargin: null,
      netProfitPerActualHour: null, revenueCoverage: 0, netProfitCoverage: 0,
      marginRevenue: 0, marginProfit: 0, profitPerHourProfit: 0, profitPerHourHours: 0,
    };
    row.jobs += 1;
    const revenue = supportedNumber(job.sellValue);
    const grossProfit = supportedNumber(job.grossProfitActual);
    const netProfit = supportedNumber(job.netProfitActual);
    row.revenue += revenue ?? 0;
    row.grossProfit += grossProfit ?? 0;
    row.netProfit += netProfit ?? 0;
    if (revenue !== null) row.revenueCoverage += 1;
    if (netProfit !== null) row.netProfitCoverage += 1;
    if (revenue !== null && netProfit !== null) {
      row.marginRevenue += revenue;
      row.marginProfit += netProfit;
    }
    const actualHours = actualLaborHoursFor(job);
    if (netProfit !== null && actualHours !== null && actualHours > 0) {
      row.profitPerHourProfit += netProfit;
      row.profitPerHourHours += actualHours;
    }
    rows.set(label, row);
  }
  return [...rows.values()]
    .map(({ marginRevenue, marginProfit, profitPerHourProfit, profitPerHourHours, ...row }) => ({
      ...row,
      netMargin: grossMarginPercent(marginRevenue, marginProfit),
      netProfitPerActualHour: profitPerHourHours > 0 ? profitPerHourProfit / profitPerHourHours : null,
    }))
    .sort((left, right) => right.revenue - left.revenue || left.label.localeCompare(right.label));
}

function aggregateNetMarginDistribution(jobs: NormalizedJobSnapshot[]) {
  const buckets = [
    { label: "Below 0%", min: Number.NEGATIVE_INFINITY, max: 0 },
    { label: "0 to <10%", min: 0, max: 10 },
    { label: "10 to <20%", min: 10, max: 20 },
    { label: "20 to <30%", min: 20, max: 30 },
    { label: "30%+", min: 30, max: Number.POSITIVE_INFINITY },
  ].map((bucket) => ({ ...bucket, jobs: 0, revenue: 0, netProfit: 0 }));
  const unclassified = { label: "Unclassified", jobs: 0, revenue: 0, netProfit: 0 };
  for (const job of jobs) {
    const revenue = supportedNumber(job.sellValue);
    const netProfit = supportedNumber(job.netProfitActual);
    const margin = supportedNumber(job.netMarginActual);
    if (margin === null) {
      unclassified.jobs += 1;
      unclassified.revenue += revenue ?? 0;
      unclassified.netProfit += netProfit ?? 0;
      continue;
    }
    const bucket = buckets.find((candidate) => margin !== null && margin >= candidate.min && margin < candidate.max);
    if (!bucket) continue;
    bucket.jobs += 1;
    bucket.revenue += revenue ?? 0;
    bucket.netProfit += netProfit ?? 0;
  }
  return [...buckets.map((bucket) => ({ label: bucket.label, jobs: bucket.jobs, revenue: bucket.revenue, netProfit: bucket.netProfit })), unclassified];
}

function jobSourceTypeFor(job: NormalizedJobSnapshot): JobSourceType {
  const source = (job.jobSourceType?.trim() || job.convertedFromType?.trim() || "").toLowerCase();
  if (source.includes("quote")) return "Quote-generated";
  if (source.includes("recurr") || source.includes("contract")) return "Recurring";
  if (isQuoteSourced(job)) return "Quote-generated";
  return "Direct service";
}

function buildDrilldownRow(job: NormalizedJobSnapshot): JobDrilldownRow {
  const costCenters = activeCostCenters(job);
  const byCategory = new Map<string, number>();
  for (const row of costCenters) {
    const category = normalizedCategory(row.category);
    byCategory.set(category, (byCategory.get(category) ?? 0) + (supportedNumber(row.sellValue) ?? 0));
  }
  if (byCategory.size === 0) byCategory.set(normalizedCategory(job.category), 0);
  const primaryCategory = [...byCategory.entries()].sort(([leftName, left], [rightName, right]) => right - left || leftName.localeCompare(rightName))[0][0];
  const sell = supportedNumber(job.sellValue);
  const profit = supportedNumber(job.grossProfitActual);
  const netProfit = supportedNumber(job.netProfitActual);
  const quoted = estimatedLaborHoursFor(job);
  const actual = actualLaborHoursFor(job);
  const labor = deriveJobLaborCoverage(job);
  const quoteId = linkedQuoteIdFor(job);
  const technicianNames = [...new Set(activeTimesheets(job).map((row) => display(row.technicianName, "Unmapped technician")))].sort();
  const costCenterSellValue = costCenters.reduce((sum, row) => sum + (supportedNumber(row.sellValue) ?? 0), 0);

  return {
    jobId: String(job.jobId),
    jobNo: display(job.jobNo, `Job ${job.jobId}`),
    name: plainDisplayText(job.name, `Job ${job.jobId}`),
    description: plainDisplayText(job.description, "No description", 1000),
    completedDate: job.completedDate ?? "",
    stage: display(job.stageName, "Unknown"),
    status: display(job.statusName, "Unknown"),
    inclusionReason: `CompletedDate ${job.completedDate ?? "missing"}; Stage ${display(job.stageName, "Unknown")}`,
    sellValue: sell,
    grossProfit: profit,
    grossMargin: sell !== null && profit !== null ? grossMarginPercent(sell, profit) : null,
    netProfit,
    netMargin: supportedNumber(job.netMarginActual),
    customerName: display(job.customerName, "Unclassified"),
    siteName: display(job.siteName, "Unclassified"),
    jobSourceType: jobSourceTypeFor(job),
    jobSourceId: job.jobSourceId === null || job.jobSourceId === undefined ? null : String(job.jobSourceId),
    materialsCostActual: supportedNumber(job.materialsCostActual),
    materialsCostEstimate: supportedNumber(job.materialsCostEstimate),
    laborCostActual: supportedNumber(job.laborCostActual),
    laborCostEstimate: supportedNumber(job.laborCostEstimate),
    laborHoursActual: actual,
    laborHoursEstimate: quoted,
    overheadCostActual: supportedNumber(job.overheadCostActual),
    overheadCostEstimate: supportedNumber(job.overheadCostEstimate),
    totalResourceCostActual: supportedNumber(job.totalResourceCostActual),
    totalResourceCostEstimate: supportedNumber(job.totalResourceCostEstimate),
    commissionCostActual: supportedNumber(job.commissionCostActual),
    financialBasis: sell !== null && profit !== null && netProfit !== null ? "Simpro job Total ex-tax + GrossProfit Actual + NetProfit Actual" : sell !== null ? "Simpro job Total ex-tax; one or more persisted profit totals missing" : "Simpro job Total unsupported",
    primaryCategory,
    categories: [...byCategory.keys()].sort(),
    costCenterSellValue,
    unallocatedSellValue: sell === null ? null : sell - costCenterSellValue,
    quoteId: quoteId === null || quoteId === undefined ? null : String(quoteId),
    quotedHours: quoted,
    actualHours: actual,
    varianceHours: labor.varianceHours,
    variancePercent: labor.variancePercent,
    laborCoverage: labor.coverageReason,
    technicians: technicianNames,
    materialCoverage: display(job.materialCoverage, "unknown"),
    costCenters: costCenters.map((row) => ({
      configuredName: configuredCostCenterLabel(row),
      instanceName: display(row.name, "Unnamed instance"),
    })),
    lossClass: classifyLoss(sell, netProfit),
  };
}

function aggregateLossBreakdown(jobs: NormalizedJobSnapshot[]): LossBreakdown {
  const breakdown: LossBreakdown = {
    rule: LOSS_CLASSIFICATION_RULE,
    lossJobs: 0,
    netTotal: 0,
    diagnosticFee: { jobs: 0, netTotal: 0 },
    execution: { jobs: 0, netTotal: 0 },
  };
  for (const job of jobs) {
    const net = supportedNumber(job.netProfitActual);
    const lossClass = classifyLoss(supportedNumber(job.sellValue), net);
    if (!lossClass || net === null) continue;
    breakdown.lossJobs += 1;
    breakdown.netTotal += net;
    const bucket = lossClass === "diagnostic_fee" ? breakdown.diagnosticFee : breakdown.execution;
    bucket.jobs += 1;
    bucket.netTotal += net;
  }
  return breakdown;
}

/**
 * Quote conversion evidence for the labor-efficiency cohort: any linked quote
 * (job_source_quotes / ConvertedFrom Quote) or a recurring-plan conversion id.
 * This is deliberately broader than work-source Quote-generated, which
 * excludes recurring conversions; both classifications are served side by side.
 */
function quoteConversionIdFor(job: NormalizedJobSnapshot): string | number | null {
  const linked = linkedQuoteIdFor(job);
  if (linked !== null) return linked;
  const source = (job.jobSourceType?.trim() || job.convertedFromType?.trim() || "").toLowerCase();
  if (source.includes("recurr") || source.includes("contract")) {
    if (job.jobSourceId !== null && job.jobSourceId !== undefined) return job.jobSourceId;
    if (job.convertedFromId !== null && job.convertedFromId !== undefined) return job.convertedFromId;
  }
  return null;
}

function aggregateQuoteLinkedLabor(jobs: NormalizedJobSnapshot[]): QuoteLinkedLaborMetric {
  let quoteLinkedJobs = 0;
  let coveredJobs = 0;
  let actualOnlyJobs = 0;
  let estimatedHours = 0;
  let actualHours = 0;
  const perJob: QuoteLinkedLaborMetric["perJob"] = [];
  for (const job of jobs) {
    if (quoteConversionIdFor(job) === null) continue;
    quoteLinkedJobs += 1;
    const estimate = supportedNumber(job.laborHoursEstimate);
    const actual = supportedNumber(job.laborHoursActual);
    if (estimate !== null && estimate > 0 && actual !== null && actual > 0) {
      coveredJobs += 1;
      estimatedHours += estimate;
      actualHours += actual;
      perJob.push({
        jobId: String(job.jobId),
        jobNo: display(job.jobNo, `Job ${job.jobId}`),
        name: plainDisplayText(job.name, `Job ${job.jobId}`),
        siteName: display(job.siteName, "Unclassified"),
        estimatedHours: estimate,
        actualHours: actual,
        varianceHours: actual - estimate,
      });
    } else if (actual !== null && actual > 0) {
      actualOnlyJobs += 1;
    }
  }
  perJob.sort((left, right) => right.varianceHours - left.varianceHours || left.jobId.localeCompare(right.jobId));
  return {
    definition: QUOTE_LINKED_LABOR_DEFINITION,
    quoteLinkedJobs,
    coveredJobs,
    actualOnlyJobs,
    estimatedHours,
    actualHours,
    efficiencyRatio: actualHours > 0 ? estimatedHours / actualHours : null,
    overrunPercent: estimatedHours > 0 ? percent(actualHours - estimatedHours, estimatedHours) : null,
    perJob,
  };
}

const FOLLOW_UP_WINDOW_DAYS = 30;

function aggregateDirectServiceFollowUps(
  jobs: NormalizedJobSnapshot[],
  issuedQuotes: IssuedQuoteInput[] | undefined,
): DirectServiceFollowUps {
  const quoteEvidenceLoaded = issuedQuotes !== undefined;
  const quotesBySite = new Map<string, IssuedQuoteInput[]>();
  for (const quote of issuedQuotes ?? []) {
    if (quote.sourceDeletedAt || !quote.dateIssued) continue;
    const key = siteKeyFor(quote.siteId, quote.siteName);
    if (!key) continue;
    quotesBySite.set(key, [...(quotesBySite.get(key) ?? []), quote]);
  }
  let directServiceJobs = 0;
  let jobsWithSameDayQuote = 0;
  let jobsWithQuoteWithin30Days = 0;
  const links: DirectServiceFollowUps["links"] = [];
  for (const job of jobs) {
    if (jobSourceTypeFor(job) !== "Direct service") continue;
    directServiceJobs += 1;
    const key = siteKeyFor(job.siteId, job.siteName);
    if (!key || !job.completedDate) continue;
    const candidates = (quotesBySite.get(key) ?? [])
      .map((quote) => ({ quote, days: daysBetween(job.completedDate!, quote.dateIssued) }))
      .filter((entry) => entry.days !== null && entry.days >= 0 && entry.days <= FOLLOW_UP_WINDOW_DAYS)
      .sort((left, right) => left.days! - right.days! || String(left.quote.quoteId).localeCompare(String(right.quote.quoteId)));
    if (candidates.length === 0) continue;
    jobsWithQuoteWithin30Days += 1;
    if (candidates[0].days === 0) jobsWithSameDayQuote += 1;
    const earliest = candidates[0];
    links.push({
      jobId: String(job.jobId),
      quoteId: String(earliest.quote.quoteId),
      dateIssued: earliest.quote.dateIssued,
      daysAfterCompletion: earliest.days!,
      sameDay: earliest.days === 0,
      quoteValue: supportedNumber(earliest.quote.totalValue),
    });
  }
  links.sort((left, right) => left.jobId.localeCompare(right.jobId));
  return {
    linkRule: FOLLOW_UP_LINK_RULE,
    sameDayRule: FOLLOW_UP_SAME_DAY_RULE,
    quoteEvidenceLoaded,
    directServiceJobs,
    jobsWithSameDayQuote,
    jobsWithQuoteWithin30Days,
    links,
  };
}

function siteKeyFor(siteId: string | number | null | undefined, siteName: string | null | undefined): string | null {
  if (siteId !== null && siteId !== undefined && String(siteId).trim() !== "") return `id:${String(siteId).trim()}`;
  const name = siteName?.trim();
  return name ? `name:${name.toLowerCase()}` : null;
}

function daysBetween(fromDate: string, toDate: string): number | null {
  const from = Date.parse(`${fromDate.slice(0, 10)}T00:00:00Z`);
  const to = Date.parse(`${toDate.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.round((to - from) / 86_400_000);
}

function aggregateMaterialCoverage(jobs: NormalizedJobSnapshot[]): JobMonthlyReadModel["materialCoverage"] {
  let nestedItemsComplete = 0;
  let coverageOnly = 0;
  let unknown = 0;
  for (const job of jobs) {
    const basis = (job.materialCoverage ?? "").trim().toLowerCase();
    if (basis.includes("nested") && basis.includes("complete")) nestedItemsComplete += 1;
    else if (basis.includes("coverage")) coverageOnly += 1;
    else unknown += 1;
  }
  return { totalJobs: jobs.length, nestedItemsComplete, coverageOnly, unknown };
}

function aggregateFieldCoverage(jobs: NormalizedJobSnapshot[]): Record<JobAnalyticsField, FieldCoverage> {
  const result = {} as Record<JobAnalyticsField, FieldCoverage>;
  for (const field of JOB_ANALYTICS_FIELDS) {
    if (field === "configuredCostCenterName") {
      const costCenters = jobs.flatMap(activeCostCenters);
      const supported = costCenters.filter((row) => Boolean(row.configuredCostCenterName?.trim())).length;
      result[field] = { total: costCenters.length, supported, missing: costCenters.length - supported };
      continue;
    }
    const supported = jobs.filter((job) => jobFieldIsSupported(job, field)).length;
    result[field] = { total: jobs.length, supported, missing: jobs.length - supported };
  }
  return result;
}

function jobFieldIsSupported(job: NormalizedJobSnapshot, field: Exclude<JobAnalyticsField, "configuredCostCenterName">) {
  const value = job[field];
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.trim().length > 0;
  return value !== null && value !== undefined;
}

function buildComparisons(current: JobMonthlyReadModel, previous: JobMonthlyReadModel, priorYear: JobMonthlyReadModel, priorYearFull: JobMonthlyReadModel): JobMetricsDashboardReadModel["comparisons"] {
  const rows: Array<[JobMetricsDashboardReadModel["comparisons"][number]["key"], string, "count" | "currency" | "percent", number | null, number | null, number | null, number | null]> = [
    ["completedJobs", "Completed jobs", "count", current.completedJobCount, previous.completedJobCount, priorYear.completedJobCount, priorYearFull.completedJobCount],
    ["sellValue", "Sell value", "currency", current.totalSellValue, previous.totalSellValue, priorYear.totalSellValue, priorYearFull.totalSellValue],
    ["averageJobValue", "Average job value", "currency", current.averageJobValue, previous.averageJobValue, priorYear.averageJobValue, priorYearFull.averageJobValue],
    ["grossProfit", "Gross profit", "currency", current.grossProfitActual, previous.grossProfitActual, priorYear.grossProfitActual, priorYearFull.grossProfitActual],
    ["grossMargin", "Gross margin", "percent", current.grossMarginActual, previous.grossMarginActual, priorYear.grossMarginActual, priorYearFull.grossMarginActual],
    ["netProfit", "Simpro job net profit", "currency", current.netProfitActual, previous.netProfitActual, priorYear.netProfitActual, priorYearFull.netProfitActual],
    ["netMargin", "Simpro job net margin", "percent", current.netMarginActual, previous.netMarginActual, priorYear.netMarginActual, priorYearFull.netMarginActual],
    ["laborVariance", "Labor hours variance", "percent", current.labor.variancePercent, previous.labor.variancePercent, priorYear.labor.variancePercent, priorYearFull.labor.variancePercent],
  ];
  return rows.map(([key, label, format, value, priorMonth, year, yearFull]) => ({
    key,
    label,
    format,
    current: value,
    priorMonth,
    priorYear: year,
    priorYearFull: yearFull,
    priorMonthDelta: changePercent(value, priorMonth),
    priorYearDelta: changePercent(value, year),
  }));
}

/**
 * The served trend window is the later of the history start and the earlier of
 * Jan 2025 and the trailing-18 start, so it always covers Jan 2025 through the
 * selected month once history reaches that far.
 */
function trendWindowStart(selectedMonth: string, historyStart: string): string {
  const trailing18Start = shiftMonth(selectedMonth, -17);
  const fixedStart = "2025-01";
  const start = trailing18Start < fixedStart ? trailing18Start : fixedStart;
  return start < historyStart ? historyStart : start;
}

function trendProvenance(reconciliation: JobReconciliationInput | undefined): "verified" | "representative" {
  return reconciliation?.status === "matched" ? "verified" : "representative";
}

function aggregateTrailing(months: JobMonthlyReadModel[]): JobMetricsDashboardReadModel["trailing"] {
  const completedJobs = months.reduce((sum, row) => sum + row.completedJobCount, 0);
  const sellValue = months.reduce((sum, row) => sum + row.totalSellValue, 0);
  const grossProfit = months.reduce((sum, row) => sum + row.grossProfitActual, 0);
  const netProfit = months.reduce((sum, row) => sum + row.netProfitActual, 0);
  const coveredSell = months.reduce((sum, row) => sum + row.financialCoverage.grossMarginCoveredSellValue, 0);
  const coveredProfit = months.reduce((sum, row) => sum + row.financialCoverage.grossMarginCoveredProfit, 0);
  const netCoveredSell = months.reduce((sum, row) => sum + row.financialCoverage.netMarginCoveredSellValue, 0);
  const netCoveredProfit = months.reduce((sum, row) => sum + row.financialCoverage.netMarginCoveredProfit, 0);
  const quotedHours = months.reduce((sum, row) => sum + row.labor.quotedHours, 0);
  const actualHours = months.reduce((sum, row) => sum + row.labor.actualHours, 0);
  return {
    completedJobs,
    sellValue,
    grossProfit,
    grossMargin: grossMarginPercent(coveredSell, coveredProfit),
    netProfit,
    netMargin: grossMarginPercent(netCoveredSell, netCoveredProfit),
    quotedHours,
    actualHours,
    laborVariancePercent: quotedHours > 0 ? percent(actualHours - quotedHours, quotedHours) : null,
  };
}

function buildFilterOptions(jobs: NormalizedJobSnapshot[]) {
  const categories = new Set<string>();
  const costCenters = new Set<string>();
  const technicians = new Set<string>();
  for (const job of jobs) {
    for (const row of activeCostCenters(job)) {
      categories.add(normalizedCategory(row.category));
      costCenters.add(configuredCostCenterLabel(row));
    }
    if (activeCostCenters(job).length === 0) categories.add(normalizedCategory(job.category));
    for (const row of activeTimesheets(job)) {
      if (row.technicianName) technicians.add(row.technicianName);
    }
  }
  return {
    categories: [...categories].sort(),
    costCenters: [...costCenters].sort(),
    technicians: [...technicians].sort(),
  };
}

function buildDashboardWarnings(selected: JobMonthlyReadModel, months: string[], reconciliations: Map<string, JobReconciliationInput>) {
  const warnings: string[] = [];
  if (selected.completedJobCount === 0) warnings.push("No jobs meet the CompletedDate plus Complete/Archived Stage contract for this selection.");
  if (selected.financialCoverage.sellValueMissing > 0) warnings.push(`${selected.financialCoverage.sellValueMissing} completed jobs are missing supported sell value.`);
  if (selected.financialCoverage.grossProfitMissing > 0) warnings.push(`${selected.financialCoverage.grossProfitMissing} completed jobs are excluded from gross-margin coverage.`);
  if (selected.financialCoverage.netProfitMissing > 0) warnings.push(`${selected.financialCoverage.netProfitMissing} completed jobs are excluded from Simpro job net-profit coverage.`);
  if (selected.financialCoverage.costTotalsSupported < selected.completedJobCount) warnings.push(`${selected.completedJobCount - selected.financialCoverage.costTotalsSupported} completed jobs are missing authoritative Simpro job cost totals.`);
  if (selected.labor.eligibleQuoteSourcedJobs > selected.labor.includedJobs) warnings.push(`${selected.labor.eligibleQuoteSourcedJobs - selected.labor.includedJobs} quote-sourced jobs are excluded from labor variance by disclosed coverage reasons.`);
  const missingReconciliation = months.filter((month) => !reconciliations.has(month)).length;
  if (missingReconciliation > 0) warnings.push(`${missingReconciliation} history months do not have a recorded job reconciliation run.`);
  return warnings;
}

function matchesFilters(job: NormalizedJobSnapshot, filters: Required<JobFilters>) {
  const costCenters = activeCostCenters(job);
  if (filters.category && !costCenters.some((row) => normalizedCategory(row.category) === filters.category) && normalizedCategory(job.category) !== filters.category) return false;
  if (filters.costCenter && !costCenters.some((row) => configuredCostCenterLabel(row) === filters.costCenter)) return false;
  if (filters.technician && !activeTimesheets(job).some((row) => row.technicianName === filters.technician)) return false;
  return true;
}

function normalizeFilters(filters: JobFilters | undefined): Required<JobFilters> {
  return {
    category: cleanFilter(filters?.category),
    costCenter: cleanFilter(filters?.costCenter),
    technician: cleanFilter(filters?.technician),
  };
}

function cleanFilter(value: string | null | undefined) {
  const cleaned = value?.trim() ?? "";
  return cleaned && cleaned.toLowerCase() !== "all" ? cleaned : null;
}

function isQuoteSourced(job: NormalizedJobSnapshot) {
  return linkedQuoteIdFor(job) !== null;
}

function linkedQuoteIdFor(job: NormalizedJobSnapshot) {
  if (job.sourceQuoteId !== null && job.sourceQuoteId !== undefined) return job.sourceQuoteId;
  if ((job.convertedFromType ?? "").trim().toLowerCase() === "quote" && job.convertedFromId !== null && job.convertedFromId !== undefined) return job.convertedFromId;
  return null;
}

function estimatedLaborHoursFor(job: NormalizedJobSnapshot) {
  const sourceType = jobSourceTypeFor(job);
  if (sourceType === "Quote-generated") {
    const facts = nestedQuoteLaborFacts(job);
    return linkedQuoteIdFor(job) !== null && facts.covered ? facts.hours : null;
  }
  if (sourceType === "Recurring") return supportedNumber(job.laborHoursEstimate);
  return null;
}

function actualLaborHoursFor(job: NormalizedJobSnapshot) {
  const facts = allJobTimesheetFacts(job);
  return facts.covered ? facts.hours : null;
}

function nestedQuoteLaborFacts(job: NormalizedJobSnapshot): {
  covered: boolean;
  hours: number | null;
  reason: Extract<JobLaborExclusionReason, "missing active nested quote labor" | "invalid nested quote labor hours"> | null;
} {
  const rows = activeQuoteLabor(job);
  if (rows.length === 0) return { covered: false, hours: null, reason: "missing active nested quote labor" };
  const hours = rows.map((row) => supportedNumber(row.quotedHours));
  if (hours.some((value) => value === null || value < 0)) return { covered: false, hours: null, reason: "invalid nested quote labor hours" };
  return { covered: true, hours: (hours as number[]).reduce((sum, value) => sum + value, 0), reason: null };
}

function allJobTimesheetFacts(job: NormalizedJobSnapshot): {
  covered: boolean;
  hours: number | null;
  reason: Extract<JobLaborExclusionReason, "missing active job timesheets" | "invalid job timesheet hours"> | null;
} {
  const rows = activeTimesheets(job);
  if (rows.length === 0) return { covered: false, hours: null, reason: "missing active job timesheets" };
  const hours = rows.map((row) => supportedNumber(row.actualHours));
  if (hours.some((value) => value === null || value < 0)) return { covered: false, hours: null, reason: "invalid job timesheet hours" };
  return { covered: true, hours: (hours as number[]).reduce((sum, value) => sum + value, 0), reason: null };
}

function activeCostCenters(job: NormalizedJobSnapshot) {
  return (job.costCenters ?? []).filter((row) => !row.sourceDeletedAt);
}

function activeTimesheets(job: NormalizedJobSnapshot) {
  return (job.timesheets ?? []).filter((row) => !row.sourceDeletedAt);
}

function activeQuoteLabor(job: NormalizedJobSnapshot) {
  return (job.quoteLabor ?? []).filter((row) => !row.sourceDeletedAt);
}

function excludedLabor(coverageReason: string): LaborAccuracyResult {
  return { included: false, coverageReason, varianceHours: null, variancePercent: null };
}

function supportedNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizedCategory(value: string | null | undefined) {
  return display(value, "Unclassified");
}

function configuredCostCenterLabel(row: JobCostCenterInput) {
  return display(row.configuredCostCenterName, "Unclassified");
}

function display(value: string | null | undefined, fallback: string) {
  const cleaned = value?.trim();
  return cleaned || fallback;
}

function percent(numerator: number, denominator: number) {
  return denominator !== 0 ? numerator / denominator * 100 : null;
}

function changePercent(current: number | null, prior: number | null) {
  if (current === null || prior === null || prior === 0) return null;
  return percent(current - prior, Math.abs(prior));
}

function isDateInRange(value: string, start: string, end: string): boolean {
  return value >= start && value <= end;
}

function validMonth(value: string | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}$/.test(value)) return false;
  const month = Number(value.slice(5));
  return month >= 1 && month <= 12;
}

function monthRange(month: string) {
  return { periodStart: `${month}-01`, periodEnd: `${month}-${pad(daysInMonth(month))}` };
}

function daysInMonth(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
}

function shiftMonth(month: string, offset: number) {
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, monthNumber - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}`;
}

function monthKeys(start: string, end: string) {
  const result: string[] = [];
  let cursor = start;
  while (cursor <= end && result.length < 120) {
    result.push(cursor);
    cursor = shiftMonth(cursor, 1);
  }
  return result;
}

function monthLabel(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year, monthNumber - 1, 1)));
}

function losAngelesDateParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(date);
  const value = (type: "year" | "month" | "day") => Number(parts.find((part) => part.type === type)?.value);
  return { year: value("year"), month: value("month"), day: value("day") };
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}
