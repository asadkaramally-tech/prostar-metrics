import assert from "node:assert/strict";
import test from "node:test";
import { jobDrilldownRecordsParams } from "../../src/app/api/jobs/records/route";

test("jobs records API normalizes the requested month", () => {
  assert.equal(jobDrilldownRecordsParams(new URLSearchParams({ month: "2026-06" })), "2026-06");
});
