import { createHash } from "node:crypto";
import { queryPostgres } from "@/lib/store/postgres";
import type { IngestionEntity, IngestionResult } from "@/lib/simpro/ingest";

export type IngestionJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type IngestionJob = {
  id: number;
  entity_type: IngestionEntity;
  status: IngestionJobStatus;
  priority: number;
  idempotency_key: string;
  request_budget: number;
  requests_used: number;
  continuation_token: Record<string, unknown> | null;
  params: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  generation: number;
};

const retiredIngestionEntities = new Set(["invoices", "customer_invoice_logs"]);

function assertActiveIngestionEntity(entity: unknown) {
  if (typeof entity !== "string" || retiredIngestionEntities.has(entity)) {
    throw new Error(`Ingestion entity ${String(entity)} is retired and cannot be enqueued or claimed.`);
  }
}

export async function enqueueIngestionJob(params: {
  entity: IngestionEntity;
  idempotencyKey: string;
  priority?: number;
  requestBudget?: number;
  continuationToken?: Record<string, unknown> | null;
  params?: Record<string, unknown>;
  preserveSucceeded?: boolean;
}, query: typeof queryPostgres = queryPostgres) {
  assertActiveIngestionEntity(params.entity);
  await query(
    `insert into metrics.ingestion_jobs (
       entity_type, idempotency_key, priority, request_budget, continuation_token, params
     )
     values ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
     on conflict (entity_type, idempotency_key) do update set
       priority = least(metrics.ingestion_jobs.priority, excluded.priority),
       request_budget = case
         when metrics.ingestion_jobs.status = 'succeeded' and not $7::boolean then excluded.request_budget
         else greatest(metrics.ingestion_jobs.request_budget, metrics.ingestion_jobs.requests_used + excluded.request_budget)
       end,
       generation = case
         when metrics.ingestion_jobs.status = 'succeeded' and not $7::boolean
           then metrics.ingestion_jobs.generation + 1
         else metrics.ingestion_jobs.generation
       end,
       status = case
         when metrics.ingestion_jobs.status in ('failed', 'cancelled') then 'queued'::metrics.ingestion_job_status
         when metrics.ingestion_jobs.status = 'succeeded' and not $7::boolean then 'queued'::metrics.ingestion_job_status
         else metrics.ingestion_jobs.status
       end,
       attempts = case
         when metrics.ingestion_jobs.status in ('failed', 'cancelled')
           or (metrics.ingestion_jobs.status = 'succeeded' and not $7::boolean) then 0
         else metrics.ingestion_jobs.attempts
       end,
       last_error = case
         when metrics.ingestion_jobs.status in ('failed', 'cancelled')
           or (metrics.ingestion_jobs.status = 'succeeded' and not $7::boolean) then null
         else metrics.ingestion_jobs.last_error
       end,
       dead_lettered_at = case
         when metrics.ingestion_jobs.status in ('failed', 'cancelled')
           or (metrics.ingestion_jobs.status = 'succeeded' and not $7::boolean) then null
         else metrics.ingestion_jobs.dead_lettered_at
       end,
       requests_used = case
         when metrics.ingestion_jobs.status = 'succeeded' and not $7::boolean then 0
         else metrics.ingestion_jobs.requests_used
       end,
       continuation_token = case
         when metrics.ingestion_jobs.status = 'succeeded' and not $7::boolean then excluded.continuation_token
         else metrics.ingestion_jobs.continuation_token
       end,
       page_cursor = case
         when metrics.ingestion_jobs.status = 'succeeded' and not $7::boolean then excluded.continuation_token
         else metrics.ingestion_jobs.page_cursor
       end,
       completed_at = case
         when metrics.ingestion_jobs.status = 'succeeded' and not $7::boolean then null
         else metrics.ingestion_jobs.completed_at
       end,
       params = case
         when metrics.ingestion_jobs.status = 'succeeded' and not $7::boolean then excluded.params
         else metrics.ingestion_jobs.params
       end,
       next_attempt_at = case
         when metrics.ingestion_jobs.status in ('failed', 'cancelled')
           or (metrics.ingestion_jobs.status = 'succeeded' and not $7::boolean) then now()
         else metrics.ingestion_jobs.next_attempt_at
       end,
       updated_at = now()`,
    [
      params.entity,
      params.idempotencyKey,
      params.priority ?? 100,
      params.requestBudget ?? 1000,
      params.continuationToken ? JSON.stringify(params.continuationToken) : null,
      JSON.stringify(params.params ?? {}),
      params.preserveSucceeded ?? false,
    ],
  );
}

export async function claimNextIngestionJob(
  workerId: string,
  entity?: IngestionEntity,
  idempotencySuffix?: string,
  query: typeof queryPostgres = queryPostgres,
): Promise<IngestionJob | null> {
  if (entity !== undefined) assertActiveIngestionEntity(entity);
  const result = await query<IngestionJob>(
    `with recovered as (
       update metrics.ingestion_jobs
          set status = 'queued'::metrics.ingestion_job_status,
              -- Fence the superseded writer: bumping the generation on expired-lease
              -- recovery invalidates the old worker's heartbeat, completion, and
              -- failure writes, which all assert the generation they claimed.
              generation = generation + 1,
              locked_by = null,
              locked_at = null,
              lock_expires_at = null,
              heartbeat_at = null,
              last_error = coalesce(last_error, 'worker lease expired; safely requeued from saved continuation'),
              next_attempt_at = now(),
              updated_at = now()
        where status = 'running'
          and entity_type::text not in ('invoices', 'customer_invoice_logs')
          and lock_expires_at is not null
          and lock_expires_at < now()
        returning id
     ), next_job as (
       select id
       from metrics.ingestion_jobs
       where status = 'queued'
         and entity_type::text not in ('invoices', 'customer_invoice_logs')
         and next_attempt_at <= now()
         and ($2::metrics.ingestion_entity_type is null or entity_type = $2::metrics.ingestion_entity_type)
         and ($3::text is null or idempotency_key like ('%:' || $3::text))
       order by priority asc, generation asc, id asc
       for update skip locked
       limit 1
     )
     update metrics.ingestion_jobs j
     set status = 'running',
         locked_by = $1,
         locked_at = now(),
         lock_expires_at = now() + interval '10 minutes',
         heartbeat_at = now(),
         attempts = attempts + 1,
         updated_at = now()
     from next_job
     where j.id = next_job.id
     returning j.id, j.entity_type::text as entity_type, j.status::text as status, j.priority,
               j.idempotency_key, j.request_budget, j.requests_used, j.continuation_token, j.params,
               j.attempts, j.max_attempts, j.generation`,
    [workerId, entity ?? null, idempotencySuffix ?? null],
  );

  return result.rows[0] ?? null;
}

export async function startIngestionRun(job: IngestionJob, workerId: string): Promise<number> {
  const result = await queryPostgres<{ id: number }>(
    `insert into metrics.ingestion_runs (job_id, entity_type, worker_id, job_generation)
     values ($1, $2, $3, $4)
     returning id`,
    [job.id, job.entity_type, workerId, job.generation],
  );

  return result.rows[0].id;
}

export async function heartbeatIngestionJob(
  job: Pick<IngestionJob, "id" | "generation">,
  workerId: string,
  query: typeof queryPostgres = queryPostgres,
) {
  const result = await query<{ id: number }>(
    `update metrics.ingestion_jobs
        set heartbeat_at = now(),
            lock_expires_at = now() + interval '10 minutes',
            updated_at = now()
      where id = $1
        and status = 'running'
        and locked_by = $2
        and generation = $3::integer
      returning id`,
    [job.id, workerId, job.generation],
  );
  if (!result.rows[0]) {
    throw new Error(`Lost ingestion lease for job ${job.id} generation ${job.generation}`);
  }
}

export async function completeIngestionJob(params: {
  job: IngestionJob;
  workerId: string;
  runId: number;
  requestCount: number;
  snapshotCount: number;
  normalizedCount: number;
  continuationToken: Record<string, unknown> | null;
  candidateRefreshes?: IngestionResult["candidateRefreshes"];
  affectedPeriods: IngestionResult["affectedPeriods"];
}, query: typeof queryPostgres = queryPostgres) {
  const hasMore = Boolean(params.continuationToken);
  const publications = buildCompletionPublications(params.job, params.candidateRefreshes, params.affectedPeriods);
  const result = await query<{ candidate_count: number; rollup_count: number }>(
    `with completed_job as (
       update metrics.ingestion_jobs j
          set status = $4::metrics.ingestion_job_status,
              requests_used = case when $4 = 'queued' then 0 else j.requests_used + $5 end,
              continuation_token = $8::jsonb,
              page_cursor = $8::jsonb,
              locked_by = null,
              locked_at = null,
              lock_expires_at = null,
              heartbeat_at = null,
              attempts = 0,
              last_error = null,
              dead_lettered_at = null,
              completed_at = case when $4 = 'succeeded' then now() else null end,
              updated_at = now(),
              next_attempt_at = case when $4 = 'queued' then now() else j.next_attempt_at end
        where j.id = $1
          and j.status = 'running'
          and j.locked_by = $2
          and j.generation = $12::integer
          and exists (
            select 1 from metrics.ingestion_runs r
             where r.id = $3
               and r.job_id = j.id
               and r.status = 'running'
               and r.worker_id = $2
               and r.job_generation = $12::integer
          )
        returning j.id
     ), completed_run as (
       update metrics.ingestion_runs r
          set status = $4::metrics.ingestion_job_status,
              finished_at = now(),
              request_count = $5,
              snapshot_count = $6,
              normalized_count = $7,
              candidate_count = $10,
              continuation_token = $8::jsonb,
              page_cursor = $8::jsonb
         from completed_job j
        where r.id = $3
          and r.job_id = j.id
          and r.status = 'running'
          and r.worker_id = $2
          and r.job_generation = $12::integer
        returning r.id
     ), candidate_payload as (
       select * from jsonb_to_recordset($9::jsonb) as c(
         entity_type text,
         entity_id bigint,
         idempotency_key text,
         params jsonb
       )
     ), eligible_candidates as (
       select c.*
         from candidate_payload c
         left join metrics.metrics_quotes quote
           on c.entity_type = 'quote_nested'
          and quote.quote_id = c.entity_id
          and quote.source_deleted_at is null
         left join metrics.raw_simpro_snapshots quote_source
           on quote_source.id = quote.source_snapshot_id
         left join metrics.metrics_jobs job
           on c.entity_type = 'job_nested'
          and job.job_id = c.entity_id
          and job.source_deleted_at is null
         left join metrics.raw_simpro_snapshots job_source
           on job_source.id = job.source_snapshot_id
        where c.entity_type not in ('invoices', 'customer_invoice_logs')
          and (
            coalesce(c.params->>'trigger', '') <> 'summary'
            or c.entity_type not in ('quote_nested', 'job_nested')
            or (c.entity_type = 'quote_nested' and quote.quote_id is null)
            or (c.entity_type = 'job_nested' and job.job_id is null)
            or (
              c.params->>'sourceModifiedAt' is not null
              and (c.params->>'sourceModifiedAt')::timestamptz > coalesce(
                case when c.entity_type = 'quote_nested' then quote_source.source_updated_at end,
                case when c.entity_type = 'job_nested' then job_source.source_updated_at end,
                '-infinity'::timestamptz
              )
            )
          )
     ), published_candidates as (
       insert into metrics.ingestion_jobs (
         entity_type, idempotency_key, priority, request_budget, params
       )
       select c.entity_type::metrics.ingestion_entity_type,
              c.idempotency_key,
              20,
              250,
              coalesce(c.params, '{}'::jsonb) || jsonb_build_object('entityId', c.entity_id)
         from eligible_candidates c
         cross join completed_run
       on conflict (entity_type, idempotency_key) do update set
         priority = least(metrics.ingestion_jobs.priority, excluded.priority),
         request_budget = greatest(
           metrics.ingestion_jobs.request_budget,
           metrics.ingestion_jobs.requests_used + excluded.request_budget
         ),
         status = case
           when metrics.ingestion_jobs.status in ('failed', 'cancelled')
             then 'queued'::metrics.ingestion_job_status
           else metrics.ingestion_jobs.status
         end,
         attempts = case
           when metrics.ingestion_jobs.status in ('failed', 'cancelled') then 0
           else metrics.ingestion_jobs.attempts
         end,
         last_error = case
           when metrics.ingestion_jobs.status in ('failed', 'cancelled') then null
           else metrics.ingestion_jobs.last_error
         end,
         dead_lettered_at = case
           when metrics.ingestion_jobs.status in ('failed', 'cancelled') then null
           else metrics.ingestion_jobs.dead_lettered_at
         end,
         next_attempt_at = case
           when metrics.ingestion_jobs.status in ('failed', 'cancelled') then now()
           else metrics.ingestion_jobs.next_attempt_at
         end,
         updated_at = now()
       returning id
     ), rollup_payload as (
       select * from jsonb_to_recordset($11::jsonb) as r(
         metric_family text,
         period_start date,
         reason text,
         idempotency_key text
       )
     ), published_rollups as (
       insert into metrics.rollup_rebuild_queue (
         metric_family, period_grain, period_start, dimensions_json, reason, idempotency_key
       )
       select r.metric_family, 'month', r.period_start, '{}'::jsonb, r.reason, r.idempotency_key
         from rollup_payload r
         cross join completed_run
       on conflict (idempotency_key) do update set
         status = case
           when metrics.rollup_rebuild_queue.status = 'running'
             and metrics.rollup_rebuild_queue.locked_until > now()
             then metrics.rollup_rebuild_queue.status
           else 'queued'::metrics.rollup_rebuild_status
         end,
         locked_by = case
           when metrics.rollup_rebuild_queue.status = 'running'
             and metrics.rollup_rebuild_queue.locked_until > now()
             then metrics.rollup_rebuild_queue.locked_by
           else null
         end,
         locked_until = case
           when metrics.rollup_rebuild_queue.status = 'running'
             and metrics.rollup_rebuild_queue.locked_until > now()
             then metrics.rollup_rebuild_queue.locked_until
           else null
         end,
         reason = excluded.reason,
         finished_at = null,
         error_message = null
       returning id
     )
     select (select count(*)::int from published_candidates) as candidate_count,
            (select count(*)::int from published_rollups) as rollup_count
       from completed_run`,
    [
      params.job.id,
      params.workerId,
      params.runId,
      hasMore ? "queued" : "succeeded",
      params.requestCount,
      params.snapshotCount,
      params.normalizedCount,
      params.continuationToken ? JSON.stringify(params.continuationToken) : null,
      JSON.stringify(publications.candidates),
      publications.candidates.length,
      JSON.stringify(publications.rollups),
      params.job.generation,
    ],
  );

  const completed = result.rows[0];
  if (!completed) {
    throw new Error(
      `Lost ingestion lease for job ${params.job.id} generation ${params.job.generation} before atomic completion`,
    );
  }
  return completed;
}

function buildCompletionPublications(
  job: IngestionJob,
  candidateRefreshes: IngestionResult["candidateRefreshes"],
  affectedPeriods: IngestionResult["affectedPeriods"],
) {
  const candidates = new Map<string, {
    entity_type: IngestionEntity;
    entity_id: number;
    idempotency_key: string;
    params: Record<string, unknown>;
  }>();
  for (const candidate of candidateRefreshes ?? []) {
    if (!Number.isInteger(candidate.entityId) || candidate.entityId <= 0 || !candidate.sourceHash) continue;
    const idempotencyKey = `${candidate.entity}:${candidate.entityId}:${candidate.sourceHash}`;
    candidates.set(idempotencyKey, {
      entity_type: candidate.entity,
      entity_id: candidate.entityId,
      idempotency_key: idempotencyKey,
      params: candidate.params ?? {},
    });
  }

  const dimensionsHash = createHash("sha256").update(JSON.stringify({})).digest("hex");
  const rollups = new Map<string, {
    metric_family: string;
    period_start: string;
    reason: string;
    idempotency_key: string;
  }>();
  for (const affected of affectedPeriods) {
    if (!isServedMonthlyPeriod(affected.periodStart)) continue;
    const idempotencyKey = `${affected.scope}:month:${affected.periodStart}:${dimensionsHash}`;
    rollups.set(idempotencyKey, {
      metric_family: affected.scope,
      period_start: affected.periodStart,
      reason: `${job.entity_type} ingestion updated ${affected.periodStart}`,
      idempotency_key: idempotencyKey,
    });
  }

  return { candidates: [...candidates.values()], rollups: [...rollups.values()] };
}

function isServedMonthlyPeriod(periodStart: string, now = new Date()) {
  if (!/^\d{4}-\d{2}-01$/.test(periodStart)) return false;
  const parsed = new Date(`${periodStart}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== periodStart) return false;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  return Boolean(year && month) && periodStart >= "2023-01-01" && periodStart <= `${year}-${month}-01`;
}

export async function failIngestionJob(
  params: {
    job: IngestionJob;
    workerId: string;
    runId?: number;
    requestCount: number;
    error: unknown;
  },
  query: typeof queryPostgres = queryPostgres,
) {
  const message = params.error instanceof Error ? params.error.message : String(params.error);
  const shouldRetry = params.job.attempts < params.job.max_attempts;
  const status: IngestionJobStatus = shouldRetry ? "queued" : "failed";
  const retryDelayMinutes = Math.min(60, 2 ** Math.max(0, params.job.attempts));

  const result = await query<{ id: number }>(
    `with failed_job as (
       update metrics.ingestion_jobs j
          set status = $3::metrics.ingestion_job_status,
              requests_used = least(j.request_budget, j.requests_used + $6),
              locked_by = null,
              locked_at = null,
              lock_expires_at = null,
              heartbeat_at = null,
              last_error = $4,
              dead_lettered_at = case when $3 = 'failed' then now() else null end,
              next_attempt_at = now() + ($5::text || ' minutes')::interval,
              updated_at = now()
        where j.id = $1
          and j.status = 'running'
          and j.locked_by = $2
          and j.generation = $8::integer
          and (
            $7::bigint is null
            or exists (
              select 1
                from metrics.ingestion_runs r
               where r.id = $7::bigint
                 and r.job_id = j.id
                 and r.status = 'running'
                 and r.worker_id = $2
                 and r.job_generation = $8::integer
            )
          )
        returning j.id
     ), failed_run as (
       update metrics.ingestion_runs r
          set status = 'failed',
              finished_at = now(),
              request_count = $6,
              error_message = $4
         from failed_job j
        where r.id = $7::bigint
          and r.job_id = j.id
          and r.status = 'running'
          and r.worker_id = $2
          and r.job_generation = $8::integer
        returning r.id
     )
     select j.id
       from failed_job j
       left join failed_run r on true`,
    [
      params.job.id,
      params.workerId,
      status,
      message,
      retryDelayMinutes,
      params.requestCount,
      params.runId ?? null,
      params.job.generation,
    ],
  );
  if (!result.rows[0]) {
    throw new Error(`Lost ingestion lease for job ${params.job.id} generation ${params.job.generation}`);
  }
}
