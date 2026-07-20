import assert from "node:assert/strict";
import test from "node:test";
import {
  parseCommissionOverride,
  isCommissionSourceEvidenceComplete,
  persistCommissionConfig,
  persistCommissionOverride,
  queueCommissionRebuild,
  transitionCommissionPeriod,
  validateCommissionConfig,
  type CommissionQuery,
} from "../../src/lib/store/commission-lifecycle";
import {
  commissionPayoutServingRow,
  commissionZeroUnknownPayoutOverrideRow,
} from "../helpers/commission-serving";
import { completeCommissionSourceEvidence } from "./commission-evidence-fixture";

test("commission config enforces locked pool and efficiency bounds", () => {
  assert.deepEqual(validateCommissionConfig({
    poolPercent: 0.5,
    minBonusPercent: 5,
    efficiencyEnabled: true,
    maxEfficiencyAdjustmentPercent: 20,
    tierMultipliers: { Gold: 1.4, Silver: 1.25, Bronze: 1.1, Standard: 1 },
  }), {
    poolPercent: 0.5,
    minBonusPercent: 5,
    efficiencyEnabled: true,
    maxEfficiencyAdjustmentPercent: 20,
    tierMultipliers: { Gold: 1.4, Silver: 1.25, Bronze: 1.1, Standard: 1 },
  });
  assert.throws(() => validateCommissionConfig({
    poolPercent: 0.5, minBonusPercent: 5, efficiencyEnabled: false,
    maxEfficiencyAdjustmentPercent: 20,
    tierMultipliers: { Gold: 2.1, Silver: 1.2, Bronze: 1.1, Standard: 1 },
  }), /Gold tier multiplier/);
  assert.throws(() => validateCommissionConfig({ poolPercent: 0.51, minBonusPercent: 5, efficiencyEnabled: false, maxEfficiencyAdjustmentPercent: 20 }), /0.05-point increments/);
  assert.throws(() => validateCommissionConfig({ poolPercent: 99, minBonusPercent: 5, efficiencyEnabled: false, maxEfficiencyAdjustmentPercent: 20 }), /0.25 through 1.00/);
  assert.throws(() => validateCommissionConfig({ poolPercent: 0.5, minBonusPercent: 5, efficiencyEnabled: true, maxEfficiencyAdjustmentPercent: 51 }), /5 through 50/);
});

test("source evidence validation fails closed for missing units and reconciliation hashes", () => {
  const complete = completeCommissionSourceEvidence({ efficiencyEnabled: true });
  assert.equal(isCommissionSourceEvidenceComplete(complete), true);
  complete.units.timesheets.status = "loading";
  assert.equal(isCommissionSourceEvidenceComplete(complete), false);
  complete.units.timesheets.status = "complete";
  complete.units.timesheets.required = false;
  assert.equal(isCommissionSourceEvidenceComplete(complete, { efficiencyEnabled: true }), false);
  complete.units.timesheets.required = true;
  complete.matchedReconciliations[0].hash = "not-a-hash";
  assert.equal(isCommissionSourceEvidenceComplete(complete), false);
  assert.equal(isCommissionSourceEvidenceComplete({ status: "complete", complete: true }), false);
});

test("typed commission overrides preserve field and pool semantics", () => {
  assert.deepEqual(parseCommissionOverride({ employeeId: 12, field: "included", value: false, reason: "Roster exclusion evidence." }), {
    employeeId: "12", field: "included", value: false, reason: "Roster exclusion evidence.", poolTreatment: "neutral",
  });
  assert.deepEqual(parseCommissionOverride({ employeeId: "12", field: "outside_pool_adjustment", value: "25.50", reason: "Approved payroll correction." }), {
    employeeId: "12", field: "outside_pool_adjustment", value: 25.5, reason: "Approved payroll correction.", poolTreatment: "outside_pool",
  });
  assert.throws(() => parseCommissionOverride({ employeeId: 12, field: "final_bonus", value: -1, reason: "Invalid negative lock." }), /nonnegative/);
  assert.throws(() => parseCommissionOverride({ employeeId: 12, field: "tier", value: "Platinum", reason: "Unknown tier evidence." }), /Gold, Silver, Bronze, or Standard/);
});

test("override write locks revision, supersedes active value, audits, and queues atomically", async () => {
  let sql = "";
  let values: unknown[] = [];
  const query: CommissionQuery = async <T>(text: string, params?: unknown[]) => {
    sql = text;
    values = params ?? [];
    return { rows: [{
      period_id: 41, period_start: "2026-06-01", period_end: "2026-06-30",
      revision: 2, edit_revision: 8, status: "draft", current_run_id: 91,
      calculation_stale: true, forked_from_revision: 1, current_edit_revision: 7,
      failure_reason: null, id: 501, employee_id: 12, field_name: "final_bonus",
      before_value: 100, after_value: 125, value_type: "number", pool_treatment: "inside_pool",
      reason: "Approved final payout decision.", evidence_url: null,
      actor_email: "finance@example.test", override_revision: 3, active: true,
      created_at: "2026-07-09T12:00:00Z", superseded_at: null,
    } as T], rowCount: 1 };
  };
  const result = await persistCommissionOverride({
    periodStart: "2026-06-01",
    expectedRevision: 7,
    override: parseCommissionOverride({ employeeId: 12, field: "final_bonus", value: 125, reason: "Approved final payout decision." }),
    actorEmail: "finance@example.test",
  }, query);

  assert.equal(result.period.revision, 2);
  assert.equal(result.period.editRevision, 8);
  assert.equal(result.override.beforeValue, 100);
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /t\.edit_revision = \$2/);
  assert.match(sql, /superseded_at = now\(\)/);
  assert.match(sql, /insert into metrics\.audit_events/);
  assert.match(sql, /insert into metrics\.rollup_rebuild_queue/);
  assert.match(sql, /t\.status in \('exported', 'locked'\)/);
  assert.match(sql, /insert into metrics\.commission_period_configs/);
  assert.match(sql, /join inherited_config c on c\.period_id = f\.id/);
  assert.equal(values[1], 7);
  assert.equal(values[11], "inside_pool");
});

test("manual rebuild fork inherits active config evidence atomically", async () => {
  let sql = "";
  const query: CommissionQuery = async <T>(text: string) => {
    sql = text;
    return { rows: [{
      period_id: 42, period_start: "2026-06-01", period_end: "2026-06-30",
      revision: 2, edit_revision: 8, status: "draft", current_run_id: null,
      calculation_stale: true, forked_from_revision: 1, current_edit_revision: 7,
      failure_reason: null,
    } as T], rowCount: 1 };
  };

  const period = await queueCommissionRebuild({
    periodStart: "2026-06-01",
    expectedRevision: 7,
    reason: "Rebuild with inherited configuration evidence.",
    actorEmail: "finance@example.test",
  }, query);

  assert.equal(period.forkedFromRevision, 1);
  assert.match(sql, /source_config as materialized/);
  assert.match(sql, /insert into metrics\.commission_period_configs/);
  assert.match(sql, /c\.revision = t\.config_revision/);
  assert.match(sql, /c\.config_hash, c\.actor_email, c\.created_at, true/);
  assert.match(sql, /join inherited_config c on c\.period_id = f\.id/);
});

test("config write is append-only, optimistic, audited, and rebuild-triggering", async () => {
  let sql = "";
  const query: CommissionQuery = async <T>(text: string) => {
    sql = text;
    return { rows: [{
      period_id: 44, period_start: "2026-07-01", period_end: "2026-07-31",
      revision: 1, edit_revision: 4, status: "draft", current_run_id: 100,
      calculation_stale: true, forked_from_revision: null, current_edit_revision: 3,
      failure_reason: null,
    } as T], rowCount: 1 };
  };
  const period = await persistCommissionConfig({
    periodStart: "2026-07-01", expectedRevision: 3,
    config: { poolPercent: 0.55, minBonusPercent: 5, efficiencyEnabled: true, maxEfficiencyAdjustmentPercent: 25 },
    reason: "Approved July efficiency configuration.", actorEmail: "admin@example.test",
  }, query);
  assert.equal(period.editRevision, 4);
  assert.match(sql, /commission_period_configs/);
  assert.match(sql, /active = false, superseded_at = now\(\)/);
  assert.match(sql, /commission_config_revised/);
  assert.match(sql, /rollup_rebuild_queue/);
});

test("review SQL rejects a run without structurally complete period evidence", async () => {
  const statements: string[] = [];
  const corrupt = structuredClone(commissionPayoutServingRow({ status: "draft", edit_revision: 2 }));
  const evidence = corrupt.source_evidence as { units: Record<string, { required: boolean }> };
  evidence.units.timesheets.required = false;
  const query: CommissionQuery = async <T>(text: string) => {
    statements.push(text);
    if (text.includes("pg_advisory_xact_lock") && !text.includes("with target_lock")) return { rows: [], rowCount: 1 };
    if (text.includes("period_config_source")) return { rows: [corrupt as T], rowCount: 1 };
    throw new Error("review update must not execute after failed canonical verification");
  };
  await assert.rejects(
    transitionCommissionPeriod({
      periodStart: "2026-06-01",
      expectedRevision: 2,
      action: "review",
      reason: "Review period source evidence.",
      actorEmail: "finance@example.test",
    }, query),
    /canonical integrity verification/,
  );
  assert.equal(statements.length, 2);
  assert.match(statements[1], /commission_employee_results/);
  assert.match(statements[1], /commission_run_inputs/);
  assert.match(statements[1], /for update of p/i);
});

test("lock rejects a corrupt run under the transaction lock before status update", async () => {
  const corrupt = commissionPayoutServingRow({ status: "exported", edit_revision: 4, immutable: false });
  let updateAttempted = false;
  const query: CommissionQuery = async <T>(text: string) => {
    if (text.includes("pg_advisory_xact_lock") && !text.includes("with target_lock")) return { rows: [], rowCount: 1 };
    if (text.includes("period_config_source")) return { rows: [corrupt as T], rowCount: 1 };
    updateAttempted = true;
    return { rows: [], rowCount: 0 };
  };
  await assert.rejects(
    transitionCommissionPeriod({
      periodStart: "2026-06-01", expectedRevision: 4, action: "lock",
      reason: "Lock verified exported run.", actorEmail: "finance@example.test",
    }, query),
    /canonical integrity verification/,
  );
  assert.equal(updateAttempted, false);
});

test("review and lock reject a hash-consistent zero run with an unknown employee payout override", async () => {
  for (const gate of [
    { action: "review", status: "draft", editRevision: 2 },
    { action: "lock", status: "exported", editRevision: 4 },
  ] as const) {
    const corrupt = commissionZeroUnknownPayoutOverrideRow({
      status: gate.status,
      edit_revision: gate.editRevision,
    });
    let updateAttempted = false;
    const query: CommissionQuery = async <T>(text: string) => {
      if (text.includes("pg_advisory_xact_lock") && !text.includes("with target_lock")) return { rows: [], rowCount: 1 };
      if (text.includes("period_config_source")) return { rows: [corrupt as T], rowCount: 1 };
      updateAttempted = true;
      return { rows: [], rowCount: 0 };
    };
    await assert.rejects(
      transitionCommissionPeriod({
        periodStart: "2026-06-01",
        expectedRevision: gate.editRevision,
        action: gate.action,
        reason: `${gate.action} semantically verified zero run.`,
        actorEmail: "finance@example.test",
      }, query),
      /unknown employee 404/,
    );
    assert.equal(updateAttempted, false);
  }
});
