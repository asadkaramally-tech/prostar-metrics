import {
  DEFAULT_ON_TIME_THRESHOLD_MINUTES,
  type TechnicianJobInput,
  type TechnicianMonthlyTrend,
  type TechnicianAvailabilityInput,
  type TechnicianCapacityProfileInput,
  type TechnicianMobileEventInput,
  type TechnicianMobileEventKind,
  type TechnicianRecordedTimeInput,
  type TechnicianRosterMemberInput,
  type TechnicianScheduleVisitInput,
  type TechnicianTimesheetWorkDate,
} from "@/lib/metrics/technicians";
import { queryPostgres } from "@/lib/store/postgres";
import { TECHNICIAN_RECONCILIATION_SOURCE_FAMILIES } from "@/lib/store/technician-reconciliation";

type TechnicianMetricConfiguration = {
  onTimeThresholdMinutes: number;
  semanticsVerified: boolean;
  arrivalStatusIds: Set<string>;
  completionStatusIds: Set<string>;
};

type TechnicianJobRow = {
  job_id: string;
  job_no: string | null;
  job_name: string | null;
  completed_date: string;
  sell_value: string;
  gross_profit: string | null;
  net_profit?: string | null;
  job_source_type?: string | null;
  job_source_id?: string | null;
  labor_hours_estimate?: string | null;
  quote_id: string | null;
  quoted_hours: string | null;
  quote_labor_rows: string;
  employee_id: string | null;
  display_name: string | null;
  person_mapped: boolean;
  hours: string | null;
  in_period_hours?: string | null;
  work_dates?: unknown;
};

export type CommissionSourceVersion = {
  sourceSnapshotId: string | null;
  upstreamSourceHash: string | null;
  sourceVersion: string | null;
  fetchedAt: string | null;
  updatedFromSourceAt: string | null;
};

export type CommissionSourceTimesheet = {
  timesheetId: string;
  employeeId: string | null;
  displayName: string | null;
  mapped: boolean;
  hours: number;
  workDate: string | null;
  referenceType: string | null;
  referenceId: string | null;
  parseStatus: string | null;
  fieldTechnician: boolean;
  fieldClassification: {
    verified: boolean;
    basis: "effective_commission_roster" | "no_effective_commission_roster" | "unmapped_person";
    rosterId: string | null;
    rosterIncluded: boolean | null;
    effectiveStart: string | null;
    effectiveEnd: string | null;
  };
  person: {
    personId: string;
    employeeId: string;
    displayName: string;
    roleType: string;
    position: string | null;
    active: boolean;
    sourceModifiedAt: string | null;
    lastSeenAt: string;
  } | null;
  source: CommissionSourceVersion;
};

export type CommissionSourceQuoteLabor = {
  quoteId: string;
  sectionId: string;
  costCenterId: string;
  laborId: string;
  laborTypeId: string | null;
  laborTypeName: string | null;
  quantityHours: number | null;
  sellExTax: number | null;
  actualCost: number | null;
  source: CommissionSourceVersion;
};

export type CommissionSourceJob = {
  jobId: string;
  jobNo: string | null;
  jobName: string | null;
  completedDate: string;
  stageName: string;
  sellValue: number;
  grossProfit: number | null;
  quoteId: string | null;
  quotedHours: number | null;
  source: CommissionSourceVersion;
  timesheets: CommissionSourceTimesheet[];
  quoteLabor: CommissionSourceQuoteLabor[];
};

type CommissionSourceJobRow = {
  job_id: string;
  job_no: string | null;
  job_name: string | null;
  completed_date: string;
  stage_name: string;
  sell_value: string;
  gross_profit: string | null;
  quote_id: string | null;
  source_snapshot_id: string | null;
  source_hash: string | null;
  source_version: string | null;
  fetched_at: string | null;
  updated_from_source_at: string | null;
  timesheets: unknown;
  quote_labor: unknown;
};

export type CommissionSourceQuery = <T = Record<string, unknown>>(
  text: string,
  values?: unknown[],
) => Promise<{ rows: T[] }>;

type MobileEventRow = {
  source_log_id: string;
  employee_id: string | null;
  display_name: string | null;
  job_id: string | null;
  work_order_id: string | null;
  occurred_at: string | null;
  status_id: string | null;
  status_name: string | null;
};

export async function getTechnicianPerformanceInputs(periodStart: string, periodEnd: string) {
  const [jobs, recordedTimesheets, scheduleVisits, mobileRows, configuration, historicalTechnicians, rosterRows] = await Promise.all([
    getTechnicianJobs(periodStart, periodEnd),
    getTechnicianRecordedTimesheets(periodStart, periodEnd),
    getTechnicianScheduleVisits(periodStart, periodEnd),
    getTechnicianMobileRows(periodStart, periodEnd),
    getTechnicianMetricConfiguration(periodStart, periodEnd),
    getHistoricalTechnicians(periodStart),
    getEffectiveTechnicianRosterRows(periodStart, periodEnd),
  ]);

  return {
    jobs,
    periodStart,
    periodEnd,
    recordedTimesheets,
    scheduleVisits,
    mobileEvents: mobileRows.map((row) => mapMobileEvent(row, configuration)),
    onTimeThresholdMinutes: configuration.onTimeThresholdMinutes,
    historicalTechnicians,
    roster: mapEffectiveTechnicianRosterRows(rosterRows),
    capacityProfiles: mapTechnicianCapacityRows(rosterRows),
  };
}

export async function getTechnicianJobs(periodStart: string, periodEnd: string): Promise<TechnicianJobInput[]> {
  const result = await queryPostgres<TechnicianJobRow>(
    `with completed_jobs as materialized (
       select j.job_id,
              j.job_no,
              j.name,
              j.completed_date,
              j.total,
              j.gross_profit_actual,
              j.net_profit_actual,
              j.job_source_type,
              j.job_source_id,
              j.labor_hours_estimate,
              source_quote.source_quote_id
         from metrics.metrics_jobs j
         left join metrics.job_source_quotes source_quote on source_quote.job_id = j.job_id
        where j.completed_date between $1::date and $2::date
          and lower(trim(j.stage)) in ('complete', 'archived')
          and j.source_deleted_at is null
     ), quote_labor as (
       select labor.quote_id,
              sum(labor.quantity_hours)::text as quoted_hours,
              count(*)::text as quote_labor_rows
       from metrics.metrics_quote_labor labor
       join completed_jobs j on j.source_quote_id = labor.quote_id
       where labor.source_deleted_at is null
       group by labor.quote_id
     ), job_timesheets as (
       select t.reference_id as job_id,
              t.employee_id,
              max(p.display_name) as display_name,
              bool_or(p.person_id is not null) as person_mapped,
              sum(t.total_hours)::text as hours,
              coalesce(sum(t.total_hours) filter (where t.work_date between $1::date and $2::date), 0)::text as in_period_hours,
              jsonb_agg(jsonb_build_object(
                'timesheetId', t.timesheet_id,
                'workDate', t.work_date::text,
                'hours', t.total_hours
              ) order by t.work_date, t.timesheet_id) as work_dates
       from metrics.metrics_employee_timesheets t
       join completed_jobs j on j.job_id = t.reference_id
       left join metrics.dim_people p on p.simpro_employee_id = t.employee_id
       where lower(trim(coalesce(t.reference_type, ''))) = 'job'
         and t.reference_id is not null
         and t.source_deleted_at is null
         and t.total_hours > 0
       group by t.reference_id, t.employee_id
     )
     select j.job_id::text,
            j.job_no,
            j.name as job_name,
            j.completed_date::text,
            j.total::text as sell_value,
            j.gross_profit_actual::text as gross_profit,
            j.net_profit_actual::text as net_profit,
            j.job_source_type,
            j.job_source_id::text,
            j.labor_hours_estimate::text,
            j.source_quote_id::text as quote_id,
            case when j.job_source_type = 'Recurring' then j.labor_hours_estimate::text else ql.quoted_hours end as quoted_hours,
            case when j.job_source_type = 'Recurring' and j.labor_hours_estimate > 0 then '1' else coalesce(ql.quote_labor_rows, '0') end as quote_labor_rows,
            jt.employee_id::text,
            jt.display_name,
            coalesce(jt.person_mapped, false) as person_mapped,
            jt.hours,
            jt.in_period_hours,
            jt.work_dates
     from completed_jobs j
     left join quote_labor ql
       on ql.quote_id = j.source_quote_id
     left join job_timesheets jt on jt.job_id = j.job_id
     order by j.completed_date, j.job_id, jt.employee_id`,
    [periodStart, periodEnd],
  );

  return mapTechnicianJobRows(result.rows);
}

export async function getCommissionSourceJobs(
  periodStart: string,
  periodEnd: string,
  query: CommissionSourceQuery = queryPostgres,
): Promise<CommissionSourceJob[]> {
  const result = await query<CommissionSourceJobRow>(
    `with effective_roster as (
       select distinct on (r.simpro_employee_id)
              r.person_id as id,
              r.simpro_employee_id as employee_id,
              true as included,
              r.date_of_hire as effective_start,
              null::date as effective_end
         from metrics.effective_technician_roster r
        where exists (
                select 1
                  from metrics.metrics_employee_timesheets t
                 where t.employee_id = r.simpro_employee_id
                   and t.work_date between $1::date and $2::date
                   and t.source_deleted_at is null
                   and t.total_hours > 0
              )
        order by r.simpro_employee_id, r.person_id desc
     ), completed_jobs as (
       select j.*, source_quote.source_quote_id
         from metrics.metrics_jobs j
         left join metrics.job_source_quotes source_quote on source_quote.job_id = j.job_id
        where j.completed_date between $1::date and $2::date
          and lower(trim(j.stage)) in ('complete', 'archived')
          and j.source_deleted_at is null
     )
     select j.job_id::text,
            j.job_no,
            j.name as job_name,
            j.completed_date::text,
            j.stage as stage_name,
            j.total::text as sell_value,
            j.gross_profit_actual::text as gross_profit,
            j.source_quote_id::text as quote_id,
            j.source_snapshot_id::text,
            j.source_hash,
            j.source_version,
            j.fetched_at::text,
            j.updated_from_source_at::text,
            coalesce((
              select jsonb_agg(jsonb_build_object(
                'timesheetId', t.timesheet_id,
                'employeeId', t.employee_id::text,
                'displayName', p.display_name,
                'mapped', p.person_id is not null,
                'hours', t.total_hours,
                'workDate', t.work_date::text,
                'referenceType', t.reference_type,
                'referenceId', t.reference_id::text,
                'parseStatus', t.parse_status,
                'fieldTechnician', p.person_id is not null and r.id is not null,
                'fieldClassification', jsonb_build_object(
                  'verified', p.person_id is not null,
                  'basis', case
                    when p.person_id is null then 'unmapped_person'
                    when r.id is not null then 'effective_commission_roster'
                    else 'no_effective_commission_roster'
                  end,
                  'rosterId', r.id::text,
                  'rosterIncluded', r.included,
                  'effectiveStart', r.effective_start::text,
                  'effectiveEnd', r.effective_end::text
                ),
                'person', case when p.person_id is null then null else jsonb_build_object(
                  'personId', p.person_id::text,
                  'employeeId', p.simpro_employee_id::text,
                  'displayName', p.display_name,
                  'roleType', p.role_type,
                  'position', p.position,
                  'active', p.active,
                  'sourceModifiedAt', p.source_modified_at::text,
                  'lastSeenAt', p.last_seen_at::text
                ) end,
                'source', jsonb_build_object(
                  'sourceSnapshotId', t.source_snapshot_id::text,
                  'upstreamSourceHash', t.source_hash,
                  'sourceVersion', null,
                  'fetchedAt', t.fetched_at::text,
                  'updatedFromSourceAt', t.updated_from_source_at::text
                )
              ) order by t.employee_id, t.timesheet_id)
                from metrics.metrics_employee_timesheets t
                left join metrics.dim_people p on p.simpro_employee_id = t.employee_id
                left join effective_roster r on r.employee_id = t.employee_id
               where lower(trim(coalesce(t.reference_type, ''))) = 'job'
                 and t.reference_id = j.job_id
                 and t.source_deleted_at is null
            ), '[]'::jsonb) as timesheets,
            coalesce((
              select jsonb_agg(jsonb_build_object(
                'quoteId', ql.quote_id::text,
                'sectionId', ql.section_id::text,
                'costCenterId', ql.cost_center_id::text,
                'laborId', ql.labor_id::text,
                'laborTypeId', ql.labor_type_id::text,
                'laborTypeName', ql.labor_type_name,
                'quantityHours', ql.quantity_hours,
                'sellExTax', ql.sell_ex_tax,
                'actualCost', ql.actual_cost,
                'source', jsonb_build_object(
                  'sourceSnapshotId', ql.source_snapshot_id::text,
                  'upstreamSourceHash', ql.source_hash,
                  'sourceVersion', null,
                  'fetchedAt', ql.fetched_at::text,
                  'updatedFromSourceAt', null
                )
              ) order by ql.section_id, ql.cost_center_id, ql.labor_id)
                from metrics.metrics_quote_labor ql
               where ql.quote_id = j.source_quote_id
                 and ql.source_deleted_at is null
            ), '[]'::jsonb) as quote_labor
       from completed_jobs j
      order by j.completed_date, j.job_id`,
    [periodStart, periodEnd],
  );

  return mapCommissionSourceJobRows(result.rows);
}

export function mapCommissionSourceJobRows(rows: CommissionSourceJobRow[]): CommissionSourceJob[] {
  return rows.map((row) => {
    const quoteLabor = arrayRecords(row.quote_labor).map((entry) => ({
      quoteId: textValue(entry.quoteId),
      sectionId: textValue(entry.sectionId),
      costCenterId: textValue(entry.costCenterId),
      laborId: textValue(entry.laborId),
      laborTypeId: nullableText(entry.laborTypeId),
      laborTypeName: nullableText(entry.laborTypeName),
      quantityHours: nullableNumber(entry.quantityHours),
      sellExTax: nullableNumber(entry.sellExTax),
      actualCost: nullableNumber(entry.actualCost),
      source: sourceVersion(entry.source),
    }));
    return {
      jobId: row.job_id,
      jobNo: row.job_no,
      jobName: row.job_name,
      completedDate: row.completed_date,
      stageName: row.stage_name,
      sellValue: numeric(row.sell_value),
      grossProfit: nullableNumeric(row.gross_profit),
      quoteId: row.quote_id,
      quotedHours: quoteLabor.length > 0
        ? quoteLabor.reduce((total, labor) => total + (labor.quantityHours ?? 0), 0)
        : null,
      source: {
        sourceSnapshotId: row.source_snapshot_id,
        upstreamSourceHash: row.source_hash,
        sourceVersion: row.source_version,
        fetchedAt: row.fetched_at,
        updatedFromSourceAt: row.updated_from_source_at,
      },
      timesheets: arrayRecords(row.timesheets).map(mapCommissionSourceTimesheet),
      quoteLabor,
    };
  });
}

function mapCommissionSourceTimesheet(entry: Record<string, unknown>): CommissionSourceTimesheet {
  const field = recordValue(entry.fieldClassification);
  const person = recordValue(entry.person);
  return {
    timesheetId: textValue(entry.timesheetId),
    employeeId: nullableText(entry.employeeId),
    displayName: nullableText(entry.displayName),
    mapped: entry.mapped === true,
    hours: numberValue(entry.hours),
    workDate: nullableText(entry.workDate),
    referenceType: nullableText(entry.referenceType),
    referenceId: nullableText(entry.referenceId),
    parseStatus: nullableText(entry.parseStatus),
    fieldTechnician: entry.fieldTechnician === true,
    fieldClassification: {
      verified: field?.verified === true,
      basis: field?.basis === "effective_commission_roster"
        ? "effective_commission_roster"
        : field?.basis === "no_effective_commission_roster"
          ? "no_effective_commission_roster"
          : "unmapped_person",
      rosterId: nullableText(field?.rosterId),
      rosterIncluded: typeof field?.rosterIncluded === "boolean" ? field.rosterIncluded : null,
      effectiveStart: nullableText(field?.effectiveStart),
      effectiveEnd: nullableText(field?.effectiveEnd),
    },
    person: person ? {
      personId: textValue(person.personId),
      employeeId: textValue(person.employeeId),
      displayName: textValue(person.displayName),
      roleType: textValue(person.roleType),
      position: nullableText(person.position),
      active: person.active === true,
      sourceModifiedAt: nullableText(person.sourceModifiedAt),
      lastSeenAt: textValue(person.lastSeenAt),
    } : null,
    source: sourceVersion(entry.source),
  };
}

export function mapTechnicianJobRows(rows: TechnicianJobRow[]): TechnicianJobInput[] {
  const jobs = new Map<string, TechnicianJobInput>();
  for (const row of rows) {
    const job = jobs.get(row.job_id) ?? {
      jobId: row.job_id,
      jobNo: row.job_no,
      jobName: row.job_name,
      completedDate: row.completed_date,
      sellValue: numeric(row.sell_value),
      sellValueCovered: isNumeric(row.sell_value),
      grossProfit: nullableNumeric(row.gross_profit),
      netProfit: nullableNumeric(row.net_profit ?? null),
      jobSource: row.job_source_type ?? null,
      recurringJobId: row.job_source_type === "Recurring" ? row.job_source_id ?? null : null,
      quoteId: row.quote_id,
      quotedHours: nullableNumeric(row.quoted_hours),
      quoteLaborCovered: Number(row.quote_labor_rows) > 0 && isNumeric(row.quoted_hours),
      timesheets: [],
    };
    if (row.employee_id && row.hours !== null) {
      job.timesheets.push({
        employeeId: row.employee_id,
        displayName: row.display_name,
        mapped: row.person_mapped,
        hours: numeric(row.hours),
        ...(row.in_period_hours !== undefined && row.in_period_hours !== null
          ? { inPeriodHours: numeric(row.in_period_hours) }
          : {}),
        ...(row.work_dates !== undefined && row.work_dates !== null
          ? { workDates: mapTimesheetWorkDates(row.work_dates) }
          : {}),
      });
    }
    jobs.set(row.job_id, job);
  }
  return [...jobs.values()];
}

async function getTechnicianRecordedTimesheets(
  periodStart: string,
  periodEnd: string,
): Promise<TechnicianRecordedTimeInput[]> {
  const result = await queryPostgres<{
    timesheet_id: string;
    employee_id: string;
    display_name: string | null;
    person_mapped: boolean;
    work_date: string;
    hours: string;
    reference_type: string | null;
    reference_id: string | null;
    parse_status: string | null;
    job_supported: boolean;
  }>(
    `select t.timesheet_id,
            t.employee_id::text,
            p.display_name,
            (p.person_id is not null) as person_mapped,
            t.work_date::text,
            t.total_hours::text as hours,
            t.reference_type,
            t.reference_id::text,
            t.parse_status,
            (j.job_id is not null and j.source_deleted_at is null) as job_supported
     from metrics.metrics_employee_timesheets t
     left join metrics.dim_people p on p.simpro_employee_id = t.employee_id
     left join metrics.metrics_jobs j
       on lower(trim(coalesce(t.reference_type, ''))) = 'job'
      and j.job_id = t.reference_id
     where t.work_date between $1::date and $2::date
       and t.source_deleted_at is null
     order by t.work_date, t.employee_id, t.timesheet_id`,
    [periodStart, periodEnd],
  );

  return result.rows.map((row) => ({
    timesheetId: row.timesheet_id,
    employeeId: row.employee_id,
    displayName: row.display_name,
    personMapped: row.person_mapped,
    workDate: row.work_date,
    hours: numeric(row.hours),
    referenceType: row.reference_type,
    referenceId: row.reference_id,
    parseStatus: row.parse_status,
      jobSupported: row.job_supported,
      activityId: row.reference_type?.trim().toLowerCase() === "activity" ? row.reference_id : null,
    }));
}

type TechnicianCapacityRow = {
  employee_id: string;
  display_name: string | null;
  date_of_hire: string | null;
  position?: string | null;
  archived: boolean | null;
  availability_json: unknown;
};

export type EffectiveTechnicianRosterRow = TechnicianCapacityRow & {
  position: string | null;
  is_field_technician: boolean | null;
  has_in_period_work: boolean | null;
};

/**
 * The month's effective technician roster from metrics.effective_technician_roster
 * is the people with positive recorded work in the month. Position, archive
 * state, hire date, and old commission_roster rows are evidence/display only;
 * they do not gate membership.
 */
async function getEffectiveTechnicianRosterRows(
  periodStart: string,
  periodEnd: string,
): Promise<EffectiveTechnicianRosterRow[]> {
  const result = await queryPostgres<EffectiveTechnicianRosterRow>(
    `with roster as (
       select r.person_id,
              r.simpro_employee_id,
              r.display_name,
              r.position,
              r.date_of_hire,
              r.archived,
              r.is_field_technician,
              exists (
                select 1
                  from metrics.metrics_employee_timesheets t
                 where t.employee_id = r.simpro_employee_id
                   and t.work_date between $1::date and $2::date
                   and t.source_deleted_at is null
                   and t.total_hours > 0
              ) as has_in_period_work
         from metrics.effective_technician_roster r
     )
     select roster.simpro_employee_id::text as employee_id,
            roster.display_name,
            roster.position,
            roster.date_of_hire::text,
            roster.archived,
            roster.is_field_technician,
            roster.has_in_period_work,
            p.availability_json
       from roster
       join metrics.dim_people p on p.person_id = roster.person_id
      where roster.has_in_period_work
      order by roster.display_name, roster.simpro_employee_id`,
    [periodStart, periodEnd],
  );
  return result.rows;
}

export function mapEffectiveTechnicianRosterRows(rows: EffectiveTechnicianRosterRow[]): TechnicianRosterMemberInput[] {
  return rows.map((row) => ({
    employeeId: row.employee_id,
    displayName: row.display_name,
    position: row.position,
    dateOfHire: row.date_of_hire,
    archived: row.archived === true,
    isFieldTechnician: row.is_field_technician === true,
    hasInPeriodWork: row.has_in_period_work === true,
  }));
}

export function mapTechnicianCapacityRows(rows: TechnicianCapacityRow[]): TechnicianCapacityProfileInput[] {
  return rows.map((row) => ({
    employeeId: row.employee_id,
    displayName: row.display_name,
    dateOfHire: row.date_of_hire,
    position: row.position ?? null,
    archived: row.archived === true,
    archiveEvidenceAt: null,
    availability: parseTechnicianAvailability(row.availability_json),
  }));
}

export function parseTechnicianAvailability(value: unknown): TechnicianAvailabilityInput | null {
  const availability: TechnicianAvailabilityInput = {};
  const entries = availabilityEntries(value);
  for (const [rawDay, rawValue] of entries) {
    const weekday = weekdayName(rawDay);
    const day = availabilityDay(rawValue);
    if (!weekday || !day) continue;
    availability[weekday] = {
      startTime: nullableText(day.StartTime ?? day.startTime ?? day.Start ?? day.start),
      endTime: nullableText(day.EndTime ?? day.endTime ?? day.End ?? day.end),
      workHours: nullableNumber(day.WorkHours ?? day.workHours ?? day.Hours ?? day.hours),
      unavailable: day.Unavailable === true || day.unavailable === true || day.Available === false || day.available === false,
    };
  }
  return Object.keys(availability).length ? availability : null;
}

function availabilityEntries(value: unknown): Array<[string, unknown]> {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index): Array<[string, unknown]> => {
      if (typeof entry === "string") return availabilityTextEntries(entry, index);
      const row = recordValue(entry);
      if (!row) return [];
      const namedDay = textValue(row.Day ?? row.day ?? row.Weekday ?? row.weekday);
      return namedDay ? [[namedDay, entry]] : availabilityEntries(row);
    });
  }
  if (typeof value === "string") return availabilityTextEntries(value, 0);
  const root = recordValue(value);
  if (!root) return [];
  if (root.source === "default_business_hours") return [];
  for (const nested of [root.sourceAvailability, root.availability, root.Availability, root.Days, root.days]) {
    if (nested !== undefined && nested !== null) return availabilityEntries(nested);
  }
  return Object.entries(root).filter(([day]) => weekdayName(day));
}

function availabilityDay(value: unknown): Record<string, unknown> | null {
  const day = recordValue(value);
  if (day) return day;
  if (typeof value !== "string") return null;
  const times = [...value.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g)].map((match) => match[0]);
  if (times.length >= 2) return { startTime: times[0], endTime: times[1] };
  if (/\b(?:unavailable|not available|off)\b/i.test(value)) return { unavailable: true };
  return null;
}

function availabilityTextEntries(value: string, index: number): Array<[string, unknown]> {
  if (!value.trim()) return [];
  const weekdays = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  const named = weekdays.find((weekday) =>
    new RegExp(`\\b${weekday.slice(0, 3)}(?:${weekday.slice(3)})?\\b`, "i").test(value),
  );
  const positional = weekdays[index];
  const times = [...value.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g)].map((match) => match[0]);
  if (times.length < 2) {
    if (!/\b(?:unavailable|not available|off)\b/i.test(value)) return [];
    if (/weekdays?|monday\s*(?:-|to)\s*friday/i.test(value)) {
      return weekdays.slice(0, 5).map((weekday) => [weekday, { unavailable: true }]);
    }
    if (/weekends?/i.test(value)) {
      return weekdays.slice(5).map((weekday) => [weekday, { unavailable: true }]);
    }
    return [[named ?? positional ?? "", { unavailable: true }]];
  }
  const schedule = { startTime: times[0], endTime: times[1] };
  if (/weekdays?|monday\s*(?:-|to)\s*friday/i.test(value)) {
    return weekdays.slice(0, 5).map((weekday) => [weekday, schedule]);
  }
  if (/weekends?/i.test(value)) {
    return weekdays.slice(5).map((weekday) => [weekday, schedule]);
  }
  return [[named ?? positional ?? "", schedule]];
}

function weekdayName(value: string) {
  const normalized = value.trim().toLowerCase();
  return (["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const)
    .find((weekday) => weekday === normalized || weekday.slice(0, 3) === normalized.slice(0, 3));
}

async function getTechnicianScheduleVisits(
  periodStart: string,
  periodEnd: string,
): Promise<TechnicianScheduleVisitInput[]> {
  const result = await queryPostgres<{
    schedule_id: string;
    block_index: number;
    employee_id: string | null;
    display_name: string | null;
    person_mapped: boolean;
    job_id: string | null;
    work_order_id: string | null;
    cancelled: boolean;
    planned_start_at: string | null;
    planned_end_at: string | null;
  }>(
    `select b.schedule_id::text,
            b.block_index,
            b.staff_id::text as employee_id,
            p.display_name,
            (p.person_id is not null) as person_mapped,
            b.reference_id::text as job_id,
            b.work_order_id::text,
            b.cancelled,
            b.planned_start_at::text,
            b.planned_end_at::text
     from metrics.metrics_schedule_blocks b
     left join metrics.dim_people p on p.simpro_employee_id = b.staff_id
     where lower(trim(coalesce(b.reference_type, ''))) = 'job'
       and b.source_deleted_at is null
       and b.planned_start_at >= ($1::date::timestamp at time zone 'America/Los_Angeles')
       and b.planned_start_at < (($2::date + 1)::timestamp at time zone 'America/Los_Angeles')
     order by b.planned_start_at, b.schedule_id, b.block_index`,
    [periodStart, periodEnd],
  );

  return result.rows.map((row) => ({
    scheduleId: row.schedule_id,
    blockIndex: row.block_index,
    employeeId: row.employee_id ?? "",
    displayName: row.display_name,
    personMapped: row.person_mapped,
    jobId: row.job_id ?? "",
    workOrderId: row.work_order_id,
    plannedStartAt: row.planned_start_at ?? "",
    plannedEndAt: row.planned_end_at ?? "",
    cancelled: row.cancelled,
  }));
}

async function getTechnicianMobileRows(periodStart: string, periodEnd: string): Promise<MobileEventRow[]> {
  const result = await queryPostgres<MobileEventRow>(
    `select m.simpro_log_id::text as source_log_id,
            p.simpro_employee_id::text as employee_id,
            p.display_name,
            m.project_id::text as job_id,
            m.work_order_id::text,
            m.date_logged::text as occurred_at,
            m.status_id::text,
            m.status_name
     from metrics.metrics_mobile_status_logs m
     left join metrics.dim_people p on p.person_id = m.staff_person_id
     where lower(trim(coalesce(m.work_order_type, ''))) = 'job'
       and m.project_id is not null
       and m.date_logged >= (($1::date::timestamp at time zone 'America/Los_Angeles') - interval '12 hours')
       and m.date_logged < ((($2::date + 1)::timestamp at time zone 'America/Los_Angeles') + interval '24 hours')
     order by m.date_logged, m.simpro_log_id`,
    [periodStart, periodEnd],
  );
  return result.rows;
}

async function getTechnicianMetricConfiguration(
  periodStart: string,
  periodEnd: string,
): Promise<TechnicianMetricConfiguration> {
  const result = await queryPostgres<{
    on_time_threshold_minutes: number;
    config_json: unknown;
  }>(
    `select configured.on_time_threshold_minutes, configured.config_json
       from (
         select c.on_time_threshold_minutes,
                jsonb_build_object(
                  'technician', jsonb_build_object(
                    'mobileStatus', jsonb_build_object(
                      'verified', c.mobile_status_verified,
                      'arrivalStatusIds', to_jsonb(c.arrival_status_ids),
                      'completionStatusIds', to_jsonb(c.completion_status_ids),
                      'evidence', c.evidence_json,
                      'configHash', c.config_hash
                    )
                  )
                ) as config_json,
                0 as source_priority, c.effective_start as sort_date, c.revision as sort_revision
           from metrics.technician_metric_configs c
          where c.active
            and c.effective_start <= $2::date
            and (c.effective_end is null or c.effective_end >= $1::date)
         union all
         select c.on_time_threshold_minutes, c.config_json,
                1 as source_priority, p.period_start as sort_date, c.revision as sort_revision
           from metrics.commission_period_configs c
           join metrics.commission_periods p on p.id = c.period_id
          where c.active
            and p.period_start <= $2::date
            and p.period_end >= $1::date
       ) configured
      order by configured.source_priority, configured.sort_date desc, configured.sort_revision desc
      limit 1`,
    [periodStart, periodEnd],
  );
  return parseTechnicianMetricConfiguration(result.rows[0]);
}

export async function getHistoricalTechnicians(
  periodStart: string,
  query: CommissionSourceQuery = queryPostgres,
): Promise<TechnicianMonthlyTrend[]> {
  const result = await query<HistoricalTechnicianRow>(
    `select model.period_start::text,
            model.values_json,
            authority.id::text as authority_id,
            authority.checked_at::text as reconciliation_checked_at,
            coalesce(
              authority.checked_at < model.rebuilt_at
                or authority.checked_at < manifests.latest_evidence_at,
              false
            ) as reconciliation_stale,
            manifests.manifest_count as source_manifest_count,
            manifests.generation_proof_count,
            manifests.authoritative_manifest_count,
            manifests.mapped_manifest_count,
            manifests.valid_generation_count,
            technician_evidence.rows as technician_reconciliations
       from metrics.dashboard_read_models model
       left join lateral (
         select result.id, result.checked_at, result.source_manifest_generations
           from metrics.authoritative_reconciliation_results result
          where result.scope = 'technicians'
            and result.period_start = model.period_start
            and result.period_end = (model.period_start + interval '1 month - 1 day')::date
          order by result.checked_at desc, result.id desc
          limit 1
       ) authority on true
       left join lateral (
         select count(manifest.source_family)::integer as manifest_count,
                count(*) filter (
                  where manifest.manifest_generation is not null
                    and manifest.reconciliation_generation is not null
                )::integer as generation_proof_count,
                count(*) filter (
                  where manifest.manifest_generation > 0
                    and manifest.reconciliation_generation = manifest.manifest_generation
                    and manifest.coverage_status = 'complete'
                    and manifest.reconciliation_status = 'matched'
                    and manifest.continuation_token is null
                    and manifest.expected_page_count > 0
                    and manifest.completed_page_count = manifest.expected_page_count
                    and manifest.reconciled_at is not null
                )::integer as authoritative_manifest_count,
                count(*) filter (
                  where authority.source_manifest_generations ? required.source_family
                )::integer as mapped_manifest_count,
                count(*) filter (
                  where manifest.manifest_generation is not null
                    and manifest.reconciliation_generation = manifest.manifest_generation
                    and authority.source_manifest_generations ->> required.source_family = manifest.manifest_generation::text
                    and manifest.coverage_status = 'complete'
                    and manifest.reconciliation_status = 'matched'
                    and manifest.continuation_token is null
                    and manifest.expected_page_count > 0
                    and manifest.completed_page_count = manifest.expected_page_count
                    and manifest.reconciled_at is not null
                )::integer as valid_generation_count,
                max(greatest(manifest.evidence_as_of, manifest.updated_at)) as latest_evidence_at
           from unnest($2::text[]) required(source_family)
           left join metrics.source_period_manifests manifest
             on manifest.source_family = required.source_family
            and manifest.period_start = model.period_start
            and manifest.period_end = (model.period_start + interval '1 month - 1 day')::date
       ) manifests on true
       left join lateral (
         select jsonb_agg(jsonb_build_object(
                  'employeeId', evidence.employee_id,
                  'status', evidence.status,
                  'sourceCount', evidence.source_count,
                  'servedCount', evidence.served_count,
                  'sourceValue', evidence.source_value,
                  'servedValue', evidence.served_value,
                  'sourceHours', evidence.source_hours,
                  'servedHours', evidence.served_hours,
                  'modelMatches', evidence.read_model_source_hash = model.source_hash
                ) order by evidence.employee_id) as rows
           from metrics.technician_reconciliation_results evidence
          where evidence.reconciliation_check_id = authority.id
            and evidence.period_start = model.period_start
            and evidence.period_end = (model.period_start + interval '1 month - 1 day')::date
       ) technician_evidence on true
      where model.metric_family = 'technicians'
        and model.period_grain = 'month'
        and model.status = 'ready'
        and model.superseded_at is null
        and model.period_start <= $1::date
        and model.period_start >= date '2023-01-01'
      order by model.period_start`,
    [periodStart, [...TECHNICIAN_RECONCILIATION_SOURCE_FAMILIES]],
  );
  return mapHistoricalTechnicianRows(result.rows);
}

export async function getServedTechnicianHistory(
  periodStart: string,
  query: CommissionSourceQuery = queryPostgres,
): Promise<TechnicianMonthlyTrend[]> {
  const expectedSourceManifestCount = TECHNICIAN_RECONCILIATION_SOURCE_FAMILIES.length;
  const result = await query<HistoricalTechnicianRow>(
    `select model.period_start::text,
            model.values_json,
            null::text as authority_id,
            null::text as reconciliation_checked_at,
            false as reconciliation_stale,
            $2::integer as source_manifest_count,
            $2::integer as generation_proof_count,
            $2::integer as authoritative_manifest_count,
            $2::integer as mapped_manifest_count,
            $2::integer as valid_generation_count,
            null::jsonb as technician_reconciliations
       from metrics.dashboard_read_models model
      where model.metric_family = 'technicians'
        and model.period_grain = 'month'
        and model.status = 'ready'
        and model.superseded_at is null
        and model.period_start <= $1::date
        and model.period_start >= date '2023-01-01'
      order by model.period_start`,
    [periodStart, expectedSourceManifestCount],
  );
  return mapHistoricalTechnicianRows(result.rows);
}

type HistoricalTechnicianRow = {
  period_start: string;
  values_json: unknown;
  authority_id?: string | null;
  reconciliation_checked_at?: string | null;
  reconciliation_stale?: boolean | null;
  source_manifest_count?: number | null;
  generation_proof_count?: number | null;
  authoritative_manifest_count?: number | null;
  mapped_manifest_count?: number | null;
  valid_generation_count?: number | null;
  technician_reconciliations?: unknown;
};

export function mapHistoricalTechnicianRows(
  rows: HistoricalTechnicianRow[],
): TechnicianMonthlyTrend[] {
  const history: TechnicianMonthlyTrend[] = [];
  for (const row of rows) {
    const payload = recordValue(row.values_json);
    const periodEnd = typeof payload?.periodEnd === "string" ? payload.periodEnd : row.period_start;
    const technicians = Array.isArray(payload?.technicians) ? payload.technicians : [];
    const reconciliationByEmployee = new Map(
      arrayRecords(row.technician_reconciliations)
        .map((value) => [textValue(value.employeeId), value] as const)
        .filter(([employeeId]) => employeeId.length > 0),
    );
    for (const value of technicians) {
      const technician = recordValue(value);
      const employeeId = textValue(technician?.employeeId);
      if (!employeeId) continue;
      history.push({
        periodStart: row.period_start,
        periodEnd,
        employeeId,
        displayName: textValue(technician?.displayName) || `Employee ${employeeId}`,
        completedJobCredit: numberValue(technician?.completedJobCredit),
        allocatedSellValue: numberValue(technician?.allocatedSellValue),
        allocatedGrossProfit: numberValue(technician?.allocatedGrossProfit),
        allocatedNetProfit: nullableNumber(technician?.allocatedNetProfit),
        actualJobHours: numberValue(technician?.actualJobHours),
        jobHours: numberValue(technician?.jobHours),
        travelHours: numberValue(technician?.travelHours),
        pickupPartsHours: numberValue(technician?.pickupPartsHours),
        supportHours: numberValue(technician?.supportHours),
        grossCapacityHours: numberValue(technician?.grossCapacityHours),
        adjustedCapacityHours: numberValue(technician?.adjustedCapacityHours),
        workingRecordedHours: numberValue(technician?.workingRecordedHours),
        unrecordedHours: numberValue(technician?.unrecordedHours),
        overCapacityHours: numberValue(technician?.overCapacityHours),
        productiveHours: numberValue(technician?.productiveHours),
        totalRecordedHours: numberValue(technician?.totalRecordedHours),
        quotedHours: numberValue(technician?.quotedHours),
        laborEfficiencyActualHours: numberValue(technician?.laborEfficiencyActualHours),
        scheduledVisits: numberValue(technician?.scheduledVisits),
        arrivalCoveredVisits: numberValue(technician?.arrivalCoveredVisits),
        onTimeVisits: numberValue(technician?.onTimeVisits),
        reconciliation: historicalTechnicianReconciliation(row, reconciliationByEmployee.get(employeeId)),
      });
    }
  }
  return history;
}

function historicalTechnicianReconciliation(
  row: HistoricalTechnicianRow,
  evidence: Record<string, unknown> | undefined,
): TechnicianMonthlyTrend["reconciliation"] {
  const expected = TECHNICIAN_RECONCILIATION_SOURCE_FAMILIES.length;
  const manifestCount = numberValue(row.source_manifest_count);
  const checkedAt = nullableText(row.reconciliation_checked_at);
  const missing = (reason: TechnicianMonthlyTrend["reconciliation"]["reason"]) => ({
    status: "missing" as const,
    reason,
    checkedAt,
    sourceCount: null,
    servedCount: null,
    sourceValue: null,
    servedValue: null,
    sourceHours: null,
    servedHours: null,
    sourceManifestCount: manifestCount,
    expectedSourceManifestCount: expected,
  });
  if (manifestCount < expected || numberValue(row.generation_proof_count) < expected) {
    return missing("source_manifest_missing");
  }
  if (numberValue(row.authoritative_manifest_count) < expected) {
    return missing("source_manifest_mismatch");
  }
  if (!row.authority_id) return missing("check_missing");
  if (numberValue(row.mapped_manifest_count) < expected) return missing("source_manifest_missing");
  if (numberValue(row.valid_generation_count) < expected) return missing("source_manifest_mismatch");
  if (row.reconciliation_stale) return missing("stale");
  if (!evidence) return missing("check_missing");
  if (evidence.modelMatches !== true) return missing("stale");
  const status = evidence.status === "matched" ? "matched" : "mismatch";
  return {
    status,
    reason: status === "matched" ? "matched" : "check_mismatch",
    checkedAt,
    sourceCount: nullableNumber(evidence.sourceCount),
    servedCount: nullableNumber(evidence.servedCount),
    sourceValue: nullableNumber(evidence.sourceValue),
    servedValue: nullableNumber(evidence.servedValue),
    sourceHours: nullableNumber(evidence.sourceHours),
    servedHours: nullableNumber(evidence.servedHours),
    sourceManifestCount: manifestCount,
    expectedSourceManifestCount: expected,
  };
}

export function parseTechnicianMetricConfiguration(row?: {
  on_time_threshold_minutes: number;
  config_json: unknown;
}): TechnicianMetricConfiguration {
  const root = recordValue(row?.config_json);
  const technician = recordValue(root?.technician);
  const mobileStatus = recordValue(technician?.mobileStatus);
  const requestedVerification = mobileStatus?.verified === true;
  const arrivalStatusIds = requestedVerification ? stringSet(mobileStatus?.arrivalStatusIds) : new Set<string>();
  const completionStatusIds = requestedVerification ? stringSet(mobileStatus?.completionStatusIds) : new Set<string>();
  const semanticsVerified = requestedVerification && ![...arrivalStatusIds].some((statusId) => completionStatusIds.has(statusId));

  return {
    onTimeThresholdMinutes:
      Number.isInteger(row?.on_time_threshold_minutes) && Number(row?.on_time_threshold_minutes) >= 0
        ? Number(row?.on_time_threshold_minutes)
        : DEFAULT_ON_TIME_THRESHOLD_MINUTES,
    semanticsVerified,
    arrivalStatusIds: semanticsVerified ? arrivalStatusIds : new Set(),
    completionStatusIds: semanticsVerified ? completionStatusIds : new Set(),
  };
}

function mapMobileEvent(row: MobileEventRow, configuration: TechnicianMetricConfiguration): TechnicianMobileEventInput {
  return {
    sourceLogId: row.source_log_id,
    employeeId: row.employee_id ?? "",
    displayName: row.display_name,
    personMapped: Boolean(row.employee_id),
    jobId: row.job_id ?? "",
    workOrderId: row.work_order_id,
    occurredAt: row.occurred_at ?? "",
    kind: mobileEventKind(row.status_id, configuration),
    statusId: row.status_id,
    statusName: row.status_name,
  };
}

function mobileEventKind(
  statusId: string | null,
  configuration: TechnicianMetricConfiguration,
): TechnicianMobileEventKind {
  if (!configuration.semanticsVerified || statusId === null) return "unverified";
  if (configuration.arrivalStatusIds.has(statusId)) return "arrival";
  if (configuration.completionStatusIds.has(statusId)) return "completion";
  return "unverified";
}

export function mapTimesheetWorkDates(value: unknown): TechnicianTimesheetWorkDate[] {
  return arrayRecords(value).map((entry) => ({
    timesheetId: nullableText(entry.timesheetId),
    workDate: nullableText(entry.workDate),
    hours: numberValue(entry.hours),
  }));
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function arrayRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(recordValue).filter((entry): entry is Record<string, unknown> => entry !== null)
    : [];
}

function sourceVersion(value: unknown): CommissionSourceVersion {
  const source = recordValue(value);
  return {
    sourceSnapshotId: nullableText(source?.sourceSnapshotId),
    upstreamSourceHash: nullableText(source?.upstreamSourceHash),
    sourceVersion: nullableText(source?.sourceVersion),
    fetchedAt: nullableText(source?.fetchedAt),
    updatedFromSourceAt: nullableText(source?.updatedFromSourceAt),
  };
}

function nullableText(value: unknown): string | null {
  const text = textValue(value);
  return text.length > 0 ? text : null;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function stringSet(value: unknown) {
  if (!Array.isArray(value)) return new Set<string>();
  return new Set(value.map((entry) => String(entry)).filter(Boolean));
}

function textValue(value: unknown) {
  return typeof value === "string" ? value.trim() : value === null || value === undefined ? "" : String(value);
}

function numberValue(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function isNumeric(value: string | null) {
  return value !== null && Number.isFinite(Number(value));
}

function numeric(value: string | null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function nullableNumeric(value: string | null) {
  return isNumeric(value) ? Number(value) : null;
}
