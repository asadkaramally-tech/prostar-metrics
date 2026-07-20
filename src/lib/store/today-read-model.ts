import type { FreshnessStatus } from "@/lib/metrics/freshness";
import { classifyLoss } from "@/lib/metrics/jobs";
import {
  buildTodayReadModel,
  type TodayJobInput,
  type TodayQuoteInput,
  type TodayReadModel,
  type TodayTimesheetInput,
} from "@/lib/metrics/today";
import { getPageFreshness } from "@/lib/store/freshness";
import { queryPostgres } from "@/lib/store/postgres";

/** Per-technician MTD hours (plus the prior month's full total) for the
 *  Today roster flags — 0-hours and over-capacity rows. */
export type TodayRosterTechnician = {
  employeeId: string;
  name: string;
  mtdHours: number;
  priorMonthHours: number;
};

export type TodayDashboardReadModel = TodayReadModel & {
  freshness: { jobs: FreshnessStatus; quotes: FreshnessStatus };
  loadError: string | null;
  /** Prior-month full-month loss cohort (same classifyLoss rule), for the
   *  Losses card's honest full-month comparison. Null when unavailable. */
  lossesPriorMonth: { month: string; count: number; netTotal: number } | null;
  /** Null when the per-technician detail could not be read. */
  rosterDetail: { technicians: TodayRosterTechnician[] } | null;
};

type TodayJobRow = {
  job_id: string;
  name: string | null;
  completed_date: string;
  stage: string;
  total: string | null;
  net_profit_actual: string | null;
  site_name: string | null;
  customer_name: string | null;
};

type TodayQuoteRow = {
  quote_id: string;
  date_approved: string;
  total_value: string | null;
};

type RosterTimesheetDetailRow = {
  employee_id: string;
  name: string;
  work_date: string | null;
  hours: string | null;
};

export async function getTodayReadModel(params: { now?: Date } = {}): Promise<TodayDashboardReadModel> {
  const now = params.now ?? new Date();
  const local = losAngelesDateParts(now);
  const month = `${local.year}-${pad(local.month)}`;
  const asOfDate = `${month}-${pad(local.day)}`;
  const currentRange = { start: `${month}-01`, end: asOfDate };
  const priorMonthKey = shiftMonth(month, -1);
  const priorYearKey = shiftMonth(month, -12);
  const priorMonthRange = monthRange(priorMonthKey);
  const priorYearRange = monthRange(priorYearKey);
  const freshnessPromise = Promise.all([
    getPageFreshness("jobs", `${month}-01`),
    getPageFreshness("quotes", `${month}-01`),
  ]);

  try {
    const [rosterDetailInput, jobs, quotes, [jobsFreshness, quotesFreshness]] = await Promise.all([
      getRosterTimesheetDetail(currentRange, priorMonthRange),
      getTodayJobs([currentRange, priorMonthRange, priorYearRange]),
      getTodayQuotes(currentRange),
      freshnessPromise,
    ]);
    return {
      ...buildTodayReadModel({
        jobs,
        quotesSent: quotes,
        timesheets: rosterDetailInput.timesheets,
        roster: { size: rosterDetailInput.employeeIds.length, source: "recorded_work_month" },
        now,
      }),
      freshness: { jobs: jobsFreshness, quotes: quotesFreshness },
      loadError: null,
      lossesPriorMonth: buildPriorMonthLosses(jobs, priorMonthKey),
      rosterDetail: rosterDetailInput.rosterDetail,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unable to read persisted Today data.";
    const [jobsFreshness, quotesFreshness] = await freshnessPromise;
    const empty = buildTodayReadModel({
      jobs: [],
      quotesSent: [],
      timesheets: [],
      roster: { size: 0, source: "recorded_work_month" },
      now,
    });
    return {
      ...empty,
      freshness: { jobs: jobsFreshness, quotes: quotesFreshness },
      loadError: detail,
      lossesPriorMonth: null,
      rosterDetail: null,
    };
  }
}

/** Prior-month full-month losses under the same classifyLoss rule the MTD
 *  loss module uses — never fabricated: null net rows are skipped. */
function buildPriorMonthLosses(jobs: TodayJobInput[], priorMonthKey: string) {
  let count = 0;
  let netTotal = 0;
  for (const job of jobs) {
    if (!job.completedDate || job.completedDate.slice(0, 7) !== priorMonthKey) continue;
    const net = typeof job.netProfitActual === "number" && Number.isFinite(job.netProfitActual)
      ? job.netProfitActual
      : null;
    const sell = typeof job.sellValue === "number" && Number.isFinite(job.sellValue) ? job.sellValue : null;
    if (net === null || !classifyLoss(sell, net)) continue;
    count += 1;
    netTotal += net;
  }
  return { month: priorMonthKey, count, netTotal };
}

async function getTodayJobs(
  ranges: Array<{ start: string; end: string }>,
): Promise<TodayJobInput[]> {
  const result = await queryPostgres<TodayJobRow>(
    `select j.job_id::text, j.name, j.completed_date::text, j.stage, j.total::text,
            j.net_profit_actual::text, j.site_name, j.customer_name
       from metrics.metrics_jobs j
      where j.source_deleted_at is null
        and lower(trim(j.stage)) in ('complete', 'archived')
        and (j.completed_date between $1::date and $2::date
          or j.completed_date between $3::date and $4::date
          or j.completed_date between $5::date and $6::date)
      order by j.completed_date, j.job_id`,
    ranges.flatMap((range) => [range.start, range.end]),
  );
  return result.rows.map((row) => ({
    jobId: row.job_id,
    name: row.name,
    completedDate: row.completed_date,
    stageName: row.stage,
    sellValue: nullableNumber(row.total),
    netProfitActual: nullableNumber(row.net_profit_actual),
    siteName: row.site_name,
    customerName: row.customer_name,
  }));
}

async function getTodayQuotes(range: { start: string; end: string }): Promise<TodayQuoteInput[]> {
  const result = await queryPostgres<TodayQuoteRow>(
    `select q.quote_id::text, q.date_approved::text, q.total::text as total_value
       from metrics.metrics_quotes q
      where q.source_deleted_at is null
        and q.date_approved between $1::date and $2::date
      order by q.date_approved, q.quote_id`,
    [range.start, range.end],
  );
  return result.rows.map((row) => ({
    quoteId: row.quote_id,
    dateApproved: row.date_approved,
    totalValue: nullableNumber(row.total_value),
  }));
}

/**
 * MTD Today roster: people with positive dated timesheet work in the live
 * month window. This page is an operating view, so static Simpro positions do
 * not decide who appears or inflate capacity.
 */
async function getRosterTimesheetDetail(
  currentRange: { start: string; end: string },
  priorMonthRange: { start: string; end: string },
): Promise<{
  employeeIds: string[];
  timesheets: TodayTimesheetInput[];
  rosterDetail: { technicians: TodayRosterTechnician[] };
}> {
  const result = await queryPostgres<RosterTimesheetDetailRow>(
    `with roster as (
       select t.employee_id
         from metrics.metrics_employee_timesheets t
        where t.source_deleted_at is null
          and t.employee_id is not null
          and t.work_date between $1::date and $2::date
          and t.total_hours > 0
        group by t.employee_id
     )
     select r.employee_id::text as employee_id,
            coalesce(nullif(trim(p.display_name), ''), 'Employee ' || r.employee_id::text) as name,
            t.work_date::text,
            t.total_hours::text as hours
       from roster r
       left join metrics.dim_people p on p.simpro_employee_id = r.employee_id
       left join metrics.metrics_employee_timesheets t
         on t.employee_id = r.employee_id
        and t.source_deleted_at is null
        and t.work_date between $3::date and $2::date
      order by r.employee_id, t.work_date, t.timesheet_id`,
    [currentRange.start, currentRange.end, priorMonthRange.start],
  );
  const employeeIds: string[] = [];
  const detail = new Map<string, TodayRosterTechnician>();
  const timesheets: TodayTimesheetInput[] = [];
  for (const row of result.rows) {
    if (!detail.has(row.employee_id)) {
      employeeIds.push(row.employee_id);
      detail.set(row.employee_id, {
        employeeId: row.employee_id,
        name: row.name,
        mtdHours: 0,
        priorMonthHours: 0,
      });
    }
    if (!row.work_date) continue;
    const hours = nullableNumber(row.hours) ?? 0;
    const technician = detail.get(row.employee_id)!;
    if (row.work_date >= currentRange.start && row.work_date <= currentRange.end) {
      technician.mtdHours += hours;
      timesheets.push({ workDate: row.work_date, hours });
    } else if (row.work_date >= priorMonthRange.start && row.work_date <= priorMonthRange.end) {
      technician.priorMonthHours += hours;
    }
  }
  return {
    employeeIds,
    timesheets,
    rosterDetail: { technicians: [...detail.values()] },
  };
}

function monthRange(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  const day = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${pad(day)}` };
}

function shiftMonth(month: string, offset: number) {
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, monthNumber - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}`;
}

function losAngelesDateParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(date);
  const value = (type: "year" | "month" | "day") => Number(parts.find((part) => part.type === type)?.value);
  return { year: value("year"), month: value("month"), day: value("day") };
}

function nullableNumber(value: string | null): number | null {
  if (value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}
