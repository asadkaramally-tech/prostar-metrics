import assert from "node:assert/strict";
import test from "node:test";
import { buildFreshnessStatus } from "../../src/lib/metrics/freshness";

test("buildFreshnessStatus marks missing data", () => {
  const status = buildFreshnessStatus({ pageKey: "quotes", maxAgeHours: 24 });
  assert.equal(status.state, "missing");
});

test("buildFreshnessStatus marks failed runs while preserving last successful data", () => {
  const status = buildFreshnessStatus({
    pageKey: "quotes",
    dataThrough: "2026-06-27T00:00:00.000Z",
    lastSuccessfulRunAt: "2026-06-27T01:00:00.000Z",
    lastFailedRunAt: "2026-06-27T02:00:00.000Z",
    maxAgeHours: 24,
    now: new Date("2026-06-27T03:00:00.000Z"),
  });

  assert.equal(status.state, "failed");
  assert.match(status.detail, /Showing last successful data/);
});

test("buildFreshnessStatus marks stale and current data", () => {
  assert.equal(
    buildFreshnessStatus({
      pageKey: "jobs",
      dataThrough: "2026-06-25T00:00:00.000Z",
      lastSuccessfulRunAt: "2026-06-25T01:00:00.000Z",
      maxAgeHours: 24,
      now: new Date("2026-06-27T00:00:00.000Z"),
    }).state,
    "stale",
  );

  assert.equal(
    buildFreshnessStatus({
      pageKey: "jobs",
      dataThrough: "2026-06-26T23:00:00.000Z",
      lastSuccessfulRunAt: "2026-06-26T23:30:00.000Z",
      maxAgeHours: 24,
      now: new Date("2026-06-27T00:00:00.000Z"),
    }).state,
    "current",
  );
});

test("buildFreshnessStatus preserves building, partial, and suspect precedence", () => {
  const base = {
    pageKey: "jobs",
    dataThrough: "2026-06-30T23:00:00Z",
    lastSuccessfulRunAt: "2026-06-30T23:05:00Z",
    maxAgeHours: 24,
    now: new Date("2026-07-01T00:00:00Z"),
  };

  assert.equal(buildFreshnessStatus({ ...base, explicitState: "building" }).state, "building");
  assert.equal(buildFreshnessStatus({ ...base, explicitState: "partial" }).state, "partial");
  assert.equal(buildFreshnessStatus({ ...base, explicitState: "suspect" }).state, "suspect");
});
