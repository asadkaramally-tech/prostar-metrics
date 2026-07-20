import assert from "node:assert/strict";
import test from "node:test";
import { calculateOverlapStart, compareLogCursor } from "../../src/lib/simpro/ingest-change-logs";

test("change-log cursor orders same-timestamp events by Simpro log ID", () => {
  const earlier = { dateLogged: "2026-07-09T22:52:47.000Z", logId: 150551 };
  const later = { dateLogged: "2026-07-09T22:52:47.000Z", logId: 150552 };

  assert.equal(compareLogCursor(later, earlier) > 0, true);
  assert.equal(compareLogCursor(earlier, later) < 0, true);
});

test("incremental overlap starts two hours before the committed boundary", () => {
  assert.equal(
    calculateOverlapStart("2026-07-09T23:05:56.000Z", new Date("2026-07-10T00:00:00.000Z")),
    "2026-07-09T21:05:56.000Z",
  );
});

test("first change-log poll uses a bounded two-hour window", () => {
  assert.equal(
    calculateOverlapStart(null, new Date("2026-07-10T00:00:00.000Z")),
    "2026-07-09T22:00:00.000Z",
  );
});
