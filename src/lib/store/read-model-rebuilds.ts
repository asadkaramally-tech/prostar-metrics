import { createHash } from "node:crypto";
import type { CommissionReadModel } from "@/lib/metrics/commissions";
import type { FreshnessStatus } from "@/lib/metrics/freshness";
import {
  buildJobMetricsDashboard,
  buildJobMonthlyReadModel,
  type JobMetricsDashboardReadModel,
  type NormalizedJobSnapshot,
} from "@/lib/metrics/jobs";
import type { MaterialsReadModel } from "@/lib/metrics/materials";
import { buildQuoteMonthlyReadModel, type NormalizedQuoteSnapshot, type QuoteMonthlyReadModel } from "@/lib/metrics/quotes";
import { buildTechnicianPerformanceReadModel } from "@/lib/metrics/technicians";
import { buildMaterialsReadModelPayload } from "@/lib/store/materials-read-model";
import { BACKFILL_START_MONTH, businessCurrentMonth } from "@/lib/backfill/plan";
import { queryPostgres, withPostgresTransaction, type PostgresQuery } from "@/lib/store/postgres";
import {
  buildQuoteMetricsReadModel,
  buildPersistedQuoteDashboardRecords,
  loadQuoteDashboardRows,
  type PersistedQuoteDashboardRecord,
  type QuoteMetricsReadModel,
} from "@/lib/store/quote-dashboard-read-model";
import {
  assertCommissionRebuildPublishable,
  persistCommissionRebuildArtifactInTransaction,
  prepareCommissionRebuildArtifact,
  type CommissionRebuildArtifact,
} from "@/lib/store/commission-rebuild";
import type { RollupScope } from "@/lib/store/rollups";
import { getIssuedQuoteInputs, getJobMetricInputs, getJobReconciliations } from "@/lib/store/job-dashboard-read-model";
import { getTechnicianPerformanceInputs } from "@/lib/store/technician-read-model-inputs";
import {
  assertCurrentTechnicianReadModel,
  assertServeableTechnicianReadModel,
} from "@/lib/store/technician-read-model-contract";

export type QuoteDashboardReadModelPayload = QuoteMonthlyReadModel & {
  dashboard: QuoteMetricsReadModel;
  quoteRecords: PersistedQuoteDashboardRecord[];
};
export type JobDashboardReadModelPayload = ReturnType<typeof buildJobMonthlyReadModel> & {
  dashboard: JobMetricsDashboardReadModel;
};

export type ReadModelPayload = QuoteDashboardReadModelPayload
  | JobDashboardReadModelPayload
  | ReturnType<typeof buildTechnicianPerformanceReadModel>
  | CommissionReadModel
  | MaterialsReadModel;

export type RollupRebuildJob = {
  id: number;
  metric_family: RollupScope;
  period_grain: "month";
  period_start: string;
  dimensions_json: Record<string, unknown>;
  locked_by: string;
};

type JobDashboardSourceInputs = {
  jobs: NormalizedJobSnapshot[];
  reconciliations: Awaited<ReturnType<typeof getJobReconciliations>>;
  issuedQuotes: Awaited<ReturnType<typeof getIssuedQuoteInputs>>;
};

let jobDashboardSourceInputs: Promise<JobDashboardSourceInputs> | null = null;

export type RollupRebuildQuery = <T = Record<string, unknown>>(
  text: string,
  values?: unknown[],
) => Promise<{ rows: T[] }>;

export type RollupRebuildTransaction = <T>(
  callback: (query: PostgresQuery) => Promise<T>,
) => Promise<T>;

type RollupMutationOptions = { query?: RollupRebuildQuery; lockedBy?: string };

export async function enqueueRollupRebuild(params: {
  metricFamily: RollupScope;
  periodStart: string;
  reason: string;
  dimensions?: Record<string, unknown>;
  idempotencyKey?: string;
  preserveSucceeded?: boolean;
}, query: RollupRebuildQuery = queryPostgres): Promise<{ id: number; status: string } | null> {
  if (!isServedRollupPeriod(params.periodStart)) return null;

  const dimensions = params.dimensions ?? {};
  const idempotencyKey = params.idempotencyKey ?? `${params.metricFamily}:month:${params.periodStart}:${hashJson(dimensions)}`;
  const result = await query<{ id: string; status: string }>(
    `with enqueued as (
       insert into metrics.rollup_rebuild_queue (
         metric_family, period_grain, period_start, dimensions_json, reason, idempotency_key
       )
       values ($1, 'month', $2::date, $3::jsonb, $4, $5)
       on conflict (idempotency_key) do update set
         status = case
           when $6::boolean and metrics.rollup_rebuild_queue.status = 'succeeded'
             then metrics.rollup_rebuild_queue.status
           when metrics.rollup_rebuild_queue.status = 'running'
             and metrics.rollup_rebuild_queue.locked_until > now()
             then metrics.rollup_rebuild_queue.status
           else 'queued'::metrics.rollup_rebuild_status
         end,
         attempts = case
           when $6::boolean and metrics.rollup_rebuild_queue.status = 'succeeded'
             then metrics.rollup_rebuild_queue.attempts
           when metrics.rollup_rebuild_queue.status = 'running'
             and metrics.rollup_rebuild_queue.locked_until > now()
             then metrics.rollup_rebuild_queue.attempts
           else 0
         end,
         locked_by = case
           when $6::boolean and metrics.rollup_rebuild_queue.status = 'succeeded'
             then metrics.rollup_rebuild_queue.locked_by
           when metrics.rollup_rebuild_queue.status = 'running'
             and metrics.rollup_rebuild_queue.locked_until > now()
             then metrics.rollup_rebuild_queue.locked_by
           else null
         end,
         locked_until = case
           when $6::boolean and metrics.rollup_rebuild_queue.status = 'succeeded'
             then metrics.rollup_rebuild_queue.locked_until
           when metrics.rollup_rebuild_queue.status = 'running'
             and metrics.rollup_rebuild_queue.locked_until > now()
             then metrics.rollup_rebuild_queue.locked_until
           else null
         end,
         reason = case
           when $6::boolean and metrics.rollup_rebuild_queue.status = 'succeeded'
             then metrics.rollup_rebuild_queue.reason
           else excluded.reason
         end,
         finished_at = case
           when $6::boolean and metrics.rollup_rebuild_queue.status = 'succeeded'
             then metrics.rollup_rebuild_queue.finished_at
           else null
         end,
         error_message = case
           when $6::boolean and metrics.rollup_rebuild_queue.status = 'succeeded'
             then metrics.rollup_rebuild_queue.error_message
           else null
         end
       where not ($6::boolean and metrics.rollup_rebuild_queue.status = 'succeeded')
       returning id, metric_family, period_grain, period_start, dimensions_json, status
     ), stale_siblings as (
       update metrics.rollup_rebuild_queue sibling
          set status = 'cancelled',
              locked_by = null,
              locked_until = null,
              finished_at = coalesce(sibling.finished_at, now()),
              error_message = coalesce(sibling.error_message, '') || ' [Superseded by a newer queued rebuild.]'
         from enqueued
        where sibling.id <> enqueued.id
          and sibling.status in ('queued', 'failed')
          and sibling.metric_family = enqueued.metric_family
          and sibling.period_grain = enqueued.period_grain
          and sibling.period_start = enqueued.period_start
          and sibling.dimensions_json = enqueued.dimensions_json
        returning sibling.id
     )
     select id::text, status::text from enqueued`,
    [params.metricFamily, params.periodStart, JSON.stringify(dimensions), params.reason, idempotencyKey, params.preserveSucceeded ?? false],
  );
  const row = result.rows[0];
  return row ? { id: Number(row.id), status: row.status } : null;
}

export async function claimNextRollupRebuild(
  workerId: string,
  metricFamily?: RollupScope,
  excludeJobIds: number[] = [],
  query: RollupRebuildQuery = queryPostgres,
): Promise<RollupRebuildJob | null> {
  const result = await query<Omit<RollupRebuildJob, "id"> & { id: string | number }>(
    `with exhausted as (
       update metrics.rollup_rebuild_queue
          set status = 'failed'::metrics.rollup_rebuild_status,
              locked_by = null,
              locked_until = null,
              finished_at = now(),
              error_message = coalesce(error_message, 'worker lease expired after maximum attempts')
        where status = 'running'
          and locked_until is not null
          and locked_until < now()
          and attempts >= 5
        returning id
     ), next_job as (
       select id
       from metrics.rollup_rebuild_queue
       where (
           (status = 'queued' and (locked_until is null or locked_until < now()))
           or (status = 'running' and locked_until is not null and locked_until < now() and attempts < 5)
         )
         and ($2::text is null or metric_family = $2)
         and not (id = any($3::bigint[]))
         and period_start >= $4::date
         and period_start <= $5::date
       order by case when status = 'running' then 0 else 1 end, period_start desc, id asc
       for update skip locked
       limit 1
     )
     update metrics.rollup_rebuild_queue q
     set status = 'running',
         attempts = case
           when q.status = 'queued' and q.error_message is null then 1
           else q.attempts + 1
         end,
         locked_by = $1,
         locked_until = now() + interval '10 minutes',
         finished_at = null
     from next_job
     where q.id = next_job.id
     returning q.id, q.metric_family, q.period_grain, q.period_start::text, q.dimensions_json, q.locked_by`,
    [workerId, metricFamily ?? null, excludeJobIds, BACKFILL_START_MONTH, businessCurrentMonth()],
  );

  const row = result.rows[0];
  if (!row) return null;
  const id = Number(row.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error("PostgreSQL returned an invalid rollup rebuild job id.");
  }
  return { ...row, id };
}

export async function rebuildReadModelForJob(job: RollupRebuildJob): Promise<ReadModelPayload> {
  if (!isServedRollupPeriod(job.period_start)) {
    throw new Error(`Rollup period ${job.period_start} is outside the approved 2023-current serving window.`);
  }
  await assertRollupLease(job);
  const period = monthWindow(job.period_start);
  if (job.metric_family === "commissions") {
    const artifact = await prepareCommissionRebuildArtifact({
      periodStart: period.start,
      periodEnd: period.end,
      actorEmail: "metrics-rollup-worker",
    });
    await publishCommissionReadModelForJob({ job, artifact, actorEmail: "metrics-rollup-worker" });
    return artifact.readModel;
  }

  const payload = await buildPayload(job.metric_family, period.start, period.end);
  await publishReadModelForJob(job, payload, queryPostgres);
  await completeRollupRebuild(job);
  return payload;
}

export async function publishCommissionReadModelForJob(
  params: {
    job: RollupRebuildJob;
    artifact: CommissionRebuildArtifact;
    actorEmail: string;
  },
  transaction: RollupRebuildTransaction = withPostgresTransaction,
): Promise<void> {
  const { job, artifact } = params;
  if (job.metric_family !== "commissions"
      || job.period_grain !== "month"
      || artifact.periodStart !== job.period_start
      || JSON.stringify(job.dimensions_json ?? {}) !== "{}") {
    throw new Error(`Commission publication scope does not exactly match queue job ${job.id}.`);
  }
  assertCommissionRebuildPublishable(artifact);

  await transaction(async (query) => {
    await assertRollupLease(job, query, true);
    await persistCommissionRebuildArtifactInTransaction({
      artifact,
      rebuiltByJobId: job.id,
      lockedBy: job.locked_by,
      actorEmail: params.actorEmail,
    }, query);
    await publishReadModelForJob(job, artifact.readModel, query);
    await completeRollupRebuild(job, query);
  });
}

async function publishReadModelForJob(
  job: RollupRebuildJob,
  payload: ReadModelPayload,
  query: RollupRebuildQuery,
): Promise<void> {
  if (job.metric_family === "technicians") {
    assertCurrentTechnicianReadModel(payload, `${job.metric_family}/${job.period_start}`);
  }
  const sourceHash = readModelSourceHash(payload);
  const published = await query<{ metric_family: string }>(
    `insert into metrics.dashboard_read_models (
       metric_family, period_grain, period_start, dimensions_json, values_json,
       status, source_hash, rebuilt_by_job_id, rebuilt_at, source_coverage_json
     )
     select $1, $2, $3::date, $4::jsonb, $5::jsonb, 'ready', $6, $7, now(), $8::jsonb
       from metrics.rollup_rebuild_queue lease
      where lease.id = $7
        and lease.metric_family = $1
        and lease.period_grain = $2
        and lease.period_start = $3::date
        and lease.dimensions_json = $4::jsonb
        and lease.status = 'running'
        and lease.locked_by = $9
        and lease.locked_until > clock_timestamp()
     on conflict (metric_family, period_grain, period_start, dimensions_json) do update set
       values_json = excluded.values_json,
       status = excluded.status,
       source_hash = excluded.source_hash,
       rebuilt_by_job_id = excluded.rebuilt_by_job_id,
       rebuilt_at = case
         when metrics.dashboard_read_models.source_hash = excluded.source_hash
           then metrics.dashboard_read_models.rebuilt_at
         else now()
       end,
       source_coverage_json = excluded.source_coverage_json,
       superseded_at = null,
       suspect_reason = null
     returning metric_family`,
    [
      job.metric_family,
      job.period_grain,
      job.period_start,
      JSON.stringify(job.dimensions_json ?? {}),
      JSON.stringify(payload),
      sourceHash,
      job.id,
      JSON.stringify(extractCoverage(payload)),
      job.locked_by,
    ],
  );
  if (published.rows.length !== 1) throw new Error(`Lost rollup lease for job ${job.id} before read-model publication.`);
}

export async function completeRollupRebuild(
  job: RollupRebuildJob,
  query: RollupRebuildQuery = queryPostgres,
): Promise<void> {
  const completed = await query<{ id: string }>(
    `with completed as (
       update metrics.rollup_rebuild_queue
          set status = 'succeeded',
              finished_at = now(),
              locked_by = null,
              locked_until = null,
              error_message = null,
              attempts = 0
        where id = $1
          and metric_family = $2
          and period_grain = $3
          and period_start = $4::date
          and dimensions_json = $5::jsonb
          and status = 'running'
          and locked_by = $6
          and locked_until > clock_timestamp()
        returning id, metric_family, period_grain, period_start, dimensions_json
     ), siblings as (
       update metrics.rollup_rebuild_queue sibling
        set status = 'cancelled',
            locked_by = null,
            locked_until = null,
            finished_at = coalesce(sibling.finished_at, now()),
            error_message = coalesce(sibling.error_message, '') || ' [Superseded by a newer successful rebuild.]'
       from completed
      where sibling.id <> completed.id
        and sibling.status in ('queued', 'failed')
        and sibling.metric_family = completed.metric_family
        and sibling.period_grain = completed.period_grain
        and sibling.period_start = completed.period_start
        and sibling.dimensions_json = completed.dimensions_json
        returning sibling.id
     )
     select id::text from completed`,
    [job.id, job.metric_family, job.period_grain, job.period_start, JSON.stringify(job.dimensions_json ?? {}), job.locked_by],
  );
  if (completed.rows.length !== 1) {
    throw new Error(`Lost rollup lease for job ${job.id} before queue completion.`);
  }
}

export async function heartbeatRollupRebuild(
  job: RollupRebuildJob,
  query: RollupRebuildQuery = queryPostgres,
): Promise<void> {
  const result = await query<{ id: string }>(
    `update metrics.rollup_rebuild_queue
        set locked_until = clock_timestamp() + interval '10 minutes'
      where id = $1
        and metric_family = $2
        and period_grain = $3
        and period_start = $4::date
        and dimensions_json = $5::jsonb
        and status = 'running'
        and locked_by = $6
        and locked_until > clock_timestamp()
      returning id::text`,
    [job.id, job.metric_family, job.period_grain, job.period_start, JSON.stringify(job.dimensions_json ?? {}), job.locked_by],
  );
  if (result.rows.length !== 1) throw new Error(`Lost rollup lease for job ${job.id}.`);
}

export function isServedRollupPeriod(periodStart: string, now = new Date()) {
  if (!/^\d{4}-\d{2}-01$/.test(periodStart)) return false;
  const parsed = new Date(`${periodStart}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== periodStart) return false;
  return periodStart >= BACKFILL_START_MONTH && periodStart <= businessCurrentMonth(now);
}

export async function failRollupRebuild(
  jobId: number,
  error: unknown,
  queryOrOptions: RollupRebuildQuery | RollupMutationOptions = queryPostgres,
) {
  const { query, lockedBy } = rollupMutationOptions(queryOrOptions);
  const message = error instanceof Error ? error.message : String(error);
  await query(
    `update metrics.rollup_rebuild_queue
     set status = case when attempts >= 5 then 'failed'::metrics.rollup_rebuild_status else 'queued'::metrics.rollup_rebuild_status end,
         locked_by = null,
         locked_until = null,
         finished_at = case when attempts >= 5 then now() else null end,
         error_message = $2
     where id = $1
       and ($3::text is null or (status = 'running' and locked_by = $3))`,
    [jobId, message, lockedBy],
  );
}

function rollupMutationOptions(value: RollupRebuildQuery | RollupMutationOptions) {
  return typeof value === "function"
    ? { query: value, lockedBy: null }
    : { query: value.query ?? queryPostgres, lockedBy: value.lockedBy ?? null };
}

async function assertRollupLease(
  job: RollupRebuildJob,
  query: RollupRebuildQuery = queryPostgres,
  lock = false,
) {
  const result = await query<{ id: string }>(
    `select id::text
       from metrics.rollup_rebuild_queue
      where id = $1
        and metric_family = $2
        and period_grain = $3
        and period_start = $4::date
        and dimensions_json = $5::jsonb
        and status = 'running'
        and locked_by = $6
        and locked_until > clock_timestamp()
      ${lock ? "for update" : ""}`,
    [job.id, job.metric_family, job.period_grain, job.period_start, JSON.stringify(job.dimensions_json ?? {}), job.locked_by],
  );
  if (result.rows.length !== 1) throw new Error(`Lost rollup lease for job ${job.id}.`);
}

export async function getLatestReadModelPayload(
  scope: RollupScope,
  periodStart?: string,
  compactTechnicianDetails = false,
): Promise<{
  period_start: string;
  values_json: ReadModelPayload;
  source_coverage_json: Record<string, unknown>;
  rebuilt_at: string;
} | null> {
  const upperBound = periodStart ? null : currentMonthStart();
  const result = await queryPostgres<{
    period_start: string;
    values_json: ReadModelPayload;
    source_coverage_json: Record<string, unknown>;
    rebuilt_at: string;
  }>(
    `select period_start::text,
            case
              when $4::boolean and metric_family = 'technicians' then
                values_json || '{"history":[],"visits":[],"crewLaborEfficiency":[]}'::jsonb
              else values_json
            end as values_json,
            source_coverage_json, rebuilt_at::text
     from metrics.dashboard_read_models
     where metric_family = $1
       and period_grain = 'month'
       and superseded_at is null
       and ($2::date is null or period_start = $2::date)
       and ($2::date is not null or period_start <= $3::date)
     order by
       case
         when $2::date is not null then 0
         when metric_family = 'technicians'
           and coalesce(
             jsonb_array_length(
               case
                 when jsonb_typeof(values_json -> 'technicians') = 'array' then values_json -> 'technicians'
                 else '[]'::jsonb
               end
             ),
             0
           ) > 0 then 0
         when metric_family = 'jobs'
           and coalesce(nullif(values_json ->> 'completedJobCount', '')::numeric, 0) > 0 then 0
         when metric_family = 'commissions'
           and coalesce(nullif(values_json ->> 'completedJobs', '')::numeric, 0) > 0 then 0
         when metric_family = 'quotes'
           and coalesce(nullif(values_json ->> 'quoteCount', '')::numeric, 0) > 0 then 0
         else 1
       end,
       period_start desc
     limit 1`,
    [scope, periodStart ?? null, upperBound, compactTechnicianDetails],
  );

  const row = result.rows[0] ?? null;
  if (row && scope === "technicians") {
    assertServeableTechnicianReadModel(row.values_json, `${scope}/${row.period_start}`);
  }
  return row;
}

function currentMonthStart() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

async function buildPayload(scope: RollupScope, periodStart: string, periodEnd: string): Promise<ReadModelPayload> {
  switch (scope) {
    case "quotes":
      return buildQuoteDashboardPayload(periodStart, periodEnd);
    case "jobs":
      return buildJobDashboardPayload(periodStart, periodEnd);
    case "technicians":
      return buildTechnicianPerformanceReadModel(await getTechnicianPerformanceInputs(periodStart, periodEnd));
    case "materials":
      return buildMaterialsReadModelPayload(periodStart);
    case "commissions":
      throw new Error("Commission rebuilds require the owner-fenced transactional publication workflow.");
    default:
      assertNever(scope);
  }
}

async function buildJobDashboardPayload(periodStart: string, periodEnd: string): Promise<JobDashboardReadModelPayload> {
  const source = await getJobDashboardSourceInputs();
  const jobs = source.jobs.filter((job) => !job.completedDate || job.completedDate <= periodEnd);
  const reconciliations = source.reconciliations.filter((row) => row.periodStart <= periodEnd);
  const dashboard = buildJobMetricsDashboard({
    jobs,
    reconciliations,
    issuedQuotes: source.issuedQuotes,
    selectedMonth: periodStart.slice(0, 7),
  });
  return { ...dashboard.selected, dashboard };
}

function getJobDashboardSourceInputs(): Promise<JobDashboardSourceInputs> {
  if (!jobDashboardSourceInputs) {
    const currentPeriodEnd = monthWindow(businessCurrentMonth()).end;
    jobDashboardSourceInputs = (async () => {
      const jobs = await getJobMetricInputs({ periodStart: BACKFILL_START_MONTH, periodEnd: currentPeriodEnd });
      const reconciliations = await getJobReconciliations(BACKFILL_START_MONTH, currentPeriodEnd);
      const issuedQuotes = await getIssuedQuoteInputs();
      return { jobs, reconciliations, issuedQuotes };
    })();
  }
  return jobDashboardSourceInputs;
}

async function buildQuoteDashboardPayload(periodStart: string, periodEnd: string): Promise<QuoteDashboardReadModelPayload> {
  // Rollup jobs deliberately use a one-connection pool. Keep these reads serial so a
  // long monthly query cannot make sibling pool requests hit the acquisition timeout.
  const monthly = await buildQuoteMonthlyRollup(periodStart, periodEnd);
  const snapshots = await loadQuoteDashboardRows();
  const overrideSummary = await getQuoteOverrideSummary();
  const dashboard = buildQuoteMetricsReadModel(rollupFreshness("quotes"), snapshots, overrideSummary, { selectedMonth: periodStart.slice(0, 7) });
  return {
    ...monthly,
    dashboard,
    quoteRecords: buildPersistedQuoteDashboardRecords(snapshots, periodStart),
  };
}

async function getQuoteOverrideSummary() {
  const result = await queryPostgres<{ active_count: string; latest_at: string | null }>(
    `select count(*)::text as active_count, max(created_at)::text as latest_at
       from metrics.quote_classification_overrides
      where active = true`,
  );
  return result.rows[0] ?? { active_count: "0", latest_at: null };
}

function rollupFreshness(pageKey: string): FreshnessStatus {
  return {
    pageKey,
    state: "current",
    label: "Persisted read model",
    detail: "Built by the app-owned rollup worker.",
    dataThrough: null,
    lastSuccessfulRunAt: null,
    lastFailedRunAt: null,
  };
}

export async function buildQuoteMonthlyRollup(
  periodStart: string,
  periodEnd: string,
  query: RollupRebuildQuery = queryPostgres,
): Promise<QuoteMonthlyReadModel> {
  return buildQuoteMonthlyReadModel({
    quotes: await getQuoteSnapshots(periodStart, periodEnd, query),
    periodStart,
    periodEnd,
  });
}

export async function getQuoteSnapshots(
  periodStart: string,
  periodEnd: string,
  query: RollupRebuildQuery = queryPostgres,
): Promise<NormalizedQuoteSnapshot[]> {
  const result = await query<{
    quote_id: string;
    quote_no: string | null;
    date_issued: string | null;
    date_approved: string | null;
    status_name: string | null;
    total: string;
    linked_job_match_id: string | null;
    inverse_conversion_match_id: string | null;
    excluded_override_id: string | null;
    source_deleted_at: string | null;
  }>(
    `select q.quote_id::text, q.quote_no, q.date_issued::text, q.date_approved::text,
            q.status_name, q.total::text,
            linked_job.job_id::text as linked_job_match_id,
            inverse_job.job_id::text as inverse_conversion_match_id,
            excluded_override.id::text as excluded_override_id,
            q.source_deleted_at::text
     from metrics.metrics_quotes q
     left join metrics.metrics_jobs linked_job
       on linked_job.job_id = q.linked_job_id
      and linked_job.source_deleted_at is null
     left join lateral (
       select relationship.job_id
         from metrics.job_source_quotes relationship
        where relationship.source_quote_id = q.quote_id
        order by relationship.job_id
        limit 1
     ) inverse_job on true
     left join lateral (
       select o.id from metrics.quote_classification_overrides o
        where o.quote_id = q.quote_id and o.active = true and o.outcome = 'excluded'
        order by o.created_at desc, o.id desc limit 1
     ) excluded_override on true
     where q.source_deleted_at is null
       and q.date_issued between $1::date and $2::date`,
    [periodStart, periodEnd],
  );

  return result.rows.map((row) => ({
    quoteId: row.quote_id,
    quoteNo: row.quote_no,
    totalValue: Number(row.total),
    dateIssued: row.date_issued,
    dateApproved: row.date_approved,
    statusName: row.status_name,
    linkedJobId: row.linked_job_match_id,
    convertedFromJobId: row.inverse_conversion_match_id,
    outcomeOverride: row.excluded_override_id === null ? null : "excluded",
    sourceDeletedAt: row.source_deleted_at,
  }));
}

function monthWindow(periodStart: string) {
  const [year, month] = periodStart.slice(0, 10).split("-").map(Number);
  const start = `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-01`;
  const endDate = new Date(Date.UTC(year, month, 0));
  const end = endDate.toISOString().slice(0, 10);
  return { start, end };
}

function extractCoverage(payload: ReadModelPayload): Record<string, unknown> {
  if ("coverage" in payload) {
    return payload.coverage;
  }
  if ("laborAccuracy" in payload) {
    return { laborAccuracy: payload.laborAccuracy, grossMarginCoverage: payload.grossMarginCoverage };
  }
  return {};
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function readModelSourceHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(semanticReadModelValue(value))).digest("hex");
}

function semanticReadModelValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(semanticReadModelValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "generatedAt")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, semanticReadModelValue(item)]),
  );
}

function assertNever(value: never): never {
  throw new Error(`Unhandled read-model scope: ${value}`);
}
