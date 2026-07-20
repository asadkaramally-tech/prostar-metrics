import type { IngestionEntity } from "@/lib/simpro/ingest";
import { queryPostgres } from "@/lib/store/postgres";

export type FailedIngestionRepairRow = {
  id: number;
  entity_type: IngestionEntity;
  idempotency_key: string;
  attempts: number;
  last_error: string | null;
};

export async function previewFailedIngestionRepair(params: {
  entity: IngestionEntity;
  errorContains: string;
  limit: number;
}) {
  return queryPostgres<FailedIngestionRepairRow>(
    `select id, entity_type::text as entity_type, idempotency_key, attempts, last_error
       from metrics.ingestion_jobs
      where entity_type = $1::metrics.ingestion_entity_type
        and status = 'failed'
        and position(lower($2) in lower(coalesce(last_error, ''))) > 0
      order by id
      limit $3`,
    [params.entity, requiredText(params.errorContains, "errorContains"), boundedLimit(params.limit)],
  );
}

export async function requeueFailedIngestionRepair(params: {
  entity: IngestionEntity;
  errorContains: string;
  limit: number;
  actorEmail: string;
  reason: string;
}) {
  const result = await queryPostgres<FailedIngestionRepairRow>(
    `with candidates as materialized (
       select id
         from metrics.ingestion_jobs
        where entity_type = $1::metrics.ingestion_entity_type
          and status = 'failed'
          and position(lower($2) in lower(coalesce(last_error, ''))) > 0
        order by id
        for update skip locked
        limit $3
     ), repaired as (
       update metrics.ingestion_jobs j
          set status = 'queued'::metrics.ingestion_job_status,
              attempts = 0,
              locked_by = null,
              locked_at = null,
              lock_expires_at = null,
              heartbeat_at = null,
              next_attempt_at = now(),
              dead_lettered_at = null,
              completed_at = null,
              last_error = null,
              updated_at = now()
         from candidates
        where j.id = candidates.id
        returning j.id, j.entity_type::text as entity_type, j.idempotency_key,
                  j.attempts, j.last_error
     ), audited as (
       insert into metrics.audit_events (
         actor_email, action, entity_type, entity_id, before_value, after_value, reason
       )
       select $4, 'ingestion_job_requeued', 'ingestion_job', repaired.id::text,
              jsonb_build_object('status', 'failed', 'errorContains', $2),
              jsonb_build_object('status', 'queued', 'attempts', 0), $5
         from repaired
       returning entity_id
     )
     select repaired.*
       from repaired
       join audited on audited.entity_id = repaired.id::text
      order by repaired.id`,
    [
      params.entity,
      requiredText(params.errorContains, "errorContains"),
      boundedLimit(params.limit),
      requiredText(params.actorEmail, "actorEmail"),
      requiredText(params.reason, "reason"),
    ],
  );
  return result.rows;
}

export function boundedLimit(value: number) {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error("limit must be an integer from 1 through 100.");
  }
  return value;
}

function requiredText(value: string, name: string) {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} is required.`);
  return normalized;
}
