import { NextResponse } from "next/server";
import { assertRole, getCurrentUser } from "@/lib/auth/roles";
import { CommissionRevisionConflictError, queueCommissionRebuild } from "@/lib/store/commission-lifecycle";
import { clearPageLoadCache } from "@/lib/store/page-cache";

export async function POST(request: Request) {
  const user = await getCurrentUser();
  try {
    assertRole(user, ["admin", "finance"]);
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const periodStart = normalizePeriodStart(body.periodStart, body.year, body.month);
  if (!periodStart) {
    return NextResponse.json({ error: "periodStart or year/month is required." }, { status: 400 });
  }
  const expectedRevision = Number(body.expectedRevision);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    return NextResponse.json({ error: "expectedRevision must be a nonnegative integer." }, { status: 400 });
  }
  const reason = typeof body.reason === "string" && body.reason.trim()
    ? body.reason.trim()
    : `Manual commission rebuild requested by ${user.email}`;

  try {
    const period = await queueCommissionRebuild({ periodStart, expectedRevision, reason, actorEmail: user.email });
    clearPageLoadCache();
    return NextResponse.json({ queued: true, period });
  } catch (error) {
    if (error instanceof CommissionRevisionConflictError) {
      return NextResponse.json({ error: error.message, currentRevision: error.currentRevision }, { status: 409 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to queue commission rebuild." }, { status: 400 });
  }
}

function normalizePeriodStart(periodStart: unknown, year: unknown, month: unknown) {
  if (typeof periodStart === "string" && /^\d{4}-\d{2}-01$/.test(periodStart)) {
    return periodStart;
  }

  const parsedYear = Number(year);
  const parsedMonth = Number(month);
  if (!Number.isInteger(parsedYear) || !Number.isInteger(parsedMonth) || parsedMonth < 1 || parsedMonth > 12) {
    return null;
  }

  return `${parsedYear}-${String(parsedMonth).padStart(2, "0")}-01`;
}
