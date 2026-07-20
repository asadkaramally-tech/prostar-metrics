import path from "node:path";
import pg from "pg";
import {
  flattenBulkEmployees,
  flattenBulkMobileStatus,
  flattenBulkSchedules,
  flattenBulkTimesheets,
} from "@/lib/simpro/bulk-operational-export";
import { compareExactSourceIds } from "@/lib/store/exact-source-identities";
import { verifyOperationalBulkArtifact } from "@/lib/store/bulk-operational-bootstrap";
import { buildPostgresSslConfig } from "@/lib/store/postgres";

type Aggregate = { count: number; value: number; secondary: number };
type SourceEvidence = {
  ids: string[];
  months: Record<string, Aggregate>;
  nestedCount: number;
  nestedValue: number;
  postArtifactCount: number;
};

async function main() {
  const inputDirectory = path.resolve(
    argumentValue("--input") ?? path.join(".work", "simpro-operational-bulk-export"),
  );
  const artifact = await verifyOperationalBulkArtifact(inputDirectory);
  const source = readSourceEvidence(artifact);
  const connectionString = process.env.AZURE_POSTGRES_CONNECTION_STRING;
  if (!connectionString) throw new Error("AZURE_POSTGRES_CONNECTION_STRING is required");

  const client = new pg.Client({ connectionString, ssl: buildPostgresSslConfig() });
  await client.connect();
  try {
    const canonical = await readCanonicalEvidence(
      client,
      artifact.manifest.startDate,
      artifact.manifest.asOfDate,
      artifact.manifest.completedAt,
      source,
    );
    const comparisons = Object.fromEntries(Object.entries(source).map(([family, evidence]) => {
      const actual = canonical[family]!;
      const idMismatches = compareIds(evidence.ids, actual.ids);
      const monthMismatches = compareMonths(evidence.months, actual.months);
      const nestedMatches = evidence.nestedCount === actual.nestedCount
        && close(evidence.nestedValue, actual.nestedValue);
      return [family, {
        sourceRows: evidence.ids.length,
        canonicalRows: actual.ids.length,
        exactIdsMatch: idMismatches.length === 0,
        idMismatches: idMismatches.slice(0, 20),
        monthsCompared: new Set([...Object.keys(evidence.months), ...Object.keys(actual.months)]).size,
        monthMismatches: monthMismatches.slice(0, 20),
        sourceNestedRows: evidence.nestedCount,
        canonicalNestedRows: actual.nestedCount,
        sourceNestedValue: money(evidence.nestedValue),
        canonicalNestedValue: money(actual.nestedValue),
        nestedMatches,
        acceptedPostArtifactRows: actual.postArtifactCount,
      }];
    }));
    const matched = Object.values(comparisons).every((comparison) => (
      comparison.exactIdsMatch && comparison.monthMismatches.length === 0 && comparison.nestedMatches
    ));
    console.log(JSON.stringify({
      status: matched ? "matched" : "mismatch",
      manifestSha256: artifact.manifestSha256,
      sourceCompletedAt: artifact.manifest.completedAt,
      comparisons,
    }, null, 2));
    if (!matched) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

function readSourceEvidence(artifact: Awaited<ReturnType<typeof verifyOperationalBulkArtifact>>) {
  const evidence: Record<string, SourceEvidence> = {};
  const fetchedAt = artifact.manifest.completedAt;

  const employees = emptyEvidence();
  for (const payload of artifact.sources.employees.rows) {
    const row = flattenBulkEmployees([payload], fetchedAt)[0]!;
    employees.ids.push(String(row.employeeId));
    add(employees.months, row.archived ? "archived" : "active", 1, 0, 0);
  }
  evidence.employees = employees;

  const timesheets = emptyEvidence();
  for (const payload of artifact.sources.timesheets.rows) {
    const row = flattenBulkTimesheets([payload], fetchedAt)[0]!;
    timesheets.ids.push(row.timesheetIdentity);
    add(timesheets.months, month(row.workDate), 1, quantizeHours(row.totalHours), quantizeMoney(row.totalCost));
  }
  evidence.timesheets = timesheets;

  const schedules = emptyEvidence();
  for (const payload of artifact.sources.schedules.rows) {
    const flattened = flattenBulkSchedules([payload], fetchedAt);
    const row = flattened.schedules[0]!;
    schedules.ids.push(String(row.scheduleId));
    add(schedules.months, month(row.scheduleDate), 1, quantizeHours(row.totalHours), 0);
    schedules.nestedCount += flattened.scheduleBlocks.length;
    schedules.nestedValue += flattened.scheduleBlocks.reduce((sum, block) => sum + quantizeHours(block.plannedHours), 0);
  }
  evidence.schedules = schedules;

  const mobile = emptyEvidence();
  for (const payload of artifact.sources.mobile_status.rows) {
    const row = flattenBulkMobileStatus([payload], fetchedAt)[0]!;
    mobile.ids.push(String(row.logId));
    add(mobile.months, pacificMonth(row.dateLogged), 1, row.projectId === null ? 0 : 1, 0);
  }
  evidence.mobile_status = mobile;

  for (const item of Object.values(evidence)) item.ids.sort(compareExactSourceIds);
  return evidence;
}

async function readCanonicalEvidence(
  client: pg.Client,
  startDate: string,
  asOfDate: string,
  evidenceAsOf: string,
  source: Record<string, SourceEvidence>,
): Promise<Record<string, SourceEvidence>> {
  const employeeIds = await client.query<{ id: string }>(
    "select employee_id::text id from metrics.employee_snapshots order by employee_id",
  );
  const employeeMonths = await client.query<{ month: string; count: string }>(
    "select case when archived then 'archived' else 'active' end as \"month\", count(*)::text count from metrics.employee_snapshots group by archived",
  );
  const timesheetIds = await client.query<{ id: string }>(
      `select employee_id::text || ':' || timesheet_id id
         from metrics.metrics_employee_timesheets
        where source_deleted_at is null and work_date >= $1::date and work_date <= $2::date
        order by employee_id, timesheet_id`, [startDate, asOfDate],
  );
  const timesheetMonths = await client.query<{ month: string; count: string; value: string; secondary: string }>(
      `select to_char(work_date, 'YYYY-MM-01') as "month", count(*)::text count,
              coalesce(sum(total_hours), 0)::text value, coalesce(sum(total_cost), 0)::text secondary
         from metrics.metrics_employee_timesheets
        where source_deleted_at is null and work_date >= $1::date and work_date <= $2::date
        group by 1 order by 1`, [startDate, asOfDate],
  );
  const sourceScheduleIds = source.schedules!.ids.map(Number);
  const scheduleIds = await client.query<{ id: string }>(
      "select schedule_id::text id from metrics.metrics_schedules where source_deleted_at is null and schedule_id = any($1::bigint[]) order by schedule_id",
      [sourceScheduleIds],
  );
  const scheduleMonths = await client.query<{ month: string; count: string; value: string; secondary: string }>(
      `select coalesce(to_char(schedule_date, 'YYYY-MM-01'), 'undated') as "month",
              count(*)::text count, coalesce(sum(total_hours), 0)::text value, '0' secondary
         from metrics.metrics_schedules
        where source_deleted_at is null and schedule_id = any($1::bigint[])
        group by 1 order by 1`, [sourceScheduleIds],
  );
  const scheduleNested = await client.query<{ count: string; value: string }>(
      "select count(*)::text count, coalesce(sum(planned_hours), 0)::text value from metrics.metrics_schedule_blocks where source_deleted_at is null and schedule_id = any($1::bigint[])",
      [sourceScheduleIds],
  );
  const scheduleExtras = await client.query<{ id: string; fetched_at: string; source_month: string | null }>(
    `select schedule_id::text id, fetched_at::text,
            to_char(schedule_date, 'YYYY-MM-01') source_month
       from metrics.metrics_schedules
      where source_deleted_at is null and not (schedule_id = any($1::bigint[]))
      order by schedule_id`,
    [sourceScheduleIds],
  );
  const currentMonth = pacificMonth(new Date().toISOString());
  const invalidScheduleExtras = scheduleExtras.rows.filter((row) => (
    Date.parse(row.fetched_at) <= Date.parse(evidenceAsOf) || row.source_month !== currentMonth
  ));
  scheduleIds.rows.push(...invalidScheduleExtras.map((row) => ({ id: row.id })));
  const mobileIds = await client.query<{ id: string }>(
      "select simpro_log_id::text id from metrics.metrics_mobile_status_logs order by simpro_log_id",
  );
  const mobileMonths = await client.query<{ month: string; count: string; value: string; secondary: string }>(
      `select coalesce(to_char(date_logged at time zone 'America/Los_Angeles', 'YYYY-MM-01'), 'undated') as "month",
              count(*)::text count, count(project_id)::text value, '0' secondary
         from metrics.metrics_mobile_status_logs group by 1 order by 1`,
  );
  return {
    employees: fromDb(employeeIds.rows, employeeMonths.rows),
    timesheets: fromDb(timesheetIds.rows, timesheetMonths.rows),
    schedules: fromDb(
      scheduleIds.rows,
      scheduleMonths.rows,
      scheduleNested.rows[0],
      scheduleExtras.rows.length - invalidScheduleExtras.length,
    ),
    mobile_status: fromDb(mobileIds.rows, mobileMonths.rows),
  };
}

function fromDb(
  ids: Array<{ id: string }>,
  months: Array<{ month: string; count: string; value?: string; secondary?: string }>,
  nested?: { count: string; value: string },
  postArtifactCount = 0,
): SourceEvidence {
  return {
    ids: ids.map((row) => row.id).sort(compareExactSourceIds),
    months: Object.fromEntries(months.map((row) => [row.month, {
      count: Number(row.count),
      value: Number(row.value ?? 0),
      secondary: Number(row.secondary ?? 0),
    }])),
    nestedCount: Number(nested?.count ?? 0),
    nestedValue: Number(nested?.value ?? 0),
    postArtifactCount,
  };
}

function compareIds(source: string[], canonical: string[]) {
  const sourceSet = new Set(source);
  const canonicalSet = new Set(canonical);
  return [
    ...source.filter((id) => !canonicalSet.has(id)).map((id) => `missing:${id}`),
    ...canonical.filter((id) => !sourceSet.has(id)).map((id) => `extra:${id}`),
  ];
}

function compareMonths(source: Record<string, Aggregate>, canonical: Record<string, Aggregate>) {
  const keys = [...new Set([...Object.keys(source), ...Object.keys(canonical)])].sort();
  return keys.flatMap((key) => {
    const left = source[key] ?? { count: 0, value: 0, secondary: 0 };
    const right = canonical[key] ?? { count: 0, value: 0, secondary: 0 };
    return left.count === right.count && close(left.value, right.value) && close(left.secondary, right.secondary)
      ? []
      : [{ month: key, source: left, canonical: right }];
  });
}

function emptyEvidence(): SourceEvidence {
  return { ids: [], months: {}, nestedCount: 0, nestedValue: 0, postArtifactCount: 0 };
}

function add(months: Record<string, Aggregate>, key: string, count: number, value: number, secondary: number) {
  const current = months[key] ?? { count: 0, value: 0, secondary: 0 };
  current.count += count;
  current.value += value;
  current.secondary += secondary;
  months[key] = current;
}

function month(value: string | null) {
  return value ? `${value.slice(0, 7)}-01` : "undated";
}

function pacificMonth(value: string | null) {
  if (!value) return "undated";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "undated";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  return year && month ? `${year}-${month}-01` : "undated";
}

function quantizeHours(value: number | null) {
  const number = value ?? 0;
  return Math.sign(number) * Math.round((Math.abs(number) + 1e-9) * 10_000) / 10_000;
}

function quantizeMoney(value: number | null) {
  const number = value ?? 0;
  return Math.sign(number) * Math.round((Math.abs(number) + 1e-9) * 100) / 100;
}

function close(left: number, right: number) {
  return Math.abs(left - right) < 0.00005;
}

function money(value: number) {
  return Math.round(value * 100) / 100;
}

function argumentValue(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
