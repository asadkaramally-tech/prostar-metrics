import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("bounded refresh API uses the existing owner role policy and only enqueues store work", async () => {
  const source = await readFile(
    new URL("../../src/app/api/data-refresh/route.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /getCurrentUser\(\)/);
  assert.match(source, /assertRole\(user, \["admin"\]\)/);
  assert.match(source, /enqueueBoundedSourceWork/);
  assert.match(source, /listBoundedSourceWorkRequests/);
  assert.doesNotMatch(source, /SimproClient|SimproEndpoints|fetch\([^)]*simpro/i);
});
