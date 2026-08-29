import assert from "node:assert/strict";
import test from "node:test";
import { jobDrilldownRecordsParams } from "../../src/lib/api/dashboard-route-params";

test("jobs records API normalizes the requested month", () => {
  assert.equal(jobDrilldownRecordsParams(new URLSearchParams({ month: "2026-06" })), "2026-06");
});

test("jobs records API rejects unsupported reporting months", () => {
  const now = new Date("2026-07-15T19:00:00.000Z");
  assert.equal(jobDrilldownRecordsParams(new URLSearchParams({ month: "2022-12" }), now), null);
  assert.equal(jobDrilldownRecordsParams(new URLSearchParams({ month: "2026-08" }), now), null);
});
