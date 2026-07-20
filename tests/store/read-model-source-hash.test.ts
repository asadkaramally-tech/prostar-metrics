import assert from "node:assert/strict";
import test from "node:test";
import { readModelSourceHash } from "../../src/lib/store/read-model-rebuilds";

test("read model source hashes ignore generation timestamps and object key order", () => {
  const first = readModelSourceHash({
    generatedAt: "2026-07-10T21:00:00.000Z",
    dashboard: { total: 10, generatedAt: "2026-07-10T21:00:00.000Z", count: 2 },
  });
  const second = readModelSourceHash({
    dashboard: { count: 2, generatedAt: "2026-07-10T22:00:00.000Z", total: 10 },
    generatedAt: "2026-07-10T22:00:00.000Z",
  });

  assert.equal(first, second);
  assert.notEqual(first, readModelSourceHash({ dashboard: { count: 3, total: 10 } }));
});
