import assert from "node:assert/strict";
import test from "node:test";
import {
  ingestionIdempotencyKey,
  ingestionParamSets,
  parseArgs,
} from "../../workers/ingest-simpro";

test("quote date windows schedule DateApproved and DateIssued candidates with distinct retry keys", () => {
  const args = parseArgs([
    "--entity", "quotes",
    "--start-date", "2026-07-20",
    "--end-date", "2026-07-21",
  ], {});

  const candidates = ingestionParamSets(args);
  assert.deepEqual(candidates, [
    { DateApproved: "2026-07-20" },
    { DateIssued: "2026-07-20" },
    { DateApproved: "2026-07-21" },
    { DateIssued: "2026-07-21" },
  ]);
  assert.equal(ingestionIdempotencyKey("quotes", candidates[0]!), "quotes:date-approved:2026-07-20");
  assert.equal(ingestionIdempotencyKey("quotes", candidates[1]!), "quotes:date-issued:2026-07-20");
});

test("one-day quote windows still schedule both source-date candidates", () => {
  const args = parseArgs([
    "--entity", "quotes",
    "--start-date", "2026-07-21",
    "--end-date", "2026-07-21",
  ], {});

  assert.deepEqual(ingestionParamSets(args), [
    { DateApproved: "2026-07-21" },
    { DateIssued: "2026-07-21" },
  ]);
});

test("explicit project IDs are preserved as targeted ingestion parameters", () => {
  for (const entity of ["quotes", "jobs"] as const) {
    const args = parseArgs(["--entity", entity, "--entity-id", "2797"], {});
    assert.deepEqual(ingestionParamSets(args), [{ entityId: 2797 }]);
    assert.equal(ingestionIdempotencyKey(entity, ingestionParamSets(args)[0]!), `${entity}:2797`);
  }
});
