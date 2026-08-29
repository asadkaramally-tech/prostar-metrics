import { NextResponse } from "next/server";
import { getCurrentUser, assertRole } from "@/lib/auth/roles";
import { commissionDashboardReadModelParams } from "@/lib/api/dashboard-route-params";
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
