import assert from "node:assert/strict";
import test from "node:test";
import { jobDashboardReadModelParams } from "../../src/lib/api/dashboard-route-params";

test("jobs API forwards page 2 and all existing filters to the read model", () => {
  const params = jobDashboardReadModelParams(new URLSearchParams({
    month: "2026-06",
    category: "HVAC",
    costCenter: "Commercial Service",
    technician: "Alex Tech",
    page: "2",
  }));

  assert.deepEqual(params, {
    selectedMonth: "2026-06",
    category: "HVAC",
    costCenter: "Commercial Service",
    technician: "Alex Tech",
    page: 2,
  });
});

test("jobs API falls back to page 1 for invalid page values", () => {
  for (const page of [undefined, "", "0", "-1", "1.5", "not-a-page", "9007199254740992"]) {
    const searchParams = new URLSearchParams({ month: "2026-06" });
    if (page !== undefined) searchParams.set("page", page);

    assert.equal(jobDashboardReadModelParams(searchParams)?.page, 1, `expected ${String(page)} to use page 1`);
  }
});

test("jobs API rejects unsupported reporting months", () => {
  const now = new Date("2026-07-15T19:00:00.000Z");
  assert.equal(jobDashboardReadModelParams(new URLSearchParams({ month: "2022-12" }), now), null);
  assert.equal(jobDashboardReadModelParams(new URLSearchParams({ month: "2026-08" }), now), null);
  assert.equal(jobDashboardReadModelParams(new URLSearchParams({ month: "2026-13" }), now), null);
});
