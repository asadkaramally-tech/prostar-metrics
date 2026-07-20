import { NextResponse } from "next/server";
import { assertRole, getCurrentUser } from "@/lib/auth/roles";
import {
  CommissionRevisionConflictError,
  transitionCommissionPeriod,
  type CommissionLifecycleAction,
} from "@/lib/store/commission-lifecycle";
import { clearPageLoadCache } from "@/lib/store/page-cache";

export async function POST(request: Request) {
  const user = await getCurrentUser();
  try {
    assertRole(user, ["admin", "finance"]);
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = await request.json().catch(() => ({}));
  const periodStart = typeof body.periodStart === "string" ? body.periodStart : "";
  const action = body.action as CommissionLifecycleAction;
  const expectedRevision = Number(body.expectedRevision);
  if (!/^\d{4}-\d{2}-01$/.test(periodStart)) {
    return NextResponse.json({ error: "periodStart must be YYYY-MM-01." }, { status: 400 });
  }
  if (action !== "review" && action !== "lock") {
    return NextResponse.json({ error: "action must be review or lock." }, { status: 400 });
  }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    return NextResponse.json({ error: "expectedRevision must be a nonnegative integer." }, { status: 400 });
  }
  try {
    const period = await transitionCommissionPeriod({
      periodStart,
      expectedRevision,
      action,
      reason: typeof body.reason === "string" ? body.reason : "",
      actorEmail: user.email,
    });
    clearPageLoadCache();
    return NextResponse.json({ period });
  } catch (error) {
    if (error instanceof CommissionRevisionConflictError) {
      return NextResponse.json({ error: error.message, currentRevision: error.currentRevision }, { status: 409 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to transition commission period." }, { status: 400 });
  }
}
