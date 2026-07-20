import { createHash, randomUUID } from "node:crypto";
import { isSimproNotFound, SimproClient, SimproError, sourceHash, type RequestBudget } from "@/lib/simpro/client";
import { SimproEndpoints } from "@/lib/simpro/endpoints";
import { normalizeSimproSnapshot } from "@/lib/simpro/normalize";
import {
  mapCostCenterFact,
  markProjectSourceUnavailable,
  persistProjectCostCenter,
  type SourceProvenance,
} from "@/lib/simpro/normalize-nested";
import { pickId } from "@/lib/simpro/schemas";
import {
  queryPostgres,
  withPostgresTransaction,
  type PostgresQuery,
} from "@/lib/store/postgres";
import type { RollupScope } from "@/lib/store/rollups";

const CONTRACT = "simpro-profit-capacity-028-exact";
const SINGLETON_LOCK = "simpro-profit-capacity-028-exact-worker";
const EMPTY_DIMENSIONS_HASH = createHash("sha256").update(JSON.stringify({})).digest("hex");
const FAILURE_SAMPLE_LIMIT = 100;

type Query = PostgresQuery;
type Transaction = <T>(callback: (query: Query) => Promise<T>) => Promise<T>;
type ExactEndpoints = Pick<SimproEndpoints, "getJob" | "getEmployee" | "getJobCostCenter">;

export type ExactBackfillTarget = {
  id: string;
  target_type: "job" | "cost_center" | "employee";
  target_key: string;
  job_id: string | null;
  section_id: string | null;
  cost_center_id: string | null;
  employee_id: string | null;
  period_start: string | null;
  source_snapshot_id: string | null;
};

type RawTargetSnapshot = {
  id: string;
  payload: Record<string, unknown>;
  source_hash: string;
  source_version: string;
  extracted_at: string;
};

export type DirectProfitCapacityProgress = {
  requestsUsed: number;
  jobs: number;
  costCenters: number;
  employees: number;
  sourceDeleted: number;
  failed: number;
};

export type DirectProfitCapacityResult = DirectProfitCapacityProgress & {
  runId: string;
  claimed: boolean;
  stopReason: "complete" | "request-budget" | "runtime-limit" | "already-running";
  remaining: { jobs: number; costCenters: number; employees: number; failedTargets: number };
  failures: Array<{ target: string; error: string }>;
};

export async function runDirectProfitCapacityBackfill(options: {
  maxRequests?: number;
  runtimeMinutes?: number;
  concurrency?: number;
  actorEmail: string;
  query?: Query;
  transaction?: Transaction;
  endpoints?: ExactEndpoints;
  onProgress?: (progress: DirectProfitCapacityProgress) => void | Promise<void>;
}): Promise<DirectProfitCapacityResult> {
  const query = options.query ?? queryPostgres;
  const transaction: Transaction = options.transaction
    ?? (options.query ? async (callback) => callback(query) : withPostgresTransaction);
  const endpoints = options.endpoints ?? new SimproEndpoints(new SimproClient());
  const maxRequests = boundedInteger(options.maxRequests ?? 5_000, 1, 25_000, "maxRequests");
  const runtimeMinutes = boundedInteger(options.runtimeMinutes ?? 17, 1, 17, "runtimeMinutes");
  const concurrency = boundedInteger(options.concurrency ?? 5, 1, 5, "concurrency");
  const actorEmail = requiredText(options.actorEmail, "actorEmail").toLowerCase();
  const runId = randomUUID();
  const workerId = `profit-capacity-exact-${runId}`;
  const budget: RequestBudget = { limit: maxRequests, used: 0 };
  const deadline = Date.now() + runtimeMinutes * 60_000;
  const progress: DirectProfitCapacityProgress = {
    requestsUsed: 0, jobs: 0, costCenters: 0, employees: 0, sourceDeleted: 0, failed: 0,
  };
  const failures: Array<{ target: string; error: string }> = [];
  const locked = await acquireSingleton(query, workerId);
  if (!locked) {
    return {
      ...progress,
      runId,
      claimed: false,
      stopReason: "already-running",
      remaining: await loadRemaining(query),
      failures,
    };
  }

  let heartbeatError: unknown;
  const heartbeat = setInterval(() => {
    void heartbeatSingleton(query, workerId).catch((error) => { heartbeatError = error; });
  }, 60_000);
  try {
    await seedExactTargets(query);
    await recordRunEvent(query, actorEmail, runId, "simpro_profit_capacity_exact_started", { maxRequests, runtimeMinutes, concurrency });

    while (canLaunch(deadline, budget)) {
      if (heartbeatError) throw heartbeatError;
      const targets = await claimExactTargetBatch(query, workerId, Math.min(50, budget.limit - budget.used));
      if (targets.length === 0) break;
      if (heartbeatError) {
        await releaseExactTargetBatch(query, targets, workerId);
        throw heartbeatError;
      }
      await processConcurrently(targets, concurrency, async (target) => {
        if (heartbeatError || !canLaunch(deadline, budget)) {
          await releaseExactTarget(query, target.id, workerId);
          return;
        }
        try {
          const outcome = await processTarget({ target, endpoints, budget, query, transaction, workerId });
          if (outcome.sourceDeleted) progress.sourceDeleted += 1;
          else if (target.target_type === "job") progress.jobs += 1;
          else if (target.target_type === "cost_center") progress.costCenters += 1;
          else progress.employees += 1;
        } catch (error) {
          if (isBudgetExhausted(error)) {
            await releaseExactTarget(query, target.id, workerId);
            return;
          }
          const message = error instanceof Error ? error.message : String(error);
          await failExactTarget(query, target.id, workerId, message);
          progress.failed += 1;
          if (failures.length < FAILURE_SAMPLE_LIMIT) failures.push({ target: `${target.target_type}:${target.target_key}`, error: message });
        } finally {
          progress.requestsUsed = budget.used;
          const processed = progress.jobs + progress.costCenters + progress.employees + progress.sourceDeleted + progress.failed;
          if (processed > 0 && processed % 100 === 0) await options.onProgress?.({ ...progress });
        }
      });
    }

    const remaining = await loadRemaining(query);
    const stopReason = remaining.jobs + remaining.costCenters + remaining.employees + remaining.failedTargets === 0
      ? "complete"
      : budget.used >= budget.limit
        ? "request-budget"
        : "runtime-limit";
    const result: DirectProfitCapacityResult = {
      ...progress, requestsUsed: budget.used, runId, claimed: true, stopReason, remaining, failures,
    };
    await recordRunEvent(query, actorEmail, runId, "simpro_profit_capacity_exact_finished", result);
    return result;
  } finally {
    clearInterval(heartbeat);
    await releaseSingleton(query, workerId);
  }
}

async function processTarget(params: {
  target: ExactBackfillTarget;
  endpoints: ExactEndpoints;
  budget: RequestBudget;
  query: Query;
  transaction: Transaction;
  workerId: string;
}) {
  const { target, endpoints, budget, query, transaction, workerId } = params;
  let snapshot = await loadTargetSnapshot(query, target);
  let sourceDeleted = false;
  if (!snapshot) {
    let payload: Record<string, unknown>;
    try {
      payload = await fetchTarget(target, endpoints, budget);
      assertTargetIdentity(target, payload);
    } catch (error) {
      if (!isSimproNotFound(error) || target.target_type === "employee") throw error;
      payload = { sourceUnavailable: true, reason: "not_found", status: 404, targetType: target.target_type, targetKey: target.target_key };
      sourceDeleted = true;
    }
    snapshot = await persistTargetSnapshot(query, target, payload, workerId);
  } else {
    sourceDeleted = snapshot.payload.sourceUnavailable === true && Number(snapshot.payload.status) === 404;
  }

  return transaction(async (transactionQuery) => {
    await lockOwnedExactTarget(transactionQuery, target, workerId);
    const provenance: SourceProvenance = {
      sourceSnapshotId: Number(snapshot.id),
      sourceHash: snapshot.source_hash,
      fetchedAt: snapshot.extracted_at,
    };
    let affectedPeriods: Array<{ scope: RollupScope; periodStart: string }> = [];
    if (sourceDeleted) {
      affectedPeriods = await applySourceDeletedTarget(transactionQuery, target);
    } else if (target.target_type === "cost_center") {
      const jobId = requiredTargetId(target.job_id, "job_id");
      const sectionId = requiredTargetId(target.section_id, "section_id");
      await persistProjectCostCenter({
        projectType: "job",
        projectId: jobId,
        fact: mapCostCenterFact(sectionId, snapshot.payload),
        provenance,
        query: transactionQuery,
      });
      affectedPeriods = defaultTargetPeriods(target);
    } else {
      const entityId = target.target_type === "job" ? target.job_id : target.employee_id;
      const normalized = await normalizeSimproSnapshot({
        entity: target.target_type === "job" ? "jobs" : "employees",
        entityId: String(requiredTargetId(entityId, `${target.target_type}_id`)),
        payload: snapshot.payload,
        sourceSnapshotId: provenance.sourceSnapshotId,
        sourceHash: provenance.sourceHash,
        sourceVersion: snapshot.source_version,
        fetchedAt: provenance.fetchedAt,
        query: transactionQuery,
      });
      if (!normalized.normalized) throw new Error(`Canonical normalizer rejected ${target.target_type}:${target.target_key}.`);
      affectedPeriods = target.target_type === "employee"
        ? employeeCapacityPeriods()
        : mergePeriods(defaultTargetPeriods(target), normalized.affectedPeriods);
      if (target.target_type === "job") {
        await restoreExactJobCostCenters(transactionQuery, requiredTargetId(target.job_id, "job_id"));
      }
    }
    const outcome = { sourceSnapshotId: Number(snapshot.id), sourceDeleted, affectedPeriods };
    await completeExactTarget({ query: transactionQuery, target, workerId, ...outcome });
    return outcome;
  });
}

async function fetchTarget(target: ExactBackfillTarget, endpoints: ExactEndpoints, budget: RequestBudget) {
  if (target.target_type === "job") return endpoints.getJob(requiredTargetId(target.job_id, "job_id"), budget);
  if (target.target_type === "employee") return endpoints.getEmployee(requiredTargetId(target.employee_id, "employee_id"), budget);
  return endpoints.getJobCostCenter(
    requiredTargetId(target.job_id, "job_id"),
    requiredTargetId(target.section_id, "section_id"),
    requiredTargetId(target.cost_center_id, "cost_center_id"),
    budget,
  );
}

export function assertTargetIdentity(target: ExactBackfillTarget, payload: Record<string, unknown>) {
  const expected = target.target_type === "employee" ? target.employee_id : target.target_type === "job" ? target.job_id : target.cost_center_id;
  const actual = numericPayloadId(payload.ID ?? payload.id);
  if (actual === null || actual !== requiredTargetId(expected, `${target.target_type}_id`)) {
    throw new Error(`Simpro response identity mismatch for ${target.target_type}:${target.target_key}.`);
  }
  if (target.target_type === "cost_center") {
    const responseJob = numericPayloadId(payload.Job ?? payload.JobID);
    const responseSection = numericPayloadId(payload.Section ?? payload.SectionID);
    if (responseJob !== null && responseJob !== requiredTargetId(target.job_id, "job_id")) {
      throw new Error(`Simpro response job mismatch for cost_center:${target.target_key}.`);
    }
    if (responseSection !== null && responseSection !== requiredTargetId(target.section_id, "section_id")) {
      throw new Error(`Simpro response section mismatch for cost_center:${target.target_key}.`);
    }
  }
}

export async function seedExactTargets(query: Query = queryPostgres) {
  const result = await query<{ inserted: string }>(
    `with recovered as (
       update metrics.profit_capacity_exact_backfill_targets
          set status = case when attempts >= 5 then 'failed' else 'queued' end,
              locked_by = null, lock_expires_at = null, updated_at = now()
        where contract = $1 and status = 'running' and lock_expires_at < now()
     ), candidates as (
       select 'cost_center'::text as target_type,
              concat_ws(':', cost_center.job_id, cost_center.section_id, cost_center.cost_center_id) as target_key,
              cost_center.job_id, cost_center.section_id, cost_center.cost_center_id,
              null::bigint as employee_id, date_trunc('month', job.completed_date)::date as period_start
         from metrics.metrics_job_cost_centers cost_center
         join metrics.metrics_jobs job on job.job_id = cost_center.job_id
        where job.source_deleted_at is null and job.stage in ('Complete', 'Archived')
          and cost_center.source_deleted_at is null and not cost_center.totals_authoritative
       union all
       select 'employee', person.simpro_employee_id::text, null, null, null,
              person.simpro_employee_id, null::date
         from metrics.dim_people person
        where person.simpro_employee_id is not null and person.capacity_normalized_at is null
       union all
       select 'job', job.job_id::text, job.job_id, null, null, null,
              date_trunc('month', job.completed_date)::date
         from metrics.metrics_jobs job
        where job.source_deleted_at is null and job.stage in ('Complete', 'Archived')
          and job.profit_capacity_normalized_at is null
     ), inserted as (
       insert into metrics.profit_capacity_exact_backfill_targets (
         contract, target_type, target_key, job_id, section_id, cost_center_id, employee_id, period_start
       )
       select $1, target_type, target_key, job_id, section_id, cost_center_id, employee_id, period_start
         from candidates
       on conflict (contract, target_type, target_key) do nothing
       returning id
     ) select count(*)::text as inserted from inserted`,
    [CONTRACT],
  );
  return Number(result.rows[0]?.inserted ?? 0);
}

export async function requeueFailedExactTargets(params: {
  actorEmail: string;
  confirmation: string;
  query?: Query;
}) {
  if (params.confirmation !== "RETRY-SIMPRO-PROFIT-CAPACITY-028") {
    throw new Error("Exact retry confirmation is required.");
  }
  const query = params.query ?? queryPostgres;
  const result = await query<{ requeued: string }>(
    `with requeued as (
       update metrics.profit_capacity_exact_backfill_targets
          set status = 'queued', attempts = 0, next_attempt_at = now(),
              locked_by = null, lock_expires_at = null, last_error = null, updated_at = now()
        where contract = $1 and status = 'failed'
        returning id
     ), audited as (
       insert into metrics.audit_events (actor_email, action, entity_type, entity_id, after_value, reason)
       select $2, 'simpro_profit_capacity_exact_failed_requeued', 'backfill_contract', $1,
              jsonb_build_object('requeued', count(*)), 'Explicit audited retry of terminal exact-detail targets.'
         from requeued
       returning after_value
     ) select coalesce(after_value ->> 'requeued', '0') as requeued from audited`,
    [CONTRACT, requiredText(params.actorEmail, "actorEmail").toLowerCase()],
  );
  return Number(result.rows[0]?.requeued ?? 0);
}

export async function claimExactTargetBatch(query: Query, workerId: string, limit: number) {
  const result = await query<ExactBackfillTarget>(
    `with candidates as (
       select id
         from metrics.profit_capacity_exact_backfill_targets
        where contract = $1 and status = 'queued' and next_attempt_at <= now()
        order by case target_type when 'cost_center' then 0 when 'employee' then 1 else 2 end, id
        for update skip locked
        limit $2
     )
     update metrics.profit_capacity_exact_backfill_targets target
        set status = 'running', attempts = attempts + 1, locked_by = $3,
            lock_expires_at = now() + interval '10 minutes', next_attempt_at = now(), updated_at = now()
       from candidates
      where target.id = candidates.id
      returning target.id::text, target.target_type, target.target_key,
                target.job_id::text, target.section_id::text, target.cost_center_id::text,
                target.employee_id::text, target.period_start::text, target.source_snapshot_id::text`,
    [CONTRACT, boundedInteger(limit, 1, 250, "claim limit"), workerId],
  );
  return result.rows;
}

export async function persistTargetSnapshot(
  query: Query,
  target: ExactBackfillTarget,
  payload: Record<string, unknown>,
  workerId: string,
) {
  const entityType = target.target_type === "job" ? "job_details" : target.target_type === "employee" ? "employee_details" : "job_cost_center_detail";
  const entityId = target.target_type === "cost_center"
    ? `${target.target_key}:costCenter:${target.cost_center_id}`
    : target.target_key;
  const hash = sourceHash(payload);
  const parentIdentity = target.target_type === "cost_center"
    ? { projectType: "job", projectId: Number(target.job_id), sectionId: Number(target.section_id), costCenterId: Number(target.cost_center_id) }
    : target.target_type === "employee" ? { employeeId: Number(target.employee_id) } : { projectType: "job", projectId: Number(target.job_id) };
  const sourcePath = target.target_type === "job" ? `/jobs/${target.job_id}`
    : target.target_type === "employee" ? `/employees/${target.employee_id}`
      : `/jobs/${target.job_id}/sections/${target.section_id}/costCenters/${target.cost_center_id}`;
  const result = await query<RawTargetSnapshot>(
    `with owned as materialized (
       select id
         from metrics.profit_capacity_exact_backfill_targets
        where id = $9::bigint and status = 'running' and locked_by = $10
          and lock_expires_at > now()
        for update
     ), snapshot as (
       insert into metrics.raw_simpro_snapshots (
         entity_type, entity_id, source_path, payload, source_hash, source_updated_at,
         source_version, parent_identity
       )
       select $1, $2, $3, $4::jsonb, $5, $6::timestamptz, $7, $8::jsonb
         from owned
       on conflict (entity_type, entity_id, source_hash) do update set
         source_path = metrics.raw_simpro_snapshots.source_path
       returning id, payload, source_hash, source_version, extracted_at
     ), linked as (
       update metrics.profit_capacity_exact_backfill_targets target
          set source_snapshot_id = snapshot.id, updated_at = now()
         from snapshot, owned
        where target.id = owned.id and target.status = 'running' and target.locked_by = $10
          and target.lock_expires_at > now()
        returning snapshot.id, snapshot.payload, snapshot.source_hash, snapshot.source_version,
                  snapshot.extracted_at::text
     ) select id::text, payload, source_hash, source_version, extracted_at from linked`,
    [entityType, entityId, sourcePath, JSON.stringify(payload), hash, textValue(payload.DateModified), "exact-backfill-028", JSON.stringify(parentIdentity), target.id, workerId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`Lost target lease while persisting ${target.target_type}:${target.target_key}.`);
  return row;
}

export async function lockOwnedExactTarget(query: Query, target: ExactBackfillTarget, workerId: string) {
  const result = await query<{ id: string }>(
    `select id::text
       from metrics.profit_capacity_exact_backfill_targets
      where id = $1::bigint and status = 'running' and locked_by = $2
        and lock_expires_at > now()
      for update`,
    [target.id, workerId],
  );
  if (!result.rows[0]) {
    throw new Error(`Lost target lease before normalizing ${target.target_type}:${target.target_key}.`);
  }
}

async function loadTargetSnapshot(query: Query, target: ExactBackfillTarget) {
  if (!target.source_snapshot_id) return null;
  const result = await query<RawTargetSnapshot>(
    `select id::text, payload, source_hash, source_version, extracted_at::text
       from metrics.raw_simpro_snapshots where id = $1::bigint`,
    [target.source_snapshot_id],
  );
  return result.rows[0] ?? null;
}

export async function completeExactTarget(params: {
  query: Query;
  target: ExactBackfillTarget;
  workerId: string;
  sourceSnapshotId: number;
  sourceDeleted: boolean;
  affectedPeriods: Array<{ scope: RollupScope; periodStart: string }>;
}) {
  const publications = mergePeriods(params.affectedPeriods).map((period) => ({
    metric_family: period.scope,
    period_start: period.periodStart,
    reason: `${CONTRACT} completed ${params.target.target_type}:${params.target.target_key}`,
    idempotency_key: `${period.scope}:month:${period.periodStart}:${EMPTY_DIMENSIONS_HASH}`,
  }));
  const result = await params.query<{ id: string }>(
    `with completed as (
       update metrics.profit_capacity_exact_backfill_targets
          set status = $4, source_snapshot_id = $5, locked_by = null, lock_expires_at = null,
              last_error = null, completed_at = now(), updated_at = now()
        where id = $1::bigint and status = 'running' and locked_by = $2
        returning id
     ), rollups as (
       insert into metrics.rollup_rebuild_queue (
         metric_family, period_grain, period_start, dimensions_json, reason, idempotency_key
       )
       select publication.metric_family, 'month', publication.period_start, '{}'::jsonb,
              publication.reason, publication.idempotency_key
         from jsonb_to_recordset($3::jsonb) publication(
           metric_family text, period_start date, reason text, idempotency_key text
         )
         cross join completed
       on conflict (idempotency_key) do update set
         status = case when metrics.rollup_rebuild_queue.status = 'running'
                            and metrics.rollup_rebuild_queue.locked_until > now()
                       then metrics.rollup_rebuild_queue.status else 'queued'::metrics.rollup_rebuild_status end,
         locked_by = case when metrics.rollup_rebuild_queue.status = 'running'
                               and metrics.rollup_rebuild_queue.locked_until > now()
                          then metrics.rollup_rebuild_queue.locked_by else null end,
         locked_until = case when metrics.rollup_rebuild_queue.status = 'running'
                                  and metrics.rollup_rebuild_queue.locked_until > now()
                             then metrics.rollup_rebuild_queue.locked_until else null end,
         reason = excluded.reason, finished_at = null, error_message = null
       returning metric_family, period_start, reason, idempotency_key, status, locked_until
     ), followups as (
       insert into metrics.rollup_rebuild_queue (
         metric_family, period_grain, period_start, dimensions_json, reason, idempotency_key
       )
       select dirty.metric_family, 'month', dirty.period_start, '{}'::jsonb,
              dirty.reason || ' after an older running rebuild',
              dirty.idempotency_key || ':after-exact-target-' || $1::text
         from rollups dirty
         cross join completed
        where dirty.status = 'running' and dirty.locked_until > now()
       on conflict (idempotency_key) do update set
         status = 'queued'::metrics.rollup_rebuild_status,
         locked_by = null, locked_until = null, reason = excluded.reason,
         finished_at = null, error_message = null
       returning id
     ) select id::text from completed`,
    [params.target.id, params.workerId, JSON.stringify(publications), params.sourceDeleted ? "source_deleted" : "succeeded", params.sourceSnapshotId],
  );
  if (!result.rows[0]) throw new Error(`Lost target lease while completing ${params.target.target_type}:${params.target.target_key}.`);
}

export async function applySourceDeletedTarget(query: Query, target: ExactBackfillTarget) {
  if (target.target_type === "cost_center") {
    await query(
      `with deleted_snapshots as (
         update metrics.raw_simpro_snapshots
            set source_deleted_at = coalesce(source_deleted_at, now())
          where entity_type = 'job_cost_center_detail'
            and parent_identity @> jsonb_build_object(
              'projectType', 'job', 'projectId', $1::bigint,
              'sectionId', $2::bigint, 'costCenterId', $3::bigint
            )
         returning id
       )
       update metrics.metrics_job_cost_centers
          set source_deleted_at = coalesce(source_deleted_at, now()), updated_from_source_at = now()
        where job_id = $1 and section_id = $2 and cost_center_id = $3`,
      [target.job_id, target.section_id, target.cost_center_id],
    );
    return defaultTargetPeriods(target);
  }
  if (target.target_type === "job") {
    const sourceUnavailable = await markProjectSourceUnavailable(
      "job",
      requiredTargetId(target.job_id, "job_id"),
      {
        query,
        transaction: async (callback) => callback(query),
      },
    );
    return sourceUnavailable.affectedPeriods;
  }
  throw new Error(`Employee ${target.target_key} is unavailable from Simpro and requires source remediation.`);
}

async function restoreExactJobCostCenters(query: Query, jobId: number) {
  await query(
    `update metrics.metrics_job_cost_centers cost_center
        set source_deleted_at = null, updated_from_source_at = now()
      where cost_center.job_id = $1
        and exists (
          select 1 from metrics.raw_simpro_snapshots snapshot
           where snapshot.entity_type = 'job_cost_center_detail'
             and snapshot.source_deleted_at is null
             and coalesce((snapshot.payload ->> 'sourceUnavailable')::boolean, false) = false
             and snapshot.parent_identity @> jsonb_build_object(
               'projectType', 'job', 'projectId', cost_center.job_id,
               'sectionId', cost_center.section_id, 'costCenterId', cost_center.cost_center_id
             )
        )`,
    [jobId],
  );
}

async function failExactTarget(query: Query, targetId: string, workerId: string, error: string) {
  await query(
    `update metrics.profit_capacity_exact_backfill_targets
        set status = case when attempts >= 5 then 'failed' else 'queued' end,
            locked_by = null, lock_expires_at = null,
            next_attempt_at = case when attempts >= 5 then next_attempt_at
              else now() + make_interval(secs => least(900, 30 * power(2, greatest(0, attempts - 1)))::integer) end,
            last_error = left($3, 2000), updated_at = now()
      where id = $1::bigint and status = 'running' and locked_by = $2`,
    [targetId, workerId, error],
  );
}

async function releaseExactTarget(query: Query, targetId: string, workerId: string) {
  await query(
    `update metrics.profit_capacity_exact_backfill_targets
        set status = 'queued', attempts = greatest(0, attempts - 1), locked_by = null,
            lock_expires_at = null, next_attempt_at = now(), updated_at = now()
      where id = $1::bigint and status = 'running' and locked_by = $2`,
    [targetId, workerId],
  );
}

export async function releaseExactTargetBatch(
  query: Query,
  targets: ExactBackfillTarget[],
  workerId: string,
) {
  if (targets.length === 0) return;
  await query(
    `update metrics.profit_capacity_exact_backfill_targets
        set status = 'queued', attempts = greatest(0, attempts - 1), locked_by = null,
            lock_expires_at = null, next_attempt_at = now(), updated_at = now()
      where id = any($1::bigint[]) and status = 'running' and locked_by = $2`,
    [targets.map((target) => target.id), workerId],
  );
}

export async function acquireSingleton(query: Query, workerId: string) {
  const result = await query<{ locked: boolean }>(
    `with claimed as (
       insert into metrics.profit_capacity_exact_backfill_control (
         lock_key, locked_by, lock_expires_at, heartbeat_at, updated_at
       ) values ($1, $2, now() + interval '3 minutes', now(), now())
       on conflict (lock_key) do update set
         locked_by = excluded.locked_by,
         lock_expires_at = excluded.lock_expires_at,
         heartbeat_at = excluded.heartbeat_at,
         updated_at = now()
       where metrics.profit_capacity_exact_backfill_control.locked_by is null
          or metrics.profit_capacity_exact_backfill_control.lock_expires_at is null
          or metrics.profit_capacity_exact_backfill_control.lock_expires_at < now()
       returning lock_key
     ) select exists(select 1 from claimed) as locked`,
    [SINGLETON_LOCK, workerId],
  );
  return result.rows[0]?.locked === true;
}

export async function heartbeatSingleton(query: Query, workerId: string) {
  const result = await query(
    `update metrics.profit_capacity_exact_backfill_control
        set lock_expires_at = now() + interval '3 minutes', heartbeat_at = now(), updated_at = now()
      where lock_key = $1 and locked_by = $2 and lock_expires_at > now()
      returning lock_key`,
    [SINGLETON_LOCK, workerId],
  );
  if (!result.rowCount) throw new Error("Lost the exact backfill singleton lease.");
}

export async function releaseSingleton(query: Query, workerId: string) {
  await query(
    `update metrics.profit_capacity_exact_backfill_control
        set locked_by = null, lock_expires_at = null, updated_at = now()
      where lock_key = $1 and locked_by = $2`,
    [SINGLETON_LOCK, workerId],
  );
}

async function recordRunEvent(query: Query, actorEmail: string, runId: string, action: string, value: unknown) {
  await query(
    `insert into metrics.audit_events (actor_email, action, entity_type, entity_id, after_value, reason)
     values ($1, $2, 'backfill_contract', $3, $4::jsonb, $5)`,
    [actorEmail, action, runId, JSON.stringify(value), CONTRACT],
  );
}

async function loadRemaining(query: Query) {
  const result = await query<{
    completed_jobs_missing: string;
    active_completed_cost_centers_missing: string;
    people_missing: string;
    failed_targets: string;
  }>(
    `select completeness.completed_jobs_missing::text,
            completeness.active_completed_cost_centers_missing::text,
            completeness.people_missing::text,
            (select count(*)::text from metrics.profit_capacity_exact_backfill_targets
              where contract = $1 and status = 'failed') as failed_targets
       from metrics.simpro_profit_capacity_completeness completeness`,
    [CONTRACT],
  );
  const row = result.rows[0];
  return {
    jobs: Number(row?.completed_jobs_missing ?? 0),
    costCenters: Number(row?.active_completed_cost_centers_missing ?? 0),
    employees: Number(row?.people_missing ?? 0),
    failedTargets: Number(row?.failed_targets ?? 0),
  };
}

function defaultTargetPeriods(target: ExactBackfillTarget) {
  if (!target.period_start) return [];
  return (["jobs", "technicians", "commissions"] as RollupScope[]).map((scope) => ({ scope, periodStart: target.period_start! }));
}

function employeeCapacityPeriods(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit" }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (!year || !month) throw new Error("Could not resolve the current Pacific month.");
  const periods: Array<{ scope: RollupScope; periodStart: string }> = [];
  for (let cursor = "2023-01"; cursor <= `${year}-${month}`; cursor = nextMonth(cursor)) {
    periods.push({ scope: "technicians", periodStart: `${cursor}-01` });
    periods.push({ scope: "commissions", periodStart: `${cursor}-01` });
  }
  return periods;
}

function mergePeriods(...groups: Array<Array<{ scope: RollupScope; periodStart: string }>>) {
  return [...new Map(groups.flat().map((period) => [`${period.scope}:${period.periodStart}`, period])).values()];
}

function nextMonth(month: string) {
  const [year, value] = month.split("-").map(Number);
  return new Date(Date.UTC(year, value, 1)).toISOString().slice(0, 7);
}

function requiredTargetId(value: string | null, field: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${field} is invalid.`);
  return parsed;
}

function canLaunch(deadline: number, budget: RequestBudget) {
  return budget.used < budget.limit && Date.now() < deadline - 60_000;
}

function isBudgetExhausted(error: unknown) {
  return error instanceof SimproError && error.message === "Simpro request budget exhausted";
}

async function processConcurrently<T>(items: T[], concurrency: number, handler: (item: T) => Promise<void>) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      await handler(items[index]);
    }
  }));
}

function boundedInteger(value: number, minimum: number, maximum: number, field: string) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function requiredText(value: string, field: string) {
  const text = value.trim();
  if (!text) throw new Error(`${field} is required.`);
  return text;
}

function textValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function numericPayloadId(value: unknown) {
  const raw = value && typeof value === "object" ? pickId(value) : value;
  if (raw === null || raw === undefined || raw === "") return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
