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
  /** Same-month-prior-year value, day-aligned only for the live partial month. */
  comparisonValue: number | null;
  comparisonQty: number | null;
  valueDelta: number | null;
  /** UI compatibility alias for the signed selected-minus-comparator value. */
  changeValue: number | null;
  qtyDelta: number | null;
  comparisonAvailable: boolean;
  /** False until category mapping revisions are snapshotted historically. */
  taxonomyComparable: boolean;
};

export type MaterialsItemRow = {
  key: string;
  name: string;
  partNo: string | null;
  category: string;
  qty: number;
  /** Null when the prior month has not been authoritatively walked. */
  priorMonthQty: number | null;
  /** Null when the prior month has not been authoritatively walked. */
  priorMonthExtended: number | null;
  /** Same-month-prior-year comparators. They are day-aligned for the live
   * partial month and full-month for closed months. */
  comparisonSales: number | null;
  /** UI compatibility alias for comparison sales. */
  comparisonExtended: number | null;
  comparisonQty: number | null;
  comparisonSalesDelta: number | null;
  comparisonQtyDelta: number | null;
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
  comparison: MaterialsComparison;
  topSignedDollarChangeDrivers: MaterialsChangeDriver[];
  /** Bounded, signed drivers used by the investigation surface. */
  changeDrivers: MaterialsChangeDriver[];
  /** Small, factual selected-month exposure facts for the Materials overview.
   * Optional while older persisted read models age out. */
  exposure?: MaterialsExposure;
};

export type MaterialsComparison = {
  basis: "day-aligned-yoy" | "full-yoy";
  periodStart: string;
  comparatorPeriodStart: string;
  label: string;
  shortLabel: string;
  columnLabel: string;
  partial: boolean;
  elapsedDays: number;
  available: boolean;
  comparable: boolean;
  sales: number | null;
  salesDelta: number | null;
  salesDeltaPct: number | null;
};

export type MaterialsChangeDriver = Pick<
  MaterialsItemRow,
  "key" | "name" | "partNo" | "category" | "extended" | "comparisonExtended" | "comparisonSalesDelta"
> & {
  /** Explicit aliases make the signed-driver payload self-describing. */
  sales: number;
  comparisonSales: number;
  salesDelta: number;
};

export type MaterialsExposure = {
  specialOrder: { value: number; share: number };
  largestItem: { name: string; value: number; share: number } | null;
  ungrouped: { value: number; share: number };
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
      `The prior-month materials walk is ${params.coverage.priorMonth.status}; prior-month context is unavailable.`,
    );
  }
  if (params.coverage.priorYearMonth.status !== "complete") {
    warnings.push(
      `The prior-year materials walk is ${params.coverage.priorYearMonth.status}; the year-over-year comparison is unavailable.`,
    );
  }

  const comparisonAvailable = params.coverage.selectedMonth.status === "complete"
    && params.coverage.priorYearMonth.status === "complete";
  const categories = buildCategories(selected, priorYearSameDay, comparisonAvailable);
  const items = buildItems(
    selected,
    priorMonth,
    params.coverage.priorMonth.status === "complete",
    priorYearSameDay,
    comparisonAvailable,
  );
  const comparatorPeriodStart = addMonthsToPeriodStart(periodStart, -12);
  const comparison = buildComparison({
    periodStart,
    comparatorPeriodStart,
    partial: isCurrentMonthPartial,
    elapsedDays,
    available: comparisonAvailable,
    sales: currentTotal,
    comparatorSales: priorYearSameDayTotal,
  });
  const changeDrivers = buildTopChangeDrivers(items, priorYearSameDay, comparisonAvailable);

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
    categories,
    items,
    freshness: params.freshness,
    coverage: {
      selectedMonth: params.coverage.selectedMonth,
      priorMonth: params.coverage.priorMonth,
      priorYearMonth: params.coverage.priorYearMonth,
      includedLineCount: selected.length,
      excludedServiceContractLineCount,
    },
    warnings,
    comparison,
    topSignedDollarChangeDrivers: changeDrivers,
    changeDrivers,
    exposure: buildExposure(currentTotal, categories, items),
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

function buildCategories(
  lines: MaterialLineInput[],
  comparisonLines: MaterialLineInput[],
  comparisonAvailable: boolean,
): MaterialsCategorySlice[] {
  type CategoryAccumulator = Pick<MaterialsCategorySlice, "name" | "value" | "qty" | "lines">;
  const byCategory = new Map<string, CategoryAccumulator>();
  for (const line of lines) {
    const name = materialLineCategory(line);
    const slice = byCategory.get(name) ?? { name, value: 0, qty: 0, lines: 0 };
    slice.value += line.extendedExTax;
    slice.qty += line.qty;
    slice.lines += 1;
    byCategory.set(name, slice);
  }
  const comparisonByCategory = new Map<string, Pick<MaterialsCategorySlice, "value" | "qty">>();
  for (const line of comparisonLines) {
    const name = materialLineCategory(line);
    const slice = comparisonByCategory.get(name) ?? { value: 0, qty: 0 };
    slice.value += line.extendedExTax;
    slice.qty += line.qty;
    comparisonByCategory.set(name, slice);
  }
  return [...byCategory.values()]
    .map((slice) => {
      const value = roundMoney(slice.value);
      const qty = roundQty(slice.qty);
      const comparison = comparisonByCategory.get(slice.name);
      const comparisonValue = comparisonAvailable ? roundMoney(comparison?.value ?? 0) : null;
      const comparisonQty = comparisonAvailable ? roundQty(comparison?.qty ?? 0) : null;
      return {
        ...slice,
        value,
        qty,
        comparisonValue,
        comparisonQty,
        valueDelta: comparisonValue === null ? null : roundMoney(value - comparisonValue),
        changeValue: comparisonValue === null ? null : roundMoney(value - comparisonValue),
        qtyDelta: comparisonQty === null ? null : roundQty(qty - comparisonQty),
        comparisonAvailable,
        taxonomyComparable: false,
      };
    })
    .sort((left, right) => right.value - left.value || left.name.localeCompare(right.name));
}

function buildItems(
  lines: MaterialLineInput[],
  priorMonthLines: MaterialLineInput[],
  priorMonthComplete: boolean,
  comparisonLines: MaterialLineInput[],
  comparisonAvailable: boolean,
): MaterialsItemRow[] {
  const priorQtyByKey = new Map<string, number>();
  const priorExtendedByKey = new Map<string, number>();
  for (const line of priorMonthLines) {
    const key = materialItemKey(line);
    priorQtyByKey.set(key, (priorQtyByKey.get(key) ?? 0) + line.qty);
    priorExtendedByKey.set(key, (priorExtendedByKey.get(key) ?? 0) + line.extendedExTax);
  }
  const comparisonQtyByKey = new Map<string, number>();
  const comparisonExtendedByKey = new Map<string, number>();
  for (const line of comparisonLines) {
    const key = materialItemKey(line);
    comparisonQtyByKey.set(key, (comparisonQtyByKey.get(key) ?? 0) + line.qty);
    comparisonExtendedByKey.set(key, (comparisonExtendedByKey.get(key) ?? 0) + line.extendedExTax);
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
      priorMonthExtended: priorMonthComplete ? roundMoney(priorExtendedByKey.get(key) ?? 0) : null,
      comparisonSales: comparisonAvailable ? roundMoney(comparisonExtendedByKey.get(key) ?? 0) : null,
      comparisonExtended: comparisonAvailable ? roundMoney(comparisonExtendedByKey.get(key) ?? 0) : null,
      comparisonQty: comparisonAvailable ? roundQty(comparisonQtyByKey.get(key) ?? 0) : null,
      comparisonSalesDelta: null,
      comparisonQtyDelta: null,
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
        priorMonthExtended: item.priorMonthExtended,
        comparisonSales: item.comparisonSales,
        comparisonExtended: item.comparisonExtended,
        comparisonQty: item.comparisonQty,
        comparisonSalesDelta: item.comparisonSales === null ? null : roundMoney(extended - item.comparisonSales),
        comparisonQtyDelta: item.comparisonQty === null ? null : roundQty(qty - item.comparisonQty),
        unitSell: qty > 0 ? roundMoney(extended / qty) : null,
        extended,
        jobCount: jobIds.length,
        jobIds,
      };
    })
    .sort((left, right) => right.extended - left.extended || left.key.localeCompare(right.key));
}

function buildComparison(params: {
  periodStart: string;
  comparatorPeriodStart: string;
  partial: boolean;
  elapsedDays: number;
  available: boolean;
  sales: number;
  comparatorSales: number;
}): MaterialsComparison {
  const shortLabel = monthYearShortLabel(params.comparatorPeriodStart);
  const cutoff = monthDayLabel(params.periodStart, params.elapsedDays);
  const label = params.partial ? `vs ${shortLabel} through ${cutoff}` : `vs ${shortLabel} full month`;
  const sales = params.available ? params.comparatorSales : null;
  const salesDelta = sales === null ? null : roundMoney(params.sales - sales);
  return {
    basis: params.partial ? "day-aligned-yoy" : "full-yoy",
    periodStart: params.periodStart,
    comparatorPeriodStart: params.comparatorPeriodStart,
    label,
    shortLabel,
    columnLabel: params.partial ? `${shortLabel} through ${cutoff}` : shortLabel,
    partial: params.partial,
    elapsedDays: params.elapsedDays,
    available: params.available,
    comparable: params.available,
    sales,
    salesDelta,
    salesDeltaPct: sales === null || sales === 0 || salesDelta === null ? null : roundPct(salesDelta / sales),
  };
}

function buildTopChangeDrivers(
  items: MaterialsItemRow[],
  comparisonLines: MaterialLineInput[],
  comparisonAvailable: boolean,
): MaterialsChangeDriver[] {
  if (!comparisonAvailable) return [];
  const drivers = new Map<string, MaterialsChangeDriver>();
  const selectedKeys = new Set(items.map((item) => item.key));
  for (const item of items) {
    if (item.comparisonSales === null || item.comparisonSalesDelta === null) continue;
    drivers.set(item.key, {
      key: item.key,
      name: item.name,
      partNo: item.partNo,
      category: item.category,
      extended: item.extended,
      comparisonExtended: item.comparisonExtended,
      comparisonSalesDelta: item.comparisonSalesDelta,
      sales: item.extended,
      comparisonSales: item.comparisonSales,
      salesDelta: item.comparisonSalesDelta,
    });
  }
  for (const line of comparisonLines) {
    const key = materialItemKey(line);
    const existing = drivers.get(key);
    // Selected-period items already carry their fully aggregated comparator.
    if (selectedKeys.has(key)) continue;
    const comparisonSales = roundMoney((existing?.comparisonSales ?? 0) + line.extendedExTax);
    if (existing) {
      existing.comparisonExtended = comparisonSales;
      existing.comparisonSalesDelta = -comparisonSales;
      existing.comparisonSales = comparisonSales;
      existing.salesDelta = -comparisonSales;
      continue;
    }
    drivers.set(key, {
      key,
      name: cleanText(line.name) ?? "Unnamed material",
      partNo: cleanText(line.partNo),
      category: materialLineCategory(line),
      extended: 0,
      comparisonExtended: comparisonSales,
      comparisonSalesDelta: -comparisonSales,
      sales: 0,
      comparisonSales,
      salesDelta: -comparisonSales,
    });
  }
  return [...drivers.values()]
    .filter((item) => item.comparisonSales !== null && item.comparisonSalesDelta !== null)
    .sort((left, right) => Math.abs(right.salesDelta) - Math.abs(left.salesDelta) || right.salesDelta - left.salesDelta || left.key.localeCompare(right.key))
    .slice(0, 10);
}

function buildExposure(total: number, categories: MaterialsCategorySlice[], items: MaterialsItemRow[]): MaterialsExposure {
  const share = (value: number) => total > 0 ? roundPct(value / total) : 0;
  const specialOrder = categories.find((category) => category.name === SPECIAL_ORDER_CATEGORY)?.value ?? 0;
  const ungrouped = categories.find((category) => category.name === UNGROUPED_CATEGORY)?.value ?? 0;
  const largest = items[0] ?? null;
  return {
    specialOrder: { value: specialOrder, share: share(specialOrder) },
    largestItem: largest ? { name: largest.name, value: largest.extended, share: share(largest.extended) } : null,
    ungrouped: { value: ungrouped, share: share(ungrouped) },
  };
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

function roundPct(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}

function monthYearShortLabel(periodStart: string): string {
  const date = new Date(`${periodStart}T00:00:00Z`);
  const month = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(date);
  return `${month} ’${String(date.getUTCFullYear()).slice(-2)}`;
}

function monthDayLabel(periodStart: string, day: number): string {
  const month = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" })
    .format(new Date(`${periodStart}T00:00:00Z`));
  return `${month} ${day}`;
}
