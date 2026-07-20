import { NextResponse } from "next/server";
import { assertRole, getCurrentUser } from "@/lib/auth/roles";
import { monthParamToPeriodStart, periodStartToMonthKey } from "@/lib/metrics/periods";
import { getJobDashboardReadModel } from "@/lib/store/job-dashboard-read-model";
import { cachedPageLoad } from "@/lib/store/page-cache";

export async function GET(request: Request) {
  try {
    assertRole(await getCurrentUser(), ["admin", "finance"]);
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const url = new URL(request.url);
  const params = jobDashboardReadModelParams(url.searchParams);
  const model = await cachedPageLoad(`api:jobs:${JSON.stringify(params)}`, 120_000, () =>
    getJobDashboardReadModel(params),
  );
  return NextResponse.json(model, { status: model.loadError ? 503 : 200 });
}

export function jobDashboardReadModelParams(searchParams: URLSearchParams) {
  const periodStart = monthParamToPeriodStart(searchParams.get("month"));
  const page = Number(searchParams.get("page"));
  return {
    selectedMonth: periodStartToMonthKey(periodStart),
    category: searchParams.get("category"),
    costCenter: searchParams.get("costCenter"),
    technician: searchParams.get("technician"),
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
  };
}
