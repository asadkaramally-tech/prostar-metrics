import { NextResponse } from "next/server";
import { assertRole, getCurrentUser } from "@/lib/auth/roles";
import { jobDashboardReadModelParams } from "@/lib/api/dashboard-route-params";
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
  if (!params) return NextResponse.json({ error: "month is outside the supported reporting range." }, { status: 400 });
  const model = await cachedPageLoad(`api:jobs:${JSON.stringify(params)}`, 120_000, () =>
    getJobDashboardReadModel(params),
  );
  return NextResponse.json(model, { status: model.loadError ? 503 : 200 });
}
