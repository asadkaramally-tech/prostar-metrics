import assert from "node:assert/strict";
import test from "node:test";
import { commissionDashboardReadModelParams } from "../../src/app/api/commissions/route";
import { parseCommissionDashboardPeriod } from "../../src/lib/commissions/period";

const now = new Date("2026-07-21T12:00:00-07:00");

test("commissions API accepts the shared YYYY-MM period-picker value", () => {
  assert.deepEqual(
    commissionDashboardReadModelParams(new URLSearchParams({ month: "2026-06", summaryYear: "2026" }), now),
    { year: 2026, month: 6, summaryYear: 2026 },
  );
});

test("commissions API keeps the legacy numeric year/month form strict", () => {
  assert.deepEqual(
    commissionDashboardReadModelParams(new URLSearchParams({ year: "2026", month: "6" }), now),
    { year: 2026, month: 6, summaryYear: 2026 },
  );
});

test("commissions API defaults to the current business month", () => {
  assert.deepEqual(
    commissionDashboardReadModelParams(new URLSearchParams(), now),
    { year: 2026, month: 7, summaryYear: 2026 },
  );
});

test("commissions API rejects malformed, ambiguous, and out-of-range periods", () => {
  const invalid: Array<Record<string, string>> = [
    { month: "2026-13" },
    { month: "2026-08" },
    { month: "2022-12" },
    { month: "6" },
    { year: "2026", month: "13" },
    { year: "2025", month: "2026-06" },
    { month: "2026-06", summaryYear: "2027" },
    { month: "2026-06", summaryYear: "June" },
  ];

  for (const params of invalid) {
    assert.equal(commissionDashboardReadModelParams(new URLSearchParams(params), now), null, JSON.stringify(params));
  }
});

test("commissions page period parser uses the same Pacific 2023-current boundary", () => {
  assert.deepEqual(
    parseCommissionDashboardPeriod({ month: "2023-01" }, now),
    { year: 2023, month: 1, summaryYear: 2023, periodStart: "2023-01-01" },
  );
  assert.equal(parseCommissionDashboardPeriod({ month: "2022-12" }, now), null);
  assert.equal(parseCommissionDashboardPeriod({ month: "2026-08" }, now), null);
});
