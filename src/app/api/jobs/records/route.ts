import { NextResponse } from "next/server";
import { assertRole, getCurrentUser } from "@/lib/auth/roles";
import { monthParamToPeriodStart, periodStartToMonthKey } from "@/lib/metrics/periods";
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
  try {
    const records = await cachedPageLoad(`api:jobs:records:${selectedMonth}`, 120_000, () =>
      getJobDrilldownRecords(selectedMonth),
    );
    return NextResponse.json({ records, total: records.length });
  } catch {
    return NextResponse.json({ error: "Job drilldown records could not be loaded." }, { status: 503 });
  }
}

export function jobDrilldownRecordsParams(searchParams: URLSearchParams): string {
  const month = periodStartToMonthKey(monthParamToPeriodStart(searchParams.get("month")));
  if (month) return month;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit",
  }).formatToParts(new Date());
  const part = (type: "year" | "month") => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}`;
}
