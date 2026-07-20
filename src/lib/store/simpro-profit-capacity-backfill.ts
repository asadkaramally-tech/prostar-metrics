import { createHash } from "node:crypto";
import { queryPostgres } from "@/lib/store/postgres";

export const SIMPRO_PROFIT_CAPACITY_CONTRACT_VERSION = "026";
export const SIMPRO_COMPLETED_JOB_STAGE_FILTER = "in(Complete,Archived)";
export const SIMPRO_PROFIT_CAPACITY_START_MONTH = "2023-01-01";

export type ProfitCapacityBackfillQuery = typeof queryPostgres;

export type ProfitCapacityBackfillEstimate = {
  startMonth: string;
  throughMonth: string;
  throughDate: string;
  months: number;
  approvedWorkUnits: number;
  expectedRecords: number;
  approvedEstimatedRequests: number;
  discoveryDays: number;
  missingJobDetails: number;
  missingCostCenterDetails: number;
  missingEmployeeDetails: number;
  minimumRequests: number;
};

export function completedJobDiscoveryParams(completedDate: string) {
  return {
    CompletedDate: canonicalDate(completedDate, "completedDate"),
    Stage: SIMPRO_COMPLETED_JOB_STAGE_FILTER,
    orderby: "ID",
  };
}

export async function estimateProfitCapacityBackfill(
  startMonth = SIMPRO_PROFIT_CAPACITY_START_MONTH,
  throughMonth = pacificMonthStart(),
  query: ProfitCapacityBackfillQuery = queryPostgres,
): Promise<ProfitCapacityBackfillEstimate> {
  const start = canonicalMonth(startMonth, "startMonth");
  const through = canonicalMonth(throughMonth, "throughMonth");
  if (start < SIMPRO_PROFIT_CAPACITY_START_MONTH) {
    throw new Error(`startMonth must be ${SIMPRO_PROFIT_CAPACITY_START_MONTH} or later.`);
  }
  if (through < start) throw new Error("throughMonth must not precede startMonth.");
  const throughDate = through === pacificMonthStart() ? pacificDate() : monthEndInclusive(through);

  const result = await query<{
    approved_work_units: number;
    expected_records: string;
    approved_estimated_requests: string;
    discovery_days: number;
    missing_job_details: number;
    missing_cost_center_details: number;
    missing_employee_details: number;
  }>(
    `select
       (select count(*)::integer
          from metrics.backfill_source_month_ledger
         where source_family in ('jobs', 'job_nested')
           and month_start between $1::date and $2::date) as approved_work_units,
       (select coalesce(sum(expected_records), 0)::text
          from metrics.backfill_source_month_ledger
         where source_family in ('jobs', 'job_nested')
           and month_start between $1::date and $2::date) as expected_records,
       (select coalesce(sum(estimated_requests), 0)::text
          from metrics.backfill_source_month_ledger
         where source_family in ('jobs', 'job_nested')
           and month_start between $1::date and $2::date) as approved_estimated_requests,
       ($3::date - $1::date + 1)::integer as discovery_days,
       (select count(*)::integer
          from metrics.metrics_jobs job
         where job.completed_date between $1::date and $3::date
           and job.stage in ('Complete', 'Archived')
           and job.source_deleted_at is null
           and job.profit_capacity_normalized_at is null) as missing_job_details,
       (select count(*)::integer
          from metrics.metrics_job_cost_centers cost_center
          join metrics.metrics_jobs job on job.job_id = cost_center.job_id
         where job.completed_date between $1::date and $3::date
           and job.stage in ('Complete', 'Archived')
           and job.source_deleted_at is null
           and cost_center.source_deleted_at is null
           and not cost_center.totals_authoritative) as missing_cost_center_details,
       (select count(*)::integer
          from metrics.dim_people employee
         where employee.simpro_employee_id is not null
           and employee.capacity_normalized_at is null) as missing_employee_details`,
    [start, through, throughDate],
  );
  const row = result.rows[0];
  const discoveryDays = Number(row?.discovery_days ?? 0);
  const missingJobDetails = Number(row?.missing_job_details ?? 0);
  const missingCostCenterDetails = Number(row?.missing_cost_center_details ?? 0);
  const missingEmployeeDetails = Number(row?.missing_employee_details ?? 0);
  return {
    startMonth: start,
    throughMonth: through,
    throughDate,
    months: monthCount(start, through),
    approvedWorkUnits: Number(row?.approved_work_units ?? 0),
    expectedRecords: Number(row?.expected_records ?? 0),
    approvedEstimatedRequests: Number(row?.approved_estimated_requests ?? 0),
    discoveryDays,
    missingJobDetails,
    missingCostCenterDetails,
    missingEmployeeDetails,
    minimumRequests: discoveryDays + missingJobDetails + missingCostCenterDetails + missingEmployeeDetails,
  };
}

export async function enqueueProfitCapacityBackfill(params: {
  startMonth?: string;
  throughMonth?: string;
  approvedBy: string;
  query?: ProfitCapacityBackfillQuery;
}) {
  const query = params.query ?? queryPostgres;
  const approvedBy = params.approvedBy.trim().toLowerCase();
  if (!approvedBy) throw new Error("approvedBy is required.");
  const estimate = await estimateProfitCapacityBackfill(params.startMonth, params.throughMonth, query);
  if (estimate.approvedWorkUnits !== estimate.months * 2) {
    throw new Error(
      `Backfill ledger is incomplete for this range: expected ${estimate.months * 2} approved jobs/job_nested units, found ${estimate.approvedWorkUnits}.`,
    );
  }

  const entityId = `simpro-profit-capacity-${SIMPRO_PROFIT_CAPACITY_CONTRACT_VERSION}:${estimate.startMonth}:${estimate.throughMonth}`;
  const planHash = createHash("sha256").update(JSON.stringify({ entityId, estimate })).digest("hex");
  const result = await query<{
    generation: number;
    discovery_queued: number;
    job_details_queued: number;
    employees_queued: number;
  }>(
    `with lock_scope as materialized (
       select pg_advisory_xact_lock(hashtext($3::text))
     ), run_generation as materialized (
       select coalesce(max(
                case when audit.after_value ->> 'generation' ~ '^[0-9]+$'
                  then (audit.after_value ->> 'generation')::integer
                end
              ), 0) + 1 as generation
         from metrics.audit_events audit
         cross join lock_scope
        where audit.action = 'simpro_profit_capacity_backfill_queued'
          and audit.entity_type = 'backfill_contract'
          and audit.entity_id = $3
     ), discovery_candidates as materialized (
       select day::date as completed_date
         from generate_series($1::date, $2::date, interval '1 day') day
     ), discovery as (
       insert into metrics.ingestion_jobs (
         entity_type, idempotency_key, priority, request_budget, params
       )
       select 'jobs'::metrics.ingestion_entity_type,
              'jobs:' || candidate.completed_date::text || ':simpro-profit-capacity-${SIMPRO_PROFIT_CAPACITY_CONTRACT_VERSION}',
              15, 250,
              jsonb_build_object(
                'CompletedDate', candidate.completed_date::text,
                'Stage', '${SIMPRO_COMPLETED_JOB_STAGE_FILTER}',
                'orderby', 'ID',
                'contract', $3::text,
                'seedGeneration', run_generation.generation
              )
         from discovery_candidates candidate
         cross join run_generation
       on conflict (entity_type, idempotency_key) do update set
         priority = least(metrics.ingestion_jobs.priority, excluded.priority),
         request_budget = case
           when metrics.ingestion_jobs.status = 'succeeded' then excluded.request_budget
           else greatest(metrics.ingestion_jobs.request_budget, metrics.ingestion_jobs.requests_used + excluded.request_budget)
         end,
         generation = case
           when metrics.ingestion_jobs.status = 'succeeded' then metrics.ingestion_jobs.generation + 1
           else metrics.ingestion_jobs.generation
         end,
         status = 'queued'::metrics.ingestion_job_status,
         attempts = 0,
         last_error = null,
         dead_lettered_at = null,
         requests_used = case when metrics.ingestion_jobs.status = 'succeeded' then 0 else metrics.ingestion_jobs.requests_used end,
         continuation_token = case when metrics.ingestion_jobs.status = 'succeeded' then excluded.continuation_token else metrics.ingestion_jobs.continuation_token end,
         page_cursor = case when metrics.ingestion_jobs.status = 'succeeded' then excluded.continuation_token else metrics.ingestion_jobs.page_cursor end,
         completed_at = null,
         params = case when metrics.ingestion_jobs.status = 'succeeded' then excluded.params else metrics.ingestion_jobs.params end,
         next_attempt_at = now(),
         updated_at = now()
       where metrics.ingestion_jobs.status in ('failed', 'cancelled', 'succeeded')
       returning id
     ), missing_jobs as materialized (
       select distinct job.job_id
         from metrics.metrics_jobs job
         left join metrics.metrics_job_cost_centers cost_center
           on cost_center.job_id = job.job_id
          and cost_center.source_deleted_at is null
          and not cost_center.totals_authoritative
        where job.completed_date between $1::date and $2::date
          and job.stage in ('Complete', 'Archived')
          and job.source_deleted_at is null
          and (job.profit_capacity_normalized_at is null or cost_center.job_id is not null)
     ), job_details as (
       insert into metrics.ingestion_jobs (
         entity_type, idempotency_key, priority, request_budget, params
       )
       select 'job_nested'::metrics.ingestion_entity_type,
              'job_nested:' || job_id::text || ':simpro-profit-capacity-${SIMPRO_PROFIT_CAPACITY_CONTRACT_VERSION}',
              10, 250,
              jsonb_build_object(
                'entityId', job_id,
                'contract', $3::text,
                'seedGeneration', run_generation.generation
              )
         from missing_jobs
         cross join run_generation
       on conflict (entity_type, idempotency_key) do update set
         priority = least(metrics.ingestion_jobs.priority, excluded.priority),
         request_budget = case
           when metrics.ingestion_jobs.status = 'succeeded' then excluded.request_budget
           else greatest(metrics.ingestion_jobs.request_budget, metrics.ingestion_jobs.requests_used + excluded.request_budget)
         end,
         generation = case
           when metrics.ingestion_jobs.status = 'succeeded' then metrics.ingestion_jobs.generation + 1
           else metrics.ingestion_jobs.generation
         end,
         status = 'queued'::metrics.ingestion_job_status,
         attempts = 0,
         last_error = null,
         dead_lettered_at = null,
         requests_used = case when metrics.ingestion_jobs.status = 'succeeded' then 0 else metrics.ingestion_jobs.requests_used end,
         continuation_token = case when metrics.ingestion_jobs.status = 'succeeded' then excluded.continuation_token else metrics.ingestion_jobs.continuation_token end,
         page_cursor = case when metrics.ingestion_jobs.status = 'succeeded' then excluded.continuation_token else metrics.ingestion_jobs.page_cursor end,
         completed_at = null,
         params = case when metrics.ingestion_jobs.status = 'succeeded' then excluded.params else metrics.ingestion_jobs.params end,
         next_attempt_at = now(),
         updated_at = now()
       where metrics.ingestion_jobs.status in ('failed', 'cancelled', 'succeeded')
       returning id
     ), employees as (
       insert into metrics.ingestion_jobs (
         entity_type, idempotency_key, priority, request_budget, params
       )
       select 'employees'::metrics.ingestion_entity_type,
              'employees:' || simpro_employee_id::text || ':simpro-profit-capacity-${SIMPRO_PROFIT_CAPACITY_CONTRACT_VERSION}',
              12, 5,
              jsonb_build_object(
                'entityId', simpro_employee_id,
                'contract', $3::text,
                'seedGeneration', run_generation.generation
              )
         from metrics.dim_people
         cross join run_generation
        where simpro_employee_id is not null and capacity_normalized_at is null
       on conflict (entity_type, idempotency_key) do update set
         priority = least(metrics.ingestion_jobs.priority, excluded.priority),
         request_budget = case
           when metrics.ingestion_jobs.status = 'succeeded' then excluded.request_budget
           else greatest(metrics.ingestion_jobs.request_budget, metrics.ingestion_jobs.requests_used + excluded.request_budget)
         end,
         generation = case
           when metrics.ingestion_jobs.status = 'succeeded' then metrics.ingestion_jobs.generation + 1
           else metrics.ingestion_jobs.generation
         end,
         status = 'queued'::metrics.ingestion_job_status,
         attempts = 0,
         last_error = null,
         dead_lettered_at = null,
         requests_used = case when metrics.ingestion_jobs.status = 'succeeded' then 0 else metrics.ingestion_jobs.requests_used end,
         continuation_token = case when metrics.ingestion_jobs.status = 'succeeded' then excluded.continuation_token else metrics.ingestion_jobs.continuation_token end,
         page_cursor = case when metrics.ingestion_jobs.status = 'succeeded' then excluded.continuation_token else metrics.ingestion_jobs.page_cursor end,
         completed_at = null,
         params = case when metrics.ingestion_jobs.status = 'succeeded' then excluded.params else metrics.ingestion_jobs.params end,
         next_attempt_at = now(),
         updated_at = now()
       where metrics.ingestion_jobs.status in ('failed', 'cancelled', 'succeeded')
       returning id
     ), audit as (
       insert into metrics.audit_events (
         actor_email, action, entity_type, entity_id, after_value, reason
       )
       select $4, 'simpro_profit_capacity_backfill_queued', 'backfill_contract', $3,
              jsonb_build_object(
                'generation', run_generation.generation,
                'startDate', $1::date, 'throughDate', $2::date,
                'discoveryQueued', (select count(*) from discovery),
                'jobDetailsQueued', (select count(*) from job_details),
                'employeesQueued', (select count(*) from employees),
                'planHash', $5::text
              ),
              'Queue CompletedDate plus Complete/Archived Stage discovery and missing authoritative details.'
         from run_generation
       returning id
     )
     select (select generation from run_generation)::integer as generation,
            (select count(*)::integer from discovery) as discovery_queued,
            (select count(*)::integer from job_details) as job_details_queued,
            (select count(*)::integer from employees) as employees_queued
       from audit`,
    [estimate.startMonth, estimate.throughDate, entityId, approvedBy, planHash],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Backfill queue generation was not recorded.");
  const queued = {
    discovery: Number(row.discovery_queued),
    jobDetails: Number(row.job_details_queued),
    employees: Number(row.employees_queued),
  };
  const idempotent = queued.discovery + queued.jobDetails + queued.employees === 0;
  return { estimate, queued, idempotent, generation: Number(row.generation), entityId };
}

function canonicalDate(value: string, field: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${field} must use YYYY-MM-DD.`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`${field} is not a valid calendar date.`);
  }
  return value;
}

function canonicalMonth(value: string, field: string) {
  const normalized = /^\d{4}-\d{2}$/.test(value) ? `${value}-01` : value;
  canonicalDate(normalized, field);
  if (!normalized.endsWith("-01")) throw new Error(`${field} must be the first day of a month.`);
  return normalized;
}

function monthCount(start: string, through: string) {
  const [startYear, startMonth] = start.split("-").map(Number);
  const [endYear, endMonth] = through.split("-").map(Number);
  return (endYear - startYear) * 12 + endMonth - startMonth + 1;
}

function monthEndInclusive(monthStart: string) {
  const date = new Date(`${monthStart}T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() + 1);
  date.setUTCDate(0);
  return date.toISOString().slice(0, 10);
}

function pacificDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function pacificMonthStart(date = new Date()) {
  return `${pacificDate(date).slice(0, 7)}-01`;
}
