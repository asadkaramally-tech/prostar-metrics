import { businessCurrentMonth } from "@/lib/backfill/plan";
import { monthParamToPeriodStart } from "@/lib/metrics/periods";

export const COMMISSION_PERIOD_START = "2023-01-01";

export type CommissionPeriodParams = {
  year?: string | null;
  month?: string | null;
  summaryYear?: string | null;
};

export type CommissionDashboardPeriod = {
  year: number;
  month: number;
  summaryYear: number;
  periodStart: string;
};

/**
 * Accept the shared YYYY-MM picker value or the legacy numeric year/month
 * form. Invalid, historical, and future periods are rejected before they can
 * reach a read model that should never rewrite the caller's request.
 */
export function parseCommissionDashboardPeriod(
  params: CommissionPeriodParams,
  now = new Date(),
): CommissionDashboardPeriod | null {
  const currentPeriodStart = businessCurrentMonth(now);
  const currentYear = Number(currentPeriodStart.slice(0, 4));
  const monthParam = params.month ?? null;
  const yearParam = params.year ?? null;

  let periodStart: string;
  if (monthParam === null && yearParam === null) {
    periodStart = currentPeriodStart;
  } else if (monthParam && monthParamToPeriodStart(monthParam)) {
    periodStart = monthParamToPeriodStart(monthParam)!;
    if (yearParam !== null && yearParam !== periodStart.slice(0, 4)) return null;
  } else {
    if (!yearParam || !monthParam || !/^\d{4}$/.test(yearParam) || !/^(?:0?[1-9]|1[0-2])$/.test(monthParam)) return null;
    periodStart = `${yearParam}-${monthParam.padStart(2, "0")}-01`;
  }

  if (periodStart < COMMISSION_PERIOD_START || periodStart > currentPeriodStart) return null;

  const summaryYearParam = params.summaryYear ?? null;
  const summaryYear = summaryYearParam === null ? Number(periodStart.slice(0, 4)) : strictYear(summaryYearParam);
  if (summaryYear === null || summaryYear < 2023 || summaryYear > currentYear) return null;

  return {
    year: Number(periodStart.slice(0, 4)),
    month: Number(periodStart.slice(5, 7)),
    summaryYear,
    periodStart,
  };
}

export function requireCommissionDashboardPeriod(
  params: CommissionPeriodParams,
  now = new Date(),
): CommissionDashboardPeriod {
  const period = parseCommissionDashboardPeriod(params, now);
  if (!period) {
    throw new CommissionPeriodRangeError(
      `Commission period must be between ${COMMISSION_PERIOD_START.slice(0, 7)} and ${businessCurrentMonth(now).slice(0, 7)} in Pacific time.`,
    );
  }
  return period;
}

export class CommissionPeriodRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommissionPeriodRangeError";
  }
}

function strictYear(value: string): number | null {
  return /^\d{4}$/.test(value) ? Number(value) : null;
}
