import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

function source(relativePath: string) {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

test("materials month navigation resets table pagination", () => {
  const page = source("src/app/materials/page.tsx");
  assert.match(page, /<PeriodSelector action="\/materials" value=/);
  assert.doesNotMatch(page, /hiddenFields=\{\{ page:/);
});

test("Today's Profitability is a live-date screen and has route loading UI", () => {
  const page = source("src/app/today/page.tsx");
  assert.match(page, /title="Today's Profitability"/);
  assert.match(page, /freshness=\{model\.freshness\.jobs\}/);
  assert.doesNotMatch(page, /PeriodSelector|MonthStepper/);
  assert.match(source("src/app/today/loading.tsx"), /aria-label="Loading Today's Profitability"/);
});
