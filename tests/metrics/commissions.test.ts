import assert from "node:assert/strict";
import test from "node:test";
import {
  allocateCommissionPool,
  allocateLargestRemainder,
  buildCommissionReadModel,
  calculateCommissionPool,
  calculateCommissionPoolFromPercent,
  CommissionCalculationError,
  efficiencyMultiplier,
  type CommissionJobInput,
  type CommissionOverrideInput,
  type CommissionPeriodConfig,
  type CommissionReadModel,
  type CommissionRosterEntry,
} from "../../src/lib/metrics/commissions";

const periodStart = "2026-06-01";
const periodEnd = "2026-06-30";
const defaultConfig: CommissionPeriodConfig = {
  poolPercent: 0.5,
  minBonusPercent: 5,
  efficiencyEnabled: false,
  maxEfficiencyAdjustmentPercent: 20,
  tierMultipliers: { Gold: 1.3, Silver: 1.2, Bronze: 1.1, Standard: 1 },
};

function roster(...entries: Array<[
  employeeId: string,
  included?: boolean,
  tier?: CommissionRosterEntry["tier"],
]>): CommissionRosterEntry[] {
  return entries.map(([employeeId, included = true, tier]) => ({
    employeeId,
    displayName: `Technician ${employeeId}`,
    included,
    tier,
  }));
}

function job(
  jobId: string,
  sellValue: number,
  timesheets: CommissionJobInput["timesheets"],
  quotedHours?: number,
): CommissionJobInput {
  return {
    jobId,
    completedDate: "2026-06-15",
    stageName: "Complete",
    sellValue,
    quotedHours,
    timesheets,
  };
}

function build(params: {
  jobs: CommissionJobInput[];
  roster: CommissionRosterEntry[];
  config?: CommissionPeriodConfig;
  overrides?: CommissionOverrideInput[];
}) {
  return buildCommissionReadModel({
    ...params,
    periodStart,
    periodEnd,
    config: params.config ?? defaultConfig,
  });
}

function technician(model: CommissionReadModel, employeeId: string) {
  const result = model.technicians.find((entry) => entry.employeeId === employeeId);
  assert.ok(result, `Expected technician ${employeeId}`);
  return result;
}

function cents(value: number) {
  return Math.round(value * 100);
}

function assertReconciles(model: CommissionReadModel) {
  assert.equal(
    model.technicians.reduce((total, entry) => total + cents(entry.finalBonus), 0),
    cents(model.poolAmount),
  );
  assert.equal(
    model.technicians.reduce((total, entry) => total + cents(entry.payrollBonus ?? 0), 0),
    cents(model.payrollTotal),
  );
  assert.deepEqual(model.invariants, {
    insidePoolReconciles: true,
    outsidePoolReconciles: true,
    jobAllocationsReconcile: true,
    unsupportedJobsUnallocated: true,
    forfeitureReconciles: true,
    efficiencyReconciles: true,
    nonnegativePayroll: true,
  });
  for (const jobId of new Set(model.jobAllocations.map((allocation) => allocation.jobId))) {
    const allocations = model.jobAllocations.filter((allocation) => allocation.jobId === jobId);
    assert.equal(
      allocations.reduce((total, allocation) => total + cents(allocation.allocatedValue), 0),
      cents(allocations[0].jobTotal),
    );
  }
}

function assertCalculationError(
  callback: () => unknown,
  code: CommissionCalculationError["code"],
  message?: RegExp,
) {
  assert.throws(callback, (error: unknown) => {
    assert.ok(error instanceof CommissionCalculationError);
    assert.equal(error.code, code);
    if (message) assert.match(error.message, message);
    return true;
  });
}

test("pool helpers distinguish fractional rates from persisted percentages", () => {
  assert.equal(calculateCommissionPool(100000, 0.03), 3000);
  assert.equal(calculateCommissionPoolFromPercent(100000, 0.5), 500);
  assert.equal(calculateCommissionPoolFromPercent(1, 0.5), 0.01);
});

test("largest remainder conserves integer cents and breaks equal remainders by employee ID", () => {
  const allocation = allocateLargestRemainder(2, [
    { id: "10", weight: 1 },
    { id: "2", weight: 1 },
    { id: "30", weight: 1 },
  ]);

  assert.deepEqual(Object.fromEntries(allocation), { "2": 1, "10": 1, "30": 0 });
  assert.equal([...allocation.values()].reduce((sum, value) => sum + value, 0), 2);
});

test("compatibility allocator is cent-deterministic and conserves weighted and forfeited pools", () => {
  const weighted = allocateCommissionPool(3000, [
    { employeeId: "1", displayName: "A", included: true, allocatedWorkValue: 50000, tierMultiplier: 1, efficiencyMultiplier: 1.15, adjustment: 0, belowMinimum: false },
    { employeeId: "2", displayName: "B", included: true, allocatedWorkValue: 50000, tierMultiplier: 1, efficiencyMultiplier: 0.85, adjustment: 0, belowMinimum: false },
  ]);
  assert.deepEqual(weighted.map((entry) => entry.rawBonus), [1725, 1275]);
  assert.equal(weighted.reduce((sum, entry) => sum + entry.finalBonus, 0), 3000);

  const forfeited = allocateCommissionPool(3000, [
    { employeeId: "1", displayName: "A", included: true, allocatedWorkValue: 60000, tierMultiplier: 1, adjustment: 0, belowMinimum: false },
    { employeeId: "2", displayName: "B", included: true, allocatedWorkValue: 30000, tierMultiplier: 1, adjustment: 0, belowMinimum: true },
  ]);
  assert.equal(forfeited[0].finalBonus, 3000);
  assert.equal(forfeited[1].finalBonus, 0);
  assert.equal(forfeited[0].reallocationReceived, forfeited[1].forfeitedBonus);
});

test("zero cohort, no eligible roster, zero eligible basis, and zero-cent pool fail explicitly", () => {
  assertCalculationError(
    () => build({ jobs: [], roster: [] }),
    "NO_ELIGIBLE_TECHNICIANS",
  );
  assertCalculationError(
    () => build({ jobs: [], roster: roster(["1"]) }),
    "ZERO_ELIGIBLE_BASIS",
  );
  assertCalculationError(
    () => build({ jobs: [job("tiny", 0.01, [{ employeeId: "1", hours: 1 }])], roster: roster(["1"]), config: { ...defaultConfig, poolPercent: 0.25 } }),
    "ZERO_POOL",
  );
});

test("single eligible technician receives the entire completed-cohort pool", () => {
  const model = build({
    roster: roster(["1", true, "Standard"]),
    jobs: [job("1", 1000, [{ employeeId: "1", hours: 2 }], 2)],
  });

  assert.equal(model.totalWorkValue, 1000);
  assert.equal(model.poolAmount, 5);
  assert.equal(model.activeTechnicians, 1);
  assert.equal(technician(model, "1").tier, "Gold");
  assert.equal(technician(model, "1").finalBonus, 5);
  assert.equal(technician(model, "1").efficiency?.neutralReason, "disabled");
  assertReconciles(model);
});

test("completed cohort uses only Complete and Archived stages in the requested period", () => {
  const jobs: CommissionJobInput[] = [
    job("complete", 1000, [{ employeeId: "1", hours: 1 }]),
    { ...job("archived", 500, [{ employeeId: "1", hours: 1 }]), stageName: "Archived" },
    { ...job("completed", 700, [{ employeeId: "1", hours: 1 }]), stageName: "Completed" },
    { ...job("invoiced", 900, [{ employeeId: "1", hours: 1 }]), stageName: "Invoiced" },
    { ...job("outside", 1100, [{ employeeId: "1", hours: 1 }]), completedDate: "2026-07-01" },
  ];
  const model = build({ jobs, roster: roster(["1"]) });

  assert.equal(model.completedJobs, 2);
  assert.equal(model.totalWorkValue, 1500);
  assert.equal(model.poolAmount, 7.5);
  assertReconciles(model);
});

test("unsupported and unmapped jobs remain in work value and pool with complete exclusion coverage", () => {
  const model = build({
    roster: roster(["1"]),
    jobs: [
      job("supported", 1000, [{ employeeId: "1", hours: 2 }]),
      job("uncovered", 500, []),
      job("unmapped", 250, [{ employeeId: null, hours: 3 }]),
      job("zero-value", 0, [{ employeeId: "1", hours: 1 }]),
    ],
  });

  assert.equal(model.completedJobs, 4);
  assert.equal(model.totalWorkValue, 1750);
  assert.equal(model.poolAmount, 8.75);
  assert.equal(technician(model, "1").finalBonus, 8.75);
  assert.equal(model.coverage.commissionSupportedJobs, 1);
  assert.equal(model.coverage.excludedJobs, 2);
  assert.equal(model.coverage.excludedWorkValue, 750);
  assert.equal(model.coverage.nonPositiveValueJobs, 1);
  assert.equal(model.coverage.unmappedHours, 3);
  assert.equal(model.coverage.nonFieldTechnicianHours, 0);
  assert.deepEqual(model.coverage.excludedJobDetails.map((entry) => entry.jobId), ["uncovered", "unmapped"]);
  assert.ok(!model.jobAllocations.some((allocation) => allocation.jobId === "uncovered" || allocation.jobId === "unmapped"));
  assert.ok(model.diagnostics.some((entry) => entry.code === "EXCLUDED_JOB_NO_MAPPED_HOURS"));
  assert.ok(model.diagnostics.some((entry) => entry.code === "UNMAPPED_TIMESHEET_WORK"));
  assertReconciles(model);
});

/* FINAL OWNER RULE: membership and shares come ONLY from recorded hours —
   anyone with mapped hours on a period job is a row, included by default,
   and ALL recorded hours count in the job's denominator. */

test("a technician with mapped hours and no roster or override row is included with the correct hours-share", () => {
  const model = build({
    roster: roster(["1"]),
    jobs: [job("shared", 1000, [
      { employeeId: "1", hours: 2, fieldTechnician: true },
      { employeeId: "77", hours: 2, fieldTechnician: false },
    ])],
  });

  // All-hours denominator: 4h total, 2h each ⇒ 50% shares of $1,000.
  assert.equal(model.jobAllocations.find((entry) => entry.employeeId === "77")?.share, 0.5);
  assert.equal(model.jobAllocations.find((entry) => entry.employeeId === "77")?.allocatedValue, 500);
  assert.equal(model.jobAllocations.find((entry) => entry.employeeId === "1")?.allocatedValue, 500);
  // Included by default — the former non-field flag never gates membership.
  assert.equal(technician(model, "77").included, true);
  assert.equal(technician(model, "77").allocatedWorkValue, 500);
  assert.equal(model.coverage.technicianWork.find((entry) => entry.employeeId === "77")?.included, true);
  assert.equal(model.coverage.nonFieldTechnicianHours, 0);
  assert.ok(!model.diagnostics.some((entry) => entry.code === "NON_FIELD_TECHNICIAN_WORK"));
  assertReconciles(model);
});

test("roster inclusion flags are ignored — hours alone decide membership", () => {
  const model = build({
    roster: roster(["1"], ["2", false]),
    jobs: [job("shared", 1000, [
      { employeeId: "1", hours: 3 },
      { employeeId: "2", hours: 1 },
    ])],
  });

  assert.equal(technician(model, "2").included, true);
  assert.equal(technician(model, "2").allocatedWorkValue, 250);
  assert.ok(model.diagnostics.some((entry) => entry.code === "ROSTER_INCLUSION_IGNORED"));
  assertReconciles(model);
});

test("operator-excluded work stays allocated and disclosed while the full pool redistributes over included weights", () => {
  const model = build({
    roster: roster(["1"], ["2"]),
    jobs: [
      job("included-job", 1000, [{ employeeId: "1", hours: 2 }]),
      job("excluded-job", 1000, [{ employeeId: "2", hours: 2 }]),
    ],
    overrides: [{ employeeId: "2", field: "included", value: false, poolTreatment: "neutral", reason: "Operator uncheck" }],
  });

  assert.equal(model.totalWorkValue, 2000);
  assert.equal(model.poolAmount, 10);
  assert.equal(technician(model, "1").finalBonus, 10);
  assert.equal(model.technicians.some((entry) => entry.employeeId === "2"), false);
  assert.equal(model.coverage.ineligibleAllocatedWorkValue, 1000);
  assert.equal(model.coverage.jobsWithOnlyIneligibleWork, 1);
  assert.equal(model.jobAllocations.find((entry) => entry.employeeId === "2")?.included, false);
  assert.equal(model.coverage.technicianWork.find((entry) => entry.employeeId === "2")?.included, false);
  assert.ok(model.diagnostics.some((entry) => entry.code === "INELIGIBLE_TECHNICIAN_WORK"));
  assertReconciles(model);
});

test("zero-hour directory rows stay visible for inclusion editing but never enter allocation math", () => {
  const model = build({
    roster: roster(["1"], ["2", false]),
    jobs: [job("only-one", 1000, [{ employeeId: "1", hours: 1 }])],
  });

  // The zero-hour person renders as a row (included by default, checkbox
  // present) but earns nothing and changes no denominator.
  assert.deepEqual(
    model.coverage.technicianWork.map((entry) => [entry.employeeId, entry.included, entry.allocatedWorkValue]),
    [["1", true, 1000], ["2", true, 0]],
  );
  assert.equal(model.technicians.some((entry) => entry.employeeId === "2"), false);
  assert.deepEqual(model.jobAllocations.map((entry) => [entry.employeeId, entry.share]), [["1", 1]]);
  assert.equal(technician(model, "1").finalBonus, model.poolAmount);
  assertReconciles(model);
});

test("ranks derive Gold, Silver, Bronze, and Standard from effective work instead of roster tiers", () => {
  const model = build({
    roster: roster(
      ["1", true, "Standard"],
      ["2", true, "Gold"],
      ["3", true, "Silver"],
      ["4", true, "Bronze"],
    ),
    jobs: [job("rank", 10000, [
      { employeeId: "1", hours: 4 },
      { employeeId: "2", hours: 3 },
      { employeeId: "3", hours: 2 },
      { employeeId: "4", hours: 1 },
    ])],
  });

  assert.deepEqual(
    model.technicians.map((entry) => [entry.employeeId, entry.rank, entry.tier, entry.tierMultiplier]),
    [
      ["1", 1, "Gold", 1.3],
      ["2", 2, "Silver", 1.2],
      ["3", 3, "Bronze", 1.1],
      ["4", 4, "Standard", 1],
    ],
  );
  assert.ok(model.diagnostics.some((entry) => entry.code === "PERMANENT_ROSTER_TIER_IGNORED"));
  assertReconciles(model);
});

test("persisted tier multipliers change payout weights", () => {
  const model = build({
    roster: roster(["1"], ["2"]),
    jobs: [job("custom-tiers", 2000, [
      { employeeId: "1", hours: 1 },
      { employeeId: "2", hours: 1 },
    ])],
    config: {
      ...defaultConfig,
      tierMultipliers: { Gold: 2, Silver: 1, Bronze: 1, Standard: 1 },
    },
  });

  assert.equal(technician(model, "1").tierMultiplier, 2);
  assert.equal(technician(model, "2").tierMultiplier, 1);
  assert.equal(technician(model, "1").finalBonus, 6.67);
  assert.equal(technician(model, "2").finalBonus, 3.33);
  assertReconciles(model);
});

test("equal work ranks and job-allocation cents break ties by numeric employee ID", () => {
  const model = build({
    roster: roster(["10"], ["2"]),
    jobs: [job("rounding", 100.01, [
      { employeeId: "10", hours: 1 },
      { employeeId: "2", hours: 1 },
    ])],
  });

  assert.deepEqual(model.technicians.map((entry) => [entry.employeeId, entry.tier]), [
    ["2", "Gold"],
    ["10", "Silver"],
  ]);
  assert.equal(model.jobAllocations.find((entry) => entry.employeeId === "2")?.allocatedValue, 50.01);
  assert.equal(model.jobAllocations.find((entry) => entry.employeeId === "10")?.allocatedValue, 50);
  assert.equal(cents(model.poolAmount), 50);
  assertReconciles(model);
});

test("multi-technician normalized payout uses deterministic largest-remainder cents", () => {
  const model = build({
    roster: roster(["1"], ["2"], ["3"], ["4"]),
    jobs: [job("multi", 100, [
      { employeeId: "1", hours: 1 },
      { employeeId: "2", hours: 1 },
      { employeeId: "3", hours: 1 },
      { employeeId: "4", hours: 1 },
    ])],
    config: { ...defaultConfig, poolPercent: 0.25 },
  });

  assert.equal(model.poolAmount, 0.25);
  assert.equal(model.technicians.reduce((sum, entry) => sum + cents(entry.finalBonus), 0), 25);
  assert.deepEqual(model.technicians.map((entry) => cents(entry.finalBonus)), [7, 7, 6, 5]);
  assertReconciles(model);
});

test("cent invariants hold across allowed pool settings and one through eight technicians", () => {
  for (const poolPercent of [0.25, 0.5, 1]) {
    for (let technicianCount = 1; technicianCount <= 8; technicianCount += 1) {
      const employees = Array.from({ length: technicianCount }, (_, index) => String(index + 1));
      const model = build({
        roster: roster(...employees.map((employeeId) => [employeeId] as [string])),
        jobs: [job(
          `matrix-${poolPercent}-${technicianCount}`,
          1234.57,
          employees.map((employeeId, index) => ({ employeeId, hours: (index + 1) / 3 })),
        )],
        config: { ...defaultConfig, poolPercent },
      });

      assert.equal(model.technicians.length, technicianCount);
      assert.ok(model.technicians.every((entry) => entry.efficiency?.effect === 0));
      assertReconciles(model);
    }
  }
});

test("below-threshold bonus is forfeited then redistributed pro rata without losing a cent", () => {
  const model = build({
    roster: roster(["1"], ["2"]),
    jobs: [job("forfeit", 10000, [
      { employeeId: "1", hours: 999 },
      { employeeId: "2", hours: 1 },
    ])],
  });
  const winner = technician(model, "1");
  const forfeiter = technician(model, "2");

  assert.equal(forfeiter.belowMinimum, true);
  assert.ok(forfeiter.forfeitedBonus > 0);
  assert.equal(forfeiter.finalBonus, 0);
  assert.equal(winner.reallocationReceived, forfeiter.forfeitedBonus);
  assert.equal(winner.finalBonus, model.poolAmount);
  assertReconciles(model);
});

test("forfeiture is waived when every eligible technician is below threshold", () => {
  const model = build({
    roster: roster(["1"], ["2"]),
    jobs: [job("all-below", 1000, [
      { employeeId: "1", hours: 1 },
      { employeeId: "2", hours: 1 },
    ])],
    config: { ...defaultConfig, minBonusPercent: 201 },
  });

  assert.ok(model.technicians.every((entry) => entry.belowMinimum === false));
  assert.ok(model.technicians.every((entry) => entry.forfeitedBonus === 0));
  assert.ok(model.diagnostics.some((entry) => entry.code === "FORFEITURE_WAIVED_NO_SURVIVOR"));
  assertReconciles(model);
});

test("efficiency interpolation honors persisted enabled and max-adjustment config after forfeiture", () => {
  const jobs = [
    job("slow", 1000, [{ employeeId: "1", hours: 10 }], 5),
    job("fast", 1000, [{ employeeId: "2", hours: 10 }], 15),
  ];
  const disabled = build({ jobs, roster: roster(["1"], ["2"]) });
  const enabled = build({
    jobs,
    roster: roster(["1"], ["2"]),
    config: { ...defaultConfig, efficiencyEnabled: true },
  });
  const stronger = build({
    jobs,
    roster: roster(["1"], ["2"]),
    config: { ...defaultConfig, efficiencyEnabled: true, maxEfficiencyAdjustmentPercent: 50 },
  });

  assert.equal(technician(disabled, "1").efficiency?.potentialMultiplier, 0.8);
  assert.equal(technician(disabled, "1").efficiency?.multiplier, 1);
  assert.equal(technician(disabled, "1").efficiency?.effect, 0);
  assert.equal(technician(enabled, "1").efficiency?.multiplier, 0.8);
  assert.equal(technician(enabled, "2").efficiency?.multiplier, 1.2);
  assert.ok(technician(enabled, "1").finalBonus < technician(disabled, "1").finalBonus);
  assert.ok(technician(enabled, "2").finalBonus > technician(disabled, "2").finalBonus);
  assert.ok(technician(stronger, "2").finalBonus > technician(enabled, "2").finalBonus);
  assert.equal(efficiencyMultiplier(0.5, 20), 0.8);
  assert.equal(efficiencyMultiplier(1, 20), 1);
  assert.equal(efficiencyMultiplier(1.5, 20), 1.2);
  assertReconciles(disabled);
  assertReconciles(enabled);
  assertReconciles(stronger);
});

test("technicians without qualifying quote work remain neutral when efficiency is enabled", () => {
  const model = build({
    jobs: [job("no-quote", 1000, [{ employeeId: "1", hours: 5 }])],
    roster: roster(["1"]),
    config: { ...defaultConfig, efficiencyEnabled: true, maxEfficiencyAdjustmentPercent: 35 },
  });

  assert.deepEqual(technician(model, "1").efficiency, {
    enabled: true,
    maxAdjustmentPercent: 35,
    quoteJobs: 0,
    quotedHours: 0,
    actualHours: 0,
    efficiencyRatio: null,
    potentialMultiplier: 1,
    multiplier: 1,
    effect: 0,
    neutralReason: "no_qualifying_quote_work",
  });
  assertReconciles(model);
});

test("efficiency coverage distinguishes complete no-work from incomplete quote labor", () => {
  const noWork = build({
    config: { ...defaultConfig, efficiencyEnabled: true },
    roster: roster(["1"]),
    jobs: [{
      ...job("no-work", 1000, [{ employeeId: "1", hours: 2 }]),
      quoteId: "50",
      quotedHours: 0,
      quoteLaborRows: 0,
      quoteLaborCoverageStatus: "complete_no_qualifying_work",
    }],
  });
  assert.equal(noWork.coverage.quoteLabor?.status, "complete_no_qualifying_work");
  assert.equal(noWork.technicians[0].efficiency?.neutralReason, "no_qualifying_quote_work");

  const missing = build({
    config: { ...defaultConfig, efficiencyEnabled: true },
    roster: roster(["1"]),
    jobs: [{
      ...job("missing", 1000, [{ employeeId: "1", hours: 2 }]),
      quoteId: "51",
      quotedHours: null,
      quoteLaborRows: 0,
      quoteLaborCoverageStatus: "missing",
    }],
  });
  assert.equal(missing.coverage.quoteLabor?.status, "missing");
  assert.ok(missing.diagnostics.some((diagnostic) => diagnostic.code === "QUOTE_LABOR_COVERAGE_INCOMPLETE"));
});

test("included override applies after all-technician allocation without changing job shares or pool", () => {
  const baseline = build({
    jobs: [job("include", 1000, [{ employeeId: "1", hours: 1 }, { employeeId: "2", hours: 1 }])],
    roster: roster(["1"], ["2"]),
  });
  const excluded = build({
    jobs: [job("include", 1000, [{ employeeId: "1", hours: 1 }, { employeeId: "2", hours: 1 }])],
    roster: roster(["1"], ["2"]),
    overrides: [{ employeeId: "2", field: "included", value: false, poolTreatment: "neutral", reason: "Period exclusion" }],
  });

  assert.equal(excluded.poolAmount, baseline.poolAmount);
  assert.deepEqual(excluded.jobAllocations.map((entry) => entry.allocatedValue), [500, 500]);
  assert.equal(excluded.jobAllocations.find((entry) => entry.employeeId === "2")?.included, false);
  assert.equal(excluded.technicians.length, 1);
  assert.equal(technician(excluded, "1").finalBonus, excluded.poolAmount);
  assert.equal(excluded.coverage.ineligibleAllocatedWorkValue, 500);
  assertReconciles(excluded);
});

test("allocated-value and tier overrides change relative basis and tier without changing work value or pool", () => {
  const model = build({
    jobs: [job("basis", 1000, [{ employeeId: "1", hours: 9 }, { employeeId: "2", hours: 1 }])],
    roster: roster(["1"], ["2"]),
    overrides: [
      { employeeId: "2", field: "allocated_value", value: 2000, poolTreatment: "neutral", reason: "Correct relative basis" },
      { employeeId: "2", field: "tier", value: "Standard", poolTreatment: "neutral", reason: "Approved period tier" },
    ],
  });

  assert.equal(model.totalWorkValue, 1000);
  assert.equal(model.poolAmount, 5);
  assert.equal(technician(model, "2").allocatedWorkValue, 100);
  assert.equal(technician(model, "2").effectiveAllocatedWorkValue, 2000);
  assert.equal(technician(model, "2").rank, 1);
  assert.equal(technician(model, "2").tier, "Standard");
  assert.equal(technician(model, "1").tier, "Silver");
  assertReconciles(model);
});

test("final-bonus override locks cents and redistributes the exact remaining pool", () => {
  const model = build({
    jobs: [job("lock", 2000, [{ employeeId: "1", hours: 1 }, { employeeId: "2", hours: 1 }])],
    roster: roster(["1"], ["2"]),
    overrides: [{ employeeId: "1", field: "final_bonus", value: 2, poolTreatment: "inside_pool", reason: "Payroll lock" }],
  });

  assert.equal(model.poolAmount, 10);
  assert.equal(technician(model, "1").finalBonus, 2);
  assert.equal(technician(model, "1").finalBonusLocked, true);
  assert.equal(technician(model, "2").finalBonus, 8);
  assertReconciles(model);
});

test("final-bonus lock is applied after efficiency and remains exact", () => {
  const model = build({
    jobs: [
      job("slow", 1000, [{ employeeId: "1", hours: 10 }], 5),
      job("fast", 1000, [{ employeeId: "2", hours: 10 }], 15),
    ],
    roster: roster(["1"], ["2"]),
    config: { ...defaultConfig, efficiencyEnabled: true },
    overrides: [{ employeeId: "1", field: "final_bonus", value: 3.33, poolTreatment: "inside_pool", reason: "Locked final" }],
  });

  assert.notEqual(technician(model, "1").efficiency?.effect, 0);
  assert.equal(technician(model, "1").finalBonus, 3.33);
  assert.equal(technician(model, "2").finalBonus, 6.67);
  assertReconciles(model);
});

test("inside-pool adjustment floors at zero and redistributes the applied inverse amount", () => {
  const jobs = [job("inside", 2000, [{ employeeId: "1", hours: 1 }, { employeeId: "2", hours: 1 }])];
  const baseline = build({ jobs, roster: roster(["1"], ["2"]) });
  const increased = build({
    jobs,
    roster: roster(["1"], ["2"]),
    overrides: [{ employeeId: "1", field: "inside_pool_adjustment", value: 1, poolTreatment: "inside_pool", reason: "Inside adjustment" }],
  });
  const floored = build({
    jobs,
    roster: roster(["1"], ["2"]),
    overrides: [{ employeeId: "1", field: "inside_pool_adjustment", value: -100, poolTreatment: "inside_pool", reason: "Floor at zero" }],
  });

  assert.equal(technician(increased, "1").finalBonus, technician(baseline, "1").finalBonus + 1);
  assert.equal(technician(increased, "2").finalBonus, technician(baseline, "2").finalBonus - 1);
  assert.equal(technician(floored, "1").finalBonus, 0);
  assert.equal(technician(floored, "1").insidePoolAdjustment, -technician(baseline, "1").finalBonus);
  assert.equal(technician(floored, "2").finalBonus, floored.poolAmount);
  assertReconciles(increased);
  assertReconciles(floored);
});

test("outside-pool adjustment changes payroll only and reconciles separately", () => {
  const model = build({
    jobs: [job("outside", 2000, [{ employeeId: "1", hours: 1 }, { employeeId: "2", hours: 1 }])],
    roster: roster(["1"], ["2"]),
    overrides: [
      { employeeId: "1", field: "outside_pool_adjustment", value: 2.25, poolTreatment: "outside_pool", reason: "Spot bonus" },
      { employeeId: "2", field: "outside_pool_adjustment", value: -1, poolTreatment: "outside_pool", reason: "Payroll correction" },
    ],
  });

  assert.equal(model.insidePoolTotal, model.poolAmount);
  assert.equal(model.outsidePoolTotal, 1.25);
  assert.equal(model.payrollTotal, model.poolAmount + 1.25);
  assert.equal(technician(model, "1").payrollBonus, technician(model, "1").finalBonus + 2.25);
  assert.equal(technician(model, "2").payrollBonus, technician(model, "2").finalBonus - 1);
  assertReconciles(model);
});

test("notes override is informational and cannot alter payout", () => {
  const jobs = [job("notes", 1000, [{ employeeId: "1", hours: 1 }])];
  const baseline = build({ jobs, roster: roster(["1"]) });
  const noted = build({
    jobs,
    roster: roster(["1"]),
    overrides: [{ employeeId: "1", field: "notes", value: "Reviewed by payroll", poolTreatment: "neutral", reason: "Review note" }],
  });

  assert.equal(technician(noted, "1").finalBonus, technician(baseline, "1").finalBonus);
  assert.deepEqual(technician(noted, "1").notes, ["Reviewed by payroll"]);
  assertReconciles(noted);
});

test("typed override application is independent of input order", () => {
  const jobs = [job("order", 2000, [{ employeeId: "1", hours: 1 }, { employeeId: "2", hours: 1 }])];
  const overrides: CommissionOverrideInput[] = [
    { employeeId: "1", field: "final_bonus", value: 4, poolTreatment: "inside_pool", reason: "Lock" },
    { employeeId: "2", field: "outside_pool_adjustment", value: 1.5, poolTreatment: "outside_pool", reason: "Outside" },
    { employeeId: "2", field: "notes", value: "Approved", poolTreatment: "neutral", reason: "Note" },
  ];
  const forward = build({ jobs, roster: roster(["1"], ["2"]), overrides });
  const reverse = build({ jobs, roster: roster(["1"], ["2"]), overrides: [...overrides].reverse() });

  assert.deepEqual(forward.technicians, reverse.technicians);
  assert.equal(forward.payrollTotal, reverse.payrollTotal);
  assertReconciles(forward);
  assertReconciles(reverse);
});

test("override conflicts reject final-lock overflow, mutual fields, unabsorbable changes, and negative payroll", () => {
  const jobs = [job("conflict", 2000, [{ employeeId: "1", hours: 1 }, { employeeId: "2", hours: 1 }])];
  const people = roster(["1"], ["2"]);

  assertCalculationError(
    () => build({ jobs, roster: people, overrides: [{ employeeId: "1", field: "final_bonus", value: 10.01, poolTreatment: "inside_pool", reason: "Too high" }] }),
    "OVERRIDE_CONFLICT",
    /exceed/,
  );
  assertCalculationError(
    () => build({ jobs, roster: people, overrides: [
      { employeeId: "1", field: "final_bonus", value: 3, poolTreatment: "inside_pool", reason: "Lock" },
      { employeeId: "1", field: "inside_pool_adjustment", value: 1, poolTreatment: "inside_pool", reason: "Conflict" },
    ] }),
    "OVERRIDE_CONFLICT",
    /both/,
  );
  assertCalculationError(
    () => build({ jobs, roster: people, overrides: [
      { employeeId: "1", field: "inside_pool_adjustment", value: 1, poolTreatment: "inside_pool", reason: "No absorber" },
      { employeeId: "2", field: "final_bonus", value: 5, poolTreatment: "inside_pool", reason: "Locked absorber" },
    ] }),
    "OVERRIDE_CONFLICT",
    /no other unlocked/,
  );
  assertCalculationError(
    () => build({ jobs, roster: people, overrides: [{ employeeId: "1", field: "outside_pool_adjustment", value: -100, poolTreatment: "outside_pool", reason: "Negative payroll" }] }),
    "OVERRIDE_CONFLICT",
    /negative/,
  );
});

test("payout overrides on operator-excluded employees fail instead of being silently ignored", () => {
  assertCalculationError(
    () => build({
      jobs: [job("excluded-override", 1000, [{ employeeId: "1", hours: 1 }, { employeeId: "2", hours: 1 }])],
      roster: roster(["1"], ["2"]),
      overrides: [
        { employeeId: "2", field: "included", value: false, poolTreatment: "neutral", reason: "Operator uncheck" },
        { employeeId: "2", field: "outside_pool_adjustment", value: 1, poolTreatment: "outside_pool", reason: "Invalid target" },
      ],
    }),
    "OVERRIDE_CONFLICT",
    /excluded or zero-basis/,
  );
});

test("invalid config and override values are rejected before calculation", () => {
  const jobs = [job("invalid", 1000, [{ employeeId: "1", hours: 1 }])];
  const people = roster(["1"]);
  const invalidOverrides: CommissionOverrideInput[] = [
    { employeeId: "1", field: "allocated_value", value: -1, poolTreatment: "neutral", reason: "Invalid" },
    { employeeId: "1", field: "final_bonus", value: Number.NaN, poolTreatment: "inside_pool", reason: "Invalid" },
    { employeeId: "1", field: "tier", value: "Platinum", poolTreatment: "neutral", reason: "Invalid" } as unknown as CommissionOverrideInput,
    { employeeId: "1", field: "inside_pool_adjustment", value: 1, poolTreatment: "outside_pool", reason: "Invalid" } as unknown as CommissionOverrideInput,
    { employeeId: "1", field: "notes", value: "x", poolTreatment: "neutral", reason: "" },
  ];
  for (const override of invalidOverrides) {
    assertCalculationError(() => build({ jobs, roster: people, overrides: [override] }), "INVALID_INPUT");
  }
  assertCalculationError(
    () => build({ jobs, roster: people, config: { ...defaultConfig, poolPercent: 0.26 } }),
    "INVALID_INPUT",
    /Pool percent/,
  );
  assertCalculationError(
    () => build({ jobs, roster: people, config: { ...defaultConfig, maxEfficiencyAdjustmentPercent: 51 } }),
    "INVALID_INPUT",
    /Maximum efficiency/,
  );
});

test("duplicate jobs, overlapping roster rows, duplicate fields, and unknown targets fail deterministically", () => {
  const oneJob = job("duplicate", 1000, [{ employeeId: "1", hours: 1 }]);
  assertCalculationError(
    () => build({ jobs: [oneJob, oneJob], roster: roster(["1"]) }),
    "INVALID_INPUT",
    /Duplicate commission job/,
  );
  assertCalculationError(
    () => build({ jobs: [oneJob], roster: roster(["1"], ["1"]) }),
    "INVALID_INPUT",
    /overlapping effective entries/,
  );
  assertCalculationError(
    () => build({ jobs: [oneJob], roster: roster(["1"]), overrides: [
      { employeeId: "1", field: "notes", value: "a", poolTreatment: "neutral", reason: "First" },
      { employeeId: "1", field: "notes", value: "b", poolTreatment: "neutral", reason: "Second" },
    ] }),
    "OVERRIDE_CONFLICT",
    /Duplicate notes/,
  );
  assertCalculationError(
    () => build({ jobs: [oneJob], roster: roster(["1"]), overrides: [
      { employeeId: "999", field: "included", value: true, poolTreatment: "neutral", reason: "Unknown" },
    ] }),
    "INVALID_INPUT",
    /unknown employee/,
  );
});
