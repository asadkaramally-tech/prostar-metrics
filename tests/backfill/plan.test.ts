import assert from "node:assert/strict";
import test from "node:test";
import {
  BACKFILL_REQUESTS_PER_SECOND,
  BACKFILL_REQUEST_SLICE_LIMIT,
  BACKFILL_SOURCE_DEFINITIONS,
  backfillSliceBudget,
  buildBackfillPlan,
  buildEstimateTemplate,
  businessCurrentMonth,
  canCompleteAfterReconciliation,
  capacityAllocation,
  parseBackfillEstimates,
  retryDecision,
  shouldYieldToCurrentQueue,
  type BackfillEstimateMap,
} from "../../src/lib/backfill/plan";

test("planner creates every month/source unit from January 2023 through the requested month", () => {
  const estimates = estimatesFor("2023-01-01", "2023-03-01");
  const units = buildBackfillPlan({
    throughMonth: "2023-03-01",
    dailyRequestCeiling: 10_000,
    estimates,
  });

  assert.equal(units.length, 3 * BACKFILL_SOURCE_DEFINITIONS.length);
  assert.deepEqual([...new Set(units.map((unit) => unit.monthStart))], ["2023-01-01", "2023-02-01", "2023-03-01"]);
  assert.equal(units.find((unit) => unit.sourceFamily === "quote_nested")?.dependsOn.includes("quotes"), true);
  assert.deepEqual(
    units.find((unit) => unit.sourceFamily === "mobile_status"),
    {
      sourceFamily: "mobile_status",
      monthStart: "2023-01-01",
      monthEndExclusive: "2023-02-01",
      executionMode: "coverage_only",
      requiredForCompletion: false,
      dependsOn: ["jobs"],
      expectedPages: 2,
      expectedRecords: 3,
      estimatedNestedRequests: 4,
      estimatedRequests: 6,
      dailyRequestCeiling: 10_000,
      queuePriority: 290,
      requestSliceLimit: 250,
      idempotencyKey: "wp04:mobile_status:2023-01",
    },
  );
});

test("planner rejects an unestimated source/month instead of inventing capacity", () => {
  const estimates = estimatesFor("2023-01-01", "2023-01-01");
  delete estimates["2023-01:jobs"];

  assert.throws(
    () => buildBackfillPlan({ throughMonth: "2023-01-01", dailyRequestCeiling: 10_000, estimates }),
    /Missing approved capacity estimate 2023-01:jobs/,
  );
});

test("estimate parser rejects negative and fractional counts", () => {
  assert.throws(
    () => parseBackfillEstimates({ "2023-01:quotes": { expectedPages: 1.5, expectedRecords: 3, estimatedNestedRequests: 0 } }),
    /non-negative integer/,
  );
  assert.throws(
    () => parseBackfillEstimates({ "2023-01:quotes": { expectedPages: 1, expectedRecords: -1, estimatedNestedRequests: 0 } }),
    /non-negative integer/,
  );
});

test("capacity reserves at least 60 percent current and 15 percent reconciliation", () => {
  assert.equal(BACKFILL_REQUESTS_PER_SECOND, 1);
  assert.equal(BACKFILL_REQUEST_SLICE_LIMIT, 250);
  assert.deepEqual(capacityAllocation(10_000), { current: 6000, reconciliation: 1500, backfill: 2500 });
  assert.deepEqual(capacityAllocation(101), { current: 61, reconciliation: 16, backfill: 24 });
  assert.equal(backfillSliceBudget({
    dailyRequestCeiling: 1000,
    backfillRequests: 100,
    backfillReservedRequests: 100,
    requested: 250,
  }), 50);
  assert.equal(backfillSliceBudget({
    dailyRequestCeiling: 1000,
    backfillRequests: 250,
    backfillReservedRequests: 0,
    requested: 250,
  }), 0);
  assert.equal(backfillSliceBudget({
    dailyRequestCeiling: 1000,
    currentRequests: 800,
    reconciliationRequests: 100,
    backfillRequests: 0,
    backfillReservedRequests: 0,
    requested: 250,
  }), 100);
  assert.equal(backfillSliceBudget({
    dailyRequestCeiling: 1000,
    currentRequests: 900,
    reconciliationRequests: 100,
    backfillRequests: 0,
    backfillReservedRequests: 0,
    requested: 250,
  }), 0);
});

test("fifth transient failure dead-letters and retry delays remain bounded", () => {
  assert.deepEqual(retryDecision(0, 5), { nextRetryCount: 1, deadLettered: false, retryDelayMinutes: 2 });
  assert.deepEqual(retryDecision(4, 5), { nextRetryCount: 5, deadLettered: true, retryDelayMinutes: 32 });
  assert.equal(retryDecision(20, 5).retryDelayMinutes, 60);
});

test("completion requires matched reconciliation except optional mobile coverage", () => {
  assert.equal(canCompleteAfterReconciliation(true, "matched"), true);
  assert.equal(canCompleteAfterReconciliation(true, "partial"), false);
  assert.equal(canCompleteAfterReconciliation(false, "partial"), true);
  assert.equal(canCompleteAfterReconciliation(false, "unavailable"), true);
  assert.equal(canCompleteAfterReconciliation(false, "mismatch"), false);
});

test("backfill yields as current work approaches its freshness SLA", () => {
  assert.equal(shouldYieldToCurrentQueue({ sourceFamily: "mobile_status", oldestAgeMinutes: 20 }), true);
  assert.equal(shouldYieldToCurrentQueue({ sourceFamily: "quotes", oldestAgeMinutes: 44 }), false);
  assert.equal(shouldYieldToCurrentQueue({ sourceFamily: "jobs", oldestAgeMinutes: 90 }), true);
});

test("business current month honors America/Los_Angeles at UTC boundaries", () => {
  assert.equal(businessCurrentMonth(new Date("2026-01-01T07:30:00.000Z")), "2025-12-01");
  assert.equal(businessCurrentMonth(new Date("2026-01-01T08:30:00.000Z")), "2026-01-01");
});

test("current quote capacity includes the required full open-quote discovery scan", () => {
  const currentMonth = businessCurrentMonth();
  const units = buildBackfillPlan({
    startMonth: currentMonth,
    throughMonth: currentMonth,
    dailyRequestCeiling: 10_000,
    estimates: estimatesFor(currentMonth, currentMonth),
  });

  assert.equal(units.find((unit) => unit.sourceFamily === "quotes")?.estimatedRequests, 14);
  assert.equal(units.find((unit) => unit.sourceFamily === "jobs")?.estimatedRequests, 9);
});

function estimatesFor(startMonth: string, throughMonth: string): BackfillEstimateMap {
  return Object.fromEntries(
    Object.keys(buildEstimateTemplate(startMonth, throughMonth)).map((key) => [key, {
      expectedPages: 2,
      expectedRecords: 3,
      estimatedNestedRequests: 4,
    }]),
  );
}
