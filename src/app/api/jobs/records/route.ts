import { NextResponse } from "next/server";
import { assertRole, getCurrentUser } from "@/lib/auth/roles";
import { jobDrilldownRecordsParams } from "@/lib/api/dashboard-route-params";
import { getJobDrilldownRecords } from "@/lib/store/job-dashboard-read-model";
import { cachedPageLoad } from "@/lib/store/page-cache";

/** Narrow, full-month roster for the Jobs table, CSV, and recurring labor. */
export async function GET(request: Request) {
  try {
    assertRole(await getCurrentUser(), ["admin", "finance"]);
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const selectedMonth = jobDrilldownRecordsParams(new URL(request.url).searchParams);
  if (!selectedMonth) return NextResponse.json({ error: "month is outside the supported reporting range." }, { status: 400 });
  try {
    const records = await cachedPageLoad(`api:jobs:records:${selectedMonth}`, 120_000, () =>
      getJobDrilldownRecords(selectedMonth),
    );
    return NextResponse.json({ records, total: records.length });
  } catch {
    return NextResponse.json({ error: "Job drilldown records could not be loaded." }, { status: 503 });
  }
}
