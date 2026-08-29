import assert from "node:assert/strict";
import test from "node:test";
import type { AppRole, CurrentUser } from "../../src/lib/auth/roles";
import {
  canReadQuoteOverrideHistory,
  quoteOverrideHistoryResponse,
} from "../../src/lib/api/quote-override-response";
import type { QuoteOverrideRecord } from "../../src/lib/store/quote-overrides";

test("quote override history GET access includes operators who can write actions", () => {
  assert.equal(canReadQuoteOverrideHistory(userWithRole("admin")), true);
  assert.equal(canReadQuoteOverrideHistory(userWithRole("finance")), true);
  assert.equal(canReadQuoteOverrideHistory(userWithRole("operator")), true);
  assert.equal(canReadQuoteOverrideHistory(userWithRole("viewer")), false);
  assert.equal(canReadQuoteOverrideHistory(userWithRole()), false);
});

test("quote override history API reports only the active exclusion revision as writable", () => {
  const legacyHistory: QuoteOverrideRecord[] = [
    overrideRecord({ id: 17, outcome: "won", revision: 7, active: true }),
    overrideRecord({ id: 16, outcome: "lost", revision: 6, active: false }),
  ];

  const beforeExclusion = quoteOverrideHistoryResponse(700, legacyHistory, true);
  assert.equal(beforeExclusion.currentExclusionRevision, 0);
  assert.deepEqual(beforeExclusion.history.map((record) => record.requestedEffect), ["legacy_accept", "legacy_not_accept"]);

  const afterExclusion = quoteOverrideHistoryResponse(700, [
    ...legacyHistory,
    overrideRecord({ id: 18, outcome: "excluded", revision: 1, active: true }),
  ], true);
  assert.equal(afterExclusion.currentExclusionRevision, 1);
  assert.equal(afterExclusion.history.at(-1)?.effective, true);

  const afterReinstatement = quoteOverrideHistoryResponse(700, [
    ...legacyHistory,
    overrideRecord({ id: 18, outcome: "excluded", revision: 1, active: false }),
    overrideRecord({ id: 19, outcome: "manual_reinstated", revision: 2, active: false }),
  ], true);
  assert.equal(afterReinstatement.currentExclusionRevision, 0);
  assert.equal(afterReinstatement.history.at(-1)?.requestedEffect, "reinstated");
});

function userWithRole(role?: AppRole): CurrentUser {
  return {
    email: "quote-user@example.test",
    displayName: "Quote User",
    roles: role ? [role] : [],
  };
}

function overrideRecord(
  values: Pick<QuoteOverrideRecord, "id" | "outcome" | "revision" | "active">,
): QuoteOverrideRecord {
  return {
    quoteId: 700,
    action: values.outcome === "excluded"
      ? "exclude"
      : values.outcome === "manual_reinstated"
        ? "reinstate"
        : null,
    previousOutcome: "unknown",
    reason: "Migration 017 reviewed quote decision.",
    evidenceUrl: null,
    actorEmail: "legacy-reviewer@example.test",
    createdAt: "2026-03-06T12:00:00.000Z",
    supersededAt: values.active ? null : "2026-03-07T12:00:00.000Z",
    ...values,
  };
}
