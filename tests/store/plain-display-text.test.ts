import assert from "node:assert/strict";
import test from "node:test";
import { plainDisplayText } from "../../src/lib/text/plain-display-text";

test("plain display text strips Simpro HTML and decodes common entities", () => {
  assert.equal(
    plainDisplayText('<div>Boiler &amp; tank</div><ul><li>Replace&nbsp;pump</li></ul>', "Fallback"),
    "Boiler & tank Replace pump",
  );
});

test("plain display text uses a fallback and bounds oversized labels", () => {
  assert.equal(plainDisplayText("<br>", "Job 100"), "Job 100");
  assert.equal(plainDisplayText("abcdefghij", "Fallback", 8), "abcde...");
});
