import type { CatalogGroupLookup, WalkedMaterialLine } from "@/lib/simpro/materials";
import {
  queryPostgres,
  withPostgresTransaction,
  type PostgresQuery,
} from "@/lib/store/postgres";

export type MaterialsIngestQuery = <T = Record<string, unknown>>(
  text: string,
  values?: unknown[],
) => Promise<{ rows: T[] }>;

export type MaterialsIngestTransaction = <T>(
  callback: (query: PostgresQuery) => Promise<T>,
) => Promise<T>;

export type CatalogGroupCacheRow = CatalogGroupLookup & { fetchedAt: string };

export type SourceChangeCursor = {
  dateLogged: string;
  logId: number;
};

/**
 * Jobs from the durable job-log mirror that can affect an already-mirrored,
 * older materials job.  We deliberately require an existing materials row:
 * a job-log event alone cannot prove that an older job was completed and in
 * scope for materials.  The periodic full-month walk owns that discovery.
 */
export async function listChangedOlderMaterialJobs(
  params: {
    after: SourceChangeCursor | null;
    through: SourceChangeCursor;
    olderThan: string;
  },
  query: MaterialsIngestQuery = queryPostgres,
): Promise<Array<{ jobId: number; previousPeriodStarts: string[] }>> {
  const result = await query<{
    job_id: string;
    previous_period_starts: string[] | null;
  }>(
    `select min(lines.job_id)::text as job_id,
            array_agg(distinct lines.period_start::text order by lines.period_start::text) as previous_period_starts
       from metrics.source_change_events event
       join metrics.metrics_material_lines lines
         on event.source_entity_id = lines.job_id::text
      where event.source_family = 'job_logs'
        and event.source_entity_type = 'job'
        and event.source_entity_id ~ '^[1-9][0-9]*$'
        and lines.completed_date < $1::date
        and (event.date_logged, event.log_id) <= ($2::timestamptz, $3::bigint)
        and ($4::timestamptz is null or (event.date_logged, event.log_id) > ($4::timestamptz, $5::bigint))
      group by event.source_entity_id
      order by min(lines.job_id)`,
    [
      params.olderThan,
      params.through.dateLogged,
      params.through.logId,
      params.after?.dateLogged ?? null,
      params.after?.logId ?? null,
    ],
  );
  return result.rows.map((row) => ({
    jobId: Number(row.job_id),
    previousPeriodStarts: row.previous_period_starts ?? [],
  })).filter((row) => Number.isSafeInteger(row.jobId) && row.jobId > 0);
}

/** Remove an older job which is no longer completed at source. */
export async function removeJobMaterialLines(
  jobId: number,
  query: MaterialsIngestQuery = queryPostgres,
): Promise<void> {
  await query(`delete from metrics.metrics_material_lines where job_id = $1`, [jobId]);
}

/**
 * Replace one completed job's material lines atomically. A job carries exactly
 * one CompletedDate, so all of its previous lines (any period) are superseded
 * by the walked set.
 */
export async function replaceJobMaterialLines(
  params: {
    jobId: number;
    periodStart: string;
    completedDate: string;
    lines: WalkedMaterialLine[];
    fetchedAt: Date;
  },
  transaction: MaterialsIngestTransaction = withPostgresTransaction,
): Promise<void> {
  await transaction(async (query) => {
    await query(`delete from metrics.metrics_material_lines where job_id = $1`, [params.jobId]);
    if (params.lines.length === 0) return;
    await query(
      `insert into metrics.metrics_material_lines (
         job_id, section_id, cost_center_id, line_type, line_id,
         period_start, completed_date, catalog_id, prebuild_id, name, part_no,
         qty, extended_ex_tax, base_price, one_off_type, fetched_at, updated_from_source_at
       )
       select $1, source.section_id, source.cost_center_id, source.line_type, source.line_id,
              $2::date, $3::date, source.catalog_id, source.prebuild_id, source.name, source.part_no,
              source.qty, source.extended_ex_tax, source.base_price, source.one_off_type,
              $4::timestamptz, now()
         from jsonb_to_recordset($5::jsonb) as source(
           section_id bigint, cost_center_id bigint, line_type text, line_id bigint,
           catalog_id bigint, prebuild_id bigint, name text, part_no text,
           qty numeric, extended_ex_tax numeric, base_price numeric, one_off_type text
         )
       on conflict (job_id, section_id, cost_center_id, line_type, line_id) do update set
         period_start = excluded.period_start,
         completed_date = excluded.completed_date,
         catalog_id = excluded.catalog_id,
         prebuild_id = excluded.prebuild_id,
         name = excluded.name,
         part_no = excluded.part_no,
         qty = excluded.qty,
         extended_ex_tax = excluded.extended_ex_tax,
         base_price = excluded.base_price,
         one_off_type = excluded.one_off_type,
         fetched_at = excluded.fetched_at,
         updated_from_source_at = now()`,
      [
        params.jobId,
        params.periodStart,
        params.completedDate,
        params.fetchedAt.toISOString(),
        JSON.stringify(params.lines.map((line) => ({
          section_id: line.sectionId,
          cost_center_id: line.costCenterId,
          line_type: line.lineType,
          line_id: line.lineId,
          catalog_id: line.catalogId,
          prebuild_id: line.prebuildId,
          name: line.name,
          part_no: line.partNo,
          qty: line.qty,
          extended_ex_tax: line.extendedExTax,
          base_price: line.basePrice,
          one_off_type: line.oneOffType,
        }))),
      ],
    );
  });
}

/**
 * Seal a complete month walk: drop lines the walk no longer observed for the
 * month (jobs that left the completion window or lines removed at source) and
 * record the walk bookkeeping row.
 */
export async function finishMaterialsMonthWalk(
  params: {
    periodStart: string;
    walkStartedAt: Date;
    jobCount: number;
    lineCount: number;
    requestsUsed: number;
  },
  transaction: MaterialsIngestTransaction = withPostgresTransaction,
): Promise<void> {
  await transaction(async (query) => {
    await query(
      `delete from metrics.metrics_material_lines
        where period_start = $1::date and fetched_at < $2::timestamptz`,
      [params.periodStart, params.walkStartedAt.toISOString()],
    );
    await query(
      `insert into metrics.materials_month_walks (
         period_start, status, walked_at, job_count, line_count, requests_used, error_message
       )
       values ($1::date, 'complete', now(), $2, $3, $4, null)
       on conflict (period_start) do update set
         status = 'complete',
         walked_at = now(),
         job_count = excluded.job_count,
         line_count = excluded.line_count,
         requests_used = excluded.requests_used,
         error_message = null`,
      [params.periodStart, params.jobCount, params.lineCount, params.requestsUsed],
    );
  });
}

/**
 * A failed walk never deletes previously mirrored lines; it only records the
 * failure so freshness and coverage read loudly instead of silently serving a
 * partial month as complete.
 */
export async function recordMaterialsMonthWalkFailure(
  params: { periodStart: string; error: unknown },
  query: MaterialsIngestQuery = queryPostgres,
): Promise<void> {
  const message = params.error instanceof Error ? params.error.message : String(params.error);
  await query(
    `insert into metrics.materials_month_walks (
       period_start, status, walked_at, job_count, line_count, requests_used, error_message
     )
     values ($1::date, 'failed', now(), 0, 0, 0, $2)
     on conflict (period_start) do update set
       status = 'failed',
       walked_at = now(),
       error_message = excluded.error_message`,
    [params.periodStart, message.slice(0, 2000)],
  );
}

export async function getCatalogGroupCache(
  catalogIds: number[],
  query: MaterialsIngestQuery = queryPostgres,
): Promise<Map<number, CatalogGroupCacheRow>> {
  if (catalogIds.length === 0) return new Map();
  const result = await query<{
    catalog_id: string;
    name: string | null;
    part_no: string | null;
    group_name: string | null;
    parent_group_name: string | null;
    fetched_at: string;
  }>(
    `select catalog_id::text, name, part_no, group_name, parent_group_name, fetched_at::text
       from metrics.catalog_groups
      where catalog_id = any($1::bigint[])`,
    [catalogIds],
  );
  return new Map(result.rows.map((row) => [Number(row.catalog_id), {
    catalogId: Number(row.catalog_id),
    name: row.name,
    partNo: row.part_no,
    groupName: row.group_name,
    parentGroupName: row.parent_group_name,
    fetchedAt: row.fetched_at,
  }]));
}

export async function upsertCatalogGroups(
  rows: CatalogGroupLookup[],
  query: MaterialsIngestQuery = queryPostgres,
): Promise<void> {
  if (rows.length === 0) return;
  await query(
    `insert into metrics.catalog_groups (catalog_id, name, part_no, group_name, parent_group_name, fetched_at)
     select source.catalog_id, source.name, source.part_no, source.group_name, source.parent_group_name, now()
       from jsonb_to_recordset($1::jsonb) as source(
         catalog_id bigint, name text, part_no text, group_name text, parent_group_name text
       )
     on conflict (catalog_id) do update set
       name = excluded.name,
       part_no = excluded.part_no,
       group_name = excluded.group_name,
       parent_group_name = excluded.parent_group_name,
       fetched_at = excluded.fetched_at`,
    [JSON.stringify(rows.map((row) => ({
      catalog_id: row.catalogId,
      name: row.name,
      part_no: row.partNo,
      group_name: row.groupName,
      parent_group_name: row.parentGroupName,
    })))],
  );
}
