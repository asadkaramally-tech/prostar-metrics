import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs, resolveMonths } from "../../workers/ingest-materials";

const emptyEnv = {};

// 2026-07-18 13:00 America/Los_Angeles.
const JULY_18 = new Date("2026-07-18T20:00:00Z");

test("scheduled default walks the current Pacific month plus the prior month", () => {
  const args = parseArgs([], emptyEnv);
  assert.equal(args.monthsBack, 1);
  assert.equal(args.rebuild, true);
  assert.deepEqual(resolveMonths(args, JULY_18), ["2026-06-01", "2026-07-01"]);
});

test("single-month and backfill range modes resolve inclusive month lists", () => {
  assert.deepEqual(resolveMonths(parseArgs(["--month", "2026-06"], emptyEnv), JULY_18), ["2026-06-01"]);
  assert.deepEqual(
    resolveMonths(parseArgs(["--from", "2025-11", "--to", "2026-02"], emptyEnv), JULY_18),
    ["2025-11-01", "2025-12-01", "2026-01-01", "2026-02-01"],
  );
});

test("invalid month arguments fail closed", () => {
  assert.throws(() => resolveMonths(parseArgs(["--from", "2026-07", "--to", "2026-01"], emptyEnv)), /--from must not be after/);
  assert.throws(() => resolveMonths(parseArgs(["--month", "2026-13"], emptyEnv)), /YYYY-MM/);
  assert.throws(() => parseArgs(["--month", "2026-06", "--from", "2026-01", "--to", "2026-02"], emptyEnv), /not both/);
  assert.throws(() => parseArgs(["--unknown"], emptyEnv), /Unknown argument/);
  assert.throws(() => parseArgs(["--request-limit", "1"], emptyEnv), /--request-limit/);
});
