import { calculateCommissionPoolFromPercent } from "@/lib/metrics/commissions";
import {
  classifyLoss,
  grossMarginPercent,
  isCompletedJobStage,
  LOSS_CLASSIFICATION_RULE,
  type LossClass,
} from "@/lib/metrics/jobs";
import { plainDisplayText } from "@/lib/text/plain-display-text";

/**
 * Saved commission-control default (MOCKUP-DECISIONS Q5: 0.50%, efficiency
 * off). Mirrors DEFAULT_CONFIG.poolPercent in metrics/commissions.ts, which is
 * module-private; the Today pool-so-far figure always uses the saved default.
 */
export const DEFAULT_POOL_PERCENT = 0.5;

export const MTD_CAPACITY_RULE =
  "Flat capacity: Monday-Friday workdays elapsed in the month multiplied by 8 productive hours and the effective roster size. Observed holidays are not deducted.";

export const QUOTES_SENT_BASIS =
  "DateIssued assigns quotes-sent activity to the month.";

export type TodayJobInput = {
  jobId: string | number;
  jobNo?: string | null;
  name?: string | null;
  completedDate?: string | null;
  stageName?: string | null;
  sellValue: number | null;
  grossProfitActual?: number | null;
  netProfitActual?: number | null;
  siteName?: string | null;
  customerName?: string | null;
  updatedFromSourceAt?: string | null;
  sourceDeletedAt?: string | null;
};

export type TodayProfitabilityJob = {
  jobId: string;
  jobNo: string;
  name: string;
  siteName: string;
  sellValue: number | null;
  grossProfit: number | null;
  grossMargin: number | null;
  netProfit: number | null;
  netMargin: number | null;
  updatedFromSourceAt: string | null;
};

export type TodayQuoteInput = {
  quoteId: string | number;
  dateIssued?: string | null;
  totalValue: number | null;
  sourceDeletedAt?: string | null;
};

export type TodayTimesheetInput = {
  workDate?: string | null;
  hours: number | null;
  sourceDeletedAt?: string | null;
};

export type TodayRosterInput = {
  size: number;
  source: "recorded_work_month" | "effective_technician_roster" | "capacity_profile_fallback";
};

export type TodayLossRow = {
  jobId: string;
  name: string;
  siteName: string;
  sellValue: number | null;
  netProfit: number;
  lossClass: LossClass;
};

export type TodayCompletionRow = {
  jobId: string;
  name: string;
  siteName: string;
  completedDate: string;
  sellValue: number;
  netProfit: number | null;
};

export type TodayReadModel = {
  asOf: string;
  asOfDate: string;
  month: string;
  timezone: "America/Los_Angeles";
  elapsedDays: number;
  daysInMonth: number;
  today: {
    completedJobs: number;
    revenue: number;
    revenueCoveredJobs: number;
    grossProfit: number;
    grossMargin: number | null;
    netProfit: number;
    netMargin: number | null;
    averageJobValue: number | null;
    grossProfitCoveredJobs: number;
    netProfitCoveredJobs: number;
    netNegativeJobs: number;
    netNegativeTotal: number;
    jobs: TodayProfitabilityJob[];
  };
  dailyCumulativeRevenue: {
    currentMonth: { month: string; days: Array<{ day: number; cumulativeRevenue: number; jobs: number }> };
    priorMonth: { month: string; days: Array<{ day: number; cumulativeRevenue: number; jobs: number }> };
    priorYearSameMonth: { month: string; days: Array<{ day: number; cumulativeRevenue: number; jobs: number }> };
  };
  mtd: {
    revenue: number;
    netProfit: number;
    netProfitCoveredJobs: number;
    jobsCount: number;
    avgJobValue: number | null;
    quotesSent: number;
    quotesSentValue: number;
    quotesSentBasis: string;
    poolSoFar: number;
    poolSoFarCents: number;
    poolPercent: number;
    teamRecordedHours: number;
    mtdCapacityHours: number;
    capacityRule: string;
    rosterSize: number;
    rosterSource: TodayRosterInput["source"];
  };
  losses: {
    rule: string;
    count: number;
    netTotal: number;
    diagnosticFee: { jobs: number; netTotal: number };
    execution: { jobs: number; netTotal: number };
    top: TodayLossRow[];
    remainder: { count: number; netTotal: number };
  };
  biggestCompletions: TodayCompletionRow[];
  sameDayComparisons: {
    dayCount: number;
    priorMonth: { month: string; cumulativeRevenue: number; jobs: number };
    priorYearSameMonth: { month: string; cumulativeRevenue: number; jobs: number };
  };
};

export function buildTodayReadModel(params: {
  jobs: TodayJobInput[];
  quotesSent: TodayQuoteInput[];
  timesheets: TodayTimesheetInput[];
  roster: TodayRosterInput;
  poolPercent?: number;
  topLossCount?: number;
  topCompletionCount?: number;
  now?: Date;
}): TodayReadModel {
  const now = params.now ?? new Date();
  const local = losAngelesDateParts(now);
  const month = `${local.year}-${pad(local.month)}`;
  const elapsedDays = local.day;
  const asOfDate = `${month}-${pad(elapsedDays)}`;
  const priorMonth = shiftMonth(month, -1);
  const priorYearMonth = shiftMonth(month, -12);
  const poolPercent = params.poolPercent ?? DEFAULT_POOL_PERCENT;

  const completed = params.jobs.filter((job) => !job.sourceDeletedAt
    && Boolean(job.completedDate)
    && isCompletedJobStage(job.stageName));
  const mtdJobs = jobsInMonth(completed, month).filter((job) => dayOfMonth(job.completedDate!) <= elapsedDays);
  const todayJobs = mtdJobs.filter((job) => job.completedDate === asOfDate);
  const priorMonthJobs = jobsInMonth(completed, priorMonth);
  const priorYearJobs = jobsInMonth(completed, priorYearMonth);

  const todayRevenue = sum(todayJobs.map((job) => supportedNumber(job.sellValue) ?? 0));
  const todayRevenueCovered = todayJobs.filter((job) => supportedNumber(job.sellValue) !== null);
  const todayGrossProfit = sum(todayJobs.map((job) => supportedNumber(job.grossProfitActual) ?? 0));
  const todayNetProfit = sum(todayJobs.map((job) => supportedNumber(job.netProfitActual) ?? 0));
  const todayGrossCovered = todayJobs.filter((job) => supportedNumber(job.grossProfitActual) !== null);
  const todayNetCovered = todayJobs.filter((job) => supportedNumber(job.netProfitActual) !== null);
  const todayGrossRevenue = sum(todayGrossCovered.map((job) => supportedNumber(job.sellValue) ?? 0));
  const todayNetRevenue = sum(todayNetCovered.map((job) => supportedNumber(job.sellValue) ?? 0));
  const todayNegative = todayJobs.filter((job) => (supportedNumber(job.netProfitActual) ?? 0) < 0);
  const todayRows = todayJobs.map((job) => {
    const sellValue = supportedNumber(job.sellValue);
    const grossProfit = supportedNumber(job.grossProfitActual);
    const netProfit = supportedNumber(job.netProfitActual);
    return {
      jobId: String(job.jobId),
      jobNo: displayText(job.jobNo, String(job.jobId)),
      name: plainDisplayText(job.name, `Job ${job.jobId}`),
      siteName: displayText(job.siteName, "Unclassified"),
      sellValue,
      grossProfit,
      grossMargin: sellValue !== null && grossProfit !== null ? grossMarginPercent(sellValue, grossProfit) : null,
      netProfit,
      netMargin: sellValue !== null && netProfit !== null ? grossMarginPercent(sellValue, netProfit) : null,
      updatedFromSourceAt: job.updatedFromSourceAt ?? null,
    } satisfies TodayProfitabilityJob;
  }).sort((left, right) =>
    (right.updatedFromSourceAt ?? "").localeCompare(left.updatedFromSourceAt ?? "")
      || right.jobId.localeCompare(left.jobId));

  const revenue = sum(mtdJobs.map((job) => supportedNumber(job.sellValue) ?? 0));
  let netProfit = 0;
  let netProfitCoveredJobs = 0;
  for (const job of mtdJobs) {
    const net = supportedNumber(job.netProfitActual);
    if (net === null) continue;
    netProfit += net;
    netProfitCoveredJobs += 1;
  }

  const quotes = params.quotesSent.filter((quote) => !quote.sourceDeletedAt
    && Boolean(quote.dateIssued)
    && quote.dateIssued!.slice(0, 7) === month
    && dayOfMonth(quote.dateIssued!) <= elapsedDays);
  const teamRecordedHours = sum(params.timesheets
    .filter((row) => !row.sourceDeletedAt
      && Boolean(row.workDate)
      && row.workDate!.slice(0, 7) === month
      && dayOfMonth(row.workDate!) <= elapsedDays)
    .map((row) => supportedNumber(row.hours) ?? 0));

  const poolSoFar = calculateCommissionPoolFromPercent(revenue, poolPercent);
  const lossRows = mtdJobs
    .map((job) => {
      const net = supportedNumber(job.netProfitActual);
      const lossClass = classifyLoss(supportedNumber(job.sellValue), net);
      if (!lossClass || net === null) return null;
      return {
        jobId: String(job.jobId),
        name: plainDisplayText(job.name, `Job ${job.jobId}`),
        siteName: displayText(job.siteName, "Unclassified"),
        sellValue: supportedNumber(job.sellValue),
        netProfit: net,
        lossClass,
      } satisfies TodayLossRow;
    })
    .filter((row): row is TodayLossRow => row !== null)
    .sort((left, right) => left.netProfit - right.netProfit || left.jobId.localeCompare(right.jobId));
  const topLossCount = params.topLossCount ?? 3;
  const topLosses = lossRows.slice(0, topLossCount);
  const remainderLosses = lossRows.slice(topLossCount);

  const completions = mtdJobs
    .map((job) => ({
      jobId: String(job.jobId),
      name: plainDisplayText(job.name, `Job ${job.jobId}`),
      siteName: displayText(job.siteName, "Unclassified"),
      completedDate: job.completedDate!,
      sellValue: supportedNumber(job.sellValue) ?? 0,
      netProfit: supportedNumber(job.netProfitActual),
    }))
    .sort((left, right) => right.sellValue - left.sellValue || left.jobId.localeCompare(right.jobId))
    .slice(0, params.topCompletionCount ?? 5);

  const priorMonthCumulative = dailyCumulative(priorMonthJobs, priorMonth);
  const priorYearCumulative = dailyCumulative(priorYearJobs, priorYearMonth);
  const priorMonthAtDay = atDay(priorMonthCumulative.days, elapsedDays);
  const priorYearAtDay = atDay(priorYearCumulative.days, elapsedDays);

  return {
    asOf: now.toISOString(),
    asOfDate,
    month,
    timezone: "America/Los_Angeles",
    elapsedDays,
    daysInMonth: daysInMonth(month),
    today: {
      completedJobs: todayJobs.length,
      revenue: todayRevenue,
      revenueCoveredJobs: todayRevenueCovered.length,
      grossProfit: todayGrossProfit,
      grossMargin: grossMarginPercent(todayGrossRevenue, todayGrossProfit),
      netProfit: todayNetProfit,
      netMargin: grossMarginPercent(todayNetRevenue, todayNetProfit),
      averageJobValue: todayJobs.length > 0 && todayRevenueCovered.length === todayJobs.length ? todayRevenue / todayJobs.length : null,
      grossProfitCoveredJobs: todayGrossCovered.length,
      netProfitCoveredJobs: todayNetCovered.length,
      netNegativeJobs: todayNegative.length,
      netNegativeTotal: sum(todayNegative.map((job) => supportedNumber(job.netProfitActual) ?? 0)),
      jobs: todayRows,
    },
    dailyCumulativeRevenue: {
      currentMonth: { month, days: dailyCumulative(mtdJobs, month, elapsedDays).days },
      priorMonth: priorMonthCumulative,
      priorYearSameMonth: priorYearCumulative,
    },
    mtd: {
      revenue,
      netProfit,
      netProfitCoveredJobs,
      jobsCount: mtdJobs.length,
      avgJobValue: mtdJobs.length > 0 ? revenue / mtdJobs.length : null,
      quotesSent: quotes.length,
      quotesSentValue: sum(quotes.map((quote) => supportedNumber(quote.totalValue) ?? 0)),
      quotesSentBasis: QUOTES_SENT_BASIS,
      poolSoFar,
      poolSoFarCents: Math.round(poolSoFar * 100),
      poolPercent,
      teamRecordedHours,
      mtdCapacityHours: workdaysElapsed(month, elapsedDays) * 8 * Math.max(0, params.roster.size),
      capacityRule: MTD_CAPACITY_RULE,
      rosterSize: params.roster.size,
      rosterSource: params.roster.source,
    },
    losses: {
      rule: LOSS_CLASSIFICATION_RULE,
      count: lossRows.length,
      netTotal: sum(lossRows.map((row) => row.netProfit)),
      diagnosticFee: lossClassTotal(lossRows, "diagnostic_fee"),
      execution: lossClassTotal(lossRows, "execution"),
      top: topLosses,
      remainder: { count: remainderLosses.length, netTotal: sum(remainderLosses.map((row) => row.netProfit)) },
    },
    biggestCompletions: completions,
    sameDayComparisons: {
      dayCount: elapsedDays,
      priorMonth: { month: priorMonth, ...priorMonthAtDay },
      priorYearSameMonth: { month: priorYearMonth, ...priorYearAtDay },
    },
  };
}

function jobsInMonth(jobs: TodayJobInput[], month: string) {
  return jobs.filter((job) => job.completedDate!.slice(0, 7) === month);
}

function dailyCumulative(jobs: TodayJobInput[], month: string, throughDay?: number) {
  const limit = Math.min(throughDay ?? daysInMonth(month), daysInMonth(month));
  const perDay = new Array<number>(limit + 1).fill(0);
  const jobsPerDay = new Array<number>(limit + 1).fill(0);
  for (const job of jobs) {
    const day = dayOfMonth(job.completedDate!);
    if (day < 1 || day > limit) continue;
    perDay[day] += supportedNumber(job.sellValue) ?? 0;
    jobsPerDay[day] += 1;
  }
  const days: Array<{ day: number; cumulativeRevenue: number; jobs: number }> = [];
  let runningRevenue = 0;
  let runningJobs = 0;
  for (let day = 1; day <= limit; day += 1) {
    runningRevenue += perDay[day];
    runningJobs += jobsPerDay[day];
    days.push({ day, cumulativeRevenue: runningRevenue, jobs: runningJobs });
  }
  return { month, days };
}

function atDay(days: Array<{ day: number; cumulativeRevenue: number; jobs: number }>, dayCount: number) {
  const row = [...days].reverse().find((entry) => entry.day <= dayCount);
  return { cumulativeRevenue: row?.cumulativeRevenue ?? 0, jobs: row?.jobs ?? 0 };
}

function lossClassTotal(rows: TodayLossRow[], lossClass: LossClass) {
  const matching = rows.filter((row) => row.lossClass === lossClass);
  return { jobs: matching.length, netTotal: sum(matching.map((row) => row.netProfit)) };
}

function workdaysElapsed(month: string, throughDay: number): number {
  const [year, monthNumber] = month.split("-").map(Number);
  let count = 0;
  for (let day = 1; day <= Math.min(throughDay, daysInMonth(month)); day += 1) {
    const weekday = new Date(Date.UTC(year, monthNumber - 1, day)).getUTCDay();
    if (weekday >= 1 && weekday <= 5) count += 1;
  }
  return count;
}

function dayOfMonth(date: string) {
  return Number(date.slice(8, 10));
}

function daysInMonth(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
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

function displayText(value: string | null | undefined, fallback: string) {
  const cleaned = value?.trim();
  return cleaned || fallback;
}

function supportedNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}
