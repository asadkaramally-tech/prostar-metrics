import { createHash } from "node:crypto";
import type { PostgresQuery } from "@/lib/store/postgres";

export const TECHNICIAN_RECONCILIATION_SOURCE_FAMILIES = [
  "jobs",
  "job_nested",
  "employees",
  "timesheets",
  "jobs_from_timesheets",
  "schedules",
  "mobile_status",
] as const;

export type TechnicianTimesheetIdentity = {
  timesheetId: string;
  workDate: string | null;
};

export type TechnicianReconciliationSourceInput = {
  employeeId: string;
  sourceCount: number;
  sourceValue: number;
  sourceHours: number;
  /** Hours-share allocated gross profit derived independently from metrics_jobs; null when no allocated job carries gross profit. */
  sourceGrossProfit: number | null;
  /** Hours-share allocated net profit derived independently from metrics_jobs; null when no allocated job carries net profit. */
  sourceNetProfit: number | null;
  /** Independent month membership from metrics.effective_technician_roster. */
  sourceRosterMember: boolean;
  /** Identity and work date of every mapped source timesheet on the employee's completed-cohort jobs. */
  sourceTimesheets: TechnicianTimesheetIdentity[];
  sourceInputHash: string;
};

export type TechnicianReconciliationComparison = TechnicianReconciliationSourceInput & {
  status: "matched" | "mismatch";
  servedCount: number;
  servedValue: number;
  servedHours: number;
  servedGrossProfit: number;
  servedNetProfit: number | null;
  servedInScorecard: boolean;
  servedOutsideRoster: boolean;
  rosterStatus: "matched" | "mismatch";
  profitStatus: "matched" | "mismatch";
  timesheetStatus: "matched" | "mismatch" | "not_verified";
  servedTimesheetCount: number | null;
  readModelSourceHash: string;
};

export type TechnicianManifestAuthority = {
  complete: boolean;
  matched: boolean;
  generations: Record<string, number>;
};

export function isTechnicianManifestAuthorityPublishable(authority: TechnicianManifestAuthority) {
  return authority.complete && authority.matched;
}

type TechnicianSourceRow = {
  employee_id: string;
  source_count: string;
  source_value: string;
  source_hours: string;
  source_gross_profit: string | null;
  gross_profit_jobs: string | number;
  source_net_profit: string | null;
  net_profit_jobs: string | number;
  roster_member: boolean;
  source_inputs: unknown;
  source_timesheets: unknown;
};

export async function getTechnicianReconciliationSourceInputs(
  periodStart: string,
  periodEnd: string,
  query: PostgresQuery,
): Promise<TechnicianReconciliationSourceInput[]> {
  const result = await query<TechnicianSourceRow>(
    `with completed_jobs as (
       select job_id, coalesce(total, 0) as total,
              gross_profit_actual, net_profit_actual, source_hash
         from metrics.metrics_jobs
        where completed_date between $1::date and $2::date
          and lower(trim(stage)) in ('complete', 'archived')
          and source_deleted_at is null
     ), employee_job_hours as (
       select job.job_id,
              job.total,
              job.gross_profit_actual,
              job.net_profit_actual,
              job.source_hash as job_source_hash,
              timesheet.employee_id,
              sum(timesheet.total_hours) as employee_hours,
              array_agg(distinct coalesce(timesheet.source_hash, '') order by coalesce(timesheet.source_hash, '')) as timesheet_source_hashes
         from completed_jobs job
         join metrics.metrics_employee_timesheets timesheet
           on lower(trim(coalesce(timesheet.reference_type, ''))) = 'job'
          and timesheet.reference_id = job.job_id
          and timesheet.source_deleted_at is null
          and timesheet.total_hours > 0
         join metrics.dim_people person
           on person.simpro_employee_id = timesheet.employee_id
        group by job.job_id, job.total, job.gross_profit_actual, job.net_profit_actual, job.source_hash, timesheet.employee_id
     ), allocated as (
       select employee.*,
              sum(employee.employee_hours) over (partition by employee.job_id) as job_hours
         from employee_job_hours employee
     ), employee_allocations as (
       select employee_id,
              sum(employee_hours / nullif(job_hours, 0)) as source_count,
              sum(total * employee_hours / nullif(job_hours, 0)) as source_value,
              sum(employee_hours) as source_hours,
              sum(gross_profit_actual * employee_hours / nullif(job_hours, 0)) filter (where gross_profit_actual is not null) as source_gross_profit,
              count(*) filter (where gross_profit_actual is not null) as gross_profit_jobs,
              sum(net_profit_actual * employee_hours / nullif(job_hours, 0)) filter (where net_profit_actual is not null) as source_net_profit,
              count(*) filter (where net_profit_actual is not null) as net_profit_jobs,
              jsonb_agg(jsonb_build_object(
                'jobId', job_id::text,
                'jobTotal', total,
                'employeeHours', employee_hours,
                'jobHours', job_hours,
                'jobSourceHash', job_source_hash,
                'timesheetSourceHashes', timesheet_source_hashes
              ) order by job_id) as source_inputs
         from allocated
        group by employee_id
     ), timesheet_identity as (
       select timesheet.employee_id,
              jsonb_agg(jsonb_build_object(
                'timesheetId', timesheet.timesheet_id,
                'workDate', timesheet.work_date::text
              ) order by timesheet.timesheet_id) as timesheets
         from completed_jobs job
         join metrics.metrics_employee_timesheets timesheet
           on lower(trim(coalesce(timesheet.reference_type, ''))) = 'job'
          and timesheet.reference_id = job.job_id
          and timesheet.source_deleted_at is null
          and timesheet.total_hours > 0
         join metrics.dim_people person
           on person.simpro_employee_id = timesheet.employee_id
        group by timesheet.employee_id
     ), month_roster as (
       -- Owner rule: the month roster is whoever recorded work in the month.
       select roster.simpro_employee_id as employee_id
         from metrics.effective_technician_roster roster
        where exists (
                select 1 from metrics.metrics_employee_timesheets t
                 where t.employee_id = roster.simpro_employee_id
                   and t.work_date between $1::date and $2::date
                   and t.source_deleted_at is null
                   and t.total_hours > 0
              )
     )
     select coalesce(allocations.employee_id, roster.employee_id)::text as employee_id,
            coalesce(allocations.source_count, 0)::text as source_count,
            coalesce(allocations.source_value, 0)::text as source_value,
            coalesce(allocations.source_hours, 0)::text as source_hours,
            allocations.source_gross_profit::text as source_gross_profit,
            coalesce(allocations.gross_profit_jobs, 0)::text as gross_profit_jobs,
            allocations.source_net_profit::text as source_net_profit,
            coalesce(allocations.net_profit_jobs, 0)::text as net_profit_jobs,
            (roster.employee_id is not null) as roster_member,
            coalesce(allocations.source_inputs, '[]'::jsonb) as source_inputs,
            coalesce(timesheet_identity.timesheets, '[]'::jsonb) as source_timesheets
       from employee_allocations allocations
       full outer join month_roster roster on roster.employee_id = allocations.employee_id
       left join timesheet_identity
         on timesheet_identity.employee_id = coalesce(allocations.employee_id, roster.employee_id)
      order by coalesce(allocations.employee_id, roster.employee_id)`,
    [periodStart, periodEnd],
  );

  return result.rows.map((row) => ({
    employeeId: row.employee_id,
    sourceCount: finiteNumber(row.source_count),
    sourceValue: finiteNumber(row.source_value),
    sourceHours: finiteNumber(row.source_hours),
    sourceGrossProfit: finiteNumber(row.gross_profit_jobs) > 0 ? finiteNumber(row.source_gross_profit) : null,
    sourceNetProfit: finiteNumber(row.net_profit_jobs) > 0 ? finiteNumber(row.source_net_profit) : null,
    sourceRosterMember: row.roster_member === true,
    sourceTimesheets: timesheetIdentityList(row.source_timesheets),
    sourceInputHash: hashStableJson({ employeeId: row.employee_id, allocations: row.source_inputs }),
  }));
}

export function compareTechnicianReconciliationInputs(
  sourceInputs: TechnicianReconciliationSourceInput[],
  readModelPayload: Record<string, unknown>,
  readModelSourceHash: string,
): TechnicianReconciliationComparison[] {
  const sourceByEmployee = new Map(sourceInputs.map((row) => [row.employeeId, row]));
  const servedByEmployee = technicianReadModelTotals(readModelPayload);
  const employeeIds = [...new Set([...sourceByEmployee.keys(), ...servedByEmployee.keys()])]
    .sort(compareEmployeeIds);

  return employeeIds.map((employeeId) => {
    const source = sourceByEmployee.get(employeeId) ?? {
      employeeId,
      sourceCount: 0,
      sourceValue: 0,
      sourceHours: 0,
      sourceGrossProfit: null,
      sourceNetProfit: null,
      sourceRosterMember: false,
      sourceTimesheets: [],
      sourceInputHash: hashStableJson({ employeeId, allocations: [] }),
    };
    const served = servedByEmployee.get(employeeId) ?? emptyServedTotals();

    // Served economics must account for the full independent allocation whether
    // the employee is on the scorecard or disclosed outside the roster.
    const economicsMatched = valuesMatch(source.sourceCount, served.count)
      && valuesMatch(source.sourceValue, served.value)
      && valuesMatch(source.sourceHours, served.hours);

    // Independent roster assertion: scorecard membership must equal the
    // effective_technician_roster month membership; roster members must never
    // be disclosed as outside-roster and non-members must never be promoted.
    const rosterStatus: "matched" | "mismatch" = source.sourceRosterMember
      ? (served.inScorecard && !served.outsideRoster ? "matched" : "mismatch")
      : (served.inScorecard ? "mismatch" : "matched");

    // Independent profit assertion: allocated gross/net profit sums recomputed
    // from metrics_jobs must match the served amounts.
    const profitStatus: "matched" | "mismatch" = valuesMatch(source.sourceGrossProfit ?? 0, served.grossProfit)
      && valuesMatch(source.sourceNetProfit ?? 0, served.netProfit ?? 0)
      ? "matched"
      : "mismatch";

    const timesheetStatus = compareTimesheetIdentity(source, served);

    return {
      ...source,
      status: economicsMatched
        && rosterStatus === "matched"
        && profitStatus === "matched"
        && timesheetStatus !== "mismatch"
        ? "matched"
        : "mismatch",
      servedCount: served.count,
      servedValue: served.value,
      servedHours: served.hours,
      servedGrossProfit: served.grossProfit,
      servedNetProfit: served.netProfit,
      servedInScorecard: served.inScorecard,
      servedOutsideRoster: served.outsideRoster,
      rosterStatus,
      profitStatus,
      timesheetStatus,
      servedTimesheetCount: served.timesheets === null ? null : served.timesheets.length,
      readModelSourceHash,
    };
  });
}

function compareTimesheetIdentity(
  source: Pick<TechnicianReconciliationSourceInput, "sourceTimesheets">,
  served: ServedTechnicianTotals,
): "matched" | "mismatch" | "not_verified" {
  if (!served.inScorecard && served.outsideRoster) {
    // Outside-roster disclosure aggregates carry no per-timesheet evidence;
    // their economics and placement are asserted above.
    return "not_verified";
  }
  if (source.sourceTimesheets.length === 0 && (served.timesheets === null || served.timesheets.length === 0)) {
    return "matched";
  }
  if (served.timesheets === null) {
    // The read model served allocation without preserved work-date evidence
    // (pre-correction payload). It must rebuild under the corrected contract.
    return "mismatch";
  }
  const sourceKeys = source.sourceTimesheets
    .map((entry) => `${entry.timesheetId}::${entry.workDate ?? ""}`)
    .sort();
  const servedKeys = served.timesheets
    .map((entry) => `${entry.timesheetId}::${entry.workDate ?? ""}`)
    .sort();
  return sourceKeys.length === servedKeys.length
    && sourceKeys.every((key, index) => key === servedKeys[index])
    ? "matched"
    : "mismatch";
}

export async function getTechnicianManifestAuthority(
  periodStart: string,
  periodEnd: string,
  query: PostgresQuery,
): Promise<TechnicianManifestAuthority> {
  const result = await query<{
    source_family: string;
    coverage_status: string | null;
    reconciliation_status: string | null;
    manifest_generation: string | null;
    reconciliation_generation: string | null;
    expected_page_count: number | null;
    completed_page_count: number | null;
  }>(
    `select source_family, coverage_status, reconciliation_status,
            manifest_generation::text, reconciliation_generation::text,
            expected_page_count, completed_page_count
       from metrics.source_period_manifests
      where period_start = $1::date
        and period_end = $2::date
        and source_family = any($3::text[])
      order by source_family`,
    [periodStart, periodEnd, [...TECHNICIAN_RECONCILIATION_SOURCE_FAMILIES]],
  );
  const byFamily = new Map(result.rows.map((row) => [row.source_family, row]));
  const generations: Record<string, number> = {};
  let complete = true;
  let matched = true;
  for (const family of TECHNICIAN_RECONCILIATION_SOURCE_FAMILIES) {
    const row = byFamily.get(family);
    const manifestGeneration = positiveInteger(row?.manifest_generation);
    const reconciliationGeneration = positiveInteger(row?.reconciliation_generation);
    const pagesComplete = row !== undefined
      && row.expected_page_count !== null
      && row.expected_page_count > 0
      && row.completed_page_count === row.expected_page_count;
    if (!row || manifestGeneration === null || reconciliationGeneration !== manifestGeneration || !pagesComplete) {
      complete = false;
      continue;
    }
    generations[family] = manifestGeneration;
    if (row.coverage_status !== "complete" || row.reconciliation_status !== "matched") matched = false;
  }
  return { complete, matched: complete && matched, generations };
}

export async function persistTechnicianReconciliationResults(params: {
  reconciliationCheckId: number;
  periodStart: string;
  periodEnd: string;
  checkedAt: string;
  comparisons: TechnicianReconciliationComparison[];
  query: PostgresQuery;
}) {
  for (const comparison of params.comparisons) {
    await params.query(
      `insert into metrics.technician_reconciliation_results (
         reconciliation_check_id, period_start, period_end, employee_id, status,
         source_count, served_count, source_value, served_value, source_hours, served_hours,
         source_input_hash, read_model_source_hash, detail, checked_at
       ) values (
         $1, $2::date, $3::date, $4, $5,
         $6, $7, $8, $9, $10, $11,
         $12, $13, $14::jsonb, $15::timestamptz
       )`,
      [
        params.reconciliationCheckId,
        params.periodStart,
        params.periodEnd,
        comparison.employeeId,
        comparison.status,
        comparison.sourceCount,
        comparison.servedCount,
        comparison.sourceValue,
        comparison.servedValue,
        comparison.sourceHours,
        comparison.servedHours,
        comparison.sourceInputHash,
        comparison.readModelSourceHash,
        JSON.stringify({
          countDelta: roundSix(comparison.servedCount - comparison.sourceCount),
          valueDelta: roundSix(comparison.servedValue - comparison.sourceValue),
          hoursDelta: roundSix(comparison.servedHours - comparison.sourceHours),
          grossProfitDelta: roundSix(comparison.servedGrossProfit - (comparison.sourceGrossProfit ?? 0)),
          netProfitDelta: roundSix((comparison.servedNetProfit ?? 0) - (comparison.sourceNetProfit ?? 0)),
          rosterStatus: comparison.rosterStatus,
          profitStatus: comparison.profitStatus,
          timesheetStatus: comparison.timesheetStatus,
          sourceRosterMember: comparison.sourceRosterMember,
          servedInScorecard: comparison.servedInScorecard,
          servedOutsideRoster: comparison.servedOutsideRoster,
          sourceTimesheetCount: comparison.sourceTimesheets.length,
          servedTimesheetCount: comparison.servedTimesheetCount,
        }),
        params.checkedAt,
      ],
    );
  }
}

type ServedTechnicianTotals = {
  count: number;
  value: number;
  hours: number;
  grossProfit: number;
  netProfit: number | null;
  inScorecard: boolean;
  outsideRoster: boolean;
  /** Timesheet identity evidence from served allocations; null when any served allocation lacks it. */
  timesheets: TechnicianTimesheetIdentity[] | null;
};

function emptyServedTotals(): ServedTechnicianTotals {
  return {
    count: 0,
    value: 0,
    hours: 0,
    grossProfit: 0,
    netProfit: null,
    inScorecard: false,
    outsideRoster: false,
    timesheets: [],
  };
}

function technicianReadModelTotals(payload: Record<string, unknown>) {
  const totals = new Map<string, ServedTechnicianTotals>();
  const entryFor = (employeeId: string) => {
    const current = totals.get(employeeId) ?? emptyServedTotals();
    totals.set(employeeId, current);
    return current;
  };
  const accumulate = (current: ServedTechnicianTotals, row: Record<string, unknown> | null) => {
    current.count += finiteNumber(row?.completedJobCredit);
    current.value += finiteNumber(row?.allocatedSellValue);
    current.hours += finiteNumber(row?.actualJobHours);
    current.grossProfit += finiteNumber(row?.allocatedGrossProfit);
    if (row?.allocatedNetProfit !== null && row?.allocatedNetProfit !== undefined) {
      current.netProfit = (current.netProfit ?? 0) + finiteNumber(row.allocatedNetProfit);
    }
  };
  const technicians = Array.isArray(payload.technicians) ? payload.technicians : [];
  for (const value of technicians) {
    const technician = recordValue(value);
    const employeeId = textValue(technician?.employeeId);
    if (!employeeId) continue;
    const current = entryFor(employeeId);
    current.inScorecard = true;
    accumulate(current, technician);
  }
  const outsideRoster = Array.isArray(payload.outsideRoster) ? payload.outsideRoster : [];
  for (const value of outsideRoster) {
    const entry = recordValue(value);
    const employeeId = textValue(entry?.employeeId);
    if (!employeeId) continue;
    const current = entryFor(employeeId);
    current.outsideRoster = true;
    accumulate(current, entry);
  }
  const allocations = Array.isArray(payload.allocations) ? payload.allocations : [];
  for (const value of allocations) {
    const allocation = recordValue(value);
    const employeeId = textValue(allocation?.employeeId);
    if (!employeeId || !totals.has(employeeId)) continue;
    const current = entryFor(employeeId);
    if (current.timesheets === null) continue;
    if (!Array.isArray(allocation?.workDates)) {
      current.timesheets = null;
      continue;
    }
    current.timesheets.push(...timesheetIdentityList(allocation.workDates));
  }
  return totals;
}

function timesheetIdentityList(value: unknown): TechnicianTimesheetIdentity[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = recordValue(entry);
    const timesheetId = textValue(record?.timesheetId);
    if (!timesheetId) return [];
    const workDate = textValue(record?.workDate);
    return [{ timesheetId, workDate: workDate.length > 0 ? workDate : null }];
  });
}

function hashStableJson(value: unknown) {
  return createHash("sha256").update(JSON.stringify(stableJson(value))).digest("hex");
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  const record = recordValue(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableJson(item)]),
  );
}

function valuesMatch(left: number, right: number) {
  return Math.abs(roundSix(left) - roundSix(right)) <= 0.01;
}

function roundSix(value: number) {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function finiteNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function positiveInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function textValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function compareEmployeeIds(left: string, right: string) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
  return left.localeCompare(right);
}
