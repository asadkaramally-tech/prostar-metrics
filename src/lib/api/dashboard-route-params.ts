import { parseCommissionDashboardPeriod } from "@/lib/commissions/period";
import { boundedDashboardPeriodStart, periodStartToMonthKey } from "@/lib/metrics/periods";
import type { QuoteMetricsReadModelOptions } from "@/lib/store/quote-dashboard-read-model";

export function commissionDashboardReadModelParams(searchParams: URLSearchParams, now = new Date()) {
  const period = parseCommissionDashboardPeriod({
    year: searchParams.get("year"),
    month: searchParams.get("month"),
    summaryYear: searchParams.get("summaryYear"),
  }, now);
  return period && { year: period.year, month: period.month, summaryYear: period.summaryYear };
}

export function jobDashboardReadModelParams(searchParams: URLSearchParams, now = new Date()) {
  const periodStart = boundedDashboardPeriodStart(searchParams.get("month"), now);
  if (!periodStart) return null;
  const page = Number(searchParams.get("page"));
  return {
    selectedMonth: periodStartToMonthKey(periodStart),
    category: searchParams.get("category"),
    costCenter: searchParams.get("costCenter"),
    technician: searchParams.get("technician"),
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
  };
}

export function jobDrilldownRecordsParams(searchParams: URLSearchParams, now = new Date()): string | null {
  return periodStartToMonthKey(boundedDashboardPeriodStart(searchParams.get("month"), now) ?? undefined) ?? null;
}

export function quoteDashboardReadModelOptions(searchParams: URLSearchParams, now = new Date()): QuoteMetricsReadModelOptions | null {
  const periodStart = boundedDashboardPeriodStart(searchParams.get("month"), now);
  if (!periodStart) return null;
  return {
    selectedMonth: periodStartToMonthKey(periodStart),
    search: searchParams.get("search") ?? undefined,
    category: searchParams.get("category") ?? undefined,
    tier: searchParams.get("tier") ?? undefined,
    outcome: searchParams.get("outcome") ?? undefined,
    acceptancePath: searchParams.get("acceptancePath") ?? undefined,
    sort: searchParams.get("sort") ?? undefined,
    page: searchParams.get("page") ?? undefined,
  };
}
