import { NextResponse } from "next/server";
import { getCurrentUser, assertRole } from "@/lib/auth/roles";
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
  const today = new Date();
  const year = parseInt(url.searchParams.get("year") ?? String(today.getFullYear()), 10);
  const month = parseInt(url.searchParams.get("month") ?? String(today.getMonth() + 1), 10);
  const summaryYear = parseInt(url.searchParams.get("summaryYear") ?? String(year), 10);

  return NextResponse.json(await cachedPageLoad(`api:commissions:${year}-${month}:${summaryYear}`, 120_000, () =>
    getCommissionDashboardReadModel({ year, month, summaryYear, includeAllocationDetails: false }),
  ));
}
