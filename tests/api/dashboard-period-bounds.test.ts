import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const monthlyRoutes = [
  "src/app/api/jobs/route.ts",
  "src/app/api/jobs/records/route.ts",
  "src/app/api/quotes/route.ts",
  "src/app/api/technicians/route.ts",
  "src/app/api/materials/route.ts",
  "src/app/api/materials/item-jobs/route.ts",
  "src/app/api/materials/csv/route.ts",
];

test("every monthly dashboard GET or download route rejects unsupported periods", () => {
  for (const relativePath of monthlyRoutes) {
    const source = readFileSync(path.join(process.cwd(), relativePath), "utf8");
    assert.match(source, /boundedDashboardPeriodStart/, `${relativePath} must use the shared period bound`);
    assert.match(source, /supported reporting range/, `${relativePath} must return an explicit range error`);
    assert.match(source, /status:\s*400/, `${relativePath} must return HTTP 400`);
  }
});
