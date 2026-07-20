import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const source = readFileSync(path.join(process.cwd(), "src/lib/store/reconciliation.ts"), "utf8");
const commissionStoreSource = source.slice(
  source.indexOf("async function getCommissionStoreSummary"),
  source.indexOf("async function getLatestCommissionRunSummary"),
);
const commissionReconciliationSource = source.slice(
  source.indexOf("async function reconcileCommissions"),
  source.indexOf("export async function collectDirectSourceMonth"),
);

test("commission reconciliation uses the full completed cohort work value", () => {
  assert.match(commissionStoreSource, /coalesce\(sum\(j\.total\), 0\)::text as total_work_value/);
  assert.doesNotMatch(commissionStoreSource, /sum\(case when t\.hours > 0 then j\.total else 0 end\)/);
});

test("commission reconciliation reads the current immutable run totals", () => {
  assert.match(source, /cr\.completed_jobs::text/);
  assert.match(source, /cr\.total_work_value::text/);
  assert.match(source, /cr\.payroll_total::text/);
  assert.match(source, /join metrics\.commission_calculation_runs cr on cr\.id = cp\.current_run_id/);
  assert.doesNotMatch(source, /cr\.employee_results, cr\.job_allocations/);
});

test("commission publication inherits strict jobs generation and source-manifest authority", () => {
  assert.match(commissionReconciliationSource, /generation: inheritedJobs\?\.generation \?\? null/);
  assert.match(
    commissionReconciliationSource,
    /sourceManifestGenerations: inheritedJobs\?\.sourceManifestGenerations \?\? \{\}/,
  );
  assert.match(source, /source_manifest\.expected_page_count > 0/);
  assert.match(source, /nested_manifest\.expected_page_count > 0/);
  assert.match(source, /A complete reconciliation publication requires a positive generation/);
  assert.match(source, /requires a nonempty positive source manifest generation map/);
});

test("reconciliation drift schedules bounded source or rollup repair", () => {
  assert.match(source, /persistAndScheduleRepair/);
  assert.match(source, /enqueueBoundedSourceWork/);
  assert.match(source, /origin: "reconciliation"/);
  assert.match(source, /enqueueRollupRebuild/);
  assert.match(source, /reconciliation_repair_queued/);
});
