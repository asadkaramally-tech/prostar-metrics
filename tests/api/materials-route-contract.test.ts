import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

function source(relativePath: string) {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

test("materials CSV carries the same allow-listed review filters as the page", () => {
  const csv = source("src/app/api/materials/csv/route.ts");
  assert.match(csv, /filterMaterialsItems/);
  assert.match(csv, /materialsSearchParam/);
  assert.match(csv, /materialsCategoryParam/);
  assert.match(csv, /materialsSortParam/);
});

test("material item drill remains local and returns enriched job facts", () => {
  const route = source("src/app/api/materials/item-jobs/route.ts");
  assert.match(route, /getMaterialsItemJobs/);
  assert.match(route, /jobIds: jobs\.map/);
  assert.doesNotMatch(route, /simpro/i);
});
