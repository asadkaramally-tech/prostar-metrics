import assert from "node:assert/strict";
import test from "node:test";
import { reprojectImportedJobCategories } from "@/lib/store/job-category-rebuild";
import type { PostgresQuery } from "@/lib/store/postgres";

test("job category projection repairs child mappings before parent projection", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const query: PostgresQuery = async <T>(sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    return { rows: [{ children_updated: "3", jobs_updated: "2" }] as T[], rowCount: 1 };
  };
  const result = await reprojectImportedJobCategories([2, 1, 2], query);

  assert.deepEqual(result, { childrenUpdated: 3, jobsUpdated: 2 });
  assert.deepEqual(calls[0]?.values, [[2, 1]]);
  assert.match(calls[0]?.sql ?? "", /child_updated/);
  assert.match(calls[0]?.sql ?? "", /canonical_updated/);
  assert.match(calls[0]?.sql ?? "", /configured_cost_center_id/);
});

test("job category projection rejects invalid IDs and skips an empty batch", async () => {
  let calls = 0;
  const query: PostgresQuery = async <T>() => {
    calls += 1;
    return { rows: [] as T[], rowCount: 0 };
  };
  assert.deepEqual(await reprojectImportedJobCategories([], query), { childrenUpdated: 0, jobsUpdated: 0 });
  await assert.rejects(() => reprojectImportedJobCategories([0], query), /positive integers/);
  assert.equal(calls, 0);
});
