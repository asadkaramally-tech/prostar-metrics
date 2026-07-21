import { NextResponse } from "next/server";
import { getCurrentUser, assertRole } from "@/lib/auth/roles";
import { businessCurrentMonth } from "@/lib/backfill/plan";
import { monthParamToPeriodStart } from "@/lib/metrics/periods";
import { getCommissionDashboardReadModel } from "@/lib/store/commissions-read-model";
import { cachedPageLoad } from "@/lib/store/page-cache";

export async function GET(request: Request) {
  const user = await getCurrentUser();

  try {
    assertRole(user, ["admin", "finance"]);
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = new URL(request.url);
  const period = commissionDashboardReadModelParams(url.searchParams);
  if (!period) {
    return NextResponse.json(
      { error: "month must be YYYY-MM (or a numeric month with year), within the supported reporting range." },
      { status: 400 },
    );
  }

  return NextResponse.json(await cachedPageLoad(`api:commissions:${period.year}-${period.month}:${period.summaryYear}`, 120_000, () =>
    getCommissionDashboardReadModel({ ...period, includeAllocationDetails: false }),
  ));
}

/**
 * Parse the same YYYY-MM format emitted by the shared period picker. The
 * numeric year/month form remains supported for existing API consumers, but
 * neither form is allowed to reach the read model's defensive clamping.
 */
export function commissionDashboardReadModelParams(
  searchParams: URLSearchParams,
  now = new Date(),
): { year: number; month: number; summaryYear: number } | null {
  const currentPeriodStart = businessCurrentMonth(now);
  const currentYear = Number(currentPeriodStart.slice(0, 4));
  const monthParam = searchParams.get("month");
  const yearParam = searchParams.get("year");

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

  if (periodStart < "2023-01-01" || periodStart > currentPeriodStart) return null;

  const summaryYearParam = searchParams.get("summaryYear");
  const summaryYear = summaryYearParam === null ? Number(periodStart.slice(0, 4)) : strictYear(summaryYearParam);
  if (summaryYear === null || summaryYear < 2023 || summaryYear > currentYear) return null;

  return {
    year: Number(periodStart.slice(0, 4)),
    month: Number(periodStart.slice(5, 7)),
    summaryYear,
  };
}

function strictYear(value: string): number | null {
  return /^\d{4}$/.test(value) ? Number(value) : null;
}
