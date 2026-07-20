import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { flattenBulkProjectPage } from "@/lib/simpro/bulk-project-export";
import {
  flattenBulkEmployees,
  flattenBulkMobileStatus,
  flattenBulkSchedules,
  flattenBulkTimesheets,
} from "@/lib/simpro/bulk-operational-export";
import { verifyBulkArtifact } from "@/lib/store/bulk-project-bootstrap";
import { verifyOperationalBulkArtifact } from "@/lib/store/bulk-operational-bootstrap";
import { buildPostgresSslConfig } from "@/lib/store/postgres";

type RecordHash = { key: string; sourceHash: string };
type DatabaseRow = { key: string; source_hash: string | null };

async function main() {
const projectDirectory = path.resolve(argumentValue("--project-input") ?? ".work/simpro-bulk-export-20260710");
const operationalDirectory = path.resolve(argumentValue("--operational-input") ?? ".work/simpro-operational-export-20260710");
const throughMonth = argumentValue("--through") ?? "2026-06";
const outputPath = argumentValue("--output");
const connectionString = process.env.AZURE_POSTGRES_CONNECTION_STRING;
if (!connectionString) throw new Error("AZURE_POSTGRES_CONNECTION_STRING is required");

const [project, operational] = await Promise.all([
  verifyBulkArtifact(projectDirectory),
  verifyOperationalBulkArtifact(operationalDirectory),
]);
const expected = new Map<string, RecordHash[]>();
const includedProjects = { job: new Set<number>(), quote: new Set<number>() };

for (const source of Object.values(project.sources)) {
  const projectType = source.family === "jobs" ? "job" : "quote";
  for (const payload of source.rows) {
    const flattened = flattenBulkProjectPage(projectType, [payload], project.manifest.completedAt);
    const row = flattened.projects[0]!;
    const activityDate = projectType === "job" ? row.completedDate : row.dateApproved;
    if (!activityDate || activityDate.slice(0, 7) > throughMonth) continue;
    includedProjects[projectType].add(row.projectId);
    add(expected, `${projectType}s`, String(row.projectId), fingerprint(projectType === "job"
      ? [row.completedDate, row.stageName, roundMoney(row.totalExTax), roundMoney(row.grossProfitActual), row.sourceQuoteId]
      : [row.dateApproved, roundMoney(row.totalExTax)]));
    for (const item of flattened.costCenters) add(expected, `${projectType}_cost_centers`, key(item.projectId, item.sectionId, item.costCenterId), fingerprint([item.category, roundMoney(item.sellValue)]));
    for (const item of flattened.labor) add(expected, `${projectType}_labor`, key(item.projectId, item.sectionId, item.costCenterId, item.laborId), fingerprint([item.quantityHours, roundMoney(item.sellExTax), roundMoney(item.actualCost)]));
    for (const item of flattened.items) add(expected, `${projectType}_items`, key(item.projectId, item.sectionId, item.costCenterId, item.itemType, item.itemId), fingerprint([]));
  }
}

for (const source of Object.values(operational.sources)) {
  for (const payload of source.rows) {
    if (source.family === "employees") {
      const row = flattenBulkEmployees([payload], operational.manifest.completedAt)[0]!;
      add(expected, "employees", String(row.employeeId), fingerprint([row.displayName, row.active, row.position]));
    } else if (source.family === "timesheets") {
      const row = flattenBulkTimesheets([payload], operational.manifest.completedAt)[0]!;
      add(expected, "timesheets", row.timesheetIdentity, fingerprint([row.referenceType, row.referenceId, row.workDate, row.totalHours]));
    } else if (source.family === "schedules") {
      const rows = flattenBulkSchedules([payload], operational.manifest.completedAt);
      const schedule = rows.schedules[0]!;
      add(expected, "schedules", String(schedule.scheduleId), fingerprint([schedule.referenceType, schedule.referenceId, schedule.staffId, schedule.scheduleDate, schedule.totalHours]));
      for (const row of rows.scheduleBlocks) add(expected, "schedule_blocks", key(row.scheduleId, row.blockIndex), fingerprint([row.staffId, row.referenceType, row.referenceId, row.plannedHours, timestampMillis(row.plannedStartAt), timestampMillis(row.plannedEndAt)]));
    } else if (source.family === "mobile_status") {
      const row = flattenBulkMobileStatus([payload], operational.manifest.completedAt)[0]!;
      add(expected, "mobile_status", String(row.logId), fingerprint([row.staffId, row.projectId, row.statusId, timestampMillis(row.dateLogged)]));
    }
  }
}

const client = new pg.Client({ connectionString, ssl: buildPostgresSslConfig() });
await client.connect();
try {
  const database = await readDatabase(client);
  const families: Record<string, unknown> = {};
  const mismatches: Array<Record<string, unknown>> = [];
  for (const [family, rows] of expected) {
    const expectedMap = new Map(rows.map((row) => [row.key, row.sourceHash]));
    const actualMap = new Map((database.get(family) ?? []).map((row) => [row.key, canonicalFingerprint(row.source_hash)]));
    const missing = [...expectedMap.keys()].filter((recordKey) => !actualMap.has(recordKey));
    const changed = [...expectedMap].filter(([recordKey, hash]) => actualMap.has(recordKey) && actualMap.get(recordKey) !== hash);
    const familyEvidence = {
      expectedRecords: expectedMap.size,
      matchedRecords: expectedMap.size - missing.length - changed.length,
      missingRecords: missing.length,
      changedRecords: changed.length,
      expectedIdentityHash: identityHash(expectedMap),
      matched: missing.length === 0 && changed.length === 0,
    };
    families[family] = familyEvidence;
    if (!familyEvidence.matched) mismatches.push({
      family,
      missing: missing.slice(0, 50),
      changed: changed.slice(0, 50).map(([recordKey, expectedValue]) => ({
        key: recordKey,
        expected: expectedValue,
        actual: actualMap.get(recordKey),
      })),
    });
  }

  const evidence = {
    schemaVersion: 1,
    status: mismatches.length === 0 ? "matched" : "mismatch",
    generatedAt: new Date().toISOString(),
    throughMonth,
    projectManifestSha256: project.manifestSha256,
    operationalManifestSha256: operational.manifestSha256,
    authority: "checksum_verified_simpro_export_jsonl",
    comparison: "record_identity_and_metric_field_fingerprint_to_current_canonical_serving_rows",
    includedProjectCounts: { jobs: includedProjects.job.size, quotes: includedProjects.quote.size },
    families,
    mismatchCount: mismatches.length,
    mismatches,
  };
  if (outputPath) {
    const resolved = path.resolve(outputPath);
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify(evidence, null, 2));
  if (mismatches.length > 0) process.exitCode = 1;
} finally {
  await client.end();
}
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

async function readDatabase(client: pg.Client) {
  const queries: Array<[string, string]> = [
    ["jobs", `select j.job_id::text key, jsonb_build_array(j.completed_date::text, j.stage, j.total::float8, j.gross_profit_actual::float8, coalesce(case when lower(trim(coalesce(j.converted_from_type, ''))) = 'quote' then j.converted_from_id end, (select q.quote_id from metrics.metrics_quotes q where q.linked_job_id = j.job_id and q.source_deleted_at is null order by q.quote_id limit 1)))::text source_hash from metrics.metrics_jobs j where j.source_deleted_at is null`],
    ["quotes", `select quote_id::text key, jsonb_build_array(date_approved::text, total::float8)::text source_hash from metrics.metrics_quotes where source_deleted_at is null`],
    ["job_cost_centers", `select concat_ws(':', job_id, section_id, cost_center_id) key, jsonb_build_array(category, sell_value::float8)::text source_hash from metrics.metrics_job_cost_centers where source_deleted_at is null`],
    ["quote_cost_centers", `select concat_ws(':', quote_id, section_id, cost_center_id) key, jsonb_build_array(category, sell_value::float8)::text source_hash from metrics.metrics_quote_cost_centers where source_deleted_at is null`],
    ["job_labor", `select concat_ws(':', job_id, section_id, cost_center_id, labor_id) key, jsonb_build_array(quantity_hours::float8, sell_ex_tax::float8, actual_cost::float8)::text source_hash from metrics.metrics_job_labor where source_deleted_at is null`],
    ["quote_labor", `select concat_ws(':', quote_id, section_id, cost_center_id, labor_id) key, jsonb_build_array(quantity_hours::float8, sell_ex_tax::float8, actual_cost::float8)::text source_hash from metrics.metrics_quote_labor where source_deleted_at is null`],
    ["job_items", `select concat_ws(':', job_id, section_id, cost_center_id, item_type, item_id) key, '[]' source_hash from metrics.metrics_job_items where source_deleted_at is null`],
    ["quote_items", `select concat_ws(':', quote_id, section_id, cost_center_id, item_type, item_id) key, '[]' source_hash from metrics.metrics_quote_items where source_deleted_at is null`],
    ["employees", `select simpro_employee_id::text key, jsonb_build_array(display_name, active, position)::text source_hash from metrics.dim_people where simpro_employee_id is not null`],
    ["timesheets", `select concat_ws(':', employee_id, timesheet_id) key, jsonb_build_array(reference_type, reference_id, work_date::text, total_hours::float8)::text source_hash from metrics.metrics_employee_timesheets where source_deleted_at is null`],
    ["schedules", `select s.schedule_id::text key, jsonb_build_array(s.reference_type, s.reference_id, p.simpro_employee_id, s.schedule_date::text, s.total_hours::float8)::text source_hash from metrics.metrics_schedules s left join metrics.dim_people p on p.person_id = s.staff_person_id where s.source_deleted_at is null`],
    ["schedule_blocks", `select concat_ws(':', schedule_id, block_index) key, jsonb_build_array(staff_id, reference_type, reference_id, planned_hours::float8, extract(epoch from planned_start_at) * 1000, extract(epoch from planned_end_at) * 1000)::text source_hash from metrics.metrics_schedule_blocks where source_deleted_at is null`],
    ["mobile_status", `select m.simpro_log_id::text key, jsonb_build_array(p.simpro_employee_id, m.project_id, m.status_id, extract(epoch from m.date_logged) * 1000)::text source_hash from metrics.metrics_mobile_status_logs m left join metrics.dim_people p on p.person_id = m.staff_person_id`],
  ];
  const results: Array<readonly [string, DatabaseRow[]]> = [];
  for (const [family, sql] of queries) results.push([family, (await client.query<DatabaseRow>(sql)).rows] as const);
  return new Map(results);
}

function add(target: Map<string, RecordHash[]>, family: string, recordKey: string, sourceHash: string) {
  const rows = target.get(family) ?? [];
  rows.push({ key: recordKey, sourceHash });
  target.set(family, rows);
}

function identityHash(values: Map<string, string>) {
  const payload = [...values].sort(([left], [right]) => left.localeCompare(right)).map(([recordKey, hash]) => `${recordKey}:${hash}`).join("\n");
  return createHash("sha256").update(payload).digest("hex");
}

function key(...parts: Array<string | number>) {
  return parts.join(":");
}

function fingerprint(values: unknown[]) {
  return JSON.stringify(values.map((value) => typeof value === "number" ? Number(value.toFixed(4)) : value ?? null));
}

function canonicalFingerprint(value: string | null) {
  if (!value) return "";
  try {
    return fingerprint(JSON.parse(value) as unknown[]);
  } catch {
    return value;
  }
}

function timestampMillis(value: string | null) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function roundMoney(value: number | null) {
  return value === null ? null : Math.round((value + Number.EPSILON) * 100) / 100;
}

function argumentValue(flag: string) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
