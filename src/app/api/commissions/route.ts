import { NextResponse } from "next/server";
import { getCurrentUser, assertRole } from "@/lib/auth/roles";
import { parseCommissionDashboardPeriod } from "@/lib/commissions/period";
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
  const period = parseCommissionDashboardPeriod({
    year: searchParams.get("year"),
    month: searchParams.get("month"),
    summaryYear: searchParams.get("summaryYear"),
  }, now);
  return period && { year: period.year, month: period.month, summaryYear: period.summaryYear };
}
