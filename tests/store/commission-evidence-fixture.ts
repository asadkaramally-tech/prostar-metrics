import type {
  CommissionEvidenceUnit,
  CommissionEvidenceUnitKey,
  CommissionSourceEvidence,
} from "../../src/lib/store/commission-rebuild";

function unit(overrides: Partial<CommissionEvidenceUnit> = {}): CommissionEvidenceUnit {
  return {
    status: "complete",
    required: true,
    rowCount: 1,
    identities: ["evidence-1"],
    detail: {},
    ...overrides,
  };
}

export function completeCommissionSourceEvidence(params: {
  efficiencyEnabled?: boolean;
  quoteStatus?: CommissionEvidenceUnit["status"];
} = {}): CommissionSourceEvidence {
  const requiredScopes = params.efficiencyEnabled ? ["jobs", "technicians", "quotes"] : ["jobs", "technicians"];
  const units = Object.fromEntries(([
    "completedJobs",
    "timesheets",
    "peopleFieldMapping",
    "roster",
    "config",
    "overrides",
    "quoteLabor",
    "backfill",
    "reconciliation",
  ] satisfies CommissionEvidenceUnitKey[]).map((key) => [key, unit()])) as Record<CommissionEvidenceUnitKey, CommissionEvidenceUnit>;
  units.quoteLabor = unit({
    status: params.quoteStatus ?? "complete",
    required: params.efficiencyEnabled ?? false,
  });
  units.reconciliation.detail = { requiredScopes };
  return {
    schemaVersion: 2,
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    status: "complete",
    complete: true,
    units,
    matchedReconciliations: requiredScopes.map((scope, index) => ({
      scope,
      id: String(index + 1),
      hash: String(index + 1).repeat(64),
    })),
  };
}
