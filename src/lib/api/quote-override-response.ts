import {
  currentActiveExclusionRevision,
  type QuoteOverrideRecord,
} from "@/lib/store/quote-overrides";
import { assertRole, type CurrentUser } from "@/lib/auth/roles";

export function hasQuoteOverrideOperatorRole(user: CurrentUser) {
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

export function quoteOverrideHistoryResponse(quoteId: number, history: QuoteOverrideRecord[], canWrite: boolean) {
  return {
    quoteId,
    history: history.map(toAcceptanceAuditRecord),
    currentExclusionRevision: currentActiveExclusionRevision(history),
    canWrite,
  };
}

export function toAcceptanceAuditRecord(record: QuoteOverrideRecord) {
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
