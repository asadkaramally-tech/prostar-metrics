import { NextResponse } from "next/server";
import { assertRole, getCurrentUser } from "@/lib/auth/roles";
import { monthParamToPeriodStart, periodStartToMonthKey } from "@/lib/metrics/periods";
import { getQuoteMetricsReadModel, type QuoteMetricsReadModelOptions } from "@/lib/store/quote-dashboard-read-model";
import { cachedPageLoad } from "@/lib/store/page-cache";

export async function GET(request: Request) {
  try {
    assertRole(await getCurrentUser(), ["admin", "finance"]);
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const url = new URL(request.url);
  const options = quoteDashboardReadModelOptions(url.searchParams);
  return NextResponse.json(await cachedPageLoad(`api:quotes:${JSON.stringify(options)}`, 120_000, () =>
    getQuoteMetricsReadModel(options),
  ));
}

export function quoteDashboardReadModelOptions(searchParams: URLSearchParams): QuoteMetricsReadModelOptions {
  const periodStart = monthParamToPeriodStart(searchParams.get("month"));
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
