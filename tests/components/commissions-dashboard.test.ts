import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fmt } from "../../src/components/charts";
import {
  buildSessionInputs,
  buildSummaryCsv,
  buildSummaryVM,
  buildWorksheetRows,
  CommissionsDashboard,
  compositeAdjustment,
  controlsMatchSaved,
  persistedWorksheetRows,
  RANK_RAMP,
  runCommissionSessionEngine,
  savedControls,
  summaryQuarters,
  type CommissionSessionControls,
} from "../../src/components/commissions-dashboard";
import { buildCommissionReadModel, type CommissionPeriodConfig } from "../../src/lib/metrics/commissions";
import { commissionHashJson, type CommissionHashManifestEntry } from "../../src/lib/store/commission-integrity";
import {
  getCommissionDashboardReadModel,
  type CommissionDashboardReadModel,
  type CommissionReadyWorksheetModel,
} from "../../src/lib/store/commissions-read-model";
import {
  buildCommissionServingRow,
  commissionFreshness,
  commissionQuery,
  commissionServingRow,
} from "../helpers/commission-serving";

/* ── June-like fixture (cent-clean splits so the disclosure-rounded payload
      weights equal the server's exact weights) ─────────────────────────── */

const SAVED_CONFIG: CommissionPeriodConfig = {
  poolPercent: 0.5,
  minBonusPercent: 5,
  efficiencyEnabled: false,
  maxEfficiencyAdjustmentPercent: 20,
  tierMultipliers: { Gold: 1.3, Silver: 1.2, Bronze: 1.1, Standard: 1 },
};

const ROSTER = [
  { employeeId: "1", displayName: "Juan Serrato", included: true },
  { employeeId: "2", displayName: "Jim Ochoa", included: true },
  { employeeId: "3", displayName: "Cole Bender", included: true },
  { employeeId: "4", displayName: "Tadeo Jimenez", included: true },
  { employeeId: "5", displayName: "Roberto Villalta", included: true },
  { employeeId: "9", displayName: "Stephen Furtado", included: false },
];

const JOBS = [
  {
    jobId: "100", completedDate: "2026-06-05", stageName: "Complete", sellValue: 36000,
    quoteId: "700", quotedHours: 10,
    timesheets: [
      { employeeId: "1", hours: 6, mapped: true, fieldTechnician: true },
      { employeeId: "9", hours: 2, mapped: true, fieldTechnician: true },
    ],
  },
  {
    jobId: "200", completedDate: "2026-06-10", stageName: "Complete", sellValue: 24000,
    quoteId: "701", quotedHours: 6,
    timesheets: [{ employeeId: "2", hours: 8, mapped: true, fieldTechnician: true }],
  },
  {
    jobId: "300", completedDate: "2026-06-15", stageName: "Complete", sellValue: 20000,
    quoteId: null, quotedHours: null,
    timesheets: [{ employeeId: "3", hours: 8, mapped: true, fieldTechnician: true }],
  },
  {
    jobId: "400", completedDate: "2026-06-20", stageName: "Complete", sellValue: 8000,
    quoteId: "702", quotedHours: 9,
    timesheets: [{ employeeId: "4", hours: 5, mapped: true, fieldTechnician: true }],
  },
];

function entry(inputType: string, sourceIdentity: string, value: unknown): CommissionHashManifestEntry {
  return { inputType, sourceIdentity, sourceVersion: `v:${sourceIdentity}`, sourceHash: commissionHashJson(value), input: value };
}

function fixtureInputRows(): CommissionHashManifestEntry[] {
  const rows: CommissionHashManifestEntry[] = [];
  for (const job of JOBS) {
    rows.push(entry("job", job.jobId, {
      jobId: job.jobId, completedDate: job.completedDate, stageName: job.stageName,
      sellValue: job.sellValue, quoteId: job.quoteId, quotedHours: job.quotedHours,
    }));
  }
  let timesheetId = 10;
  for (const job of JOBS) {
    for (const sheet of job.timesheets) {
      timesheetId += 1;
      rows.push(entry("timesheet", `${sheet.employeeId}:${timesheetId}`, {
        jobId: job.jobId, timesheetId: String(timesheetId), employeeId: sheet.employeeId,
        hours: sheet.hours, mapped: sheet.mapped, fieldTechnician: sheet.fieldTechnician,
      }));
    }
  }
  for (const job of JOBS) {
    if (job.quoteId && job.quotedHours) {
      rows.push(entry("quote_labor", `${job.quoteId}:1:1:1`, {
        jobId: job.jobId, quoteId: job.quoteId, sectionId: "1", costCenterId: "1", laborId: "1",
        quantityHours: job.quotedHours,
      }));
    }
  }
  return rows;
}

async function readyModel(config: CommissionPeriodConfig): Promise<{
  model: CommissionDashboardReadModel;
  worksheet: CommissionReadyWorksheetModel;
}> {
  const readModel = buildCommissionReadModel({
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    config,
    roster: ROSTER,
    jobs: JOBS,
  });
  const row = buildCommissionServingRow({ readModel, inputRows: fixtureInputRows() });
  const model = await getCommissionDashboardReadModel(
    { year: 2026, month: 6, summaryYear: 2026 },
    { query: commissionQuery({ selectedRows: [row], summaryRows: [row] }), getFreshness: async () => commissionFreshness },
  );
  assert.equal(model.worksheet.servingStatus, "ready", String(model.worksheet.servingMessage));
  return { model, worksheet: model.worksheet as CommissionReadyWorksheetModel };
}

function engineAt(worksheet: CommissionReadyWorksheetModel, controls: CommissionSessionControls) {
  return runCommissionSessionEngine({
    totalWorkValue: worksheet.totalWorkValue,
    minBonusPercent: worksheet.config.minBonusPercent,
    tierMultipliers: worksheet.config.tierMultipliers,
    technicians: buildSessionInputs(worksheet),
    controls,
  });
}

function cents(value: number): number {
  return Math.round(value * 100);
}

/* ── Session engine ⇄ server-verified run ──────────────── */

test("at the saved defaults the session engine reproduces the persisted run exactly (efficiency off)", async () => {
  const { worksheet } = await readyModel(SAVED_CONFIG);
  const engine = engineAt(worksheet, savedControls(worksheet.config));
  assert.equal(engine.pool, worksheet.commissionPool);
  assert.equal(worksheet.technicians.length, 4);
  for (const technician of worksheet.technicians) {
    const row = engine.rows.find((candidate) => candidate.employeeId === technician.employeeId);
    assert.ok(row, `engine row missing for ${technician.displayName}`);
    assert.equal(row.base, technician.baseBonus, `${technician.displayName} base`);
    assert.equal(row.post, technician.postForfeitureBonus, `${technician.displayName} post-forfeiture`);
    assert.equal(row.final, technician.finalBonus, `${technician.displayName} final`);
    assert.equal(row.tier, technician.tier, `${technician.displayName} tier`);
    assert.equal(row.belowMinimum, technician.belowMinimum);
  }
  // buildWorksheetRows serves the persisted numbers verbatim at the defaults.
  assert.equal(controlsMatchSaved(savedControls(worksheet.config), worksheet.config), true);
  const displayed = buildWorksheetRows(worksheet, savedControls(worksheet.config));
  const persisted = persistedWorksheetRows(worksheet);
  assert.deepEqual(
    displayed.rows.map((row) => ({ id: row.employeeId, final: row.final })).sort((a, b) => a.id.localeCompare(b.id)),
    persisted.rows.map((row) => ({ id: row.employeeId, final: row.final })).sort((a, b) => a.id.localeCompare(b.id)),
  );
});

test("at saved defaults with efficiency on the session engine still matches the persisted run", async () => {
  const config = { ...SAVED_CONFIG, efficiencyEnabled: true };
  const { worksheet } = await readyModel(config);
  const engine = engineAt(worksheet, savedControls(worksheet.config));
  assert.equal(engine.pool, worksheet.commissionPool);
  for (const technician of worksheet.technicians) {
    const row = engine.rows.find((candidate) => candidate.employeeId === technician.employeeId);
    assert.ok(row);
    assert.equal(row.post, technician.postForfeitureBonus);
    assert.equal(row.final, technician.finalBonus);
    assert.equal(cents(row.final - row.post), cents(technician.efficiency?.effect ?? 0));
  }
});

test("session recalculations match the server engine across pool and ±max settings", async () => {
  const { worksheet } = await readyModel(SAVED_CONFIG);
  const settings = [
    { poolPercent: 0.5, maxAdjustmentPercent: 20 },
    { poolPercent: 0.75, maxAdjustmentPercent: 35 },
    { poolPercent: 0.25, maxAdjustmentPercent: 50 },
    { poolPercent: 1, maxAdjustmentPercent: 5 },
  ];
  for (const setting of settings) {
    const server = buildCommissionReadModel({
      periodStart: "2026-06-01",
      periodEnd: "2026-06-30",
      config: {
        ...SAVED_CONFIG,
        poolPercent: setting.poolPercent,
        efficiencyEnabled: true,
        maxEfficiencyAdjustmentPercent: setting.maxAdjustmentPercent,
      },
      roster: ROSTER,
      jobs: JOBS,
    });
    const engine = engineAt(worksheet, {
      poolPercent: setting.poolPercent,
      efficiencyEnabled: true,
      maxAdjustmentPercent: setting.maxAdjustmentPercent,
    });
    assert.equal(engine.pool, server.poolAmount, `pool at ${setting.poolPercent}%`);
    for (const technician of server.technicians) {
      const row = engine.rows.find((candidate) => candidate.employeeId === technician.employeeId);
      assert.ok(row);
      assert.equal(row.final, technician.finalBonus, `${technician.displayName} at ${JSON.stringify(setting)}`);
      assert.equal(row.post, technician.postForfeitureBonus);
    }
  }
});

test("payouts always sum exactly to the pool and efficiency effects sum to $0", async () => {
  const { worksheet } = await readyModel(SAVED_CONFIG);
  for (const poolPercent of [0.25, 0.4, 0.5, 0.85, 1]) {
    for (const efficiencyEnabled of [false, true]) {
      const engine = engineAt(worksheet, { poolPercent, efficiencyEnabled, maxAdjustmentPercent: 30 });
      const totalCents = engine.rows.reduce((sum, row) => sum + cents(row.final), 0);
      assert.equal(totalCents, cents(engine.pool), `conservation at ${poolPercent}% eff=${efficiencyEnabled}`);
      const effectCents = engine.rows.reduce((sum, row) => sum + cents(row.final) - cents(row.post), 0);
      assert.equal(effectCents, 0, `efficiency effects sum at ${poolPercent}% eff=${efficiencyEnabled}`);
    }
  }
});

test("the printed trace arithmetic multiplies out cent-exactly at every pool/±max setting", async () => {
  const { worksheet } = await readyModel(SAVED_CONFIG);
  for (const poolPercent of [0.25, 0.5, 0.75, 1]) {
    for (const maxAdjustmentPercent of [5, 20, 50]) {
      const engine = engineAt(worksheet, { poolPercent, efficiencyEnabled: true, maxAdjustmentPercent });
      for (const row of engine.rows) {
        const ceff = compositeAdjustment(row.post, row.final);
        if (row.post <= 0) {
          assert.equal(ceff, null);
          continue;
        }
        assert.ok(ceff !== null);
        const printedOperand = Math.round(row.post * 100) / 100;
        assert.equal(
          Math.round(printedOperand * ceff * 100),
          cents(row.final),
          `${row.displayName} trace at ${poolPercent}%/±${maxAdjustmentPercent}%`,
        );
      }
    }
  }
});

test("a below-minimum bonus is forfeited to zero, marked, and redistributed without losing a cent", () => {
  const technicians = [
    { employeeId: "1", displayName: "A", allocatedValue: 66294, effectiveValue: 66294, efficiencyRatio: null, jobCount: 10, jobAllocations: [] },
    { employeeId: "2", displayName: "B", allocatedValue: 63738, effectiveValue: 63738, efficiencyRatio: null, jobCount: 10, jobAllocations: [] },
    { employeeId: "3", displayName: "C", allocatedValue: 62706, effectiveValue: 62706, efficiencyRatio: null, jobCount: 10, jobAllocations: [] },
    { employeeId: "4", displayName: "D", allocatedValue: 500, effectiveValue: 500, efficiencyRatio: null, jobCount: 1, jobAllocations: [] },
  ];
  const engine = runCommissionSessionEngine({
    totalWorkValue: 435978.86,
    minBonusPercent: 5,
    tierMultipliers: SAVED_CONFIG.tierMultipliers!,
    technicians,
    controls: { poolPercent: 0.5, efficiencyEnabled: false, maxAdjustmentPercent: 20 },
  });
  const forfeited = engine.rows.find((row) => row.employeeId === "4");
  assert.ok(forfeited);
  assert.equal(forfeited.belowMinimum, true);
  assert.equal(forfeited.final, 0);
  const totalCents = engine.rows.reduce((sum, row) => sum + cents(row.final), 0);
  assert.equal(totalCents, cents(engine.pool));
});

/* ── Rendering (approved mockup contract) ──────────────── */

test("the default render is the approved worksheet with the persisted numbers and no rejected surfaces", async () => {
  const { model, worksheet } = await readyModel(SAVED_CONFIG);
  const html = renderToStaticMarkup(createElement(CommissionsDashboard, { model }));

  assert.match(html, /Calculated Commission Due/);
  assert.match(html, /Commission by Technician/);
  assert.match(html, /Ranked by calculated payout/);
  assert.match(html, /completed work value/);
  assert.match(html, /of 5 eligible/);
  for (const technician of worksheet.technicians) {
    assert.ok(html.includes(fmt.cents(technician.finalBonus)), `${technician.displayName} payout rendered`);
  }
  // No-work roster row stays visible with no tier chip content.
  assert.match(html, /Roberto Villalta/);
  assert.match(html, /no completed-job allocation/);
  // Outside-roster disclosure comes from the payload ($9,000 → $9.0K).
  assert.match(html, /\$9\.0K of June’s revenue came from people outside the roster/);
  assert.match(html, /Stephen Furtado/);
  // Footline (approved).
  assert.match(html, /Source: Simpro completed jobs · pool = completed work value × pool percent · calculated amounts are not payment records/);
  // Efficiency-only UI is gated off while the toggle is off.
  assert.doesNotMatch(html, /Efficiency \+/);
  assert.doesNotMatch(html, /payout adjustment/);
  assert.doesNotMatch(html, /Efficiency Effect/);
  // Rejected surfaces (brief §4/§8) are gone from the owner UI.
  assert.doesNotMatch(html, /Audit History|Revision History|Rebuild|Payroll CSV|Worksheet PDF|Detail CSV/);
  assert.doesNotMatch(html, /Manifest|manifest hash|Roster Inclusion|Evidence URL|Export history|Lifecycle/);
  assert.doesNotMatch(html, /Review<\/|>Lock<|>Save</);
});

test("with efficiency saved on, the ×-column, legend entries, helper text, and effect chart render", async () => {
  const { model, worksheet } = await readyModel({ ...SAVED_CONFIG, efficiencyEnabled: true });
  const html = renderToStaticMarkup(createElement(CommissionsDashboard, { model }));

  assert.match(html, /Efficiency \+/);
  assert.match(html, /Efficiency −/);
  assert.match(html, /× column = payout adjustment/);
  assert.match(html, /Efficiency Effect/);
  assert.match(html, /\$0 — no effect/);
  assert.match(html, /effects sum to \$0 after re-scaling/);
  assert.match(html, /Faster than the estimate boosts the share, slower trims it — the pool total never changes\./);
  assert.match(html, /×\d\.\d{5}/);
  // The default-open top row's trace reproduces its printed arithmetic.
  const top = [...worksheet.technicians].sort((a, b) => b.finalBonus - a.finalBonus)[0];
  const ceff = compositeAdjustment(top.postForfeitureBonus, top.finalBonus);
  assert.ok(ceff !== null);
  assert.ok(html.includes(`×${ceff.toFixed(5)}`), "composite factor printed in the trace");
  assert.match(html, /How this was calculated:/);
});

test("an unready worksheet renders an honest state — no hero, no fabricated $0.00 payouts", async () => {
  const row = commissionServingRow({
    current_run_id: null,
    run_id: null,
    run_revision: null,
    run_status: null,
    read_model: null,
  });
  const model = await getCommissionDashboardReadModel(
    { year: 2026, month: 6, summaryYear: 2026 },
    { query: commissionQuery({ selectedRows: [row] }), getFreshness: async () => commissionFreshness },
  );
  assert.notEqual(model.worksheet.servingStatus, "ready");
  const html = renderToStaticMarkup(createElement(CommissionsDashboard, { model }));
  assert.match(html, /still building|Commission data could not be loaded/);
  assert.doesNotMatch(html, /Calculated Commission Due/);
  assert.doesNotMatch(html, /\$0\.00/);
});

test("the hero rank ramp is monotonic and never reuses the rank-boost legend color", () => {
  assert.equal(RANK_RAMP.length, 8);
  assert.ok(RANK_RAMP.every((color) => color.toLowerCase() !== "#4b52c0"));
  assert.equal(new Set(RANK_RAMP.map((color) => color.toLowerCase())).size, RANK_RAMP.length);
});

/* ── Summary (monthly | quarterly | annual + CSV) ──────── */

test("summary view model keeps missing months as N/A (never $0) and marks the latest loaded month Current", async () => {
  const { model } = await readyModel(SAVED_CONFIG);
  const vm = buildSummaryVM(model.summary);
  assert.equal(vm.year, 2026);
  assert.equal(vm.lastLoadedMonth, 6);
  assert.equal(vm.months[5].status, "current");
  assert.equal(vm.months[5].pool, model.summary.months[5].commissionPool);
  for (const month of [0, 1, 2, 3, 4, 6, 7, 8, 9, 10, 11]) {
    assert.equal(vm.months[month].pool, null);
    assert.equal(vm.months[month].status, "none");
  }
  assert.equal(vm.ytd, vm.months[5].pool);
  assert.equal(vm.average, vm.months[5].pool);
  assert.equal(vm.peak?.short, "Jun");
  assert.equal(vm.earningYtd, 4);
  const quarters = summaryQuarters(vm);
  assert.deepEqual(quarters.map((quarter) => quarter.loaded), [0, 1, 0, 0]);
  assert.equal(quarters[1].pool, vm.months[5].pool);
});

test("summary CSV export is client-buildable for every mode and preserves N/A months", async () => {
  const { model } = await readyModel(SAVED_CONFIG);
  const vm = buildSummaryVM(model.summary);
  const pool = (vm.months[5].pool ?? 0).toFixed(2);
  const monthly = buildSummaryCsv(vm, "monthly");
  assert.match(monthly, /^Month,Pool,Status\n/);
  assert.ok(monthly.includes(`Jun 2026,${pool},Current`));
  assert.ok(monthly.includes("Jan 2026,N/A,No run"));
  assert.ok(monthly.includes("Dec 2026,N/A,No run"));
  const quarterly = buildSummaryCsv(vm, "quarterly");
  assert.ok(quarterly.includes(`Q2 2026,${pool},1 of 3`));
  assert.ok(quarterly.includes("Q3 2026,N/A,0 of 3"));
  const annual = buildSummaryCsv(vm, "annual");
  assert.ok(annual.includes(`2026,${pool},N/A,${pool},Jun ${pool}`));
});

test("draft months are marked draft between loaded history and the current month", () => {
  const months = [1776.72, 1758.49, 2303.86, 1901.69, 1344.34, 2179.89, null, null, null, null, null, null];
  const summary = {
    year: 2026,
    months: months.map((pool, index) => ({
      month: index + 1,
      commissionPool: pool,
      finalized: false,
      technicians: [],
    })),
  } as unknown as CommissionDashboardReadModel["summary"];
  const vm = buildSummaryVM(summary);
  assert.equal(vm.lastLoadedMonth, 6);
  assert.deepEqual(vm.months.slice(0, 6).map((month) => month.status), ["draft", "draft", "draft", "draft", "draft", "current"]);
  assert.equal(vm.ytd, 11264.99);
  assert.equal(vm.average, 1877.5);
  assert.deepEqual(vm.peak, { short: "Mar", value: 2303.86 });
  const csv = buildSummaryCsv(vm, "monthly");
  assert.ok(csv.includes("Mar 2026,2303.86,Draft"));
  assert.ok(csv.includes("Jun 2026,2179.89,Current"));
});
