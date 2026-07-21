import { randomUUID } from "node:crypto";
import {
  BACKFILL_START_MONTH,
  businessCurrentMonth,
  type BackfillSourceFamily,
} from "@/lib/backfill/plan";
import type { IngestionEntity } from "@/lib/simpro/ingest";
import { queryPostgres } from "@/lib/store/postgres";

export const BOUNDED_BACKFILL_MAX_MONTHS = 3;

export const BOUNDED_ENTITY_TARGETS = ["quote", "job", "employee", "schedule"] as const;
export type BoundedEntityTarget = (typeof BOUNDED_ENTITY_TARGETS)[number];

export const BOUNDED_BACKFILL_SOURCES = [
  "quotes",
  "quote_nested",
  "jobs",
  "job_nested",
  "employees",
  "timesheets",
  "jobs_from_timesheets",
  "schedules",
  "mobile_status",
] as const satisfies readonly BackfillSourceFamily[];
export type BoundedBackfillSource = (typeof BOUNDED_BACKFILL_SOURCES)[number];

export type BoundedSourceWork =
  | {
      kind: "entity_refresh";
      entityType: BoundedEntityTarget;
      entityId: number;
    }
  | {
      kind: "period_backfill";
      sourceFamily: BoundedBackfillSource;
      periodStart: string;
      periodEnd: string;
    };

export type BoundedSourceWorkStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "superseded";

export type BoundedSourceWorkRequest = {
  requestId: string;
  kind: BoundedSourceWork["kind"];
  origin: "manual" | "reconciliation";
  requestedBy: string;
  reason: string | null;
  targetLabel: string;
  status: BoundedSourceWorkStatus;
  duplicate: boolean;
  unitCount: number;
  createdAt: string;
  updatedAt: string | null;
};

type QueryResult<T> = { rows: T[]; rowCount: number | null };
export type BoundedSourceWorkQuery = <T = Record<string, unknown>>(
  text: string,
  values?: unknown[],
) => Promise<QueryResult<T>>;

export class BoundedSourceWorkValidationError extends Error {}
export class BoundedSourceWorkConflictError extends Error {}

type EnqueueRow = {
  request_id: string;
  kind: BoundedSourceWork["kind"];
  origin: "manual" | "reconciliation";
  requested_by: string;
  reason: string | null;
  target_label: string;
  status: BoundedSourceWorkStatus;
  duplicate: boolean;
  unit_count: number;
  created_at: string;
  updated_at: string | null;
  expected_units?: number;
  found_units?: number;
};

const entityQueueConfig: Record<BoundedEntityTarget, {
  entity: IngestionEntity;
  requestBudget: number;
}> = {
  quote: { entity: "quote_nested", requestBudget: 100 },
  job: { entity: "job_nested", requestBudget: 100 },
  employee: { entity: "employees", requestBudget: 10 },
  schedule: { entity: "schedules", requestBudget: 10 },
};

export function parseBoundedSourceWork(value: unknown, now = new Date()): BoundedSourceWork {
  if (!isRecord(value)) throw new BoundedSourceWorkValidationError("Request body must be a JSON object.");

  if (value.kind === "entity_refresh") {
    if (!BOUNDED_ENTITY_TARGETS.includes(value.entityType as BoundedEntityTarget)) {
      throw new BoundedSourceWorkValidationError("entityType must be quote, job, employee, or schedule.");
    }
    const entityId = Number(value.entityId);
    if (!Number.isSafeInteger(entityId) || entityId <= 0) {
      throw new BoundedSourceWorkValidationError("entityId must be a positive integer.");
    }
    return { kind: "entity_refresh", entityType: value.entityType as BoundedEntityTarget, entityId };
  }

  if (value.kind === "period_backfill") {
    if (!BOUNDED_BACKFILL_SOURCES.includes(value.sourceFamily as BoundedBackfillSource)) {
      throw new BoundedSourceWorkValidationError("sourceFamily is not approved for bounded backfill.");
    }
    const periodStart = strictMonthStart(value.periodStart, "periodStart");
    const periodEnd = strictMonthStart(value.periodEnd, "periodEnd");
    if (periodStart < BACKFILL_START_MONTH) {
      throw new BoundedSourceWorkValidationError(`periodStart must be ${BACKFILL_START_MONTH} or later.`);
    }
    if (periodStart > periodEnd) {
      throw new BoundedSourceWorkValidationError("periodStart must not be after periodEnd.");
    }
    if (periodEnd > businessCurrentMonth(now)) {
      throw new BoundedSourceWorkValidationError("periodEnd must not be after the current business month.");
    }
    if (inclusiveMonthCount(periodStart, periodEnd) > BOUNDED_BACKFILL_MAX_MONTHS) {
      throw new BoundedSourceWorkValidationError(
        `A bounded backfill may include at most ${BOUNDED_BACKFILL_MAX_MONTHS} months.`,
      );
    }
    return {
      kind: "period_backfill",
      sourceFamily: value.sourceFamily as BoundedBackfillSource,
      periodStart,
      periodEnd,
    };
  }

  throw new BoundedSourceWorkValidationError("kind must be entity_refresh or period_backfill.");
}

export async function enqueueBoundedSourceWork(params: {
  work: BoundedSourceWork;
  requestedBy: string;
  reason: string;
  origin?: "manual" | "reconciliation";
}, options: {
  query?: BoundedSourceWorkQuery;
  requestId?: string;
  now?: Date;
} = {}): Promise<BoundedSourceWorkRequest> {
  const query = options.query ?? queryPostgres;
  const requestId = options.requestId ?? randomUUID();
  const now = options.now ?? new Date();
  const work = parseBoundedSourceWork(params.work, now);
  const requestedBy = params.requestedBy.trim().toLowerCase();
  const reason = params.reason.trim();
  const origin = params.origin ?? "manual";

  if (!requestedBy || requestedBy.length > 320) {
    throw new BoundedSourceWorkValidationError("A valid requesting actor is required.");
  }
  if (reason.length < 5 || reason.length > 500) {
    throw new BoundedSourceWorkValidationError("reason must be between 5 and 500 characters.");
  }

  // A reconciliation must not recreate historical job-detail work merely
  // because a newer direct traversal is incomplete. A completed, checksum
  // verified bulk traversal is durable last-good authority for that exact ID.
  // Deliberate operator requests remain available through the manual origin.
  if (
    work.kind === "entity_refresh"
    && work.entityType === "job"
    && origin === "reconciliation"
    && await hasHistoricalBulkNestedAuthority(work.entityId, query)
  ) {
    return mapRequest(await recordHistoricalAuthoritySuppression({
      query,
      requestId,
      now,
      requestedBy,
      reason,
      origin,
      work,
    }));
  }

  const row = work.kind === "entity_refresh"
    ? await enqueueEntityRefresh({ query, requestId, now, requestedBy, reason, origin, work })
    : await enqueuePeriodBackfill({ query, requestId, now, requestedBy, reason, origin, work });

  return mapRequest(row);
}

export async function listBoundedSourceWorkRequests(
  limit = 20,
  query: BoundedSourceWorkQuery = queryPostgres,
): Promise<BoundedSourceWorkRequest[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new BoundedSourceWorkValidationError("limit must be an integer from 1 through 50.");
  }

  const result = await query<EnqueueRow>(
    `select audit.entity_id as request_id,
            audit.after_value ->> 'kind' as kind,
            coalesce(audit.after_value ->> 'origin', 'manual') as origin,
            audit.actor_email as requested_by,
            audit.reason,
            audit.after_value ->> 'targetLabel' as target_label,
            case
              when audit.after_value ->> 'kind' = 'entity_refresh' then
                case
                  when queue.generation > coalesce((audit.after_value ->> 'generation')::integer, queue.generation)
                    then 'superseded'
                  else coalesce(queue.status::text, 'cancelled')
                end
              when backfill.failed_count > 0 then 'failed'
              when backfill.running_count > 0 then 'running'
              when backfill.queued_count > 0 then 'queued'
              when backfill.completed_count = backfill.unit_count and backfill.unit_count > 0 then 'succeeded'
              else 'cancelled'
            end as status,
            coalesce((audit.after_value ->> 'duplicate')::boolean, false) as duplicate,
            coalesce(backfill.unit_count, 1)::integer as unit_count,
            audit.created_at::text as created_at,
            case
              when audit.after_value ->> 'kind' = 'entity_refresh' then queue.updated_at::text
              else backfill.updated_at::text
            end as updated_at
       from metrics.audit_events audit
       left join metrics.ingestion_jobs queue
         on audit.after_value ->> 'kind' = 'entity_refresh'
        and queue.id = nullif(audit.after_value ->> 'queueJobId', '')::bigint
       left join lateral (
         select count(*)::integer as unit_count,
                count(*) filter (where ledger.status in ('queued', 'reconciliation_pending'))::integer as queued_count,
                count(*) filter (where ledger.status = 'running')::integer as running_count,
                count(*) filter (where ledger.status = 'dead_lettered')::integer as failed_count,
                count(*) filter (where ledger.status = 'completed')::integer as completed_count,
                max(ledger.updated_at) as updated_at
           from metrics.backfill_source_month_ledger ledger
          where audit.after_value ->> 'kind' = 'period_backfill'
            and ledger.source_family = audit.after_value ->> 'sourceFamily'
            and ledger.month_start between (audit.after_value ->> 'periodStart')::date
                                       and (audit.after_value ->> 'periodEnd')::date
       ) backfill on audit.after_value ->> 'kind' = 'period_backfill'
      where audit.action = 'bounded_source_work_requested'
      order by audit.created_at desc, audit.id desc
      limit $1`,
    [limit],
  );

  return result.rows.map(mapRequest);
}

async function enqueueEntityRefresh(params: {
  query: BoundedSourceWorkQuery;
  requestId: string;
  now: Date;
  requestedBy: string;
  reason: string;
  origin: "manual" | "reconciliation";
  work: Extract<BoundedSourceWork, { kind: "entity_refresh" }>;
}) {
  const config = entityQueueConfig[params.work.entityType];
  const idempotencyKey = `bounded:${params.work.entityType}:${params.work.entityId}`;
  const targetLabel = `${params.work.entityType} #${params.work.entityId}`;
  const queueParams = {
    entityId: params.work.entityId,
    boundedWork: {
      requestId: params.requestId,
      origin: params.origin,
      requestedBy: params.requestedBy,
    },
  };
  const result = await params.query<EnqueueRow>(
    `with lock_scope as materialized (
       select pg_advisory_xact_lock(hashtext($1))
     ), prior as materialized (
       select job.id, job.status::text as status, job.generation
         from metrics.ingestion_jobs job, lock_scope
        where job.entity_type = $2::metrics.ingestion_entity_type
          and job.idempotency_key = $3
     ), queued as (
       insert into metrics.ingestion_jobs (
         entity_type, operation, idempotency_key, priority, request_budget,
         continuation_token, params, source_window_start, source_window_end
       )
       values ($2, 'bounded_refresh', $3, 50, $4, null, $5::jsonb, null, null)
       on conflict (entity_type, idempotency_key) do update set
         priority = least(metrics.ingestion_jobs.priority, excluded.priority),
         request_budget = case
           when metrics.ingestion_jobs.status in ('succeeded', 'failed', 'cancelled') then excluded.request_budget
           else metrics.ingestion_jobs.request_budget
         end,
         generation = case
           when metrics.ingestion_jobs.status in ('succeeded', 'failed', 'cancelled')
             then metrics.ingestion_jobs.generation + 1
           else metrics.ingestion_jobs.generation
         end,
         status = case
           when metrics.ingestion_jobs.status in ('succeeded', 'failed', 'cancelled')
             then 'queued'::metrics.ingestion_job_status
           else metrics.ingestion_jobs.status
         end,
         operation = case
           when metrics.ingestion_jobs.status in ('succeeded', 'failed', 'cancelled') then excluded.operation
           else metrics.ingestion_jobs.operation
         end,
         attempts = case
           when metrics.ingestion_jobs.status in ('succeeded', 'failed', 'cancelled') then 0
           else metrics.ingestion_jobs.attempts
         end,
         requests_used = case
           when metrics.ingestion_jobs.status in ('succeeded', 'failed', 'cancelled') then 0
           else metrics.ingestion_jobs.requests_used
         end,
         continuation_token = case
           when metrics.ingestion_jobs.status in ('succeeded', 'failed', 'cancelled') then null
           else metrics.ingestion_jobs.continuation_token
         end,
         page_cursor = case
           when metrics.ingestion_jobs.status in ('succeeded', 'failed', 'cancelled') then null
           else metrics.ingestion_jobs.page_cursor
         end,
         params = case
           when metrics.ingestion_jobs.status in ('succeeded', 'failed', 'cancelled') then excluded.params
           else metrics.ingestion_jobs.params
         end,
         locked_by = case when metrics.ingestion_jobs.status in ('succeeded', 'failed', 'cancelled') then null else metrics.ingestion_jobs.locked_by end,
         locked_at = case when metrics.ingestion_jobs.status in ('succeeded', 'failed', 'cancelled') then null else metrics.ingestion_jobs.locked_at end,
         lock_expires_at = case when metrics.ingestion_jobs.status in ('succeeded', 'failed', 'cancelled') then null else metrics.ingestion_jobs.lock_expires_at end,
         heartbeat_at = case when metrics.ingestion_jobs.status in ('succeeded', 'failed', 'cancelled') then null else metrics.ingestion_jobs.heartbeat_at end,
         last_error = case when metrics.ingestion_jobs.status in ('succeeded', 'failed', 'cancelled') then null else metrics.ingestion_jobs.last_error end,
         dead_lettered_at = case when metrics.ingestion_jobs.status in ('succeeded', 'failed', 'cancelled') then null else metrics.ingestion_jobs.dead_lettered_at end,
         completed_at = case when metrics.ingestion_jobs.status in ('succeeded', 'failed', 'cancelled') then null else metrics.ingestion_jobs.completed_at end,
         next_attempt_at = case when metrics.ingestion_jobs.status in ('succeeded', 'failed', 'cancelled') then now() else metrics.ingestion_jobs.next_attempt_at end,
         updated_at = now()
       returning id, status::text as status, generation, params, updated_at
     ), recorded as (
       insert into metrics.audit_events (
         actor_email, action, entity_type, entity_id, before_value, after_value, reason, created_at
       )
       select $6::text, 'bounded_source_work_requested', 'bounded_source_work',
              coalesce(queued.params #>> '{boundedWork,requestId}', $7::text),
              case when prior.id is null then null else jsonb_build_object(
                'queueJobId', prior.id, 'status', prior.status, 'generation', prior.generation
              ) end,
              jsonb_build_object(
                'requestId', coalesce(queued.params #>> '{boundedWork,requestId}', $7::text),
                'kind', 'entity_refresh',
                'origin', coalesce(queued.params #>> '{boundedWork,origin}', $8::text),
                'entityType', $9::text,
                'entityId', $10::bigint,
                'targetLabel', $11::text,
                'queueJobId', queued.id,
                'generation', queued.generation,
                'duplicate', coalesce(prior.status in ('queued', 'running'), false)
              ),
              $12::text,
              $13::timestamptz
         from queued
         left join prior on true
       returning id
     )
     select coalesce(queued.params #>> '{boundedWork,requestId}', $7::text) as request_id,
            'entity_refresh'::text as kind,
            coalesce(queued.params #>> '{boundedWork,origin}', $8::text) as origin,
            $6::text as requested_by,
            $12::text as reason,
            $11::text as target_label,
            queued.status,
            coalesce(prior.status in ('queued', 'running'), false) as duplicate,
            1::integer as unit_count,
            $13::timestamptz::text as created_at,
            queued.updated_at::text as updated_at
       from queued
       cross join recorded
       left join prior on true`,
    [
      idempotencyKey,
      config.entity,
      idempotencyKey,
      config.requestBudget,
      JSON.stringify(queueParams),
      params.requestedBy,
      params.requestId,
      params.origin,
      params.work.entityType,
      params.work.entityId,
      targetLabel,
      params.reason,
      params.now.toISOString(),
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Unable to enqueue bounded entity refresh.");
  return row;
}

async function hasHistoricalBulkNestedAuthority(jobId: number, query: BoundedSourceWorkQuery) {
  const result = await query<{ covered: boolean }>(
    `select exists (
       select 1
         from metrics.backfill_source_month_ledger ledger
         join metrics.backfill_traversal_manifests traversal
           on traversal.work_unit_id = ledger.id
        where ledger.source_family = 'job_nested'
          and ledger.month_start < date_trunc('month', now() at time zone 'America/Los_Angeles')::date
          and ledger.status = 'completed'
          and ledger.reconciliation_status = 'matched'
          and traversal.manifest_status = 'completed'
          and traversal.exact_source_ids @> jsonb_build_array($1::text)
          and exists (
            select 1
              from metrics.backfill_traversal_pages page
             where page.work_unit_id = traversal.work_unit_id
               and page.generation = traversal.generation
               and page.synthetic = true
               and page.source_method = 'checksum_verified_full_universe_artifact_projection:listJobs'
               and page.exact_ids @> jsonb_build_array($1::text)
               and page.request_query->'_bulkArtifactEvidence'->>'provenance'
                 = 'checksum_verified_full_universe_artifact_projection'
               and page.request_query->'_bulkArtifactEvidence'->>'fabricatedApiResponse' = 'false'
          )
          and exists (
            select 1
              from metrics.raw_simpro_snapshots root
             where root.entity_type = 'jobs'
               and root.entity_id = $1::text
               and root.source_deleted_at is null
               and root.complete_traversal = true
               and root.source_version like 'bulk-bootstrap:%'
          )
     ) as covered`,
    [jobId],
  );
  return result.rows[0]?.covered === true;
}

async function recordHistoricalAuthoritySuppression(params: {
  query: BoundedSourceWorkQuery;
  requestId: string;
  now: Date;
  requestedBy: string;
  reason: string;
  origin: "reconciliation";
  work: Extract<BoundedSourceWork, { kind: "entity_refresh" }>;
}) {
  const targetLabel = `${params.work.entityType} #${params.work.entityId}`;
  const result = await params.query<EnqueueRow>(
    `insert into metrics.audit_events (
       actor_email, action, entity_type, entity_id, before_value, after_value, reason, created_at
     ) values (
       $1::text, 'bounded_source_work_suppressed', 'bounded_source_work', $2::text,
       null,
       jsonb_build_object(
         'requestId', $2::text,
         'kind', 'entity_refresh',
         'origin', $3::text,
         'entityType', 'job',
         'entityId', $4::bigint,
         'targetLabel', $5::text,
         'status', 'superseded',
         'duplicate', true,
         'authority', 'checksum_verified_full_universe_artifact_projection'
       ),
       $6::text, $7::timestamptz
     )
     returning $2::text as request_id,
               'entity_refresh'::text as kind,
               $3::text as origin,
               $1::text as requested_by,
               $6::text as reason,
               $5::text as target_label,
               'superseded'::text as status,
               true as duplicate,
               1::integer as unit_count,
               $7::timestamptz::text as created_at,
               $7::timestamptz::text as updated_at`,
    [
      params.requestedBy,
      params.requestId,
      params.origin,
      params.work.entityId,
      targetLabel,
      params.reason,
      params.now.toISOString(),
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Unable to record bounded entity refresh suppression.");
  return row;
}

async function enqueuePeriodBackfill(params: {
  query: BoundedSourceWorkQuery;
  requestId: string;
  now: Date;
  requestedBy: string;
  reason: string;
  origin: "manual" | "reconciliation";
  work: Extract<BoundedSourceWork, { kind: "period_backfill" }>;
}) {
  const expectedUnits = inclusiveMonthCount(params.work.periodStart, params.work.periodEnd);
  const targetLabel = `${params.work.sourceFamily}: ${params.work.periodStart.slice(0, 7)} to ${params.work.periodEnd.slice(0, 7)}`;
  const result = await params.query<EnqueueRow>(
    `with lock_scope as materialized (
       select pg_advisory_xact_lock(hashtext($1))
     ), requested as materialized (
       select ledger.*
         from metrics.backfill_source_month_ledger ledger, lock_scope
        where ledger.source_family = $2
          and ledger.month_start between $3::date and $4::date
        for update of ledger
     ), request_state as (
       select count(*)::integer as found_units,
              count(*) filter (where status in ('queued', 'running', 'reconciliation_pending'))::integer as active_units,
              count(*) filter (where status = 'completed')::integer as completed_units
         from requested
     ), completed_before_repair as materialized (
       select id
         from requested
        where status = 'completed'
          and $8 = 'reconciliation'
     ), queued as (
       update metrics.backfill_source_month_ledger ledger
          set status = 'queued',
              work_phase = 'ingest',
              retry_count = 0,
              next_attempt_at = now(),
              locked_by = null,
              locked_at = null,
              lease_expires_at = null,
              heartbeat_at = null,
              reserved_capacity_date = null,
              reserved_requests = 0,
              last_error = null,
              dead_lettered_at = null,
              started_at = null,
              completed_at = null,
              reconciliation_status = 'pending',
              updated_at = now()
         from request_state
        where ledger.id in (select id from requested)
          and request_state.found_units = $5
          and request_state.active_units = 0
          and (
            ledger.status in ('planned', 'paused', 'dead_lettered', 'cancelled')
            or ($8 = 'reconciliation' and ledger.status = 'completed')
          )
       returning ledger.id
     ), reset_completed_manifests as (
       update metrics.backfill_traversal_manifests manifest
          set generation = manifest.generation + 1,
              manifest_status = 'collecting',
              filter_contract = '{}'::jsonb,
              as_of_watermark = now(),
              observed_boundary = '{}'::jsonb,
              required_target_keys = '[]'::jsonb,
              completed_target_keys = '[]'::jsonb,
              exact_source_ids = '[]'::jsonb,
              listed_source_ids = '[]'::jsonb,
              detailed_source_ids = '[]'::jsonb,
              exclusions = '[]'::jsonb,
              continuation_token = null,
              detail_coverage_required = false,
              page_count = 0,
              record_count = 0,
              empty_proof = null,
              open_quote_discovery = '{"required":false,"status":"not_required"}'::jsonb,
              violations = '[]'::jsonb,
              completed_at = null,
              reopened_at = now(),
              updated_at = now()
         where manifest.work_unit_id in (select id from completed_before_repair)
           and manifest.work_unit_id in (select id from queued)
       returning manifest.work_unit_id
     ), recorded as (
       insert into metrics.audit_events (
         actor_email, action, entity_type, entity_id, before_value, after_value, reason, created_at
       )
       select $6::text, 'bounded_source_work_requested', 'bounded_source_work', $7::text,
              jsonb_build_object(
                'foundUnits', request_state.found_units,
                'activeUnits', request_state.active_units,
                'completedUnits', request_state.completed_units
              ),
              jsonb_build_object(
                'requestId', $7::text,
                'kind', 'period_backfill',
                'origin', $8::text,
                'sourceFamily', $2::text,
                'periodStart', $3::text,
                'periodEnd', $4::text,
                'targetLabel', $9::text,
                'unitCount', request_state.found_units,
                'duplicate', request_state.active_units > 0
                  or ($8 = 'manual' and request_state.completed_units = request_state.found_units)
              ),
              $10::text,
              $11::timestamptz
         from request_state
        where request_state.found_units = $5
       returning id
     )
     select $7::text as request_id,
            'period_backfill'::text as kind,
            $8::text as origin,
            $6::text as requested_by,
            $10::text as reason,
            $9::text as target_label,
            case
              when $8 = 'manual' and request_state.completed_units = request_state.found_units then 'succeeded'
              when request_state.active_units > 0 then 'queued'
              when count(queued.id) > 0 then 'queued'
              else 'cancelled'
            end as status,
            (request_state.active_units > 0
              or ($8 = 'manual' and request_state.completed_units = request_state.found_units)) as duplicate,
            request_state.found_units as unit_count,
            $11::timestamptz::text as created_at,
            $11::timestamptz::text as updated_at,
            $5::integer as expected_units,
            request_state.found_units
       from request_state
       left join queued on true
       left join recorded on true
      group by request_state.found_units, request_state.active_units, request_state.completed_units`,
    [
      `bounded-backfill:${params.work.sourceFamily}`,
      params.work.sourceFamily,
      params.work.periodStart,
      params.work.periodEnd,
      expectedUnits,
      params.requestedBy,
      params.requestId,
      params.origin,
      targetLabel,
      params.reason,
      params.now.toISOString(),
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Unable to enqueue bounded period backfill.");
  if (Number(row.found_units) !== expectedUnits) {
    throw new BoundedSourceWorkConflictError(
      "Every requested source-month must already exist in the approved backfill plan.",
    );
  }
  return row;
}

function mapRequest(row: EnqueueRow): BoundedSourceWorkRequest {
  return {
    requestId: row.request_id,
    kind: row.kind,
    origin: row.origin,
    requestedBy: row.requested_by,
    reason: row.reason,
    targetLabel: row.target_label,
    status: row.status,
    duplicate: Boolean(row.duplicate),
    unitCount: Number(row.unit_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function strictMonthStart(value: unknown, field: string) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-01$/.test(value)) {
    throw new BoundedSourceWorkValidationError(`${field} must be a calendar month in YYYY-MM-01 format.`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new BoundedSourceWorkValidationError(`${field} must be a valid calendar month.`);
  }
  return value;
}

function inclusiveMonthCount(start: string, end: string) {
  const startDate = new Date(`${start}T00:00:00.000Z`);
  const endDate = new Date(`${end}T00:00:00.000Z`);
  return (endDate.getUTCFullYear() - startDate.getUTCFullYear()) * 12
    + endDate.getUTCMonth() - startDate.getUTCMonth() + 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
