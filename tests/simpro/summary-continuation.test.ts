import assert from "node:assert/strict";
import test from "node:test";
import { planSummaryRows } from "../../src/lib/simpro/ingest";

test("every discovered summary row becomes a durable detail candidate", () => {
  const rows = [{ ID: 41, Name: "A" }, { ID: 42, Name: "B" }];
  for (const [source, expected] of [
    ["quotes", "quote_nested"],
    ["jobs", "job_nested"],
    ["employees", "employees"],
    ["schedules", "schedules"],
  ] as const) {
    const planned = planSummaryRows(source, rows);
    assert.equal(planned.length, rows.length);
    assert.deepEqual(planned.map((row) => row.candidate.entity), [expected, expected]);
    assert.deepEqual(planned.map((row) => row.candidate.entityId), [41, 42]);
    assert.ok(planned.every((row) => row.candidate.sourceHash.length === 64));
  }
});

test("invalid summary IDs cannot create detail work", () => {
  assert.deepEqual(planSummaryRows("jobs", [{ ID: null }, { ID: -1 }, { Name: "missing" }]), []);
});
