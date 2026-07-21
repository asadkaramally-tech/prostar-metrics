import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs, resolveMonths } from "../../workers/ingest-materials";

const emptyEnv = {};

// 2026-07-18 13:00 America/Los_Angeles.
const JULY_18 = new Date("2026-07-18T20:00:00Z");

test("scheduled default uses bounded incremental mode and a seven-day hot window", () => {
  const args = parseArgs([], emptyEnv);
  assert.equal(args.mode, "incremental");
  assert.equal(args.hotWindowDays, 7);
  assert.equal(args.monthsBack, 1);
  assert.equal(args.rebuild, true);
  assert.equal(args.autoClosePriorMonth, false);
  // The helper remains the explicit full-month plan; default main no longer
  // calls it during a scheduled incremental pass.
  assert.deepEqual(resolveMonths(args, JULY_18), ["2026-06-01", "2026-07-01"]);
});

test("scheduled infrastructure can enable an idempotent prior-month close", () => {
  const args = parseArgs(["--auto-close-prior-month"], emptyEnv);
  assert.equal(args.mode, "incremental");
  assert.equal(args.autoClosePriorMonth, true);
});

test("single-month and backfill range modes resolve inclusive month lists", () => {
  const month = parseArgs(["--month", "2026-06"], emptyEnv);
  assert.equal(month.mode, "full-month");
  assert.deepEqual(resolveMonths(month, JULY_18), ["2026-06-01"]);
  assert.deepEqual(
    resolveMonths(parseArgs(["--from", "2025-11", "--to", "2026-02"], emptyEnv), JULY_18),
    ["2025-11-01", "2025-12-01", "2026-01-01", "2026-02-01"],
  );
});

test("explicit full-month mode is retained for month sealing and backfills", () => {
  const args = parseArgs(["--mode", "full-month", "--months-back", "2"], emptyEnv);
  assert.equal(args.mode, "full-month");
  assert.deepEqual(resolveMonths(args, JULY_18), ["2026-05-01", "2026-06-01", "2026-07-01"]);
  assert.throws(() => parseArgs(["--mode", "unsafe"], emptyEnv), /--mode must be/);
  assert.throws(() => parseArgs(["--hot-window-days", "32"], emptyEnv), /--hot-window-days/);
});

test("invalid month arguments fail closed", () => {
  assert.throws(() => resolveMonths(parseArgs(["--from", "2026-07", "--to", "2026-01"], emptyEnv)), /--from must not be after/);
  assert.throws(() => resolveMonths(parseArgs(["--month", "2026-13"], emptyEnv)), /YYYY-MM/);
  assert.throws(() => parseArgs(["--month", "2026-06", "--from", "2026-01", "--to", "2026-02"], emptyEnv), /not both/);
  assert.throws(() => parseArgs(["--unknown"], emptyEnv), /Unknown argument/);
  assert.throws(() => parseArgs(["--request-limit", "1"], emptyEnv), /--request-limit/);
});
