import type { IngestionEntity } from "@/lib/simpro/ingest";
import type { BackfillTraversalSliceEvidence } from "@/lib/backfill/manifest";
import {
  BACKFILL_DETAIL_PAGE_REQUEST_FLOOR,
  canCompleteAfterReconciliation,
  capacityAllocation,
  retryDecision,
  type BackfillReconciliationStatus,
  type BackfillSourceFamily,
  type BackfillWorkUnitPlan,
} from "@/lib/backfill/plan";
import { queryPostgres } from "@/lib/store/postgres";
import type { SourcePeriodManifest } from "@/lib/store/source-period-manifests";

export type BackfillWorkPhase = "ingest" | "reconcile";
export type BackfillWorkUnitStatus =
  | "planned"
  | "queued"
  | "running"
  | "reconciliation_pending"
  | "completed"
  | "paused"
  | "dead_lettered"
  | "cancelled";

export type BackfillWorkUnit = {
  id: number;
  source_family: BackfillSourceFamily;
  month_start: string;
  month_end_exclusive: string;
  execution_mode: "ingest" | "coverage_only";
  required_for_completion: boolean;
  depends_on: BackfillSourceFamily[];
  work_phase: BackfillWorkPhase;
  status: BackfillWorkUnitStatus;
  expected_pages: number;
  expected_records: number;
  estimated_nested_requests: number;
  estimated_requests: number;
  daily_request_ceiling: number;
  queue_priority: number;
  request_slice_limit: number;
  actual_requests: number;
  snapshot_count: number;
  normalized_count: number;
  continuation_token: Record<string, unknown> | null;
  retry_count: number;
  max_attempts: number;
  reserved_capacity_date: string | null;
  reserved_requests: number;
  claim_phase: BackfillWorkPhase;
  manifest_generation?: number | null;
  manifest_as_of_watermark?: string | null;
  manifest_status?: "collecting" | "completed" | "provisional" | "invalid" | "unavailable" | null;
};

export type BackfillRepairPlan = {
  action: "refresh_or_normalize" | "verify_deletion_or_window_move" | "tombstone_after_authoritative_confirmation" | "repair_nested_traversal";
  entityIds: string[];
  rationale: string;
  evidence: Record<string, unknown>;
};

export type BackfillReconciliationEvidence = {
  status: Exclude<BackfillReconciliationStatus, "pending">;
  sourceRecordCount: number;
  normalizedRecordCount: number;
  sourceMaxDate: string | null;
  missingSourceIds: string[];
  extraNormalizedIds: string[];
  detail: Record<string, unknown>;
  repairPlans: BackfillRepairPlan[];
  sourcePeriodManifest?: SourcePeriodManifest;
};

type BackfillQuery = typeof queryPostgres;

export async function saveApprovedBackfillPlan(params: {
  units: BackfillWorkUnitPlan[];
  approvedBy: string;
  approvedAt: Date;
  planHash: string;
}) {
  if (!params.approvedBy.trim()) throw new Error("An approver is required before backfill work can be queued.");
  if (!/^[a-f0-9]{64}$/.test(params.planHash)) throw new Error("planHash must be a SHA-256 hex digest.");
  if (params.units.some((unit) => (unit as { sourceFamily: string }).sourceFamily === "invoices")) {
    throw new Error("Invoice backfill is retired and cannot be queued.");
  }
  const payload = params.units.map((unit) => ({
    source_family: unit.sourceFamily,
    month_start: unit.monthStart,
    month_end_exclusive: unit.monthEndExclusive,
    execution_mode: unit.executionMode,
    required_for_completion: unit.requiredForCompletion,
    depends_on: unit.dependsOn,
    expected_pages: unit.expectedPages,
    expected_records: unit.expectedRecords,
    estimated_nested_requests: unit.estimatedNestedRequests,
    estimated_requests: unit.estimatedRequests,
    daily_request_ceiling: unit.dailyRequestCeiling,
    queue_priority: unit.queuePriority,
    request_slice_limit: unit.requestSliceLimit,
  }));
  const result = await queryPostgres<{ id: string }>(
    `with plan as (
       select *
       from jsonb_to_recordset($1::jsonb) as p(
         source_family text,
         month_start date,
         month_end_exclusive date,
         execution_mode text,
         required_for_completion boolean,
         depends_on text[],
         expected_pages integer,
         expected_records integer,
         estimated_nested_requests integer,
         estimated_requests integer,
         daily_request_ceiling integer,
         queue_priority integer,
         request_slice_limit integer
       )
     )
     insert into metrics.backfill_source_month_ledger (
       source_family, month_start, month_end_exclusive, execution_mode, required_for_completion,
       depends_on, status, expected_pages, expected_records, estimated_nested_requests,
       estimated_requests, daily_request_ceiling, queue_priority, request_slice_limit,
       approved_by, approved_at, plan_hash
     )
     select source_family, month_start, month_end_exclusive, execution_mode, required_for_completion,
            depends_on, 'queued', expected_pages, expected_records, estimated_nested_requests,
            estimated_requests, daily_request_ceiling, queue_priority, request_slice_limit,
            $2, $3, $4
       from plan
      where source_family <> 'invoices'
     on conflict (source_family, month_start) do update set
       month_end_exclusive = excluded.month_end_exclusive,
       execution_mode = excluded.execution_mode,
       required_for_completion = excluded.required_for_completion,
       depends_on = excluded.depends_on,
       expected_pages = excluded.expected_pages,
       expected_records = excluded.expected_records,
       estimated_nested_requests = excluded.estimated_nested_requests,
       estimated_requests = excluded.estimated_requests,
       daily_request_ceiling = excluded.daily_request_ceiling,
       queue_priority = excluded.queue_priority,
       request_slice_limit = excluded.request_slice_limit,
       approved_by = excluded.approved_by,
       approved_at = excluded.approved_at,
       plan_hash = excluded.plan_hash,
       status = case when metrics.backfill_source_month_ledger.status = 'planned' then 'queued' else metrics.backfill_source_month_ledger.status end,
       updated_at = now()
     where metrics.backfill_source_month_ledger.status in ('planned', 'paused')
     returning id::text`,
    [JSON.stringify(payload), params.approvedBy.trim().toLowerCase(), params.approvedAt, params.planHash],
  );
  return { queuedOrUpdated: result.rowCount ?? 0, requested: params.units.length };
}

export async function claimNextBackfillWorkUnit(
  workerId: string,
  capacityDate = businessCapacityDate(),
): Promise<BackfillWorkUnit | null> {
  await recoverExpiredBackfillLeases();
  await reopenAdvancedProvisionalBackfills();
  await queryPostgres(
    `insert into metrics.backfill_capacity_days (capacity_date, daily_request_ceiling)
     select $1::date, max(daily_request_ceiling)
       from metrics.backfill_source_month_ledger
      where status in ('queued', 'reconciliation_pending')
        and source_family <> 'invoices'
     having max(daily_request_ceiling) is not null
     on conflict (capacity_date) do update set
       daily_request_ceiling = greatest(
         metrics.backfill_capacity_days.daily_request_ceiling,
         excluded.daily_request_ceiling
       ),
       updated_at = now()`,
    [capacityDate],
  );

  const result = await queryPostgres<BackfillWorkUnit>(
    `with candidate as materialized (
       select l.id,
              l.work_phase as claim_phase,
              coalesce(m.generation, 1) as manifest_generation,
              m.as_of_watermark::text as manifest_as_of_watermark,
              m.manifest_status,
              case
                when l.work_phase = 'reconcile' then 0
                else least(
                  l.request_slice_limit,
                  greatest(
                    0,
                    least(
                      floor(c.daily_request_ceiling * c.backfill_request_percent / 100.0)::integer
                        - c.backfill_requests
                        - c.backfill_reserved_requests,
                      c.daily_request_ceiling
                        - c.current_requests
                        - c.reconciliation_requests
                        - c.backfill_requests
                        - c.backfill_reserved_requests
                    )
                  )
                )
              end as reserve_requests
         from metrics.backfill_source_month_ledger l
         join metrics.backfill_capacity_days c on c.capacity_date = $2::date
         left join metrics.backfill_traversal_manifests m on m.work_unit_id = l.id
        where l.status in ('queued', 'reconciliation_pending')
          and l.source_family <> 'invoices'
          and l.next_attempt_at <= now()
          and not exists (
            select 1
              from unnest(l.depends_on) dependency(source_family)
             where not exists (
               select 1
                 from metrics.backfill_source_month_ledger completed_dependency
                where completed_dependency.month_start = l.month_start
                  and completed_dependency.source_family = dependency.source_family
                  and completed_dependency.status = 'completed'
             )
          )
          and (
            l.work_phase = 'reconcile'
            or (
              least(
                floor(c.daily_request_ceiling * c.backfill_request_percent / 100.0)::integer
                  - c.backfill_requests
                  - c.backfill_reserved_requests,
                c.daily_request_ceiling
                  - c.current_requests
                  - c.reconciliation_requests
                  - c.backfill_requests
                  - c.backfill_reserved_requests
              ) >= case
                when l.source_family in ('quotes', 'jobs', 'employees', 'schedules') then $3
                else 1
              end
              and not exists (
                select 1
                  from metrics.ingestion_jobs current_work
                 where current_work.operation <> 'backfill'
                   and current_work.status in ('queued', 'running')
                   and extract(epoch from (now() - current_work.created_at)) / 60 >= case
                     when current_work.entity_type::text = 'mobile_status' or current_work.entity_type::text like '%_logs' then 20
                     when current_work.entity_type::text = 'quotes' or current_work.entity_type::text like 'quote_%' then 45
                     else 90
                   end
              )
            )
          )
        order by l.queue_priority, l.month_start desc, l.id
        for update of l, c skip locked
        limit 1
     ), reserved as (
       update metrics.backfill_capacity_days c
          set backfill_reserved_requests = c.backfill_reserved_requests + candidate.reserve_requests,
              updated_at = now()
         from candidate
        where c.capacity_date = $2::date
        returning c.capacity_date
     )
     update metrics.backfill_source_month_ledger l
        set status = 'running',
            locked_by = $1,
            locked_at = now(),
            lease_expires_at = now() + interval '10 minutes',
            heartbeat_at = now(),
            reserved_capacity_date = $2::date,
            reserved_requests = candidate.reserve_requests,
            started_at = coalesce(l.started_at, now()),
            updated_at = now()
       from candidate, reserved
      where l.id = candidate.id
      returning l.*, candidate.claim_phase, candidate.manifest_generation,
                candidate.manifest_as_of_watermark, candidate.manifest_status`,
    [workerId, capacityDate, BACKFILL_DETAIL_PAGE_REQUEST_FLOOR],
  );
  const row = result.rows[0];
  return row ? normalizeBackfillWorkUnitDates(row) : null;
}

export function normalizeBackfillWorkUnitDates(
  row: BackfillWorkUnit & { month_start: unknown; month_end_exclusive: unknown },
): BackfillWorkUnit {
  return {
    ...row,
    month_start: dateOnly(row.month_start, "month_start"),
    month_end_exclusive: dateOnly(row.month_end_exclusive, "month_end_exclusive"),
  } as BackfillWorkUnit;
}

function dateOnly(value: unknown, field: string) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  throw new Error(`Backfill ${field} is not a valid database date.`);
}

export async function heartbeatBackfillWorkUnit(workUnitId: number, workerId: string) {
  const result = await queryPostgres(
    `update metrics.backfill_source_month_ledger
        set heartbeat_at = now(), lease_expires_at = now() + interval '10 minutes', updated_at = now()
      where id = $1 and status = 'running' and locked_by = $2`,
    [workUnitId, workerId],
  );
  if (result.rowCount !== 1) throw new Error(`Lost backfill lease for work unit ${workUnitId}.`);
}

export async function startBackfillIngestionRun(params: {
  workUnit: BackfillWorkUnit;
  workerId: string;
  entity: IngestionEntity;
  targetKey?: string | null;
}) {
  const result = await queryPostgres<{ id: string }>(
    `with run as (
       insert into metrics.ingestion_runs (
         entity_type, source_family, source_window_start, source_window_end, worker_id
       )
       values ($1, $2, $3::date, $4::date, $5)
       returning id
     )
     insert into metrics.backfill_work_unit_runs (work_unit_id, ingestion_run_id, target_key)
     select $6, id, $7 from run
     returning ingestion_run_id::text as id`,
    [
      params.entity,
      params.workUnit.source_family,
      params.workUnit.month_start,
      params.workUnit.month_end_exclusive,
      params.workerId,
      params.workUnit.id,
      params.targetKey ?? null,
    ],
  );
  return Number(result.rows[0].id);
}

export async function finishBackfillSlice(params: {
  workUnit: BackfillWorkUnit;
  workerId: string;
  runId?: number;
  requestsUsed: number;
  snapshotsWritten: number;
  normalizedWritten: number;
  continuationToken: Record<string, unknown> | null;
  ingestionComplete: boolean;
  traversal: BackfillTraversalSliceEvidence;
}) {
  if (params.requestsUsed > params.workUnit.reserved_requests) {
    throw new Error(`Backfill work unit ${params.workUnit.id} exceeded its reserved request capacity.`);
  }
  const pagePayload = params.traversal.pages.map((page) => ({
    ordinal: page.ordinal,
    target_key: page.targetKey,
    source_method: page.sourceMethod,
    page_number: page.pageNumber,
    page_size: page.pageSize,
    row_count: page.rowCount,
    exact_ids: page.exactIds,
    request_query: page.query,
    terminal: page.terminal,
    continuation_page: page.continuationPage,
    observed_min_date: page.observedMinDate,
    observed_max_date: page.observedMaxDate,
    response_hash: page.responseHash,
    synthetic: page.synthetic,
  }));
  const result = await queryPostgres(
    `with settled_capacity as (
       update metrics.backfill_capacity_days c
          set backfill_reserved_requests = greatest(0, c.backfill_reserved_requests - $4),
              backfill_requests = c.backfill_requests + $5,
              updated_at = now()
        where c.capacity_date = $3::date
        returning c.capacity_date
     ), manifest_recorded as materialized (
       select *
         from metrics.record_authoritative_backfill_slice(
           $1, $9, $11::jsonb, $12::jsonb, $10
         )
     ), finished_run as (
       update metrics.ingestion_runs
          set status = case
                when ($12::jsonb->>'valid')::boolean then 'succeeded'::metrics.ingestion_job_status
                else 'failed'::metrics.ingestion_job_status
              end,
              finished_at = now(),
              request_count = $5,
              snapshot_count = $6,
              normalized_count = $7,
              continuation_token = $8::jsonb,
              page_cursor = $8::jsonb,
              error_message = case when ($12::jsonb->>'valid')::boolean then null else left($12::jsonb->'violations'->>0, 4000) end
        where id = $9
        returning id
     )
     update metrics.backfill_source_month_ledger l
        set status = case when f.recorded_manifest_status = 'invalid' then 'paused' else 'queued' end,
            work_phase = case
              when $10 and f.recorded_manifest_status in ('completed', 'provisional', 'unavailable') then 'reconcile'
              else 'ingest'
            end,
            actual_requests = l.actual_requests + $5,
            snapshot_count = l.snapshot_count + $6,
            normalized_count = l.normalized_count + $7,
            continuation_token = case
              when f.recorded_manifest_status = 'invalid' then l.continuation_token
              when $10 and f.recorded_manifest_status in ('completed', 'provisional', 'unavailable') then null
              else $8::jsonb
            end,
            reconciliation_status = case
              when $10 and f.recorded_manifest_status in ('completed', 'provisional', 'unavailable') then 'pending'
              else l.reconciliation_status
            end,
            locked_by = null,
            locked_at = null,
            lease_expires_at = null,
            heartbeat_at = null,
            reserved_capacity_date = null,
            reserved_requests = 0,
            next_attempt_at = now(),
            last_error = case
              when f.recorded_manifest_status = 'invalid' then left($12::jsonb->'violations'->>0, 4000)
              else null
            end,
            updated_at = now()
       from settled_capacity, manifest_recorded f
      where l.id = $1 and l.status = 'running' and l.locked_by = $2`,
    [
      params.workUnit.id,
      params.workerId,
      params.workUnit.reserved_capacity_date,
      params.workUnit.reserved_requests,
      params.requestsUsed,
      params.snapshotsWritten,
      params.normalizedWritten,
      params.continuationToken ? JSON.stringify(params.continuationToken) : null,
      params.runId ?? null,
      params.ingestionComplete,
      JSON.stringify(pagePayload),
      JSON.stringify(params.traversal),
    ],
  );
  if (result.rowCount !== 1) throw new Error(`Lost backfill lease while completing work unit ${params.workUnit.id}.`);
}

export async function failBackfillWorkUnit(params: {
  workUnit: BackfillWorkUnit;
  workerId: string;
  runId?: number;
  requestsUsed: number;
  error: unknown;
}) {
  const message = params.error instanceof Error ? params.error.message : String(params.error);
  const decision = retryDecision(params.workUnit.retry_count, params.workUnit.max_attempts);
  if (params.runId) {
    await queryPostgres(
      `update metrics.ingestion_runs
          set status = 'failed', finished_at = now(), request_count = $2, error_message = $3
        where id = $1`,
      [params.runId, params.requestsUsed, message],
    );
  }
  const result = await queryPostgres(
    `with settled_capacity as (
       update metrics.backfill_capacity_days c
          set backfill_reserved_requests = greatest(0, c.backfill_reserved_requests - $4),
              backfill_requests = c.backfill_requests + $5,
              updated_at = now()
        where c.capacity_date = $3::date
        returning c.capacity_date
     )
     update metrics.backfill_source_month_ledger l
        set status = $6,
            retry_count = $7,
            actual_requests = l.actual_requests + $5,
            locked_by = null,
            locked_at = null,
            lease_expires_at = null,
            heartbeat_at = null,
            reserved_capacity_date = null,
            reserved_requests = 0,
            next_attempt_at = now() + ($8::text || ' minutes')::interval,
            last_error = $9,
            dead_lettered_at = case when $6 = 'dead_lettered' then now() else null end,
            updated_at = now()
       from settled_capacity
      where l.id = $1 and l.status = 'running' and l.locked_by = $2`,
    [
      params.workUnit.id,
      params.workerId,
      params.workUnit.reserved_capacity_date,
      params.workUnit.reserved_requests,
      Math.min(params.requestsUsed, params.workUnit.reserved_requests),
      decision.deadLettered ? "dead_lettered" : "queued",
      decision.nextRetryCount,
      decision.retryDelayMinutes,
      message.slice(0, 4000),
    ],
  );
  if (result.rowCount !== 1) throw new Error(`Lost backfill lease while failing work unit ${params.workUnit.id}.`);
}

export async function recordBackfillReconciliation(params: {
  workUnit: BackfillWorkUnit;
  workerId: string;
  evidence: BackfillReconciliationEvidence;
}, query: BackfillQuery = queryPostgres) {
  if (!params.evidence.sourcePeriodManifest) {
    throw new Error("Authoritative source-period evidence is required before recording backfill reconciliation.");
  }
  assertBackfillManifestAuthority(params.workUnit, params.evidence);
  const completes = canCompleteAfterReconciliation(
    params.workUnit.required_for_completion,
    params.evidence.status,
  );
  const decision = retryDecision(params.workUnit.retry_count, params.workUnit.max_attempts);
  const nextStatus = completes ? "completed" : decision.deadLettered ? "dead_lettered" : "queued";
  const result = await query(
    `with lease as (
       select id
         from metrics.backfill_source_month_ledger
        where id = $1 and status = 'running' and locked_by = $2
          and (
            $3::text <> 'matched'
            or exists (
              select 1
                from metrics.backfill_traversal_manifests manifest
               where manifest.work_unit_id = metrics.backfill_source_month_ledger.id
                 and manifest.generation = ($15::jsonb ->> 'manifestGeneration')::bigint
                 and manifest.manifest_status in ('completed', 'provisional')
                 and manifest.continuation_token is null
                 and manifest.page_count > 0
                 and manifest.page_count = ($15::jsonb ->> 'expectedPageCount')::integer
                 and manifest.page_count = ($15::jsonb ->> 'completedPageCount')::integer
                 and jsonb_array_length(manifest.exact_source_ids) = $4::integer
                 and manifest.exact_source_ids = manifest.listed_source_ids
                 and (
                   not manifest.detail_coverage_required
                   or manifest.exact_source_ids = manifest.detailed_source_ids
                 )
                 and manifest.violations = '[]'::jsonb
                 and manifest.as_of_watermark <= ($15::jsonb ->> 'evidenceAsOf')::timestamptz
            )
          )
        for update
     ), reconciliation as (
       insert into metrics.backfill_reconciliation_results (
         work_unit_id, status, source_record_count, normalized_record_count, source_max_date,
         missing_source_ids, extra_normalized_ids, detail
       )
       select lease.id, $3, $4, $5, $6::date, $7::jsonb, $8::jsonb, $9::jsonb
         from lease
       returning id
     ), reset_manifest as (
       update metrics.backfill_traversal_manifests m
          set generation = m.generation + 1,
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
        where m.work_unit_id = $1 and not $11
       returning m.work_unit_id
     ), repair_plans as (
       insert into metrics.backfill_repair_plans (
         work_unit_id, reconciliation_result_id, action, entity_ids, rationale, evidence
       )
       select $1, reconciliation.id, plan.action, plan.entity_ids, plan.rationale, plan.evidence
         from reconciliation
         cross join jsonb_to_recordset($14::jsonb) as plan(
           action text,
           entity_ids jsonb,
           rationale text,
           evidence jsonb
         )
       returning id
     ), source_manifest as (
       insert into metrics.source_period_manifests (
         source_family, period_start, period_end, coverage_status, reconciliation_status,
         listed_count, detail_count, normalized_count, source_id_hash, normalized_id_hash,
         source_value, normalized_value, continuation_token, evidence_as_of, completed_at,
         evidence_json, manifest_generation, reconciliation_generation,
         expected_page_count, completed_page_count, reconciled_at
       )
       select
         $15::jsonb ->> 'sourceFamily',
         ($15::jsonb ->> 'periodStart')::date,
         ($15::jsonb ->> 'periodEnd')::date,
         $15::jsonb ->> 'coverageStatus',
         $15::jsonb ->> 'reconciliationStatus',
         ($15::jsonb ->> 'listedCount')::integer,
         ($15::jsonb ->> 'detailCount')::integer,
         ($15::jsonb ->> 'normalizedCount')::integer,
         $15::jsonb ->> 'sourceIdHash',
         $15::jsonb ->> 'normalizedIdHash',
         ($15::jsonb ->> 'sourceValue')::numeric,
         ($15::jsonb ->> 'normalizedValue')::numeric,
         case
           when $15::jsonb -> 'continuationToken' is null
             or $15::jsonb -> 'continuationToken' = 'null'::jsonb then null
           else $15::jsonb -> 'continuationToken'
         end,
         ($15::jsonb ->> 'evidenceAsOf')::timestamptz,
         case when $15::jsonb ->> 'coverageStatus' = 'complete' then now() else null end,
         coalesce($15::jsonb -> 'evidence', '{}'::jsonb),
         ($15::jsonb ->> 'manifestGeneration')::bigint,
         case when $15::jsonb ->> 'reconciliationStatus' = 'matched'
           then ($15::jsonb ->> 'reconciliationGeneration')::bigint
           else null
         end,
         ($15::jsonb ->> 'expectedPageCount')::integer,
         ($15::jsonb ->> 'completedPageCount')::integer,
         case when $15::jsonb ->> 'reconciliationStatus' = 'matched'
           then ($15::jsonb ->> 'reconciledAt')::timestamptz
           else null
         end
       from reconciliation
       on conflict (source_family, period_start) do update set
         period_end = excluded.period_end,
         coverage_status = excluded.coverage_status,
         reconciliation_status = excluded.reconciliation_status,
         listed_count = excluded.listed_count,
         detail_count = excluded.detail_count,
         normalized_count = excluded.normalized_count,
         source_id_hash = excluded.source_id_hash,
         normalized_id_hash = excluded.normalized_id_hash,
         source_value = excluded.source_value,
         normalized_value = excluded.normalized_value,
         continuation_token = excluded.continuation_token,
         evidence_as_of = excluded.evidence_as_of,
         completed_at = excluded.completed_at,
         evidence_json = excluded.evidence_json,
         manifest_generation = excluded.manifest_generation,
         reconciliation_generation = excluded.reconciliation_generation,
         expected_page_count = excluded.expected_page_count,
         completed_page_count = excluded.completed_page_count,
         reconciled_at = excluded.reconciled_at,
         updated_at = now()
       where excluded.manifest_generation > coalesce(metrics.source_period_manifests.manifest_generation, 0)
          or (
            excluded.manifest_generation = metrics.source_period_manifests.manifest_generation
            and excluded.evidence_as_of >= metrics.source_period_manifests.evidence_as_of
          )
       returning source_family
     )
     update metrics.backfill_source_month_ledger l
        set status = $10,
            work_phase = case when $11 then 'reconcile' else 'ingest' end,
            reconciliation_status = $3,
            reconciled_source_records = $4,
            reconciled_normalized_records = $5,
            source_max_date = $6::date,
            normalized_coverage = case when $4 = 0 then 100 else round(($5::numeric / $4::numeric) * 100, 4) end,
            reconciliation_detail = $9::jsonb,
            continuation_token = null,
            retry_count = case when $11 then l.retry_count else $12 end,
            next_attempt_at = case when $11 then l.next_attempt_at else now() + ($13::text || ' minutes')::interval end,
            locked_by = null,
            locked_at = null,
            lease_expires_at = null,
            heartbeat_at = null,
            reserved_capacity_date = null,
            reserved_requests = 0,
            last_error = case when $11 then null else 'source-to-normalized reconciliation did not match' end,
            dead_lettered_at = case when $10 = 'dead_lettered' then now() else null end,
            completed_at = case when $10 = 'completed' then now() else null end,
            updated_at = now()
       from reconciliation
      where l.id = $1 and l.status = 'running' and l.locked_by = $2
      returning l.id`,
    [
      params.workUnit.id,
      params.workerId,
      params.evidence.status,
      params.evidence.sourceRecordCount,
      params.evidence.normalizedRecordCount,
      params.evidence.sourceMaxDate,
      JSON.stringify(params.evidence.missingSourceIds),
      JSON.stringify(params.evidence.extraNormalizedIds),
      JSON.stringify(params.evidence.detail),
      nextStatus,
      completes,
      decision.nextRetryCount,
      decision.retryDelayMinutes,
      JSON.stringify(params.evidence.repairPlans.map((plan) => ({
        action: plan.action,
        entity_ids: plan.entityIds,
        rationale: plan.rationale,
        evidence: plan.evidence,
      }))),
      JSON.stringify(params.evidence.sourcePeriodManifest),
    ],
  );
  if (result.rowCount !== 1) throw new Error(`Lost backfill lease while reconciling work unit ${params.workUnit.id}.`);
  return { completed: completes, status: nextStatus };
}

function assertBackfillManifestAuthority(
  workUnit: BackfillWorkUnit,
  evidence: BackfillReconciliationEvidence,
) {
  const manifest = evidence.sourcePeriodManifest;
  if (!manifest) throw new Error("Authoritative source-period evidence is required.");
  const periodEnd = new Date(`${workUnit.month_end_exclusive}T00:00:00.000Z`);
  periodEnd.setUTCDate(periodEnd.getUTCDate() - 1);
  if (
    manifest.sourceFamily !== workUnit.source_family
    || manifest.periodStart !== workUnit.month_start
    || manifest.periodEnd !== periodEnd.toISOString().slice(0, 10)
  ) {
    throw new Error("Source-period manifest does not match the claimed backfill work unit.");
  }
  if (!Number.isInteger(manifest.manifestGeneration) || manifest.manifestGeneration <= 0) {
    throw new Error("Source-period manifest requires a positive manifest generation.");
  }
  if (
    workUnit.manifest_generation !== null
    && workUnit.manifest_generation !== undefined
    && manifest.manifestGeneration !== workUnit.manifest_generation
  ) {
    throw new Error("Source-period manifest generation does not match the claimed traversal generation.");
  }
  if (
    !Number.isInteger(manifest.expectedPageCount)
    || manifest.expectedPageCount <= 0
    || !Number.isInteger(manifest.completedPageCount)
    || manifest.completedPageCount <= 0
  ) {
    throw new Error("Source-period manifest requires positive expected and completed page counts.");
  }
  if (
    manifest.listedCount !== evidence.sourceRecordCount
    || manifest.normalizedCount !== evidence.normalizedRecordCount
  ) {
    throw new Error("Source-period manifest counts do not match reconciliation evidence.");
  }

  const matched = evidence.status === "matched";
  if ((manifest.reconciliationStatus === "matched") !== matched) {
    throw new Error("Source-period manifest reconciliation status does not match reconciliation evidence.");
  }
  if (!matched) {
    if (manifest.reconciliationGeneration !== null || manifest.reconciledAt !== null) {
      throw new Error("Non-matched source-period evidence cannot retain reconciliation generation proof.");
    }
    return;
  }
  if (
    manifest.coverageStatus !== "complete"
    || manifest.continuationToken !== null
    || manifest.completedPageCount !== manifest.expectedPageCount
    || manifest.reconciliationGeneration !== manifest.manifestGeneration
    || !manifest.reconciledAt
    || manifest.listedCount !== manifest.detailCount
    || manifest.detailCount !== manifest.normalizedCount
    || !manifest.sourceIdHash
    || manifest.sourceIdHash !== manifest.normalizedIdHash
    || manifest.evidence.authoritativeListComplete !== true
    || Number(manifest.evidence.listRequestCount) !== manifest.expectedPageCount
  ) {
    throw new Error("Matched backfill reconciliation lacks exact authoritative manifest proof.");
  }
}

export async function findNextBackfillParentId(params: {
  sourceFamily: "quote_nested" | "job_nested";
  monthStart: string;
  monthEndExclusive: string;
  afterId?: number | null;
}) {
  const isQuote = params.sourceFamily === "quote_nested";
  const result = await queryPostgres<{ id: string }>(
    `select source_id as id
       from metrics.backfill_source_month_ledger dependency
       join metrics.backfill_traversal_manifests manifest on manifest.work_unit_id = dependency.id
       cross join lateral jsonb_array_elements_text(manifest.exact_source_ids) source(source_id)
      where dependency.source_family = $1
        and dependency.month_start = $2::date
        and dependency.status = 'completed'
        and manifest.manifest_status in ('completed', 'provisional')
        and source_id ~ '^\d+$'
        and source_id::bigint > $3
      order by source_id::bigint
      limit 1`,
    [isQuote ? "quotes" : "jobs", params.monthStart, params.afterId ?? 0],
  );
  return result.rows[0]?.id ? Number(result.rows[0].id) : null;
}

export async function getBackfillOperationalSummary() {
  const [status, capacity, months] = await Promise.all([
    queryPostgres<{ status: string; count: number; actual_requests: string }>(
      `select status, count(*)::int as count, coalesce(sum(actual_requests), 0)::text as actual_requests
         from metrics.backfill_source_month_ledger
        group by status
        order by status`,
    ),
    queryPostgres<{
      capacity_date: string;
      daily_request_ceiling: number;
      current_requests: number;
      reconciliation_requests: number;
      backfill_requests: number;
      backfill_reserved_requests: number;
    }>(
      `select capacity_date::text, daily_request_ceiling, current_requests, reconciliation_requests,
              backfill_requests, backfill_reserved_requests
         from metrics.backfill_capacity_days
        order by capacity_date desc
        limit 7`,
    ),
    queryPostgres<{
      month_start: string;
      required_source_count: string;
      completed_required_source_count: string;
      required_sources_complete: boolean;
      mobile_partial_source_count: string;
      mobile_unavailable_source_count: string;
      actual_requests: string;
    }>(
      `select month_start::text, required_source_count::text, completed_required_source_count::text,
              coalesce(required_sources_complete, false) as required_sources_complete,
              mobile_partial_source_count::text, mobile_unavailable_source_count::text,
              actual_requests::text
         from metrics.backfill_month_coverage
        order by month_start`,
    ),
  ]);
  return { status: status.rows, capacity: capacity.rows, months: months.rows };
}

async function recoverExpiredBackfillLeases() {
  await queryPostgres(
    `with expired as materialized (
       select id, reserved_capacity_date, reserved_requests, retry_count, max_attempts
         from metrics.backfill_source_month_ledger
        where status = 'running'
          and source_family <> 'invoices'
          and lease_expires_at < now()
        for update skip locked
     ), released as (
       update metrics.backfill_capacity_days c
          set backfill_reserved_requests = greatest(0, c.backfill_reserved_requests - release.total_reserved),
              updated_at = now()
         from (
           select reserved_capacity_date, sum(reserved_requests)::integer as total_reserved
             from expired
            where reserved_capacity_date is not null
            group by reserved_capacity_date
         ) release
        where c.capacity_date = release.reserved_capacity_date
        returning c.capacity_date
     )
     update metrics.backfill_source_month_ledger l
        set status = case when l.retry_count + 1 >= l.max_attempts then 'dead_lettered' else 'queued' end,
            retry_count = l.retry_count + 1,
            locked_by = null,
            locked_at = null,
            lease_expires_at = null,
            heartbeat_at = null,
            reserved_capacity_date = null,
            reserved_requests = 0,
            next_attempt_at = now(),
            last_error = 'backfill lease expired; resumed from the last committed continuation',
            dead_lettered_at = case when l.retry_count + 1 >= l.max_attempts then now() else null end,
            updated_at = now()
       from expired
      where l.id = expired.id
        and (not exists (select 1 from expired where reserved_capacity_date is not null) or exists (select 1 from released))`,
  );
}

async function reopenAdvancedProvisionalBackfills() {
  await queryPostgres(
    `with boundary as (
       select (now() at time zone 'America/Los_Angeles')::date as pacific_date
     ), reopened_manifests as (
       update metrics.backfill_traversal_manifests m
          set generation = m.generation + 1,
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
         from metrics.backfill_source_month_ledger l, boundary b
        where m.work_unit_id = l.id
          and l.source_family <> 'invoices'
          and m.manifest_status = 'provisional'
          and l.status in ('completed', 'queued', 'reconciliation_pending')
          and (m.observed_boundary->>'effectiveEndInclusive')::date
                < least((l.month_end_exclusive - 1), b.pacific_date)
       returning m.work_unit_id
     )
     update metrics.backfill_source_month_ledger l
        set status = 'queued',
            work_phase = 'ingest',
            reconciliation_status = 'pending',
            reconciliation_detail = jsonb_build_object(
              'reason', 'provisional Pacific boundary advanced',
              'reopenedAt', now()
            ),
            continuation_token = null,
            retry_count = 0,
            next_attempt_at = now(),
            completed_at = null,
            last_error = null,
            updated_at = now()
       from reopened_manifests r
      where l.id = r.work_unit_id`,
  );
}

function businessCapacityDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function capacitySummary(dailyRequestCeiling: number) {
  return { dailyRequestCeiling, ...capacityAllocation(dailyRequestCeiling) };
}
