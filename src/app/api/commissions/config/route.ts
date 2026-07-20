import { NextResponse } from "next/server";
import { assertRole, getCurrentUser } from "@/lib/auth/roles";
import {
  CommissionRevisionConflictError,
  persistCommissionConfig,
  validateCommissionConfig,
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
  const expectedRevision = Number(body.expectedRevision);
  if (!/^\d{4}-\d{2}-01$/.test(periodStart)) {
    return NextResponse.json({ error: "periodStart must be YYYY-MM-01." }, { status: 400 });
  }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    return NextResponse.json({ error: "expectedRevision must be a nonnegative integer." }, { status: 400 });
  }
  try {
    const period = await persistCommissionConfig({
      periodStart,
      expectedRevision,
      config: validateCommissionConfig(body.config),
      reason: typeof body.reason === "string" ? body.reason : "",
      actorEmail: user.email,
    });
    clearPageLoadCache();
    return NextResponse.json({ period, queued: true });
  } catch (error) {
    if (error instanceof CommissionRevisionConflictError) {
      return NextResponse.json({ error: error.message, currentRevision: error.currentRevision }, { status: 409 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to save commission config." }, { status: 400 });
  }
}
