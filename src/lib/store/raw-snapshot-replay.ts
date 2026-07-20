import { randomUUID } from "node:crypto";
import {
  normalizeSimproSnapshot,
  type NormalizationResult,
} from "@/lib/simpro/normalize";
import { queryPostgres } from "@/lib/store/postgres";

const REPLAY_CONTRACT = "simpro-profit-capacity-026";
const AUDIT_ACTOR = "system:raw-snapshot-replay";

type QueryResult<T> = {
  rows: T[];
  rowCount: number | null;
};

export type RawSnapshotReplayQuery = <T = Record<string, unknown>>(
  text: string,
  values?: unknown[],
) => Promise<QueryResult<T>>;

export type RawSnapshotNormalizer = (params: {
  entity: "jobs" | "employees";
  entityId: string;
  payload: Record<string, unknown>;
  sourceSnapshotId: number;
  sourceHash: string;
  sourceVersion: string;
  fetchedAt: string;
}) => Promise<NormalizationResult>;

export type RawSnapshotReplayProgress = {
  runId: string;
  processed: number;
  succeeded: number;
  failed: number;
  remaining: number;
};

export type RawSnapshotReplayOptions = {
  batchSize?: number;
  maxItems?: number;
  actorEmail?: string;
  runId?: string;
  query?: RawSnapshotReplayQuery;
  normalize?: RawSnapshotNormalizer;
  onProgress?: (progress: RawSnapshotReplayProgress) => void | Promise<void>;
};

type ReplaySnapshot = {
  id: string | number;
  entity_type: "job_details" | "job_cost_center_detail" | "employee_details";
  entity_id: string;
  source_hash: string;
  source_version: string;
  extracted_at: string | Date;
  payload: unknown;
  parent_identity: unknown;
};

type ReplayFailure = {
  sourceSnapshotId: number;
  entityType: ReplaySnapshot["entity_type"];
  entityId: string;
  error: string;
};

const LATEST_SNAPSHOTS_CTE = `
  with ranked_snapshots as materialized (
    select snapshot.*,
           row_number() over (
             partition by snapshot.entity_type,
               case
                 when snapshot.entity_type = 'job_cost_center_detail' then concat_ws(
                   ':', snapshot.parent_identity->>'projectType',
                   snapshot.parent_identity->>'projectId',
                   snapshot.parent_identity->>'sectionId',
                   snapshot.parent_identity->>'costCenterId'
                 )
                 else snapshot.entity_id
               end
             order by snapshot.extracted_at desc, snapshot.id desc
           ) as snapshot_rank
      from metrics.raw_simpro_snapshots snapshot
     where snapshot.entity_type in ('job_details', 'job_cost_center_detail', 'employee_details')
       and snapshot.source_deleted_at is null
  ), latest_snapshots as materialized (
    select * from ranked_snapshots where snapshot_rank = 1
  ), pending_snapshots as materialized (
    select snapshot.*
      from latest_snapshots snapshot
      left join metrics.metrics_jobs job
        on snapshot.entity_type = 'job_details'
       and job.job_id::text = snapshot.entity_id
      left join metrics.employee_snapshots employee
        on snapshot.entity_type = 'employee_details'
       and employee.employee_id::text = snapshot.entity_id
      left join metrics.dim_people person
        on snapshot.entity_type = 'employee_details'
       and person.simpro_employee_id::text = snapshot.entity_id
      left join metrics.metrics_job_cost_centers cost_center
        on snapshot.entity_type = 'job_cost_center_detail'
       and cost_center.job_id::text = snapshot.parent_identity->>'projectId'
       and cost_center.section_id::text = snapshot.parent_identity->>'sectionId'
       and cost_center.cost_center_id::text = snapshot.parent_identity->>'costCenterId'
     where not coalesce((
       snapshot.entity_type = 'job_details'
       and job.source_snapshot_id = snapshot.id
       and job.profit_capacity_normalized_at is not null
     ), false)
       and not coalesce((
         snapshot.entity_type = 'employee_details'
         and employee.source_snapshot_id = snapshot.id
         and person.capacity_normalized_at is not null
       ), false)
       and not coalesce((
         snapshot.entity_type = 'job_cost_center_detail'
         and cost_center.source_snapshot_id = snapshot.id
         and cost_center.totals_authoritative
       ), false)
  )`;

export async function replayRawSimproSnapshots(
  options: RawSnapshotReplayOptions = {},
): Promise<RawSnapshotReplayProgress> {
  const query = options.query ?? queryPostgres;
  const normalize = options.normalize ?? normalizeSimproSnapshot;
  const batchSize = boundedInteger(options.batchSize ?? 100, 1, 500, "batchSize");
  const maxItems = boundedInteger(options.maxItems ?? 100_000, 1, 1_000_000, "maxItems");
  const actorEmail = requiredText(options.actorEmail ?? AUDIT_ACTOR, "actorEmail");
  const runId = requiredText(options.runId ?? randomUUID(), "runId");
  const initialRemaining = await countPendingRawSnapshots(query);
  const totals: RawSnapshotReplayProgress = {
    runId,
    processed: 0,
    succeeded: 0,
    failed: 0,
    remaining: initialRemaining,
  };

  await recordReplayAudit(query, actorEmail, runId, "raw_snapshot_replay_started", {
    contract: REPLAY_CONTRACT,
    batchSize,
    maxItems,
    ...totals,
  });

  let cursor = 0;
  while (totals.processed < maxItems) {
    const snapshots = await loadPendingRawSnapshotBatch(
      query,
      cursor,
      Math.min(batchSize, maxItems - totals.processed),
    );
    if (snapshots.length === 0) break;

    const failures: ReplayFailure[] = [];
    for (const snapshot of snapshots) {
      const snapshotId = positiveInteger(snapshot.id, "source snapshot ID");
      cursor = Math.max(cursor, snapshotId);
      totals.processed += 1;
      try {
        await replaySnapshot(snapshot, snapshotId, query, normalize);
        totals.succeeded += 1;
      } catch (error) {
        totals.failed += 1;
        failures.push({
          sourceSnapshotId: snapshotId,
          entityType: snapshot.entity_type,
          entityId: snapshot.entity_id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    totals.remaining = await countPendingRawSnapshots(query);
    await recordReplayAudit(query, actorEmail, runId, "raw_snapshot_replay_progress", {
      contract: REPLAY_CONTRACT,
      cursor,
      batchProcessed: snapshots.length,
      failures,
      ...totals,
    });
    await options.onProgress?.({ ...totals });
  }

  totals.remaining = await countPendingRawSnapshots(query);
  await recordReplayAudit(query, actorEmail, runId, "raw_snapshot_replay_finished", {
    contract: REPLAY_CONTRACT,
    ...totals,
  });
  return totals;
}

export async function loadPendingRawSnapshotBatch(
  query: RawSnapshotReplayQuery,
  afterSnapshotId: number,
  limit: number,
): Promise<ReplaySnapshot[]> {
  const result = await query<ReplaySnapshot>(
    `${LATEST_SNAPSHOTS_CTE}
     select id::text, entity_type, entity_id, source_hash, source_version,
            extracted_at::text, payload, parent_identity
       from pending_snapshots
      where id > $1::bigint
      order by id
      limit $2`,
    [afterSnapshotId, boundedInteger(limit, 1, 500, "limit")],
  );
  return result.rows;
}

export async function countPendingRawSnapshots(
  query: RawSnapshotReplayQuery = queryPostgres,
): Promise<number> {
  const result = await query<{ remaining: string | number }>(
    `${LATEST_SNAPSHOTS_CTE}
     select count(*)::text as remaining from pending_snapshots`,
  );
  return nonNegativeInteger(result.rows[0]?.remaining ?? 0, "remaining snapshot count");
}

async function replaySnapshot(
  snapshot: ReplaySnapshot,
  snapshotId: number,
  query: RawSnapshotReplayQuery,
  normalize: RawSnapshotNormalizer,
) {
  if (snapshot.entity_type === "job_cost_center_detail") {
    await replayJobCostCenterSnapshot(snapshot, snapshotId, query);
    return;
  }

  const result = await normalize({
    entity: snapshot.entity_type === "job_details" ? "jobs" : "employees",
    entityId: snapshot.entity_id,
    payload: recordPayload(snapshot.payload),
    sourceSnapshotId: snapshotId,
    sourceHash: snapshot.source_hash,
    sourceVersion: snapshot.source_version,
    fetchedAt: timestampText(snapshot.extracted_at),
  });
  if (!result.normalized) {
    throw new Error(`Canonical normalizer rejected ${snapshot.entity_type}:${snapshot.entity_id}.`);
  }
}

async function replayJobCostCenterSnapshot(
  snapshot: ReplaySnapshot,
  snapshotId: number,
  query: RawSnapshotReplayQuery,
) {
  const parent = recordPayload(snapshot.parent_identity);
  if (parent.projectType !== "job") {
    throw new Error(`Snapshot ${snapshotId} does not have job cost-center provenance.`);
  }
  const jobId = positiveInteger(parent.projectId, "projectId");
  const sectionId = positiveInteger(parent.sectionId, "sectionId");
  const costCenterId = positiveInteger(parent.costCenterId, "costCenterId");
  const result = await query<{ totals_authoritative: boolean }>(
    `update metrics.metrics_job_cost_centers
        set source_snapshot_id = $1,
            source_hash = $2,
            fetched_at = $3::timestamptz,
            updated_from_source_at = updated_from_source_at
      where job_id = $4 and section_id = $5 and cost_center_id = $6
      returning totals_authoritative`,
    [
      snapshotId,
      snapshot.source_hash,
      timestampText(snapshot.extracted_at),
      jobId,
      sectionId,
      costCenterId,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Canonical job cost center ${jobId}:${sectionId}:${costCenterId} does not exist.`);
  }
  if (!row.totals_authoritative) {
    throw new Error(`Migration 026 did not apply authoritative totals for snapshot ${snapshotId}.`);
  }
}

async function recordReplayAudit(
  query: RawSnapshotReplayQuery,
  actorEmail: string,
  runId: string,
  action: string,
  after: Record<string, unknown>,
) {
  await query(
    `insert into metrics.audit_events (
       actor_email, action, entity_type, entity_id, after_value, reason
     ) values ($1, $2, 'raw_snapshot_replay', $3, $4::jsonb, $5)`,
    [
      actorEmail,
      action,
      runId,
      JSON.stringify(after),
      "Replayed only app-owned raw Simpro snapshots through canonical migration-026 normalization; no Simpro request was made.",
    ],
  );
}

function recordPayload(value: unknown): Record<string, unknown> {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Raw snapshot payload must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function timestampText(value: string | Date) {
  const timestamp = value instanceof Date ? value.toISOString() : value;
  if (Number.isNaN(Date.parse(timestamp))) throw new Error(`Invalid snapshot timestamp ${timestamp}.`);
  return timestamp;
}

function positiveInteger(value: unknown, field: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${field} must be a positive integer.`);
  return parsed;
}

function nonNegativeInteger(value: unknown, field: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${field} must be a non-negative integer.`);
  return parsed;
}

function boundedInteger(value: number, minimum: number, maximum: number, field: string) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function requiredText(value: string, field: string) {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required.`);
  return normalized;
}
