import type { FreshnessStatus } from "@/lib/metrics/freshness";
import {
  addMonthsToPeriodStart,
  buildMaterialsReadModel,
  normalizeMaterialsPeriodStart,
  type MaterialLineInput,
  type MaterialsMonthCoverage,
  type MaterialsItemRow,
  type MaterialsReadModel,
  SPECIAL_ORDER_CATEGORY,
  UNGROUPED_CATEGORY,
} from "@/lib/metrics/materials";
import { getPageFreshness } from "@/lib/store/freshness";
import { queryPostgres } from "@/lib/store/postgres";

export const MATERIALS_METRIC_FAMILY = "materials";
export const MATERIALS_FRESHNESS_PAGE_KEY = "materials";
export const MATERIALS_PAGE_SIZE = 20;

export const materialsItemSorts = ["sales", "dollar-change", "jobs", "quantity-change"] as const;
export type MaterialsItemSort = (typeof materialsItemSorts)[number];

export type MaterialsItemFilters = {
  q: string;
  category: string | null;
  sort: MaterialsItemSort;
};

export type MaterialsPageOptions = Partial<MaterialsItemFilters> & { page?: number };

/** A materials table row deliberately omits its potentially long job roster. */
export type MaterialsItemSummary = Omit<MaterialsItemRow, "jobIds">;

export type MaterialsItemPagination = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export type MaterialsTrendPoint = {
  periodStart: string;
  /** Extended sell ex-tax. Quantity is intentionally absent: it combines
   * incompatible item units and is not a valid overview measure. */
  sales: number | null;
  /** Compatibility alias while the legacy presentation is replaced. */
  spend: number | null;
  /** Compatibility placeholder. Aggregate cross-unit quantity is no longer
   * queried or populated for the overview. */
  quantity: number | null;
  status: "complete" | "failed" | "missing";
  /** Only true for the selected live month. */
  isPartial: boolean;
  elapsedDays: number | null;
  daysInMonth: number | null;
  sameMonthLastYearSales: number | null;
  comparisonLabel: string | null;
};

/** The bounded payload passed to the client Materials dashboard. */
export type MaterialsPageReadModel = Omit<MaterialsReadModel, "items"> & {
  items: MaterialsItemSummary[];
  itemPagination: MaterialsItemPagination;
  itemFilters: MaterialsItemFilters;
  itemCategories: string[];
};

export type MaterialsItemJobDetail = {
  jobId: number;
  jobNo: string | null;
  completedDate: string | null;
  /** The normalized jobs mirror does not currently persist a job name. */
  name: string | null;
  customerName: string | null;
  siteName: string | null;
  qty: number;
  extended: number;
};

export type MaterialsRowsQuery = <T = Record<string, unknown>>(
  text: string,
  values?: unknown[],
) => Promise<{ rows: T[] }>;

export type MaterialsReadModelOptions = {
  now?: Date;
  query?: MaterialsRowsQuery;
};

type MaterialLineDbRow = {
  job_id: string;
  period_start: string;
  completed_date: string;
  line_type: "catalog" | "one_off" | "prebuild";
  catalog_id: string | null;
  prebuild_id: string | null;
  name: string | null;
  part_no: string | null;
  qty: string;
  extended_ex_tax: string;
  group_name: string | null;
  parent_group_name: string | null;
};

type MonthWalkDbRow = {
  period_start: string;
  status: "complete" | "failed";
  walked_at: string;
  job_count: number | string;
  line_count: number | string;
};

type PersistedMaterialsRow = { values_json: MaterialsReadModel | null };

type MaterialsTrendDbRow = {
  period_start: string;
  status: string | null;
  sales: string | number | null;
  elapsed_days: string | number | null;
  days_in_month: string | number | null;
  prior_year_sales: string | number | null;
  prior_year_status: string | null;
};

/**
 * Serve the materials read model: persisted dashboard_read_models payload
 * first (built by the rollup worker from the materials mirror), with a
 * mirror-side rebuild as the fallback. Never walks Simpro at request time.
 */
export async function getMaterialsReadModel(
  periodStart?: string,
  options: MaterialsReadModelOptions = {},
): Promise<MaterialsReadModel> {
  const now = options.now ?? new Date();
  const normalized = normalizeMaterialsPeriodStart(periodStart, now);
  const query = options.query ?? queryPostgres;
  const freshnessPromise = getPageFreshness(MATERIALS_FRESHNESS_PAGE_KEY, normalized);

  try {
    const [freshness, persisted] = await Promise.all([
      freshnessPromise,
      getPersistedMaterialsReadModel(normalized, query),
    ]);
    if (persisted) {
      return {
        ...persisted,
        exposure: persisted.exposure ?? materialsExposure(persisted),
        freshness: materialsFreshnessForSelectedPeriod(freshness, persisted.coverage.selectedMonth, now),
      };
    }
  } catch {
    // Fall through to mirror-side reconstruction when the serving model is
    // absent or temporarily unreadable.
  }

  const freshness = await freshnessPromise;
  try {
    const payload = await buildMaterialsReadModelPayload(normalized, { now, query });
    return {
      ...payload,
      freshness: materialsFreshnessForSelectedPeriod(freshness, payload.coverage.selectedMonth, now),
    };
  } catch (error) {
    return emptyMaterialsReadModel(
      normalized,
      freshness,
      error instanceof Error ? error.message : "Unable to read the materials mirror.",
      now,
    );
  }
}

export function materialsFreshnessForSelectedPeriod(
  globalFreshness: FreshnessStatus,
  coverage: MaterialsMonthCoverage,
  now = new Date(),
): FreshnessStatus {
  if (coverage.periodStart >= normalizeMaterialsPeriodStart(undefined, now)) return globalFreshness;

  const common = {
    pageKey: MATERIALS_FRESHNESS_PAGE_KEY,
    dataThrough: coverage.status === "complete" ? materialsPeriodEnd(coverage.periodStart) : null,
    lastSuccessfulRunAt: coverage.status === "complete" ? coverage.walkedAt : null,
    lastFailedRunAt: coverage.status === "failed" ? coverage.walkedAt : null,
  };
  if (coverage.status === "complete") {
    return {
      ...common,
      state: "current",
      label: "Selected period complete",
      detail: `The ${coverage.periodStart.slice(0, 7)} materials walk is complete.`,
    };
  }
  if (coverage.status === "failed") {
    return {
      ...common,
      state: "failed",
      label: "Selected period walk failed",
      detail: `The ${coverage.periodStart.slice(0, 7)} materials walk failed.`,
    };
  }
  return {
    ...common,
    state: "missing",
    label: "No selected-period data",
    detail: `No completed materials walk exists for ${coverage.periodStart.slice(0, 7)}.`,
  };
}

/**
 * Returns the one ranked page needed to render /materials. The complete
 * material model remains server-side for exports and item drilldowns.
 */
export async function getMaterialsPageReadModel(
  periodStart?: string,
  options?: number | MaterialsPageOptions,
): Promise<MaterialsPageReadModel> {
  return toMaterialsPageReadModel(await getMaterialsReadModel(periodStart), options);
}

export function toMaterialsPageReadModel(
  model: MaterialsReadModel,
  options?: number | MaterialsPageOptions,
  pageSize = MATERIALS_PAGE_SIZE,
): MaterialsPageReadModel {
  const filters = normalizeMaterialsItemFilters(options);
  const filteredItems = filterMaterialsItems(model.items, filters);
  const total = filteredItems.length;
  const safePageSize = Number.isInteger(pageSize) && pageSize > 0 ? pageSize : MATERIALS_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(total / safePageSize));
  const requestedPage = typeof options === "number"
    ? options
    : options?.page;
  const safeRequestedPage = Number.isInteger(requestedPage) && requestedPage! > 0 ? requestedPage! : 1;
  const safePage = Math.min(safeRequestedPage, totalPages);
  const start = (safePage - 1) * safePageSize;
  const items = filteredItems.slice(start, start + safePageSize).map(({ jobIds, ...item }) => {
    void jobIds;
    return item;
  });

  return {
    ...model,
    items,
    itemPagination: { page: safePage, pageSize: safePageSize, total, totalPages },
    itemFilters: filters,
    itemCategories: [...new Set(model.items.map((item) => item.category))].sort((left, right) => left.localeCompare(right)),
  };
}

export function materialsPageParam(value: string | null | undefined): number {
  if (!value || !/^\d+$/.test(value)) return 1;
  const page = Number(value);
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

export function materialsSearchParam(value: string | null | undefined): string {
  return value?.trim().replace(/\s+/g, " ").slice(0, 120) ?? "";
}

export function materialsCategoryParam(value: string | null | undefined): string | null {
  const category = value?.trim().slice(0, 120) ?? "";
  return category || null;
}

export function materialsSortParam(value: string | null | undefined): MaterialsItemSort {
  return materialsItemSorts.includes(value as MaterialsItemSort) ? value as MaterialsItemSort : "sales";
}

export function normalizeMaterialsItemFilters(options?: number | MaterialsPageOptions): MaterialsItemFilters {
  if (typeof options === "number" || !options) return { q: "", category: null, sort: "sales" };
  return {
    q: materialsSearchParam(options.q),
    category: materialsCategoryParam(options.category),
    sort: materialsSortParam(options.sort),
  };
}

/** Filter before pagination so the client only receives the requested slice.
 * Comparator values are keyed by the canonical material key in the read model,
 * never by display name. */
export function filterMaterialsItems(items: MaterialsItemRow[], filters: MaterialsItemFilters): MaterialsItemRow[] {
  const needle = filters.q.toLocaleLowerCase();
  const categoryNeedle = filters.category?.toLocaleLowerCase() ?? null;
  return items
    .filter((item) => {
      if (categoryNeedle && item.category.toLocaleLowerCase() !== categoryNeedle) return false;
      return !needle
        || item.name.toLocaleLowerCase().includes(needle)
        || item.partNo?.toLocaleLowerCase().includes(needle) === true;
    })
    .slice()
    .sort((left, right) => compareMaterialsItems(left, right, filters.sort));
}

function compareMaterialsItems(left: MaterialsItemRow, right: MaterialsItemRow, sort: MaterialsItemSort): number {
  if (sort === "dollar-change") {
    const result = compareNullableDesc(dollarChange(left), dollarChange(right));
    return result || right.extended - left.extended || left.key.localeCompare(right.key);
  }
  if (sort === "jobs") return right.jobCount - left.jobCount || right.extended - left.extended || left.key.localeCompare(right.key);
  if (sort === "quantity-change") {
    const result = compareNullableDesc(quantityChange(left), quantityChange(right));
    return result || right.extended - left.extended || left.key.localeCompare(right.key);
  }
  return right.extended - left.extended || left.key.localeCompare(right.key);
}

function compareNullableDesc(left: number | null, right: number | null): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return right - left;
}

export function dollarChange(item: Pick<MaterialsItemRow, "comparisonSalesDelta">): number | null {
  return item.comparisonSalesDelta;
}

export function quantityChange(item: Pick<MaterialsItemRow, "comparisonQtyDelta">): number | null {
  return item.comparisonQtyDelta;
}

export async function getPersistedMaterialsReadModel(
  periodStart: string,
  query: MaterialsRowsQuery = queryPostgres,
): Promise<MaterialsReadModel | null> {
  const result = await query<PersistedMaterialsRow>(
    `select values_json
       from metrics.dashboard_read_models
      where metric_family = $1
        and period_grain = 'month'
        and period_start = $2::date
        and superseded_at is null
        and jsonb_typeof(values_json -> 'totals') = 'object'
      order by rebuilt_at desc
      limit 1`,
    [MATERIALS_METRIC_FAMILY, periodStart],
  );
  const payload = result.rows[0]?.values_json ?? null;
  return isUsablePersistedMaterialsReadModel(payload, periodStart) ? payload : null;
}

/** Load only monetary history needed by the Materials overview. This is one
 * bounded scalar query: full item arrays and job IDs never cross the
 * database or server/client boundary for history rendering. */
export async function getMaterialsTrend(
  periodStarts: string[],
  query: MaterialsRowsQuery = queryPostgres,
): Promise<MaterialsTrendPoint[]> {
  if (periodStarts.length === 0) return [];
  const result = await query<MaterialsTrendDbRow>(
    `select period_start::text,
            values_json -> 'coverage' -> 'selectedMonth' ->> 'status' as status,
            (values_json -> 'totals' ->> 'current')::numeric as sales,
            (values_json -> 'totals' ->> 'elapsedDays')::integer as elapsed_days,
            (values_json -> 'totals' ->> 'daysInMonth')::integer as days_in_month,
            (values_json -> 'totals' ->> 'priorYearSameDay')::numeric as prior_year_sales,
            values_json -> 'coverage' -> 'priorYearMonth' ->> 'status' as prior_year_status
       from metrics.dashboard_read_models
      where metric_family = $1
        and period_grain = 'month'
        and period_start = any($2::date[])
        and superseded_at is null
      order by period_start`,
    [MATERIALS_METRIC_FAMILY, periodStarts],
  );
  const byPeriod = new Map(result.rows.map((row) => [row.period_start.slice(0, 10), row]));
  const selectedPeriod = periodStarts[periodStarts.length - 1];
  return periodStarts.map((periodStart) => {
    const row = byPeriod.get(periodStart);
    const status = materialCoverageStatus(row?.status);
    const elapsedDays = nullableInteger(row?.elapsed_days);
    const daysInMonth = nullableInteger(row?.days_in_month);
    const isSelected = periodStart === selectedPeriod;
    const isPartial = isSelected && status === "complete" && elapsedDays !== null && daysInMonth !== null && elapsedDays < daysInMonth;
    const priorYearComplete = materialCoverageStatus(row?.prior_year_status) === "complete";
    const sameMonthLastYearSales = status === "complete" && priorYearComplete
      ? nullableFiniteNumber(row?.prior_year_sales)
      : null;
    return {
      periodStart,
      status,
      sales: status === "complete" ? nullableFiniteNumber(row?.sales) : null,
      // Kept temporarily so any independently deployed legacy client can
      // still render monetary history while the new chart rolls out.
      spend: status === "complete" ? nullableFiniteNumber(row?.sales) : null,
      quantity: null,
      isPartial,
      elapsedDays: isSelected ? elapsedDays : null,
      daysInMonth: isSelected ? daysInMonth : null,
      sameMonthLastYearSales,
      comparisonLabel: sameMonthLastYearSales === null
        ? null
        : materialsComparisonLabel(periodStart, isPartial, elapsedDays),
    };
  });
}

/** Material item jobs are a drill-time local query. It deliberately joins the
 * normalized jobs mirror only; opening a drawer never makes a Simpro request. */
export async function getMaterialsItemJobs(
  periodStart: string,
  key: string,
  query: MaterialsRowsQuery = queryPostgres,
): Promise<MaterialsItemJobDetail[]> {
  const result = await query<{
    job_id: string;
    job_no: string | null;
    completed_date: string | null;
    customer_name: string | null;
    site_name: string | null;
    qty: string | number;
    extended: string | number;
  }>(
    `with item_lines as (
       select l.job_id, l.completed_date, l.qty, l.extended_ex_tax,
              case
                when l.line_type = 'catalog' and l.catalog_id is not null then 'catalog:' || l.catalog_id::text
                when l.line_type = 'prebuild' and l.prebuild_id is not null then 'prebuild:' || l.prebuild_id::text
                else case when l.line_type = 'prebuild' then 'prebuild:' else 'one-off:' end
                     || coalesce(nullif(lower(btrim(l.name)), ''), 'unnamed')
              end as item_key
         from metrics.metrics_material_lines l
         left join metrics.catalog_groups g on g.catalog_id = l.catalog_id
        where l.period_start = $1::date
          and (l.line_type <> 'catalog' or (
            lower(btrim(coalesce(g.parent_group_name, ''))) <> 'service contract'
            and lower(btrim(coalesce(g.group_name, ''))) <> 'service contract'
          ))
     )
     select lines.job_id::text, max(j.job_no) as job_no, max(lines.completed_date)::text as completed_date,
            max(j.customer_name) as customer_name, max(j.site_name) as site_name,
            sum(lines.qty)::text as qty, sum(lines.extended_ex_tax)::text as extended
       from item_lines lines
       left join metrics.metrics_jobs j on j.job_id = lines.job_id and j.source_deleted_at is null
      where lines.item_key = $2
      group by lines.job_id
      order by sum(lines.extended_ex_tax) desc, lines.job_id`,
    [periodStart, key],
  );
  return result.rows.map((row) => ({
    jobId: Number(row.job_id),
    jobNo: row.job_no,
    completedDate: row.completed_date?.slice(0, 10) ?? null,
    name: null,
    customerName: row.customer_name,
    siteName: row.site_name,
    qty: finiteNumber(row.qty),
    extended: finiteNumber(row.extended),
  })).filter((row) => Number.isSafeInteger(row.jobId) && row.jobId > 0);
}

/**
 * Build the materials payload from the mirror tables. This is what the rollup
 * worker persists into dashboard_read_models for the family.
 */
export async function buildMaterialsReadModelPayload(
  periodStart: string,
  options: MaterialsReadModelOptions = {},
): Promise<MaterialsReadModel> {
  const now = options.now ?? new Date();
  const query = options.query ?? queryPostgres;
  const priorMonthStart = addMonthsToPeriodStart(periodStart, -1);
  const priorYearStart = addMonthsToPeriodStart(periodStart, -12);
  const periods = [periodStart, priorMonthStart, priorYearStart];

  const [linesByPeriod, walks] = await Promise.all([
    loadMaterialLineInputs(periods, query),
    loadMaterialsMonthWalks(periods, query),
  ]);

  return buildMaterialsReadModel({
    periodStart,
    selectedLines: linesByPeriod.get(periodStart) ?? [],
    priorMonthLines: linesByPeriod.get(priorMonthStart) ?? [],
    priorYearLines: linesByPeriod.get(priorYearStart) ?? [],
    coverage: {
      selectedMonth: walks.get(periodStart) ?? missingCoverage(periodStart),
      priorMonth: walks.get(priorMonthStart) ?? missingCoverage(priorMonthStart),
      priorYearMonth: walks.get(priorYearStart) ?? missingCoverage(priorYearStart),
    },
    freshness: builderFreshness(),
    now,
  });
}

export async function loadMaterialLineInputs(
  periodStarts: string[],
  query: MaterialsRowsQuery = queryPostgres,
): Promise<Map<string, MaterialLineInput[]>> {
  const result = await query<MaterialLineDbRow>(
    `select l.job_id::text, l.period_start::text, l.completed_date::text, l.line_type,
            l.catalog_id::text, l.prebuild_id::text,
            coalesce(l.name, g.name) as name,
            coalesce(l.part_no, g.part_no) as part_no,
            l.qty::text, l.extended_ex_tax::text,
            g.group_name, g.parent_group_name
       from metrics.metrics_material_lines l
       left join metrics.catalog_groups g on g.catalog_id = l.catalog_id
      where l.period_start = any($1::date[])`,
    [periodStarts],
  );
  const byPeriod = new Map<string, MaterialLineInput[]>();
  for (const row of result.rows) {
    const periodStart = row.period_start.slice(0, 10);
    const lines = byPeriod.get(periodStart) ?? [];
    lines.push({
      jobId: Number(row.job_id),
      completedDate: row.completed_date.slice(0, 10),
      lineType: row.line_type,
      catalogId: row.catalog_id === null ? null : Number(row.catalog_id),
      prebuildId: row.prebuild_id === null ? null : Number(row.prebuild_id),
      name: row.name,
      partNo: row.part_no,
      qty: finiteNumber(row.qty),
      extendedExTax: finiteNumber(row.extended_ex_tax),
      groupName: row.group_name,
      parentGroupName: row.parent_group_name,
    });
    byPeriod.set(periodStart, lines);
  }
  return byPeriod;
}

async function loadMaterialsMonthWalks(
  periodStarts: string[],
  query: MaterialsRowsQuery,
): Promise<Map<string, MaterialsMonthCoverage>> {
  const result = await query<MonthWalkDbRow>(
    `select period_start::text, status, walked_at::text, job_count, line_count
       from metrics.materials_month_walks
      where period_start = any($1::date[])`,
    [periodStarts],
  );
  return new Map(result.rows.map((row) => {
    const periodStart = row.period_start.slice(0, 10);
    return [periodStart, {
      periodStart,
      status: row.status,
      walkedAt: row.walked_at,
      jobCount: Number(row.job_count) || 0,
      lineCount: Number(row.line_count) || 0,
    }];
  }));
}

function isUsablePersistedMaterialsReadModel(
  payload: MaterialsReadModel | null,
  periodStart: string,
): payload is MaterialsReadModel {
  return Boolean(payload)
    && payload!.periodStart === periodStart
    && typeof payload!.totals === "object"
    && payload!.totals !== null
    && typeof payload!.totals.current === "number"
    && Array.isArray(payload!.categories)
    && Array.isArray(payload!.items)
    && typeof payload!.coverage === "object"
    && payload!.coverage !== null
    // The previous persisted shape compared items to prior month. Rebuild it
    // locally until the rollup has published the matched prior-year contract.
    && typeof payload!.comparison === "object"
    && payload!.comparison !== null
    && (payload!.comparison.basis === "day-aligned-yoy" || payload!.comparison.basis === "full-yoy")
    && Array.isArray(payload!.topSignedDollarChangeDrivers)
    && Array.isArray(payload!.changeDrivers);
}

function missingCoverage(periodStart: string): MaterialsMonthCoverage {
  return { periodStart, status: "missing", walkedAt: null, jobCount: 0, lineCount: 0 };
}

function materialsPeriodEnd(periodStart: string) {
  const end = new Date(`${addMonthsToPeriodStart(periodStart, 1)}T00:00:00.000Z`);
  end.setUTCMilliseconds(-1);
  return end.toISOString();
}

function builderFreshness(): FreshnessStatus {
  return {
    pageKey: MATERIALS_FRESHNESS_PAGE_KEY,
    state: "current",
    label: "Persisted read model",
    detail: "Built by the app-owned rollup worker from the materials mirror.",
    dataThrough: null,
    lastSuccessfulRunAt: null,
    lastFailedRunAt: null,
  };
}

function emptyMaterialsReadModel(
  periodStart: string,
  freshness: FreshnessStatus,
  warning: string,
  now: Date,
): MaterialsReadModel {
  const empty = buildMaterialsReadModel({
    periodStart,
    selectedLines: [],
    priorMonthLines: [],
    priorYearLines: [],
    coverage: {
      selectedMonth: missingCoverage(periodStart),
      priorMonth: missingCoverage(addMonthsToPeriodStart(periodStart, -1)),
      priorYearMonth: missingCoverage(addMonthsToPeriodStart(periodStart, -12)),
    },
    freshness,
    now,
  });
  return { ...empty, warnings: [warning, ...empty.warnings] };
}

/** New overview facts are derived from existing persisted category/item data
 * until all prior-month read models have been rebuilt. */
function materialsExposure(model: MaterialsReadModel) {
  const total = model.totals.current;
  const share = (value: number) => total > 0 ? Math.round((value / total) * 10_000) / 10_000 : 0;
  const specialOrder = model.categories.find((category) => category.name === SPECIAL_ORDER_CATEGORY)?.value ?? 0;
  const ungrouped = model.categories.find((category) => category.name === UNGROUPED_CATEGORY)?.value ?? 0;
  const largestItem = model.items[0] ?? null;
  return {
    specialOrder: { value: specialOrder, share: share(specialOrder) },
    largestItem: largestItem ? { name: largestItem.name, value: largestItem.extended, share: share(largestItem.extended) } : null,
    ungrouped: { value: ungrouped, share: share(ungrouped) },
  };
}

function finiteNumber(value: string | number | null): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableFiniteNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nullableInteger(value: string | number | null | undefined): number | null {
  const parsed = nullableFiniteNumber(value);
  return parsed !== null && Number.isInteger(parsed) ? parsed : null;
}

function materialsComparisonLabel(periodStart: string, isPartial: boolean, elapsedDays: number | null): string {
  const date = new Date(`${periodStart}T00:00:00Z`);
  date.setUTCFullYear(date.getUTCFullYear() - 1);
  const priorMonth = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(date);
  const prior = `${priorMonth} ’${String(date.getUTCFullYear()).slice(-2)}`;
  if (!isPartial || elapsedDays === null) return `vs ${prior} full month`;
  const selectedMonth = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" })
    .format(new Date(`${periodStart}T00:00:00Z`));
  return `vs ${prior} through ${selectedMonth} ${elapsedDays}`;
}

function materialCoverageStatus(value: string | null | undefined): MaterialsTrendPoint["status"] {
  return value === "complete" || value === "failed" ? value : "missing";
}
