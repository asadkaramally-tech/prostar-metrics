import assert from "node:assert/strict";
import test from "node:test";
import { applyVerifiedProjectDeltas } from "../../src/lib/store/project-reconciliation-deltas";

test("verified project deltas remove prior cohorts and add only the latest eligible month", () => {
  const source = new Map([
    ["2026-05-01", [
      { id: "1", periodStart: "2026-05-01", total: 100 },
      { id: "2", periodStart: "2026-05-01", total: 200 },
    ]],
  ]);

  applyVerifiedProjectDeltas(source, [
    { id: "1", periodStart: null, total: 100 },
    { id: "2", periodStart: "2026-06-01", total: 250 },
  ]);

  assert.deepEqual(source.get("2026-05-01"), []);
  assert.deepEqual(source.get("2026-06-01"), [
    { id: "2", periodStart: "2026-06-01", total: 250 },
  ]);
});
