import { queryPostgres } from "@/lib/store/postgres";

export type SourceWatermark = {
  committedDateLogged: string | null;
  committedLogId: number | null;
  overlapStart: string | null;
  gapDetected: boolean;
  completeWindow: boolean;
};

export async function getSourceWatermark(sourceFamily: string, windowKey = "incremental"): Promise<SourceWatermark | null> {
  const result = await queryPostgres<{
    committed_date_logged: string | null;
    committed_log_id: number | null;
    overlap_start: string | null;
    gap_detected: boolean;
    complete_window: boolean;
  }>(
    `select committed_date_logged::text, committed_log_id, overlap_start::text,
            gap_detected, complete_window
       from metrics.ingestion_watermarks
      where entity = $1 and window_key = $2`,
    [sourceFamily, windowKey],
  );
  const row = result.rows[0];
  return row ? {
    committedDateLogged: row.committed_date_logged,
    committedLogId: row.committed_log_id,
    overlapStart: row.overlap_start,
    gapDetected: row.gap_detected,
    completeWindow: row.complete_window,
  } : null;
}

export async function markSourceWatermarkAttempt(params: {
  sourceFamily: string;
  overlapStart: string;
  pageCursor: Record<string, unknown> | null;
  expectedThrough: string;
  gapDetected?: boolean;
  windowKey?: string;
}) {
  await queryPostgres(
    `insert into metrics.ingestion_watermarks (
       entity, window_key, source_family, last_attempt_at, status, overlap_start,
       page_cursor, gap_detected, complete_window, expected_through, updated_at
     ) values ($1, $2, $1, now(), 'running', $3::timestamptz, $4::jsonb, $5, false, $6::timestamptz, now())
     on conflict (entity, window_key) do update set
       source_family = excluded.source_family,
       last_attempt_at = now(),
       status = 'running',
       overlap_start = excluded.overlap_start,
       page_cursor = excluded.page_cursor,
       gap_detected = metrics.ingestion_watermarks.gap_detected or excluded.gap_detected,
       complete_window = false,
       expected_through = excluded.expected_through,
       updated_at = now()`,
    [params.sourceFamily, params.windowKey ?? "incremental", params.overlapStart, params.pageCursor ? JSON.stringify(params.pageCursor) : null, params.gapDetected ?? false, params.expectedThrough],
  );
}

export async function commitSourceWatermark(params: {
  sourceFamily: string;
  committedDateLogged: string | null;
  committedLogId: number | null;
  overlapStart: string;
  expectedThrough: string;
  recordCount: number;
  sourceHash: string | null;
  gapDetected: boolean;
  windowKey?: string;
}) {
  await queryPostgres(
    `insert into metrics.ingestion_watermarks (
       entity, window_key, source_family, last_success_at, last_attempt_at, status,
       record_count, source_hash, date_logged, log_id, committed_date_logged,
       committed_log_id, overlap_start, page_cursor, gap_detected, complete_window,
       expected_through, updated_at
     ) values (
       $1::text, $2::text, $1::text, case when $9::boolean then now() else null end,
       now(), $10::text, $3::integer, $4::text, $5::timestamptz, $6::bigint,
       case when $9::boolean then $5::timestamptz else null end,
       case when $9::boolean then $6::bigint else null end,
       $7::timestamptz, null, $8::boolean, $9::boolean, $11::timestamptz, now()
     )
     on conflict (entity, window_key) do update set
       source_family = excluded.source_family,
       last_success_at = case when excluded.complete_window then now() else metrics.ingestion_watermarks.last_success_at end,
       last_attempt_at = now(),
       status = excluded.status,
       record_count = excluded.record_count,
       source_hash = excluded.source_hash,
       date_logged = excluded.date_logged,
       log_id = excluded.log_id,
       committed_date_logged = case when excluded.complete_window then excluded.committed_date_logged else metrics.ingestion_watermarks.committed_date_logged end,
       committed_log_id = case when excluded.complete_window then excluded.committed_log_id else metrics.ingestion_watermarks.committed_log_id end,
       overlap_start = excluded.overlap_start,
       page_cursor = null,
       gap_detected = excluded.gap_detected,
       complete_window = excluded.complete_window,
       expected_through = excluded.expected_through,
       error_message = null,
       updated_at = now()`,
    [
      params.sourceFamily,
      params.windowKey ?? "incremental",
      params.recordCount,
      params.sourceHash,
      params.committedDateLogged,
      params.committedLogId,
      params.overlapStart,
      params.gapDetected,
      !params.gapDetected,
      params.gapDetected ? "gap" : "succeeded",
      params.expectedThrough,
    ],
  );
}

export async function upsertSourceChangeEvent(params: {
  sourceFamily: string;
  logId: number;
  dateLogged: string;
  sourceEntityType: string;
  sourceEntityId: string | null;
  message: string | null;
  staffId: number | null;
  payload: Record<string, unknown>;
  payloadHash: string;
  ingestionRunId?: number | null;
}) {
  await queryPostgres(
    `insert into metrics.source_change_events (
       source_family, log_id, date_logged, source_entity_type, source_entity_id,
       message, staff_id, payload, payload_hash, ingestion_run_id, fetched_at
     ) values ($1, $2, $3::timestamptz, $4, $5, $6, $7, $8::jsonb, $9, $10, now())
     on conflict (source_family, log_id) do update set
       date_logged = excluded.date_logged,
       source_entity_type = excluded.source_entity_type,
       source_entity_id = excluded.source_entity_id,
       message = excluded.message,
       staff_id = excluded.staff_id,
       payload = excluded.payload,
       payload_hash = excluded.payload_hash,
       ingestion_run_id = coalesce(excluded.ingestion_run_id, metrics.source_change_events.ingestion_run_id),
       fetched_at = now()
     where metrics.source_change_events.payload_hash is distinct from excluded.payload_hash`,
    [params.sourceFamily, params.logId, params.dateLogged, params.sourceEntityType, params.sourceEntityId, params.message, params.staffId, JSON.stringify(params.payload), params.payloadHash, params.ingestionRunId ?? null],
  );
}
