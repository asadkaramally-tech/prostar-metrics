import type { FreshnessStatus } from "@/lib/metrics/freshness";
import {
  buildJobMetricsDashboard,
  FOLLOW_UP_LINK_RULE,
  FOLLOW_UP_SAME_DAY_RULE,
  type IssuedQuoteInput,
  type JobCostCenterInput,
  type JobFilters,
  type JobMetricsDashboardReadModel,
  type JobDrilldownRow,
  type JobQuoteLaborInput,
  type JobReconciliationInput,
  type JobTimesheetInput,
  type NormalizedJobSnapshot,
} from "@/lib/metrics/jobs";
import { getPageFreshness } from "@/lib/store/freshness";
import { queryPostgres, type PostgresQuery } from "@/lib/store/postgres";

export type JobDashboardReadModel = JobMetricsDashboardReadModel & {
  freshness: FreshnessStatus;
  loadError: string | null;
  drilldownPagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
};

const DRILLDOWN_PAGE_SIZE = 50;

type JobRow = {
  job_id: string;
  job_no: string | null;
  name: string | null;
  description: string | null;
  status_name: string | null;
  completed_date: string;
  stage: string;
  total: string | null;
  gross_profit_actual: string | null;
  gross_margin_actual: string | null;
  net_profit_actual: string | null;
  net_margin_actual: string | null;
  materials_cost_actual: string | null;
  materials_cost_estimate: string | null;
  labor_cost_actual: string | null;
  labor_cost_estimate: string | null;
  labor_hours_actual: string | null;
  labor_hours_estimate: string | null;
  overhead_cost_actual: string | null;
  overhead_cost_estimate: string | null;
  total_resource_cost_actual: string | null;
  total_resource_cost_estimate: string | null;
  commission_cost_actual: string | null;
  job_source_type: string | null;
  job_source_id: string | null;
  customer_name: string | null;
  site_id: string | null;
  site_name: string | null;
  converted_from_type: string | null;
  converted_from_id: string | null;
  source_quote_id: string | null;
  category: string | null;
  material_coverage: string | null;
  source_deleted_at: string | null;
};

type CostCenterRow = {
  job_id: string;
  section_id: string;
  cost_center_id: string;
  configured_cost_center_id: string | null;
  configured_cost_center_name: string | null;
  name: string | null;
  category: string | null;
  sell_value: string | null;
  gross_profit_actual: string | null;
  net_profit_actual: string | null;
  net_margin_actual: string | null;
  materials_cost_actual: string | null;
  materials_cost_estimate: string | null;
  labor_cost_actual: string | null;
  labor_cost_estimate: string | null;
  labor_hours_actual: string | null;
  labor_hours_estimate: string | null;
  overhead_cost_actual: string | null;
  overhead_cost_estimate: string | null;
  labor_quoted_hours: string | null;
  material_cost_value: string | null;
  source_deleted_at: string | null;
};

type TimesheetRow = {
  job_id: string;
  timesheet_id: string;
  employee_id: string | null;
  technician_name: string | null;
  work_date: string | null;
  total_hours: string | null;
  source_deleted_at: string | null;
};

type QuoteLaborRow = {
  job_id: string;
  labor_id: string;
  quantity_hours: string | null;
  source_deleted_at: string | null;
};

type ReconciliationRow = {
  period_start: string;
  status: "matched" | "mismatch" | "failed";
  upstream_count: string | null;
  upstream_value: string | null;
  rollup_count: string | null;
  rollup_value: string | null;
  checked_at: string | null;
};

type IssuedQuoteRow = {
  quote_id: string;
  date_issued: string;
  site_id: string | null;
  site_name: string | null;
  total_value: string | null;
};

export async function getJobDashboardReadModel(params: {
  selectedMonth?: string;
  category?: string | null;
  costCenter?: string | null;
  technician?: string | null;
  page?: number;
  now?: Date;
} = {}): Promise<JobDashboardReadModel> {
  const now = params.now ?? new Date();
  const selectedMonth = normalizeSelectedMonth(params.selectedMonth, now);
  const periodEnd = monthEnd(selectedMonth);
  const freshnessPromise = getPageFreshness("jobs", `${selectedMonth}-01`);
  const filters = filtersFromParams(params);

  if (!filters.category && !filters.costCenter && !filters.technician) {
    try {
      const [persisted, freshness] = await Promise.all([
        getPersistedJobDashboard(selectedMonth, params.page),
        freshnessPromise,
      ]);
      if (persisted) {
        return paginateDrilldown({
          ...persisted.dashboard,
          freshness,
          loadError: null,
        }, persisted.page, persisted.totalRecords);
      }
    } catch {
      // Fall through to canonical reconstruction when a precomputed model is unavailable.
    }
  }

  try {
    const [jobs, reconciliations, issuedQuotes, freshness] = await Promise.all([
      getJobMetricInputs({ periodStart: "2023-01-01", periodEnd }),
      getJobReconciliations("2023-01-01", periodEnd),
      getIssuedQuoteInputs(),
      freshnessPromise,
    ]);
    return paginateDrilldown({
      ...buildJobMetricsDashboard({
        jobs,
        reconciliations,
        issuedQuotes,
        selectedMonth,
        filters,
        now,
      }),
      freshness,
      loadError: null,
    }, params.page);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unable to read persisted Job Metrics data.";
    const [freshness] = await Promise.all([freshnessPromise]);
    const empty = buildJobMetricsDashboard({
      jobs: [],
      selectedMonth,
      filters,
      now,
    });
    return paginateDrilldown({
      ...empty,
      freshness,
      loadError: detail,
      warnings: [detail, ...empty.warnings],
    }, params.page);
  }
}

/**
 * The jobs screen needs the complete record roster only for its drilldown
 * table, CSV export, and recurring-labor view.  Keep that payload separate
 * from the (much larger) dashboard wrapper so it is one bounded request.
 */
export async function getJobDrilldownRecords(selectedMonth: string): Promise<JobDrilldownRow[]> {
  const persisted = await getPersistedJobDrilldownRecords(selectedMonth);
  if (persisted) return persisted;

  // A dashboard rebuild may not have run yet. Preserve the previous live
  // reconstruction behavior as a fallback, but do not send its wrapper to
  // the browser.
  const periodEnd = monthEnd(selectedMonth);
  const [jobs, reconciliations, issuedQuotes] = await Promise.all([
    getJobMetricInputs({ periodStart: "2023-01-01", periodEnd }),
    getJobReconciliations("2023-01-01", periodEnd),
    getIssuedQuoteInputs(),
  ]);
  return buildJobMetricsDashboard({
    jobs,
    reconciliations,
    issuedQuotes,
    selectedMonth,
    filters: {},
  }).selected.records;
}

export function overlayJobReconciliations(
  model: JobMetricsDashboardReadModel,
  reconciliations: JobReconciliationInput[],
): JobMetricsDashboardReadModel {
  const byMonth = new Map(reconciliations.map((row) => [row.periodStart.slice(0, 7), row]));
  const history = model.history.map((row) => ({
    ...row,
    reconciliation: byMonth.get(row.month) ?? { periodStart: `${row.month}-01`, status: "missing" as const },
  }));
  const trends = (model.trends ?? []).map((row) => ({
    ...row,
    provenance: byMonth.get(row.month)?.status === "matched" ? "verified" as const : "representative" as const,
  }));
  const warnings = model.warnings.filter((warning) => !warning.includes("history months do not have a recorded job reconciliation run"));
  const missing = history.filter((row) => row.reconciliation.status === "missing").length;
  if (missing > 0) warnings.push(`${missing} history months do not have a recorded job reconciliation run.`);
  return { ...model, history, trends, warnings };
}

async function getPersistedJobDashboard(selectedMonth: string, requestedPage: number | undefined) {
  const result = await queryPostgres<{
    dashboard: JobMetricsDashboardReadModel | null;
    total_records: number | string;
    page: number | string;
  }>(
    `with selected_model as (
       select values_json -> 'dashboard' as dashboard
         from metrics.dashboard_read_models
        where metric_family = 'jobs'
          and period_grain = 'month'
          and period_start = $1::date
          and superseded_at is null
          and jsonb_typeof(values_json -> 'dashboard') = 'object'
        order by rebuilt_at desc
        limit 1
     ), counted as (
       select dashboard,
              coalesce(jsonb_array_length(dashboard #> '{selected,records}'), 0)::integer as total_records
         from selected_model
     ), paged as (
       select dashboard,
              total_records,
              least(
                greatest($2::integer, 1),
                greatest(1, ceil(total_records::numeric / $3::numeric)::integer)
              ) as page
         from counted
     )
     select jsonb_set(
              dashboard,
              '{selected,records}',
              coalesce((
                select jsonb_agg(entry.value order by entry.ordinality)
                  from jsonb_array_elements(coalesce(dashboard #> '{selected,records}', '[]'::jsonb))
                       with ordinality as entry(value, ordinality)
                 where entry.ordinality > ((page - 1) * $3::integer)
                   and entry.ordinality <= (page * $3::integer)
              ), '[]'::jsonb)
            ) as dashboard,
            total_records,
            page
       from paged`,
    [`${selectedMonth}-01`, normalizedPage(requestedPage), DRILLDOWN_PAGE_SIZE],
  );
  const dashboard = result.rows[0]?.dashboard ?? null;
  return dashboard?.selected?.fieldCoverage
    && dashboard.selected.netProfitActual !== undefined
    && Array.isArray(dashboard.selected.lossRecords)
    && dashboard.selected.costVariance?.materialsPairedJobs !== undefined
    && dashboard.selected.labor?.nestedQuoteLaborCoveredJobs !== undefined
    && dashboard.selected.lossBreakdown?.diagnosticFee !== undefined
    && dashboard.selected.quoteLinkedLabor?.coveredJobs !== undefined
    && dashboard.selected.directServiceFollowUps?.quoteEvidenceLoaded === true
    && dashboard.selected.directServiceFollowUps.linkRule === FOLLOW_UP_LINK_RULE
    && dashboard.selected.directServiceFollowUps.sameDayRule === FOLLOW_UP_SAME_DAY_RULE
    && dashboard.trends?.every((row) => row.laborVarianceHours !== undefined
      && row.avgJobValue !== undefined
      && row.provenance !== undefined)
    ? {
      dashboard,
      totalRecords: numericCount(result.rows[0]?.total_records),
      page: numericCount(result.rows[0]?.page) || 1,
    }
    : null;
}

async function getPersistedJobDrilldownRecords(selectedMonth: string): Promise<JobDrilldownRow[] | null> {
  const result = await queryPostgres<{ records: JobDrilldownRow[] | null }>(
    `select values_json #> '{dashboard,selected,records}' as records
       from metrics.dashboard_read_models
      where metric_family = 'jobs'
        and period_grain = 'month'
        and period_start = $1::date
        and superseded_at is null
        and jsonb_typeof(values_json #> '{dashboard,selected,records}') = 'array'
      order by rebuilt_at desc
      limit 1`,
    [`${selectedMonth}-01`],
  );
  const records = result.rows[0]?.records;
  return Array.isArray(records) ? records : null;
}

function paginateDrilldown(
  model: Omit<JobDashboardReadModel, "drilldownPagination">,
  requestedPage: number | undefined,
  totalRecords?: number,
): JobDashboardReadModel {
  const pageSize = DRILLDOWN_PAGE_SIZE;
  const total = totalRecords ?? model.selected.records.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(totalPages, normalizedPage(requestedPage));
  const offset = (page - 1) * pageSize;
  return {
    ...model,
    selected: {
      ...model.selected,
      records: totalRecords === undefined ? model.selected.records.slice(offset, offset + pageSize) : model.selected.records,
    },
    drilldownPagination: { page, pageSize, total, totalPages },
  };
}

export async function getJobMetricInputs(params: { periodStart: string; periodEnd: string }): Promise<NormalizedJobSnapshot[]> {
  try {
    return await getMigration026JobMetricInputs(params);
  } catch (error) {
    if (allowsMissingMigration026InTests(error)) return [];
    throw error;
  }
}

async function getMigration026JobMetricInputs(params: { periodStart: string; periodEnd: string }): Promise<NormalizedJobSnapshot[]> {
  const [jobResult, costCenterResult, timesheetResult, quoteLaborResult] = await Promise.all([
    queryPostgres<JobRow>(
      `select j.job_id::text, j.job_no, j.name, j.description, j.status_name,
              j.completed_date::text, j.stage, j.total::text, j.gross_profit_actual::text,
              j.gross_margin_actual::text, j.net_profit_actual::text, j.net_margin_actual::text,
              j.materials_cost_actual::text, j.materials_cost_estimate::text,
              j.labor_cost_actual::text, j.labor_cost_estimate::text,
              j.labor_hours_actual::text, j.labor_hours_estimate::text,
              j.overhead_cost_actual::text, j.overhead_cost_estimate::text,
              j.total_resource_cost_actual::text, j.total_resource_cost_estimate::text,
              j.commission_cost_actual::text, j.job_source_type, j.job_source_id::text,
              j.customer_name, j.site_id::text, j.site_name, j.converted_from_type, j.converted_from_id::text,
              source_quote.source_quote_id::text, j.category,
              coalesce(js.material_coverage, 'unknown') as material_coverage,
              j.source_deleted_at::text
         from metrics.metrics_jobs j
         left join metrics.job_snapshots js on js.job_id = j.job_id
         left join metrics.job_source_quotes source_quote on source_quote.job_id = j.job_id
        where j.completed_date between $1::date and $2::date
          and lower(trim(j.stage)) in ('complete', 'archived')
          and j.source_deleted_at is null
	        order by j.completed_date, j.job_id`,
      [params.periodStart, params.periodEnd],
    ),
    queryPostgres<CostCenterRow>(
      `select c.job_id::text, c.section_id::text, c.cost_center_id::text,
              c.configured_cost_center_id::text, c.configured_cost_center_name, c.name, c.category, c.sell_value::text,
              c.gross_profit_actual::text, c.net_profit_actual::text, c.net_margin_actual::text,
              c.materials_cost_actual::text, c.materials_cost_estimate::text,
              c.labor_cost_actual::text, c.labor_cost_estimate::text,
              c.labor_hours_actual::text, c.labor_hours_estimate::text,
              c.overhead_cost_actual::text, c.overhead_cost_estimate::text, c.labor_quoted_hours::text,
              c.material_cost_value::text, c.source_deleted_at::text
         from metrics.metrics_job_cost_centers c
         join metrics.metrics_jobs j on j.job_id = c.job_id
        where j.completed_date between $1::date and $2::date
          and lower(trim(j.stage)) in ('complete', 'archived')
          and j.source_deleted_at is null
	        order by c.job_id, c.section_id, c.cost_center_id`,
      [params.periodStart, params.periodEnd],
    ),
    queryPostgres<TimesheetRow>(
      `select j.job_id::text, t.timesheet_id, t.employee_id::text,
              coalesce(p.display_name, e.display_name) as technician_name,
              t.work_date::text, t.total_hours::text, t.source_deleted_at::text
         from metrics.metrics_employee_timesheets t
         join metrics.metrics_jobs j
           on lower(trim(coalesce(t.reference_type, ''))) = 'job' and t.reference_id = j.job_id
         left join metrics.dim_people p on p.person_id = t.person_id
         left join metrics.employee_snapshots e on e.employee_id = t.employee_id
        where j.completed_date between $1::date and $2::date
          and lower(trim(j.stage)) in ('complete', 'archived')
          and j.source_deleted_at is null
	        order by j.job_id, t.employee_id, t.timesheet_id`,
      [params.periodStart, params.periodEnd],
    ),
    queryPostgres<QuoteLaborRow>(
      `with completed_jobs as (
         select j.job_id, source_quote.source_quote_id
           from metrics.metrics_jobs j
           left join metrics.job_source_quotes source_quote on source_quote.job_id = j.job_id
          where j.completed_date between $1::date and $2::date
            and lower(trim(j.stage)) in ('complete', 'archived')
            and j.source_deleted_at is null
       )
       select completed_jobs.job_id::text,
              concat_ws(':', labor.quote_id, labor.section_id, labor.cost_center_id, labor.labor_id) as labor_id,
              labor.quantity_hours::text, labor.source_deleted_at::text
         from completed_jobs
         join metrics.metrics_quote_labor labor
           on labor.quote_id = completed_jobs.source_quote_id
	        order by completed_jobs.job_id, labor.section_id, labor.cost_center_id, labor.labor_id`,
      [params.periodStart, params.periodEnd],
    ),
  ]);

  const costCenters = groupByJob(costCenterResult.rows, costCenterInput);
  const timesheets = groupByJob(timesheetResult.rows, timesheetInput);
  const quoteLabor = groupByJob(quoteLaborResult.rows, quoteLaborInput);

  return jobResult.rows.map((row) => ({
    jobId: row.job_id,
    jobNo: row.job_no,
    name: row.name,
    description: row.description,
    statusName: row.status_name,
    completedDate: row.completed_date,
    stageName: row.stage,
    sellValue: nullableNumber(row.total),
    grossProfitActual: nullableNumber(row.gross_profit_actual),
    grossMarginActual: nullableNumber(row.gross_margin_actual),
    netProfitActual: nullableNumber(row.net_profit_actual),
    netMarginActual: nullableNumber(row.net_margin_actual),
    materialsCostActual: nullableNumber(row.materials_cost_actual),
    materialsCostEstimate: nullableNumber(row.materials_cost_estimate),
    laborCostActual: nullableNumber(row.labor_cost_actual),
    laborCostEstimate: nullableNumber(row.labor_cost_estimate),
    laborHoursActual: nullableNumber(row.labor_hours_actual),
    laborHoursEstimate: nullableNumber(row.labor_hours_estimate),
    overheadCostActual: nullableNumber(row.overhead_cost_actual),
    overheadCostEstimate: nullableNumber(row.overhead_cost_estimate),
    totalResourceCostActual: nullableNumber(row.total_resource_cost_actual),
    totalResourceCostEstimate: nullableNumber(row.total_resource_cost_estimate),
    commissionCostActual: nullableNumber(row.commission_cost_actual),
    jobSourceType: row.job_source_type,
    jobSourceId: row.job_source_id,
    customerName: row.customer_name,
    siteId: row.site_id,
    siteName: row.site_name,
    convertedFromType: row.converted_from_type,
    convertedFromId: row.converted_from_id,
    sourceQuoteId: row.source_quote_id,
    category: row.category,
    materialCoverage: row.material_coverage,
    costCenters: costCenters.get(row.job_id) ?? [],
    quoteLabor: quoteLabor.get(row.job_id) ?? [],
    timesheets: timesheets.get(row.job_id) ?? [],
    sourceDeletedAt: row.source_deleted_at,
  }));
}

/**
 * DateIssued quote rows for the direct-service follow-up linkage. Site identity
 * comes from metrics_quotes.site_id/site_name (migration 041). Loaded across
 * the full serving history so every monthly read model links consistently.
 */
export async function getIssuedQuoteInputs(): Promise<IssuedQuoteInput[]> {
  try {
    const result = await queryPostgres<IssuedQuoteRow>(
      `select q.quote_id::text, q.date_issued::text, q.site_id::text, q.site_name, q.total::text as total_value
         from metrics.metrics_quotes q
        where q.source_deleted_at is null
          and q.date_issued is not null
          and q.date_issued >= date '2023-01-01'
        order by q.date_issued, q.quote_id`,
    );
    return result.rows.map((row) => ({
      quoteId: row.quote_id,
      dateIssued: row.date_issued,
      siteId: row.site_id,
      siteName: row.site_name,
      totalValue: nullableNumber(row.total_value),
    }));
  } catch (error) {
    // Migration-041 columns are tolerated as absent only under the Node test runtime.
    if (allowsMissingMigration026InTests(error)) return [];
    throw error;
  }
}

export async function getJobReconciliations(
  periodStart: string,
  periodEnd: string,
  query: PostgresQuery = queryPostgres,
): Promise<JobReconciliationInput[]> {
  const result = await query<ReconciliationRow>(
    `select authority.period_start::text,
            case when authority.status = 'sample_missing' then 'failed' else authority.status end as status,
            coalesce(authority.detail #>> '{source,count}', authority.detail #>> '{upstream,count}') as upstream_count,
            coalesce(authority.detail #>> '{source,total}', authority.snapshot_value::text, authority.upstream_sample_value::text) as upstream_value,
            coalesce(authority.detail #>> '{dashboard,count}', authority.detail #>> '{rollup,count}') as rollup_count,
            authority.rollup_value::text, authority.checked_at::text
       from metrics.authoritative_reconciliation_results authority
       join metrics.source_period_manifests jobs_manifest
         on jobs_manifest.source_family = 'jobs'
        and jobs_manifest.period_start = authority.period_start
        and jobs_manifest.period_end = authority.period_end
       join metrics.source_period_manifests nested_manifest
         on nested_manifest.source_family = 'job_nested'
        and nested_manifest.period_start = authority.period_start
        and nested_manifest.period_end = authority.period_end
      where authority.scope = 'jobs'
        and authority.status in ('matched', 'mismatch', 'sample_missing')
        and authority.period_start between $1::date and $2::date
        and authority.generation is not null
        and authority.source_manifest_generations ->> 'jobs' = authority.generation::text
        and authority.source_manifest_generations ->> 'job_nested' = authority.generation::text
        and jobs_manifest.manifest_generation = authority.generation
        and jobs_manifest.reconciliation_generation = authority.generation
        and jobs_manifest.coverage_status = 'complete'
        and jobs_manifest.reconciliation_status = 'matched'
        and jobs_manifest.expected_page_count > 0
        and jobs_manifest.completed_page_count = jobs_manifest.expected_page_count
        and nested_manifest.manifest_generation = authority.generation
        and nested_manifest.reconciliation_generation = authority.generation
        and nested_manifest.coverage_status = 'complete'
        and nested_manifest.reconciliation_status = 'matched'
        and nested_manifest.expected_page_count > 0
        and nested_manifest.completed_page_count = nested_manifest.expected_page_count
      order by authority.period_start`,
    [periodStart, periodEnd],
  );
  return result.rows.map((row) => ({
    periodStart: row.period_start,
    status: row.status,
    sourceCount: nullableNumber(row.upstream_count),
    sourceValue: nullableNumber(row.upstream_value),
    rollupCount: nullableNumber(row.rollup_count),
    rollupValue: nullableNumber(row.rollup_value),
    checkedAt: row.checked_at,
  }));
}

function costCenterInput(row: CostCenterRow): JobCostCenterInput {
  return {
    sectionId: row.section_id,
    costCenterId: row.cost_center_id,
    configuredCostCenterId: row.configured_cost_center_id,
    configuredCostCenterName: row.configured_cost_center_name,
    name: row.name,
    category: row.category,
    sellValue: nullableNumber(row.sell_value),
    grossProfitActual: nullableNumber(row.gross_profit_actual),
    netProfitActual: nullableNumber(row.net_profit_actual),
    netMarginActual: nullableNumber(row.net_margin_actual),
    materialsCostActual: nullableNumber(row.materials_cost_actual),
    materialsCostEstimate: nullableNumber(row.materials_cost_estimate),
    laborCostActual: nullableNumber(row.labor_cost_actual),
    laborCostEstimate: nullableNumber(row.labor_cost_estimate),
    laborHoursActual: nullableNumber(row.labor_hours_actual),
    laborHoursEstimate: nullableNumber(row.labor_hours_estimate),
    overheadCostActual: nullableNumber(row.overhead_cost_actual),
    overheadCostEstimate: nullableNumber(row.overhead_cost_estimate),
    quotedHours: nullableNumber(row.labor_quoted_hours),
    materialCostValue: nullableNumber(row.material_cost_value),
    sourceDeletedAt: row.source_deleted_at,
  };
}

function timesheetInput(row: TimesheetRow): JobTimesheetInput {
  return {
    timesheetId: row.timesheet_id,
    employeeId: row.employee_id,
    technicianName: row.technician_name,
    workDate: row.work_date,
    actualHours: nullableNumber(row.total_hours),
    sourceDeletedAt: row.source_deleted_at,
  };
}

function quoteLaborInput(row: QuoteLaborRow): JobQuoteLaborInput {
  return {
    laborId: row.labor_id,
    quotedHours: nullableNumber(row.quantity_hours),
    sourceDeletedAt: row.source_deleted_at,
  };
}

function groupByJob<Row extends { job_id: string }, Output>(rows: Row[], convert: (row: Row) => Output) {
  const grouped = new Map<string, Output[]>();
  for (const row of rows) grouped.set(row.job_id, [...(grouped.get(row.job_id) ?? []), convert(row)]);
  return grouped;
}

function filtersFromParams(params: { category?: string | null; costCenter?: string | null; technician?: string | null }): JobFilters {
  return { category: params.category, costCenter: params.costCenter, technician: params.technician };
}

function normalizeSelectedMonth(value: string | undefined, now: Date) {
  if (value && /^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return value;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit" }).formatToParts(now);
  const part = (type: "year" | "month") => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}`;
}

function monthEnd(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  const day = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return `${month}-${String(day).padStart(2, "0")}`;
}

function normalizedPage(value: number | undefined) {
  return Number.isInteger(value) && value! > 0 ? value! : 1;
}

function numericCount(value: number | string | undefined) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function nullableNumber(value: string | null): number | null {
  if (value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function allowsMissingMigration026InTests(error: unknown) {
  const isTestRuntime = process.env.NODE_ENV === "test"
    || process.execArgv.includes("--test")
    || process.argv.includes("--test");
  if (!isTestRuntime) return false;
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return code === "42703" || message.includes("column") && message.includes("does not exist");
}
