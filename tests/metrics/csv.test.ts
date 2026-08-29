import assert from "node:assert/strict";
import test from "node:test";
import { csvCell } from "../../src/lib/csv";

test("csvCell neutralizes spreadsheet formulas in source text", () => {
  assert.equal(csvCell("=HYPERLINK(\"https://example.test\")"), `"'=HYPERLINK(""https://example.test"")"`);
  assert.equal(csvCell(" +SUM(A1:A2)"), "' +SUM(A1:A2)");
  assert.equal(csvCell("@cmd"), "'@cmd");
});

test("csvCell preserves numeric negatives and ordinary escaped text", () => {
  assert.equal(csvCell(-42.5), "-42.5");
  assert.equal(csvCell('3/4" Gas'), `"3/4"" Gas"`);
});
