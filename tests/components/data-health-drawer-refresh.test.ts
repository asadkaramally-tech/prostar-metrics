import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("owner diagnostics exposes bounded enqueue controls and polls queue status", async () => {
  const source = await readFile(
    new URL("../../src/components/data-health-drawer.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /fetch\("\/api\/data-refresh", \{ cache: "no-store" \}\)/);
  assert.match(source, /window\.setInterval\([^]*5_000\)/);
  assert.match(source, /event\.key !== "Tab" \|\| !panelRef\.current/);
  assert.match(source, /document\.activeElement === first/);
  assert.match(source, /document\.activeElement === last/);
  assert.match(source, /ref=\{panelRef\}/);
  assert.match(source, /data-health-mobile-trigger/);
  assert.match(source, /kind: "entity_refresh"|"entity_refresh"/);
  assert.match(source, /"period_backfill"/);
  assert.match(source, /type="month"/);
  assert.match(source, /min="2023-01"/);
  assert.doesNotMatch(source, /invoice|customer_invoice/i);
});
