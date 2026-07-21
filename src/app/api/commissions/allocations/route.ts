import { NextResponse } from "next/server";
import { assertRole, getCurrentUser } from "@/lib/auth/roles";
import { getCommissionTechnicianAllocations } from "@/lib/store/commissions-read-model";

export async function GET(request: Request) {
  try {
    assertRole(await getCurrentUser(), ["admin", "finance"]);
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const url = new URL(request.url);
  const [year, month] = (url.searchParams.get("month") ?? "").split("-").map(Number);
  const employeeId = url.searchParams.get("employeeId");
  if (!Number.isInteger(year) || !Number.isInteger(month) || !employeeId) {
    return NextResponse.json({ error: "month and employeeId are required." }, { status: 400 });
  }
  try {
    const allocations = await getCommissionTechnicianAllocations({ year, month, employeeId });
    return NextResponse.json({ allocations });
  } catch {
    return NextResponse.json({ error: "Commission allocation detail could not be loaded." }, { status: 503 });
  }
}
