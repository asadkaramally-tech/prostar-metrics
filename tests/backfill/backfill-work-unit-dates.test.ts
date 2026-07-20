import assert from "node:assert/strict";
import test from "node:test";
import { normalizeBackfillWorkUnitDates, type BackfillWorkUnit } from "../../src/lib/store/backfill-ledger";

test("claimed backfill work normalizes PostgreSQL Date objects to date-only strings", () => {
  const normalized = normalizeBackfillWorkUnitDates({
    month_start: new Date("2026-07-01T07:00:00.000Z"),
    month_end_exclusive: new Date("2026-08-01T07:00:00.000Z"),
  } as unknown as BackfillWorkUnit & { month_start: unknown; month_end_exclusive: unknown });

  assert.equal(normalized.month_start, "2026-07-01");
  assert.equal(normalized.month_end_exclusive, "2026-08-01");
});

test("claimed backfill work preserves date-only strings and rejects invalid values", () => {
  const normalized = normalizeBackfillWorkUnitDates({
    month_start: "2026-07-01",
    month_end_exclusive: "2026-08-01",
  } as unknown as BackfillWorkUnit & { month_start: unknown; month_end_exclusive: unknown });
  assert.equal(normalized.month_start, "2026-07-01");
  assert.throws(
    () => normalizeBackfillWorkUnitDates({
      month_start: null,
      month_end_exclusive: "2026-08-01",
    } as unknown as BackfillWorkUnit & { month_start: unknown; month_end_exclusive: unknown }),
    /month_start is not a valid database date/,
  );
});
