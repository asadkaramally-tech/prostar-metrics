import { NextResponse } from "next/server";
import { assertRole, getCurrentUser, type CurrentUser } from "@/lib/auth/roles";
import {
  currentActiveExclusionRevision,
  getQuoteOverrideHistory,
  persistQuoteOverrideAction,
  quoteOverrideActions,
  QuoteOverrideConflictError,
  QuoteOverrideIdempotencyConflictError,
  type QuoteOverrideRecord,
  type QuoteOverrideAction,
} from "@/lib/store/quote-overrides";
import { clearPageLoadCache } from "@/lib/store/page-cache";

const allowedActions = new Set<QuoteOverrideAction>(quoteOverrideActions);

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!canReadQuoteOverrideHistory(user)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const quoteId = positiveInteger(new URL(request.url).searchParams.get("quoteId"));
  if (!quoteId) {
    return NextResponse.json({ error: "quoteId must be a positive integer." }, { status: 400 });
  }

  try {
    const history = await getQuoteOverrideHistory(quoteId);
    return NextResponse.json(quoteOverrideHistoryResponse(quoteId, history, hasOperatorRole(user)));
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error, "Unable to load quote override history.") }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!hasOperatorRole(user)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const quoteId = positiveInteger(body.quoteId);
  const expectedActiveExclusionRevision = nonNegativeInteger(body.expectedActiveExclusionRevision);
  const action = typeof body.action === "string" ? body.action : "";
  const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  const evidenceUrl = normalizeEvidenceUrl(body.evidenceUrl);

  if (!quoteId) {
    return NextResponse.json({ error: "quoteId must be a positive integer." }, { status: 400 });
  }
  if (expectedActiveExclusionRevision === null) {
    return NextResponse.json({ error: "expectedActiveExclusionRevision must be a non-negative integer." }, { status: 400 });
  }
  if (!allowedActions.has(action as QuoteOverrideAction)) {
    return NextResponse.json({ error: "action must be exclude or reinstate; acceptance cannot be overridden." }, { status: 400 });
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(idempotencyKey)) {
    return NextResponse.json({ error: "idempotencyKey must be 8 to 200 URL-safe characters." }, { status: 400 });
  }
  if (reason.length < 5 || reason.length > 1000) {
    return NextResponse.json({ error: "reason must be between 5 and 1000 characters." }, { status: 400 });
  }
  if (evidenceUrl === undefined) {
    return NextResponse.json({ error: "evidenceUrl must be an http(s) URL when supplied." }, { status: 400 });
  }

  try {
    const override = await persistQuoteOverrideAction({
      quoteId,
      action: action as QuoteOverrideAction,
      expectedActiveExclusionRevision,
      idempotencyKey,
      reason,
      evidenceUrl,
      actorEmail: user.email,
    });
    clearPageLoadCache();
    return NextResponse.json(
      {
        override: toAcceptanceAuditRecord(override),
        currentExclusionRevision: override.action === "exclude" && override.active ? override.revision : 0,
      },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof QuoteOverrideConflictError) {
      return NextResponse.json({ error: error.message, currentRevision: error.currentRevision }, { status: 409 });
    }
    if (error instanceof QuoteOverrideIdempotencyConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json({ error: errorMessage(error, "Unable to persist quote override.") }, { status: 400 });
  }
}

export function quoteOverrideHistoryResponse(quoteId: number, history: QuoteOverrideRecord[], canWrite: boolean) {
  return {
    quoteId,
    history: history.map(toAcceptanceAuditRecord),
    currentExclusionRevision: currentActiveExclusionRevision(history),
    canWrite,
  };
}

function toAcceptanceAuditRecord(record: Awaited<ReturnType<typeof getQuoteOverrideHistory>>[number] | Awaited<ReturnType<typeof persistQuoteOverrideAction>>) {
  const requestedEffect = record.outcome === "excluded"
    ? "excluded"
    : record.outcome === "manual_reinstated"
      ? "reinstated"
    : record.outcome === "won"
      ? "legacy_accept"
      : "legacy_not_accept";
  return {
    id: record.id,
    quoteId: record.quoteId,
    reason: record.reason,
    evidenceUrl: record.evidenceUrl,
    actorEmail: record.actorEmail,
    revision: record.revision,
    active: record.active,
    createdAt: record.createdAt,
    supersededAt: record.supersededAt,
    action: record.action,
    requestedEffect,
    effective: requestedEffect === "excluded" && record.active,
  };
}

function hasOperatorRole(user: Awaited<ReturnType<typeof getCurrentUser>>) {
  try {
    assertRole(user, ["admin", "operator"]);
    return true;
  } catch {
    return false;
  }
}

export function canReadQuoteOverrideHistory(user: CurrentUser) {
  try {
    assertRole(user, ["admin", "finance", "operator"]);
    return true;
  } catch {
    return false;
  }
}

function positiveInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeInteger(value: unknown) {
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

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
