import assert from "node:assert/strict";
import test from "node:test";
import { boundedLimit } from "../../src/lib/store/queue-repairs";

test("queue repair limits are explicitly bounded", () => {
  assert.equal(boundedLimit(1), 1);
  assert.equal(boundedLimit(100), 100);
  assert.throws(() => boundedLimit(0), /1 through 100/);
  assert.throws(() => boundedLimit(101), /1 through 100/);
  assert.throws(() => boundedLimit(1.5), /1 through 100/);
});
