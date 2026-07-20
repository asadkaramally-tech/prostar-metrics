import assert from "node:assert/strict";
import test from "node:test";
import { buildCommissionReadModel } from "../../src/lib/metrics/commissions";
import {
  buildCommissionExportGate,
  buildCommissionSummary,
} from "../../src/lib/store/commissions-read-model";
import { commissionHashJson, type CommissionHashManifestEntry } from "../../src/lib/store/commission-integrity";
import { buildCommissionServingRow } from "../helpers/commission-serving";

function row(month: number, pool: number, technicians: Array<{ id: string; name: string; bonus: number; payroll?: number }>, status?: "draft" | "reviewed" | "exported" | "locked") {
  const periodStart = `2026-${String(month).padStart(2, "0")}-01`;
  const periodEnd = new Date(Date.UTC(2026, month, 0)).toISOString().slice(0, 10);
  const totalWorkValue = pool * 200;
  const config = {
    poolPercent: 0.5, minBonusPercent: 5, efficiencyEnabled: false,
    maxEfficiencyAdjustmentPercent: 20,
    tierMultipliers: { Gold: 1.3, Silver: 1.2, Bronze: 1.1, Standard: 1 },
  };
  const typedOverrides = technicians.flatMap((technician) => {
    const outside = (technician.payroll ?? technician.bonus) - technician.bonus;
    return [
      { employeeId: technician.id, field: "final_bonus" as const, value: technician.bonus, reason: "Approved summary fixture.", poolTreatment: "inside_pool" as const },
      ...(outside === 0 ? [] : [{ employeeId: technician.id, field: "outside_pool_adjustment" as const, value: outside, reason: "Approved summary fixture.", poolTreatment: "outside_pool" as const }]),
    ];
  });
  const readModel = buildCommissionReadModel({
    periodStart, periodEnd, config,
    roster: technicians.map((technician) => ({ employeeId: technician.id, displayName: technician.name, included: true })),
    jobs: [{
      jobId: String(month * 100), completedDate: periodStart, stageName: "Complete", sellValue: totalWorkValue,
      quoteId: null, quotedHours: null,
      timesheets: technicians.map((technician) => ({ employeeId: technician.id, hours: 1, mapped: true, fieldTechnician: true })),
    }],
    overrides: typedOverrides,
  });
  const overrideRows = typedOverrides.map((override, index) => ({
    period_id: String(month), employee_id: override.employeeId, field_name: override.field,
    before_value: null, after_value: override.value, value_type: "number", reason: override.reason,
    evidence_url: null, actor_email: "finance@example.test", pool_treatment: override.poolTreatment,
    revision: 1, id: String(4000 + index), active: true,
    created_at: "2026-07-01T00:00:00Z", lineage_depth: 0,
  })).sort((left, right) => left.employee_id.localeCompare(right.employee_id, undefined, { numeric: true })
    || left.field_name.localeCompare(right.field_name));
  const inputRows: CommissionHashManifestEntry[] = [
    manifestInput("job", String(month * 100), { jobId: String(month * 100), completedDate: periodStart, stageName: "Complete", sellValue: totalWorkValue, quoteId: null, quotedHours: null }),
    ...technicians.map((technician, index) => manifestInput("timesheet", `${technician.id}:t${index}`, {
      jobId: String(month * 100), timesheetId: String(index + 1), employeeId: technician.id, hours: 1, mapped: true, fieldTechnician: true,
    })),
    ...overrideRows.map((override) => manifestInput("override", override.id, override)),
  ];
  return buildCommissionServingRow({
    readModel: readModel as never,
    inputRows,
    overrides: {
      period_id: String(month), current_run_id: String(month + 10), run_id: String(month + 10),
      status: status ?? (month === 1 ? "locked" : "reviewed"), revision: 1, edit_revision: 2,
    },
  });
}

function manifestInput(inputType: string, sourceIdentity: string, value: unknown): CommissionHashManifestEntry {
  return { inputType, sourceIdentity, sourceVersion: `v:${sourceIdentity}`, sourceHash: commissionHashJson(value), input: value };
}

test("monthly, quarterly, and annual summaries exclude missing months from averages and reconcile team totals", () => {
  const summary = buildCommissionSummary(2026, [
    row(1, 100, [{ id: "1", name: "Alex", bonus: 60 }, { id: "2", name: "Jordan", bonus: 40 }]),
    row(3, 300, [{ id: "1", name: "Alex", bonus: 180 }, { id: "2", name: "Jordan", bonus: 120, payroll: 130 }]),
  ] as never);
  assert.equal(summary.loadedFinalizedMonths, 2);
  assert.equal(summary.totalAnnualPool, 400);
  assert.equal(summary.averageMonthlyPool, 200, "missing February is not zero-filled");
  assert.deepEqual(summary.peakMonth, { label: "Mar 2026", value: 300 });
  assert.equal(summary.months[1].commissionPool, null);
  assert.equal(summary.quarters[0].commissionPool, 400);
  assert.equal(summary.quarters[0].loadedMonths, 2);
  assert.equal(summary.annual.reconciles, true);
  assert.equal(summary.annual.technicians[0].trend.length, 12);
  assert.equal(summary.annual.technicians[0].trend[1], null);
  assert.equal(summary.annual.payrollTotal, 410);
});

test("draft monthly runs are visible but excluded from finalized annual totals", () => {
  const summary = buildCommissionSummary(2026, [
    row(1, 100, [{ id: "1", name: "Alex", bonus: 100 }], "locked"),
    row(6, 2179.89, [{ id: "1", name: "Alex", bonus: 2179.89 }], "draft"),
  ] as never);

  assert.equal(summary.months[5].status, "draft");
  assert.equal(summary.months[5].finalized, false);
  assert.equal(summary.months[5].payrollTotal, 2179.89);
  assert.equal(summary.loadedFinalizedMonths, 1);
  assert.equal(summary.totalAnnualPool, 100);
  assert.equal(summary.averageMonthlyPool, 100);
  assert.deepEqual(summary.peakMonth, { label: "Jan 2026", value: 100 });
  assert.equal(summary.annual.payrollTotal, 100);
});

test("loaded finalized months without a technician result count as zero while missing months remain N/A", () => {
  const summary = buildCommissionSummary(2026, [
    row(1, 100, [{ id: "1", name: "Alex", bonus: 100 }]),
    row(2, 100, [{ id: "2", name: "Jordan", bonus: 100 }]),
  ] as never);
  const alex = summary.annual.technicians.find((technician) => technician.employeeId === "1");
  const jordan = summary.annual.technicians.find((technician) => technician.employeeId === "2");
  assert.equal(alex?.averageBonus, 50, "average includes every loaded finalized month");
  assert.equal(jordan?.averageBonus, 50, "average includes loaded months before the first result");
  assert.deepEqual(alex?.trend.slice(0, 3), [100, 0, null]);
  assert.deepEqual(jordan?.trend.slice(0, 3), [0, 100, null]);
});

test("an empty summary year remains N/A and does not claim reconciliation", () => {
  const summary = buildCommissionSummary(2026, []);
  assert.equal(summary.totalAnnualPool, null);
  assert.equal(summary.averageMonthlyPool, null);
  assert.equal(summary.peakMonth, null);
  assert.equal(summary.activeTechnicians, null);
  assert.equal(summary.annual.commissionPool, null);
  assert.equal(summary.annual.reconciles, null);
  assert.match(summary.diagnostics.join(" "), /reconciliation is N\/A/i);
  assert.doesNotMatch(summary.diagnostics.join(" "), /totals reconcile to/i);
});

test("the client export gate mirrors current-run, provenance, status, source, and invariant checks", () => {
  const exportable = buildCommissionExportGate({
    periodStatus: "reviewed",
    calculationStale: false,
    currentRunId: "91",
    runId: "91",
    runStatus: "succeeded",
    sourceComplete: true,
    inputManifestHash: "manifest",
    sourceHash: "source",
    configHash: "config",
    periodOverrideHash: "override",
    runOverrideHash: "override",
    invariants: {
      insidePoolReconciles: true,
      outsidePoolReconciles: true,
      jobAllocationsReconcile: true,
      unsupportedJobsUnallocated: true,
      forfeitureReconciles: true,
      efficiencyReconciles: true,
      nonnegativePayroll: true,
    },
  });
  assert.deepEqual(exportable, { allowed: true, reason: null, reasons: [] });

  const blocked = buildCommissionExportGate({
    periodStatus: "draft",
    calculationStale: true,
    currentRunId: "92",
    runId: "91",
    runStatus: "failed",
    sourceComplete: false,
    inputManifestHash: null,
    sourceHash: null,
    configHash: null,
    periodOverrideHash: "new-override",
    runOverrideHash: "old-override",
    invariants: {
      insidePoolReconciles: false,
      outsidePoolReconciles: true,
      jobAllocationsReconcile: true,
      unsupportedJobsUnallocated: true,
      forfeitureReconciles: true,
      efficiencyReconciles: true,
      nonnegativePayroll: false,
    },
  });
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reasons.join(" "), /current immutable calculation run/i);
  assert.match(blocked.reasons.join(" "), /stale/i);
  assert.match(blocked.reasons.join(" "), /source evidence is incomplete/i);
  assert.match(blocked.reasons.join(" "), /status draft/i);
  assert.match(blocked.reasons.join(" "), /provenance hashes/i);
  assert.match(blocked.reasons.join(" "), /override revision/i);
  assert.match(blocked.reasons.join(" "), /do not reconcile/i);
  assert.match(blocked.reasons.join(" "), /negative payout/i);
});
