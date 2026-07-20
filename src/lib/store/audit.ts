import { queryPostgres } from "@/lib/store/postgres";

export async function writeAuditEvent(params: {
  actorEmail: string;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
}) {
  await queryPostgres(
    `insert into metrics.audit_events (
       actor_email, action, entity_type, entity_id, before_value, after_value, reason
     )
     values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
    [
      params.actorEmail,
      params.action,
      params.entityType,
      params.entityId,
      params.before === undefined ? null : JSON.stringify(params.before),
      params.after === undefined ? null : JSON.stringify(params.after),
      params.reason ?? null,
    ],
  );
}
