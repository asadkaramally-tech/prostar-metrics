import { queryPostgres, type PostgresQuery } from "@/lib/store/postgres";

export type RawSnapshotWrite = {
  entityType: string;
  entityId: string;
  sourcePath: string;
  payload: unknown;
  sourceHash: string;
  sourceUpdatedAt?: string | null;
  sourceVersion?: string;
  ingestionRunId?: number | null;
  completeTraversal?: boolean;
  parentIdentity?: Record<string, unknown> | null;
  pageWindow?: Record<string, unknown> | null;
};

export async function writeRawSnapshot(
  params: RawSnapshotWrite,
  query: PostgresQuery = queryPostgres,
) {
  const result = await query<{ id: number; inserted: boolean; extracted_at: string | Date }>(
    `with upserted as (
       insert into metrics.raw_simpro_snapshots (
         entity_type, entity_id, source_path, payload, source_hash, source_updated_at,
         source_version, ingestion_run_id, complete_traversal, parent_identity, page_window
       )
       values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb)
       on conflict (entity_type, entity_id, source_hash) do update set
         source_path = excluded.source_path,
         payload = excluded.payload,
         source_updated_at = excluded.source_updated_at,
         source_version = excluded.source_version,
         ingestion_run_id = excluded.ingestion_run_id,
         complete_traversal = excluded.complete_traversal,
         parent_identity = excluded.parent_identity,
         page_window = excluded.page_window,
         extracted_at = now(),
         source_deleted_at = null
       where metrics.raw_simpro_snapshots.source_deleted_at is not null
       returning id, extracted_at
     )
     select id, true as inserted, extracted_at from upserted
     union all
     select id, false as inserted, extracted_at
       from metrics.raw_simpro_snapshots
      where entity_type = $1 and entity_id = $2 and source_hash = $5
        and source_deleted_at is null
        and not exists (select 1 from upserted)
      order by inserted desc, id desc
      limit 1`,
    [
      params.entityType,
      params.entityId,
      params.sourcePath,
      JSON.stringify(params.payload),
      params.sourceHash,
      params.sourceUpdatedAt ?? null,
      params.sourceVersion ?? "current",
      params.ingestionRunId ?? null,
      params.completeTraversal ?? false,
      JSON.stringify(params.parentIdentity ?? {}),
      params.pageWindow ? JSON.stringify(params.pageWindow) : null,
    ],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error(`Failed to persist raw Simpro snapshot ${params.entityType}:${params.entityId}`);
  }
  return row;
}

export function snapshotTimestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

export async function markRawEntitySourceDeleted(
  entityType: string,
  entityId: string,
  query: PostgresQuery = queryPostgres,
) {
  await query(
    `update metrics.raw_simpro_snapshots
        set source_deleted_at = coalesce(source_deleted_at, now())
      where entity_type = $1 and entity_id = $2`,
    [entityType, entityId],
  );
}
