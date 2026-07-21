import type { FreshnessStatus } from "@/lib/metrics/freshness";

/**
 * Materials dashboard aggregation (brief §4.5, owner rulings 2026-07-19):
 * - Value basis is extended sell ex-tax on jobs completed in the month.
 * - EXCLUDE Service Fee lines (never ingested) AND every line in the
 *   "Service Contract" catalog group (service billing, not materials).
 * - MERGE the "Raypak Cheat Sheet" group into "Raypak Parts".
 * - One-off material lines are labeled "Special order / non-stock".
 * - Prebuilds are their own category ("Prebuild assemblies").
 */

export type MaterialLineType = "catalog" | "one_off" | "prebuild";

export type MaterialLineInput = {
  jobId: number;
  /** Simpro CompletedDate of the parent job (YYYY-MM-DD, business-local). */
  completedDate: string;
  lineType: MaterialLineType;
  catalogId: number | null;
  prebuildId: number | null;
  name: string | null;
  partNo: string | null;
  qty: number;
  extendedExTax: number;
  groupName: string | null;
  parentGroupName: string | null;
};

export type MaterialsCategorySlice = {
  name: string;
  value: number;
  qty: number;
  lines: number;
};

export type MaterialsItemRow = {
  key: string;
  name: string;
  partNo: string | null;
  category: string;
  qty: number;
  /** Null when the prior month has not been authoritatively walked. */
  priorMonthQty: number | null;
  unitSell: number | null;
  extended: number;
  jobCount: number;
  jobIds: number[];
};

export type MaterialsTotals = {
  current: number;
  priorMonth: number;
  priorYearSameDay: number;
  paceProjection: number;
  elapsedDays: number;
  daysInMonth: number;
};

export type MaterialsMonthCoverage = {
  periodStart: string;
  status: "complete" | "failed" | "missing";
  walkedAt: string | null;
  jobCount: number;
  lineCount: number;
};

export type MaterialsReadModel = {
  periodStart: string;
  generatedAt: string;
  totals: MaterialsTotals;
  categories: MaterialsCategorySlice[];
  items: MaterialsItemRow[];
  freshness: FreshnessStatus;
  coverage: {
    selectedMonth: MaterialsMonthCoverage;
    priorMonth: MaterialsMonthCoverage;
    priorYearMonth: MaterialsMonthCoverage;
    includedLineCount: number;
    excludedServiceContractLineCount: number;
  };
  warnings: string[];
};

export const SPECIAL_ORDER_CATEGORY = "Special order / non-stock";
export const PREBUILD_CATEGORY = "Prebuild assemblies";
export const UNGROUPED_CATEGORY = "Ungrouped";
const SERVICE_CONTRACT_GROUP = "service contract";
const RAYPAK_CHEAT_SHEET = "raypak cheat sheet";
const RAYPAK_PARTS_CATEGORY = "Raypak Parts";

export type BuildMaterialsReadModelParams = {
  periodStart: string;
  /** Lines whose parent job completed in the selected month. */
  selectedLines: MaterialLineInput[];
  /** Lines whose parent job completed in the calendar month before. */
  priorMonthLines: MaterialLineInput[];
  /** Lines whose parent job completed in the same month one year earlier. */
  priorYearLines: MaterialLineInput[];
  coverage: {
    selectedMonth: MaterialsMonthCoverage;
    priorMonth: MaterialsMonthCoverage;
    priorYearMonth: MaterialsMonthCoverage;
  };
  freshness: FreshnessStatus;
  now?: Date;
};

export function buildMaterialsReadModel(params: BuildMaterialsReadModelParams): MaterialsReadModel {
  const periodStart = normalizePeriodStart(params.periodStart);
  const now = params.now ?? new Date();
  const today = losAngelesDate(now);
  const daysInMonth = daysInPeriodMonth(periodStart);
  const isCurrentMonthPartial = periodStart.slice(0, 7) === monthKey(today);
  const elapsedDays = isCurrentMonthPartial ? Math.min(today.getUTCDate(), daysInMonth) : daysInMonth;

  const selected = params.selectedLines.filter(isMaterialLine);
  const priorMonth = params.priorMonthLines.filter(isMaterialLine);
  const priorYearSameDay = params.priorYearLines
    .filter(isMaterialLine)
    .filter((line) => completedDayOfMonth(line) <= elapsedDays);

  const currentTotal = roundMoney(sum(selected.map((line) => line.extendedExTax)));
  const priorMonthTotal = roundMoney(sum(priorMonth.map((line) => line.extendedExTax)));
  const priorYearSameDayTotal = roundMoney(sum(priorYearSameDay.map((line) => line.extendedExTax)));
  const paceProjection = isCurrentMonthPartial && elapsedDays > 0
    ? roundMoney(currentTotal / elapsedDays * daysInMonth)
    : currentTotal;

  const excludedServiceContractLineCount = params.selectedLines
    .filter((line) => !isMaterialLine(line)).length;

  const warnings: string[] = [];
  if (params.coverage.selectedMonth.status !== "complete") {
    warnings.push(`The ${periodStart.slice(0, 7)} materials walk is ${params.coverage.selectedMonth.status}; totals reflect the last complete data.`);
  }
  if (params.coverage.priorMonth.status !== "complete") {
    warnings.push(
      `The prior-month materials walk is ${params.coverage.priorMonth.status}; item quantities and changes are unavailable.`,
    );
  }
  if (params.coverage.priorYearMonth.status !== "complete") {
    warnings.push(
      `The prior-year materials walk is ${params.coverage.priorYearMonth.status}; the year-over-year comparison is unavailable.`,
    );
  }

  return {
    periodStart,
    generatedAt: now.toISOString(),
    totals: {
      current: currentTotal,
      priorMonth: priorMonthTotal,
      priorYearSameDay: priorYearSameDayTotal,
      paceProjection,
      elapsedDays,
      daysInMonth,
    },
    categories: buildCategories(selected),
    items: buildItems(selected, priorMonth, params.coverage.priorMonth.status === "complete"),
    freshness: params.freshness,
    coverage: {
      selectedMonth: params.coverage.selectedMonth,
      priorMonth: params.coverage.priorMonth,
      priorYearMonth: params.coverage.priorYearMonth,
      includedLineCount: selected.length,
      excludedServiceContractLineCount,
    },
    warnings,
  };
}

/**
 * Owner exclusion rule: every line in the "Service Contract" catalog group is
 * service billing, not materials. Service Fee lines are excluded upstream (the
 * walker never fetches the serviceFees collection).
 */
export function isMaterialLine(line: MaterialLineInput): boolean {
  if (line.lineType !== "catalog") return true;
  return normalized(line.parentGroupName) !== SERVICE_CONTRACT_GROUP
    && normalized(line.groupName) !== SERVICE_CONTRACT_GROUP;
}

export function materialLineCategory(line: MaterialLineInput): string {
  if (line.lineType === "one_off") return SPECIAL_ORDER_CATEGORY;
  if (line.lineType === "prebuild") return PREBUILD_CATEGORY;
  const category = cleanText(line.parentGroupName) ?? cleanText(line.groupName) ?? UNGROUPED_CATEGORY;
  return normalized(category) === RAYPAK_CHEAT_SHEET ? RAYPAK_PARTS_CATEGORY : category;
}

export function materialItemKey(line: MaterialLineInput): string {
  if (line.lineType === "catalog" && line.catalogId !== null) return `catalog:${line.catalogId}`;
  if (line.lineType === "prebuild" && line.prebuildId !== null) return `prebuild:${line.prebuildId}`;
  const name = normalized(line.name) || "unnamed";
  return `${line.lineType === "prebuild" ? "prebuild" : "one-off"}:${name}`;
}

function buildCategories(lines: MaterialLineInput[]): MaterialsCategorySlice[] {
  const byCategory = new Map<string, MaterialsCategorySlice>();
  for (const line of lines) {
    const name = materialLineCategory(line);
    const slice = byCategory.get(name) ?? { name, value: 0, qty: 0, lines: 0 };
    slice.value += line.extendedExTax;
    slice.qty += line.qty;
    slice.lines += 1;
    byCategory.set(name, slice);
  }
  return [...byCategory.values()]
    .map((slice) => ({ ...slice, value: roundMoney(slice.value), qty: roundQty(slice.qty) }))
    .sort((left, right) => right.value - left.value || left.name.localeCompare(right.name));
}

function buildItems(
  lines: MaterialLineInput[],
  priorMonthLines: MaterialLineInput[],
  priorMonthComplete: boolean,
): MaterialsItemRow[] {
  const priorQtyByKey = new Map<string, number>();
  for (const line of priorMonthLines) {
    const key = materialItemKey(line);
    priorQtyByKey.set(key, (priorQtyByKey.get(key) ?? 0) + line.qty);
  }

  type ItemAccumulator = Omit<MaterialsItemRow, "jobCount" | "jobIds" | "unitSell"> & { jobIds: Set<number> };
  const byKey = new Map<string, ItemAccumulator>();
  for (const line of lines) {
    const key = materialItemKey(line);
    const item = byKey.get(key) ?? {
      key,
      name: cleanText(line.name) ?? "Unnamed material",
      partNo: cleanText(line.partNo),
      category: materialLineCategory(line),
      qty: 0,
      priorMonthQty: priorMonthComplete ? roundQty(priorQtyByKey.get(key) ?? 0) : null,
      extended: 0,
      jobIds: new Set<number>(),
    };
    item.qty += line.qty;
    item.extended += line.extendedExTax;
    item.jobIds.add(line.jobId);
    if (item.partNo === null) item.partNo = cleanText(line.partNo);
    byKey.set(key, item);
  }

  return [...byKey.values()]
    .map((item) => {
      const qty = roundQty(item.qty);
      const extended = roundMoney(item.extended);
      const jobIds = [...item.jobIds].sort((left, right) => left - right);
      return {
        key: item.key,
        name: item.name,
        partNo: item.partNo,
        category: item.category,
        qty,
        priorMonthQty: item.priorMonthQty,
        unitSell: qty > 0 ? roundMoney(extended / qty) : null,
        extended,
        jobCount: jobIds.length,
        jobIds,
      };
    })
    .sort((left, right) => right.extended - left.extended || left.key.localeCompare(right.key));
}

export function normalizeMaterialsPeriodStart(value: string | undefined, now = new Date()): string {
  if (value && /^\d{4}-(0[1-9]|1[0-2])-01$/.test(value)) return value;
  return `${monthKey(losAngelesDate(now))}-01`;
}

export function addMonthsToPeriodStart(periodStart: string, amount: number): string {
  const date = new Date(`${periodStart}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + amount);
  return `${monthKey(date)}-01`;
}

function normalizePeriodStart(value: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])-01$/.test(value)) {
    throw new Error(`Materials period start must be a first-of-month date, got ${value}.`);
  }
  return value;
}

function completedDayOfMonth(line: MaterialLineInput): number {
  const day = Number(line.completedDate.slice(8, 10));
  return Number.isInteger(day) && day >= 1 ? day : 32;
}

function daysInPeriodMonth(periodStart: string): number {
  const [year, month] = periodStart.split("-").map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function losAngelesDate(now: Date): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return new Date(Date.UTC(get("year"), get("month") - 1, get("day")));
}

function normalized(value: string | null): string {
  return value?.trim().toLowerCase() ?? "";
}

function cleanText(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function roundQty(value: number): number {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}
