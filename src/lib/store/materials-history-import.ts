import { addMonthsToPeriodStart, type MaterialLineType } from "@/lib/metrics/materials";
import type { CatalogGroupLookup } from "@/lib/simpro/materials";
import { queryPostgres, withPostgresTransaction, type PostgresQuery } from "@/lib/store/postgres";

export type MaterialsHistoryQuery = <T = Record<string, unknown>>(
  text: string,
  values?: unknown[],
) => Promise<{ rows: T[] }>;

export type HistoricalMaterialLine = {
  jobId: number;
  sectionId: number;
  costCenterId: number;
  lineType: MaterialLineType;
  lineId: number;
  catalogId: number | null;
  prebuildId: number | null;
  name: string | null;
  partNo: string | null;
  qty: number;
  extendedExTax: number;
  basePrice: number | null;
  oneOffType: string | null;
};

export type MaterialsHistoryMonthPlan = {
  periodStart: string;
  jobCount: number;
  lines: HistoricalMaterialLine[];
  embeddedCatalogGroups: CatalogGroupLookup[];
  catalogIds: number[];
};

type SnapshotRow = {
  job_id: string;
  completed_date: string;
  payload: Record<string, unknown> | null;
};

export async function loadMaterialsHistoryMonthPlan(
  periodStart: string,
  query: MaterialsHistoryQuery = queryPostgres,
): Promise<MaterialsHistoryMonthPlan> {
  const periodEnd = addMonthsToPeriodStart(periodStart, 1);
  const result = await query<SnapshotRow>(
    `select job.job_id::text, job.completed_date::text, raw.payload
       from metrics.metrics_jobs job
       left join lateral (
         select snapshot.payload
           from metrics.raw_simpro_snapshots snapshot
          where snapshot.entity_type = 'jobs'
            and snapshot.entity_id = job.job_id::text
            and snapshot.complete_traversal = true
            and snapshot.source_deleted_at is null
          order by snapshot.extracted_at desc, snapshot.id desc
          limit 1
       ) raw on true
      where job.source_deleted_at is null
        and job.completed_date >= $1::date
        and job.completed_date < $2::date
      order by job.job_id`,
    [periodStart, periodEnd],
  );

  const missing = result.rows.filter((row) => row.payload === null).map((row) => row.job_id);
  if (missing.length > 0) {
    throw new Error(`${periodStart.slice(0, 7)} is missing complete raw job snapshots for ${missing.length} job(s).`);
  }

  const lines: HistoricalMaterialLine[] = [];
  const groups = new Map<number, CatalogGroupLookup>();
  for (const row of result.rows) {
    const jobId = positiveInteger(row.job_id, "job ID");
    const completedDate = row.completed_date.slice(0, 10);
    const payloadDate = dateValue(row.payload?.CompletedDate);
    if (payloadDate !== completedDate) {
      throw new Error(`Job ${jobId} raw CompletedDate ${payloadDate ?? "missing"} does not match ${completedDate}.`);
    }
    const extracted = extractHistoricalMaterialLines(row.payload!, jobId);
    lines.push(...extracted.lines);
    for (const group of extracted.catalogGroups) groups.set(group.catalogId, group);
  }

  const identities = new Set<string>();
  for (const line of lines) {
    const identity = `${line.jobId}:${line.sectionId}:${line.costCenterId}:${line.lineType}:${line.lineId}`;
    if (identities.has(identity)) throw new Error(`Duplicate historical material line ${identity}.`);
    identities.add(identity);
  }
  return {
    periodStart,
    jobCount: result.rows.length,
    lines,
    embeddedCatalogGroups: [...groups.values()],
    catalogIds: [...new Set(lines.flatMap((line) => line.catalogId === null ? [] : [line.catalogId]))].sort((a, b) => a - b),
  };
}

export async function importMaterialsHistoryMonth(
  plan: MaterialsHistoryMonthPlan,
  requestsUsed: number,
  transaction: <T>(callback: (query: PostgresQuery) => Promise<T>) => Promise<T> = withPostgresTransaction,
): Promise<void> {
  await transaction(async (query) => {
    await query(`delete from metrics.metrics_material_lines where period_start = $1::date`, [plan.periodStart]);
    if (plan.lines.length > 0) {
      await query(
        `insert into metrics.metrics_material_lines (
           job_id, section_id, cost_center_id, line_type, line_id, period_start, completed_date,
           catalog_id, prebuild_id, name, part_no, qty, extended_ex_tax, base_price,
           one_off_type, fetched_at, updated_from_source_at
         )
         select source.job_id, source.section_id, source.cost_center_id, source.line_type,
                source.line_id, $1::date, job.completed_date, source.catalog_id, source.prebuild_id,
                source.name, source.part_no, source.qty, source.extended_ex_tax, source.base_price,
                source.one_off_type, now(), now()
           from jsonb_to_recordset($2::jsonb) as source(
             job_id bigint, section_id bigint, cost_center_id bigint, line_type text, line_id bigint,
             catalog_id bigint, prebuild_id bigint, name text, part_no text, qty numeric,
             extended_ex_tax numeric, base_price numeric, one_off_type text
           )
           join metrics.metrics_jobs job on job.job_id = source.job_id`,
        [plan.periodStart, JSON.stringify(plan.lines.map((line) => ({
          job_id: line.jobId,
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
        })))],
      );
    }
    await query(
      `insert into metrics.materials_month_walks (
         period_start, status, walked_at, job_count, line_count, requests_used, error_message
       ) values ($1::date, 'complete', now(), $2, $3, $4, null)
       on conflict (period_start) do update set
         status = 'complete', walked_at = now(), job_count = excluded.job_count,
         line_count = excluded.line_count, requests_used = excluded.requests_used, error_message = null`,
      [plan.periodStart, plan.jobCount, plan.lines.length, requestsUsed],
    );
  });
}

export function extractHistoricalMaterialLines(payload: Record<string, unknown>, jobId: number): {
  lines: HistoricalMaterialLine[];
  catalogGroups: CatalogGroupLookup[];
} {
  const lines: HistoricalMaterialLine[] = [];
  const catalogGroups = new Map<number, CatalogGroupLookup>();
  for (const section of records(payload.Sections)) {
    const sectionId = positiveInteger(section.ID, `job ${jobId} section ID`);
    for (const costCenter of records(section.CostCenters)) {
      const costCenterId = positiveInteger(costCenter.ID, `job ${jobId} cost center ID`);
      const items = record(costCenter.Items) ?? costCenter;
      for (const row of records(items.Catalogs)) {
        const catalog = record(row.Catalog);
        const catalogId = positiveInteger(catalog?.ID, `job ${jobId} catalog ID`);
        const group = record(catalog?.Group);
        const parent = record(group?.ParentGroup);
        if (group) {
          catalogGroups.set(catalogId, {
            catalogId,
            name: text(catalog?.Name),
            partNo: text(catalog?.PartNo),
            groupName: text(group.Name),
            parentGroupName: text(parent?.Name),
          });
        }
        lines.push(materialLine(jobId, sectionId, costCenterId, "catalog", row, catalogId, null, null));
      }
      for (const row of records(items.OneOffs)) {
        if (text(row.Type) !== "Material") continue;
        lines.push(materialLine(jobId, sectionId, costCenterId, "one_off", row, null, null, "Material"));
      }
      for (const row of records(items.Prebuilds)) {
        const prebuild = record(row.Prebuild);
        lines.push(materialLine(
          jobId,
          sectionId,
          costCenterId,
          "prebuild",
          row,
          null,
          positiveInteger(prebuild?.ID, `job ${jobId} prebuild ID`),
          null,
        ));
      }
    }
  }
  return { lines, catalogGroups: [...catalogGroups.values()] };
}

function materialLine(
  jobId: number,
  sectionId: number,
  costCenterId: number,
  lineType: MaterialLineType,
  row: Record<string, unknown>,
  catalogId: number | null,
  prebuildId: number | null,
  oneOffType: string | null,
): HistoricalMaterialLine {
  const reference = lineType === "catalog" ? record(row.Catalog) : lineType === "prebuild" ? record(row.Prebuild) : null;
  return {
    jobId,
    sectionId,
    costCenterId,
    lineType,
    lineId: positiveInteger(row.ID, `job ${jobId} ${lineType} line ID`),
    catalogId,
    prebuildId,
    name: text(row.Description) ?? text(reference?.Name),
    partNo: text(reference?.PartNo),
    qty: finiteNumber(record(row.Total)?.Qty, `job ${jobId} ${lineType} quantity`),
    extendedExTax: finiteNumber(record(record(row.Total)?.Amount)?.ExTax, `job ${jobId} ${lineType} extended ExTax`),
    basePrice: nullableNumber(row.BasePrice),
    oneOffType,
  };
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => record(entry) !== null) : [];
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function dateValue(value: unknown): string | null {
  const valueText = text(value);
  return valueText && /^\d{4}-\d{2}-\d{2}/.test(valueText) ? valueText.slice(0, 10) : null;
}
function positiveInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Invalid ${label}.`);
  return parsed;
}
function finiteNumber(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${label}.`);
  return parsed;
}
function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
