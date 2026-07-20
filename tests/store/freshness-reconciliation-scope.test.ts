import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { reconciliationScopeForPage } from "../../src/lib/store/freshness";

test("commission freshness uses authoritative job reconciliation", () => {
  assert.equal(reconciliationScopeForPage("commissions"), "jobs");
  assert.equal(reconciliationScopeForPage("quotes"), "quotes");
  assert.equal(reconciliationScopeForPage("jobs"), "jobs");
  assert.equal(reconciliationScopeForPage("technicians"), "technicians");
});

test("current freshness combines sealed manifests with operational run and watermark evidence", async () => {
  const source = await readFile(new URL("../../src/lib/store/freshness.ts", import.meta.url), "utf8");
  assert.match(source, /from metrics\.ingestion_runs/);
  assert.match(source, /from metrics\.ingestion_watermarks/);
  assert.match(source, /from metrics\.ingestion_jobs/);
  assert.match(source, /coalesce\(manifest\.completed_at, manifest\.evidence_as_of\) as last_change_at/);
  assert.match(source, /coalesce\(watermark\.expected_through, watermark\.committed_date_logged, watermark\.last_success_at\)/);
  assert.match(source, /\[reconciliationScopeForPage\(pageKey\), selectedPeriod\]/);
});
