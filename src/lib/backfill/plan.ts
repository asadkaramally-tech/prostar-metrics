export const BACKFILL_START_MONTH = "2023-01-01";
export const BACKFILL_REQUEST_SLICE_LIMIT = 250;
export const BACKFILL_REQUESTS_PER_SECOND = 1;
export const BACKFILL_SAFE_PAGE_SIZE = 20;
export const BACKFILL_DETAIL_PAGE_REQUEST_FLOOR = BACKFILL_SAFE_PAGE_SIZE + 1;

export type BackfillSourceFamily =
  | "quotes"
  | "quote_nested"
  | "jobs"
  | "job_nested"
  | "employees"
  | "timesheets"
  | "jobs_from_timesheets"
  | "schedules"
  | "mobile_status";

export type BackfillReconciliationStatus = "pending" | "matched" | "mismatch" | "partial" | "unavailable";

export type BackfillEstimate = {
  expectedPages: number;
  expectedRecords: number;
  estimatedNestedRequests: number;
};

export type BackfillEstimateMap = Record<string, BackfillEstimate>;

export type BackfillWorkUnitPlan = BackfillEstimate & {
  sourceFamily: BackfillSourceFamily;
  monthStart: string;
  monthEndExclusive: string;
  executionMode: "ingest" | "coverage_only";
  requiredForCompletion: boolean;
  dependsOn: BackfillSourceFamily[];
  estimatedRequests: number;
  dailyRequestCeiling: number;
  queuePriority: number;
  requestSliceLimit: number;
  idempotencyKey: string;
};

type SourceDefinition = {
  sourceFamily: BackfillSourceFamily;
  executionMode: BackfillWorkUnitPlan["executionMode"];
  requiredForCompletion: boolean;
  dependsOn: BackfillSourceFamily[];
  queuePriority: number;
  detailRequestPerRecord: boolean;
};

export const BACKFILL_SOURCE_DEFINITIONS: readonly SourceDefinition[] = [
  { sourceFamily: "quotes", executionMode: "ingest", requiredForCompletion: true, dependsOn: [], queuePriority: 200, detailRequestPerRecord: true },
  { sourceFamily: "jobs", executionMode: "ingest", requiredForCompletion: true, dependsOn: [], queuePriority: 205, detailRequestPerRecord: true },
  { sourceFamily: "employees", executionMode: "ingest", requiredForCompletion: true, dependsOn: [], queuePriority: 210, detailRequestPerRecord: true },
  { sourceFamily: "quote_nested", executionMode: "ingest", requiredForCompletion: true, dependsOn: ["quotes"], queuePriority: 220, detailRequestPerRecord: false },
  { sourceFamily: "job_nested", executionMode: "ingest", requiredForCompletion: true, dependsOn: ["jobs"], queuePriority: 225, detailRequestPerRecord: false },
  { sourceFamily: "timesheets", executionMode: "ingest", requiredForCompletion: true, dependsOn: ["employees"], queuePriority: 230, detailRequestPerRecord: false },
  { sourceFamily: "jobs_from_timesheets", executionMode: "ingest", requiredForCompletion: true, dependsOn: ["timesheets", "jobs"], queuePriority: 235, detailRequestPerRecord: true },
  { sourceFamily: "schedules", executionMode: "ingest", requiredForCompletion: true, dependsOn: ["jobs"], queuePriority: 240, detailRequestPerRecord: true },
  { sourceFamily: "mobile_status", executionMode: "coverage_only", requiredForCompletion: false, dependsOn: ["jobs"], queuePriority: 290, detailRequestPerRecord: false },
] as const;

export function buildBackfillPlan(params: {
  startMonth?: string;
  throughMonth: string;
  dailyRequestCeiling: number;
  estimates: BackfillEstimateMap;
}): BackfillWorkUnitPlan[] {
  const startMonth = normalizeMonthStart(params.startMonth ?? BACKFILL_START_MONTH);
  const throughMonth = normalizeMonthStart(params.throughMonth);
  if (startMonth > throughMonth) {
    throw new Error("Backfill start month must not be after the through month.");
  }
  if (!Number.isInteger(params.dailyRequestCeiling) || params.dailyRequestCeiling < 100) {
    throw new Error("dailyRequestCeiling must be an integer of at least 100 requests.");
  }

  const units: BackfillWorkUnitPlan[] = [];
  const currentMonth = businessCurrentMonth();
  for (const monthStart of monthStarts(startMonth, throughMonth)) {
    const monthEndExclusive = addUtcMonths(monthStart, 1);
    for (const definition of BACKFILL_SOURCE_DEFINITIONS) {
      const estimateKey = backfillEstimateKey(monthStart, definition.sourceFamily);
      const estimate = params.estimates[estimateKey];
      if (!estimate) {
        throw new Error(`Missing approved capacity estimate ${estimateKey}.`);
      }
      validateEstimate(estimateKey, estimate);
      const estimatedRequests = estimate.expectedPages
        + estimate.estimatedNestedRequests
        + (definition.detailRequestPerRecord ? estimate.expectedRecords : 0)
        + (definition.sourceFamily === "quotes" && monthStart === currentMonth
          ? estimate.expectedPages + estimate.expectedRecords
          : 0);
      units.push({
        ...estimate,
        sourceFamily: definition.sourceFamily,
        monthStart,
        monthEndExclusive,
        executionMode: definition.executionMode,
        requiredForCompletion: definition.requiredForCompletion,
        dependsOn: [...definition.dependsOn],
        estimatedRequests,
        dailyRequestCeiling: params.dailyRequestCeiling,
        queuePriority: definition.queuePriority,
        requestSliceLimit: BACKFILL_REQUEST_SLICE_LIMIT,
        idempotencyKey: `wp04:${definition.sourceFamily}:${monthStart.slice(0, 7)}`,
      });
    }
  }
  return units;
}

export function buildEstimateTemplate(startMonth: string, throughMonth: string): Record<string, null> {
  const start = normalizeMonthStart(startMonth);
  const through = normalizeMonthStart(throughMonth);
  if (start > through) throw new Error("Backfill start month must not be after the through month.");
  return Object.fromEntries(
    monthStarts(start, through).flatMap((monthStart) =>
      BACKFILL_SOURCE_DEFINITIONS.map((definition) => [backfillEstimateKey(monthStart, definition.sourceFamily), null]),
    ),
  );
}

export function parseBackfillEstimates(value: unknown): BackfillEstimateMap {
  if (!isRecord(value)) throw new Error("Backfill estimates must be a JSON object.");
  const estimates: BackfillEstimateMap = {};
  for (const [key, estimate] of Object.entries(value)) {
    if (!isRecord(estimate)) throw new Error(`Capacity estimate ${key} must be an object.`);
    const parsed = {
      expectedPages: Number(estimate.expectedPages),
      expectedRecords: Number(estimate.expectedRecords),
      estimatedNestedRequests: Number(estimate.estimatedNestedRequests),
    };
    validateEstimate(key, parsed);
    estimates[key] = parsed;
  }
  return estimates;
}

export function capacityAllocation(dailyRequestCeiling: number) {
  if (!Number.isInteger(dailyRequestCeiling) || dailyRequestCeiling <= 0) {
    throw new Error("Daily request ceiling must be a positive integer.");
  }
  const current = Math.ceil(dailyRequestCeiling * 0.60);
  const reconciliation = Math.ceil(dailyRequestCeiling * 0.15);
  const backfill = Math.max(0, dailyRequestCeiling - current - reconciliation);
  return { current, reconciliation, backfill };
}

export function backfillSliceBudget(params: {
  dailyRequestCeiling: number;
  currentRequests?: number;
  reconciliationRequests?: number;
  backfillRequests: number;
  backfillReservedRequests: number;
  requested: number;
}) {
  const allocation = capacityAllocation(params.dailyRequestCeiling);
  const backfillAvailable = allocation.backfill - params.backfillRequests - params.backfillReservedRequests;
  const totalAvailable = params.dailyRequestCeiling
    - (params.currentRequests ?? 0)
    - (params.reconciliationRequests ?? 0)
    - params.backfillRequests
    - params.backfillReservedRequests;
  const available = Math.max(0, Math.min(backfillAvailable, totalAvailable));
  return Math.min(BACKFILL_REQUEST_SLICE_LIMIT, Math.max(0, Math.trunc(params.requested)), available);
}

export function retryDecision(retryCount: number, maxAttempts: number) {
  const nextRetryCount = Math.max(0, Math.trunc(retryCount)) + 1;
  const deadLettered = nextRetryCount >= Math.max(1, Math.min(5, Math.trunc(maxAttempts)));
  return {
    nextRetryCount,
    deadLettered,
    retryDelayMinutes: Math.min(60, 2 ** nextRetryCount),
  };
}

export function canCompleteAfterReconciliation(
  requiredForCompletion: boolean,
  status: BackfillReconciliationStatus,
) {
  return status === "matched" || (!requiredForCompletion && (status === "partial" || status === "unavailable"));
}

export function shouldYieldToCurrentQueue(params: {
  sourceFamily: string;
  oldestAgeMinutes: number;
}) {
  const threshold = currentQueueYieldThresholdMinutes(params.sourceFamily);
  return params.oldestAgeMinutes >= threshold;
}

export function currentQueueYieldThresholdMinutes(sourceFamily: string) {
  if (sourceFamily === "mobile_status" || sourceFamily.endsWith("_logs")) return 20;
  if (sourceFamily === "quotes" || sourceFamily.startsWith("quote_")) return 45;
  return 90;
}

export function businessCurrentMonth(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (!year || !month) throw new Error("Unable to determine the current business month.");
  return `${year}-${month}-01`;
}

export function backfillEstimateKey(monthStart: string, sourceFamily: BackfillSourceFamily) {
  return `${normalizeMonthStart(monthStart).slice(0, 7)}:${sourceFamily}`;
}

export function monthEndInclusive(monthEndExclusive: string) {
  const end = parseMonthDate(monthEndExclusive);
  end.setUTCDate(end.getUTCDate() - 1);
  return end.toISOString().slice(0, 10);
}

function monthStarts(startMonth: string, throughMonth: string) {
  const months: string[] = [];
  for (let month = startMonth; month <= throughMonth; month = addUtcMonths(month, 1)) months.push(month);
  return months;
}

function addUtcMonths(monthStart: string, count: number) {
  const date = parseMonthDate(monthStart);
  date.setUTCMonth(date.getUTCMonth() + count);
  return date.toISOString().slice(0, 10);
}

function normalizeMonthStart(value: string) {
  if (!/^\d{4}-\d{2}-01$/.test(value)) throw new Error(`Invalid month start ${value}; expected YYYY-MM-01.`);
  const date = parseMonthDate(value);
  const normalized = date.toISOString().slice(0, 10);
  if (normalized !== value) throw new Error(`Invalid month start ${value}.`);
  return normalized;
}

function parseMonthDate(value: string) {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date ${value}.`);
  return date;
}

function validateEstimate(key: string, estimate: BackfillEstimate) {
  for (const [name, value] of Object.entries(estimate)) {
    if (!Number.isInteger(value) || value < 0) throw new Error(`${key}.${name} must be a non-negative integer.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
