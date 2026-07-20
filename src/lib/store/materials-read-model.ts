import type { FreshnessStatus } from "@/lib/metrics/freshness";
import {
  addMonthsToPeriodStart,
  buildMaterialsReadModel,
  normalizeMaterialsPeriodStart,
  type MaterialLineInput,
  type MaterialsMonthCoverage,
  type MaterialsReadModel,
} from "@/lib/metrics/materials";
import { getPageFreshness } from "@/lib/store/freshness";
import { queryPostgres } from "@/lib/store/postgres";

export const MATERIALS_METRIC_FAMILY = "materials";
export const MATERIALS_FRESHNESS_PAGE_KEY = "materials";

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
    if (persisted) return { ...persisted, freshness };
  } catch {
    // Fall through to mirror-side reconstruction when the serving model is
    // absent or temporarily unreadable.
  }

  const freshness = await freshnessPromise;
  try {
    const payload = await buildMaterialsReadModelPayload(normalized, { now, query });
    return { ...payload, freshness };
  } catch (error) {
    return emptyMaterialsReadModel(
      normalized,
      freshness,
      error instanceof Error ? error.message : "Unable to read the materials mirror.",
      now,
    );
  }
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
    && payload!.coverage !== null;
}

function missingCoverage(periodStart: string): MaterialsMonthCoverage {
  return { periodStart, status: "missing", walkedAt: null, jobCount: 0, lineCount: 0 };
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

function finiteNumber(value: string | number | null): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
