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

test("Today links its previous-month affordance to the Jobs dashboard and has route loading UI", () => {
  const page = source("src/app/today/page.tsx");
  assert.match(page, /prevHref=\{`\/jobs\?month=\$\{priorMonthKey\}`\}/);
  assert.match(source("src/app/today/loading.tsx"), /aria-label="Loading Today"/);
});
