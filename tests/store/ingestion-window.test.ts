import assert from "node:assert/strict";
import test from "node:test";
import { inclusivePacificDateWindow, pacificDate } from "../../src/lib/store/ingestion-window";

test("lookback window contains exactly 90 inclusive Pacific dates", () => {
  const window = inclusivePacificDateWindow(90, new Date("2026-07-10T01:00:00.000Z"));
  assert.deepEqual(window, { startDate: "2026-04-11", endDate: "2026-07-09" });
});

test("Pacific date does not advance at UTC midnight or shift across DST", () => {
  assert.equal(pacificDate(new Date("2026-07-10T00:30:00.000Z")), "2026-07-09");
  assert.deepEqual(
    inclusivePacificDateWindow(3, new Date("2026-11-02T01:30:00.000Z")),
    { startDate: "2026-10-30", endDate: "2026-11-01" },
  );
});
