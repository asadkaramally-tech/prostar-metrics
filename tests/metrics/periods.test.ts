import assert from "node:assert/strict";
import test from "node:test";
import {
  boundedDashboardPeriodStart,
  monthParamToPeriodStart,
  periodStartToMonthKey,
} from "../../src/lib/metrics/periods";

test("monthParamToPeriodStart accepts valid dashboard month params", () => {
  assert.equal(monthParamToPeriodStart("2026-06"), "2026-06-01");
});

test("monthParamToPeriodStart rejects malformed or impossible months", () => {
  assert.equal(monthParamToPeriodStart(null), undefined);
  assert.equal(monthParamToPeriodStart("2026-6"), undefined);
  assert.equal(monthParamToPeriodStart("2026-13"), undefined);
  assert.equal(monthParamToPeriodStart("latest"), undefined);
});

test("periodStartToMonthKey converts first-of-month period starts", () => {
  assert.equal(periodStartToMonthKey("2026-06-01"), "2026-06");
  assert.equal(periodStartToMonthKey("2026-06-02"), undefined);
});

test("boundedDashboardPeriodStart rejects prehistory, future, and malformed deep links", () => {
  const now = new Date("2026-07-15T19:00:00.000Z");
  assert.equal(boundedDashboardPeriodStart("2022-12", now), null);
  assert.equal(boundedDashboardPeriodStart("2027-01", now), null);
  assert.equal(boundedDashboardPeriodStart("2026-13", now), null);
  assert.equal(boundedDashboardPeriodStart("2024-04", now), "2024-04-01");
});

test("boundedDashboardPeriodStart uses the Pacific month at UTC boundaries", () => {
  const stillJuneInPacific = new Date("2026-07-01T06:30:00.000Z");
  assert.equal(boundedDashboardPeriodStart(undefined, stillJuneInPacific), "2026-06-01");
  assert.equal(boundedDashboardPeriodStart("2026-07", stillJuneInPacific), null);
});
