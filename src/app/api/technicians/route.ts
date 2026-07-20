import { NextResponse } from "next/server";
import { assertRole, getCurrentUser } from "@/lib/auth/roles";
import { monthParamToPeriodStart } from "@/lib/metrics/periods";
import { getDashboardReadModel } from "@/lib/store/dashboard-read-models";
import { cachedPageLoad } from "@/lib/store/page-cache";

export async function GET(request: Request) {
  try {
    assertRole(await getCurrentUser(), ["admin", "finance"]);
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const url = new URL(request.url);
  const periodStart = monthParamToPeriodStart(url.searchParams.get("month"));
  return NextResponse.json(await cachedPageLoad(`api:technicians:${periodStart}`, 120_000, () =>
    getDashboardReadModel("technicians", { periodStart }),
  ));
}
