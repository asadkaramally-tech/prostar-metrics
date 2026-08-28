import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "../../workers/repair-backfill-ledger";

test("backfill repair is a bounded dry-run by default", () => {
  assert.deepEqual(parseArgs([
    "--source-family", "jobs",
    "--month-start", "2026-07-01",
    "--error-contains", "Lost backfill lease while reconciling",
  ]), {
    execute: false,
    sourceFamily: "jobs",
    monthStart: "2026-07-01",
    errorContains: "Lost backfill lease while reconciling",
    limit: 5,
    actorEmail: "",
    reason: "",
  });
});

test("backfill repair execution requires an actor and reason", () => {
  assert.throws(() => parseArgs([
    "--source-family", "quotes",
    "--month-start", "2026-07-01",
    "--error-contains", "Lost backfill lease",
    "--execute",
  ]), /actor-email and --reason/);
});

test("backfill repair rejects broad or malformed targets", () => {
  assert.throws(() => parseArgs(["--source-family", "all", "--month-start", "2026-07-01", "--error-contains", "lease"]), /not supported/);
  assert.throws(() => parseArgs(["--source-family", "jobs", "--month-start", "2026-07-02", "--error-contains", "lease"]), /YYYY-MM-01/);
  assert.throws(() => parseArgs(["--source-family", "jobs", "--month-start", "2026-07-01", "--error-contains", "lease", "--limit", "101"]), /1 through 100/);
});
