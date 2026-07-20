import { NextResponse } from "next/server";
import { assertRole, getCurrentUser } from "@/lib/auth/roles";
import {
  CommissionRevisionConflictError,
  parseCommissionOverride,
  persistCommissionOverride,
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
  const expectedRevision = nonnegativeInteger(body.expectedRevision);

  if (!/^\d{4}-\d{2}-01$/.test(periodStart)) {
    return NextResponse.json({ error: "periodStart must be YYYY-MM-01." }, { status: 400 });
  }
  if (expectedRevision === null) {
    return NextResponse.json({ error: "expectedRevision must be a nonnegative integer." }, { status: 400 });
  }

  try {
    const override = parseCommissionOverride({
      employeeId: body.employeeId,
      field: body.field ?? body.fieldName,
      value: body.value ?? body.afterValue,
      reason: body.reason,
    });
    const evidenceUrl = normalizeEvidenceUrl(body.evidenceUrl);
    if (evidenceUrl === undefined) {
      return NextResponse.json({ error: "evidenceUrl must be an http(s) URL when supplied." }, { status: 400 });
    }
    const result = await persistCommissionOverride({
      periodStart,
      expectedRevision,
      override,
      evidenceUrl,
      actorEmail: user.email,
    });
    clearPageLoadCache();
    return NextResponse.json({ ...result, queued: true }, { status: 201 });
  } catch (error) {
    if (error instanceof CommissionRevisionConflictError) {
      return NextResponse.json({ error: error.message, currentRevision: error.currentRevision }, { status: 409 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to persist commission override." },
      { status: 400 },
    );
  }
}

function nonnegativeInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeEvidenceUrl(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 2000) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}
