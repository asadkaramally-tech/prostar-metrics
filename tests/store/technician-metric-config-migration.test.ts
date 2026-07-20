import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("verified technician mobile semantics are persisted with evidence and disjoint statuses", async () => {
  const sql = await readFile(
    new URL("../../infra/db/migrations/018_verified_technician_mobile_semantics.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /arrival_status_ids.*array\[40\]/s);
  assert.match(sql, /completion_status_ids.*array\[38, 39, 42, 70\]/s);
  assert.match(sql, /not \(arrival_status_ids && completion_status_ids\)/);
  assert.match(sql, /sourceManifestSha256/);
  assert.match(sql, /technician_mobile_semantics_verified/);
});
