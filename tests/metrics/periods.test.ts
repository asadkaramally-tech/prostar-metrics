import assert from "node:assert/strict";
import test from "node:test";
import { monthParamToPeriodStart, periodStartToMonthKey } from "../../src/lib/metrics/periods";

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
