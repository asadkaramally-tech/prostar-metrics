import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { compareExactSourceIds } from "@/lib/store/exact-source-identities";
import { buildPostgresSslConfig } from "@/lib/store/postgres";
import {
  verifyBulkArtifact,
  type VerifiedBulkSource,
} from "@/lib/store/bulk-project-bootstrap";

type CanonicalProjectRow = {
  project_id: string;
  activity_date: string | null;
  stage: string | null;
  total: string | null;
};

type MonthlyValue = { count: number; value: number };
export type ComparableProjectRow = {
  sourceId: string;
  activityDate: string | null;
  stage: string | null;
  value: number;
};

type ValidationQueryClient = {
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
};

async function main() {
  const inputDirectory = path.resolve(
    argumentValue("--input") ?? path.join(".work", "simpro-bulk-export"),
  );
  const artifact = await verifyBulkArtifact(inputDirectory);
  const connectionString = process.env.AZURE_POSTGRES_CONNECTION_STRING;
  if (!connectionString) throw new Error("AZURE_POSTGRES_CONNECTION_STRING is required");
  const client = new pg.Client({ connectionString, ssl: buildPostgresSslConfig() });
  await client.connect();
  try {
    const families = [];
    for (const source of Object.values(artifact.sources)) {
      families.push(await validateFamily(client, source, artifact.manifest.startDate));
    }
    const operational = await operationalChecks(client, artifact.manifest.startDate);
    const failed = families.some((family) => (
      !family.rootIdsMatch
      || !family.snapshotIdsMatch
      || !family.nestedCountsMatch
      || family.idTotalMismatches.length > 0
      || family.monthlyMismatches.length > 0
    ))
      || operational.overrideMismatches > 0
      || operational.grossProfitAllocationMismatches > 0;
    console.log(JSON.stringify({
      status: failed ? "failed" : "matched",
      manifestSha256: artifact.manifestSha256,
      financialCoverage: artifact.financialCoverage,
      sourceCompletedAt: artifact.manifest.completedAt,
      families,
      operational,
    }, null, 2));
    if (failed) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

export async function validateFamily(
  client: ValidationQueryClient,
  source: VerifiedBulkSource,
  startDate: string,
) {
  const sourceRows = readSourceRows(source);
  const canonical = source.family === "jobs"
    ? await client.query<CanonicalProjectRow>(
      `select job_id::text as project_id, completed_date::text as activity_date,
              stage, total::text
         from metrics.metrics_jobs
        where source_deleted_at is null and completed_date >= $1::date
        order by job_id`,
      [startDate],
    )
    : await client.query<CanonicalProjectRow>(
      `select quote_id::text as project_id, date_approved::text as activity_date,
              stage, total::text
         from metrics.metrics_quotes
        where source_deleted_at is null
        order by quote_id`,
    );
  const snapshots = source.family === "jobs"
    ? await client.query<CanonicalProjectRow>(
      `select job_id::text as project_id, completed_date::text as activity_date,
              stage_name as stage, sell_value::text as total
         from metrics.job_snapshots
        where completed_date >= $1::date
        order by job_id`,
      [startDate],
    )
    : await client.query<CanonicalProjectRow>(
      `select quote_id::text as project_id, date_approved::text as activity_date,
              stage_name as stage, total_value::text as total
         from metrics.quote_snapshots
        order by quote_id`,
    );
  const sourceIds = source.exactIds.map(String);
  const canonicalIds = canonical.rows.map((row) => row.project_id);
  const snapshotIds = snapshots.rows.map((row) => row.project_id);
  const rootIdsMatch = sameIds(sourceIds, canonicalIds);
  const snapshotIdsMatch = sameIds(sourceIds, snapshotIds);
  const canonicalRows = persistedRows(canonical.rows, source.family, "canonical");
  const snapshotRows = persistedRows(snapshots.rows, source.family, "snapshot");
  const idTotalMismatches = compareExactProjectTotals(source.family, sourceRows, canonicalRows, snapshotRows);
  const sourceMonthly = monthlyValues(sourceRows);
  const canonicalMonthly = monthlyValues(canonicalRows);
  const snapshotMonthly = monthlyValues(snapshotRows);
  const monthlyMismatches = [
    ...compareMonthly("source_to_canonical", sourceMonthly, canonicalMonthly),
    ...compareMonthly("source_to_snapshot", sourceMonthly, snapshotMonthly),
  ];
  const nestedCounts = await canonicalNestedCounts(client, source);
  const nestedCountsMatch = JSON.stringify(nestedCounts) === JSON.stringify(source.nestedCounts);
  return {
    family: source.family,
    sourceRows: source.rowCount,
    canonicalRows: canonical.rows.length,
    snapshotRows: snapshots.rows.length,
    rootIdsMatch,
    snapshotIdsMatch,
    missingRootIds: difference(sourceIds, canonicalIds),
    extraRootIds: difference(canonicalIds, sourceIds),
    missingSnapshotIds: difference(sourceIds, snapshotIds),
    extraSnapshotIds: difference(snapshotIds, sourceIds),
    idTotalMismatches,
    sourceNestedCounts: source.nestedCounts,
    canonicalNestedCounts: nestedCounts,
    nestedCountsMatch,
    comparedMonths: new Set([...sourceMonthly.keys(), ...canonicalMonthly.keys(), ...snapshotMonthly.keys()]).size,
    monthlyMismatches,
  };
}

async function canonicalNestedCounts(client: ValidationQueryClient, source: VerifiedBulkSource) {
  const parentColumn = source.family === "jobs" ? "job_id" : "quote_id";
  const costCenterTable = source.family === "jobs" ? "metrics.metrics_job_cost_centers" : "metrics.metrics_quote_cost_centers";
  const laborTable = source.family === "jobs" ? "metrics.metrics_job_labor" : "metrics.metrics_quote_labor";
  const itemTable = source.family === "jobs" ? "metrics.metrics_job_items" : "metrics.metrics_quote_items";
  const result = await client.query<{ cost_centers: number; labor: number; items: number }>(
    `select
       (select count(*)::int from ${costCenterTable} where source_deleted_at is null and ${parentColumn} = any($1::bigint[])) as cost_centers,
       (select count(*)::int from ${laborTable} where source_deleted_at is null and ${parentColumn} = any($1::bigint[])) as labor,
       (select count(*)::int from ${itemTable} where source_deleted_at is null and ${parentColumn} = any($1::bigint[])) as items`,
    [source.exactIds],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`${source.family}/all/canonical nested counts row is absent.`);
  return {
    sections: source.nestedCounts.sections,
    costCenters: requiredValidationNumber(row.cost_centers, source.family, "all", "canonical cost center count"),
    labor: requiredValidationNumber(row.labor, source.family, "all", "canonical labor count"),
    items: requiredValidationNumber(row.items, source.family, "all", "canonical item count"),
  };
}

async function operationalChecks(client: ValidationQueryClient, startDate: string) {
  const result = await client.query<{
    override_mismatches: number;
    gp_covered_jobs: number;
    gp_allocation_mismatches: number;
    queued_out_of_scope_job_nested: number;
    queued_rollups: number;
  }>(
    `with active_overrides as (
       select distinct on (quote_id) quote_id,
              coalesce(outcome, case when won_override then 'won' when won_override is false then 'lost' end) as outcome
         from metrics.quote_classification_overrides
        where active = true
        order by quote_id, created_at desc, id desc
     ), job_gp as (
       select j.job_id, j.gross_profit_actual,
              sum(c.gross_profit_actual) filter (where c.source_deleted_at is null) as allocated_gp,
              count(c.*) filter (where c.source_deleted_at is null and c.gross_profit_actual is not null) as covered_rows
         from metrics.metrics_jobs j
         left join metrics.metrics_job_cost_centers c on c.job_id = j.job_id
        where j.source_deleted_at is null
          and j.completed_date >= $1::date
          and lower(trim(j.stage)) in ('complete', 'archived')
        group by j.job_id, j.gross_profit_actual
     )
     select
       (select count(*)::int from active_overrides o join metrics.metrics_quotes q using (quote_id)
         where q.outcome is distinct from o.outcome) as override_mismatches,
       (select count(*)::int from job_gp where gross_profit_actual is not null and covered_rows > 0) as gp_covered_jobs,
       (select count(*)::int from job_gp where gross_profit_actual is not null and covered_rows > 0
         and abs(gross_profit_actual - allocated_gp) > 0.01) as gp_allocation_mismatches,
       (select count(*)::int from metrics.ingestion_jobs q
         where q.entity_type = 'job_nested' and q.status = 'queued'
           and q.params->>'entityId' ~ '^[0-9]+$'
           and not exists (
             select 1 from metrics.metrics_jobs j
              where j.job_id = (q.params->>'entityId')::bigint
                and j.source_deleted_at is null and j.completed_date >= $1::date
           )) as queued_out_of_scope_job_nested,
       (select count(*)::int from metrics.rollup_rebuild_queue where status = 'queued') as queued_rollups`,
    [startDate],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`operational/${startDate}/checks row is absent.`);
  return {
    overrideMismatches: requiredValidationNumber(row.override_mismatches, "operational", startDate, "override mismatch count"),
    grossProfitCoveredJobs: requiredValidationNumber(row.gp_covered_jobs, "operational", startDate, "gross profit covered job count"),
    grossProfitAllocationMismatches: requiredValidationNumber(row.gp_allocation_mismatches, "operational", startDate, "gross profit allocation mismatch count"),
    queuedOutOfScopeJobNested: requiredValidationNumber(row.queued_out_of_scope_job_nested, "operational", startDate, "queued out-of-scope nested job count"),
    queuedRollups: requiredValidationNumber(row.queued_rollups, "operational", startDate, "queued rollup count"),
  };
}

function readSourceRows(source: VerifiedBulkSource) {
  const rows: ComparableProjectRow[] = [];
  for (const row of source.rows) {
    const sourceId = String(row.ID);
    rows.push({
      sourceId,
      activityDate: dateText(source.family === "jobs" ? row.CompletedDate : row.DateApproved),
      stage: textValue(row.Stage),
      value: requiredMoneyValue(row.Total, source.family, "all", `source ID ${sourceId} Total.ExTax`),
    });
  }
  return rows;
}

function persistedRows(
  rows: CanonicalProjectRow[],
  family: "jobs" | "quotes",
  authority: "canonical" | "snapshot",
): ComparableProjectRow[] {
  return rows.map((row) => ({
    sourceId: row.project_id,
    activityDate: row.activity_date,
    stage: row.stage,
    value: requiredValidationNumber(row.total, family, "all", `${authority} ID ${row.project_id} total`),
  }));
}

export function compareExactProjectTotals(
  family: "jobs" | "quotes",
  sourceRows: readonly ComparableProjectRow[],
  canonicalRows: readonly ComparableProjectRow[],
  snapshotRows: readonly ComparableProjectRow[],
) {
  const source = rowsById(sourceRows, family, "source");
  const canonical = rowsById(canonicalRows, family, "canonical");
  const snapshot = rowsById(snapshotRows, family, "snapshot");
  const ids = [...new Set([...source.keys(), ...canonical.keys(), ...snapshot.keys()])].sort(compareExactSourceIds);
  return ids.flatMap((sourceId) => {
    const sourceValue = source.get(sourceId)?.value;
    const canonicalValue = canonical.get(sourceId)?.value;
    const snapshotValue = snapshot.get(sourceId)?.value;
    return sourceValue !== undefined
      && canonicalValue !== undefined
      && snapshotValue !== undefined
      && close(sourceValue, canonicalValue)
      && close(sourceValue, snapshotValue)
      ? []
      : [{
          sourceId,
          source: sourceValue ?? null,
          canonical: canonicalValue ?? null,
          snapshot: snapshotValue ?? null,
          diagnostic: `${family} ID ${sourceId}: source=${sourceValue ?? "missing"}, canonical=${canonicalValue ?? "missing"}, snapshot=${snapshotValue ?? "missing"}`,
        }];
  });
}

function rowsById(rows: readonly ComparableProjectRow[], family: string, authority: string) {
  const result = new Map<string, ComparableProjectRow>();
  for (const row of rows) {
    if (result.has(row.sourceId)) throw new Error(`${family}/${authority} contains duplicate ID ${row.sourceId}.`);
    result.set(row.sourceId, row);
  }
  return result;
}

function monthlyValues(rows: readonly ComparableProjectRow[]) {
  const values = new Map<string, MonthlyValue>();
  for (const row of rows) {
    if (!row.activityDate) continue;
    const period = `${row.activityDate.slice(0, 7)}-01`;
    const current = values.get(period) ?? { count: 0, value: 0 };
    current.count += 1;
    current.value = roundMoney(current.value + row.value);
    values.set(period, current);
  }
  return values;
}

function compareMonthly(label: string, source: Map<string, MonthlyValue>, canonical: Map<string, MonthlyValue>) {
  const periods = [...new Set([...source.keys(), ...canonical.keys()])].sort();
  return periods.flatMap((period) => {
    const expected = source.get(period) ?? { count: 0, value: 0 };
    const actual = canonical.get(period) ?? { count: 0, value: 0 };
    return expected.count === actual.count && Math.abs(expected.value - actual.value) < 0.01
      ? []
      : [{ comparison: label, period, source: expected, persisted: actual }];
  });
}

function difference(left: string[], right: string[]) {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value)).slice(0, 100);
}

function sameIds(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function requiredMoneyValue(
  value: unknown,
  family: string,
  month: string,
  field: string,
): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${family}/${month}/${field} is absent; a finite number is required.`);
  }
  return requiredValidationNumber((value as Record<string, unknown>).ExTax, family, month, field);
}

export function requiredValidationNumber(value: unknown, scope: string, month: string, field: string) {
  const label = `${scope}/${month}/${field}`;
  if (value === undefined) throw new Error(`${label} is absent; a finite number is required.`);
  if (value === null) throw new Error(`${label} is null; a finite number is required.`);
  if (typeof value === "boolean") throw new Error(`${label} is boolean; a finite number is required.`);
  if (typeof value === "string" && !value.trim()) throw new Error(`${label} is blank; a finite number is required.`);
  if (typeof value !== "number" && typeof value !== "string") {
    throw new Error(`${label} has type ${typeof value}; a finite number is required.`);
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} is nonnumeric or non-finite.`);
  return parsed;
}

function dateText(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
}

function textValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function close(left: number, right: number) {
  return Math.abs(left - right) < 0.01;
}

function argumentValue(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
