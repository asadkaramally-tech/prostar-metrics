import { NextResponse } from "next/server";
import { assertRole, getCurrentUser } from "@/lib/auth/roles";
import { parseCommissionDashboardPeriod } from "@/lib/commissions/period";
import { getCommissionTechnicianAllocations } from "@/lib/store/commissions-read-model";

export async function GET(request: Request) {
  try {
    assertRole(await getCurrentUser(), ["admin", "finance"]);
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const url = new URL(request.url);
  const period = parseCommissionDashboardPeriod({ month: url.searchParams.get("month") });
  const employeeId = url.searchParams.get("employeeId");
  if (!period || !employeeId) {
    return NextResponse.json({ error: "month and employeeId are required." }, { status: 400 });
  }
  try {
    const allocations = await getCommissionTechnicianAllocations({ year: period.year, month: period.month, employeeId });
    return NextResponse.json({ allocations });
  } catch {
    return NextResponse.json({ error: "Commission allocation detail could not be loaded." }, { status: 503 });
  }
}
