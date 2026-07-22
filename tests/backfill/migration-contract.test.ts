import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationPath = new URL("../../infra/db/migrations/007_historical_backfill_ledger.sql", import.meta.url);
const authoritativeMigrationPath = new URL("../../infra/db/migrations/016_authoritative_backfill_manifest.sql", import.meta.url);
const nestedTraversalGenerationMigrationPath = new URL("../../infra/db/migrations/029_nested_traversal_generation.sql", import.meta.url);
const sourcePeriodAuthorityMigrationPath = new URL(
  "../../infra/db/migrations/051_complete_backfill_ledger_from_source_period_authority.sql",
  import.meta.url,
);
const julyQuoteAuthorityMigrationPath = new URL(
  "../../infra/db/migrations/052_close_july_quote_backfills_from_source_period_authority.sql",
  import.meta.url,
);

test("migration 007 defines capacity, source/month, run, and reconciliation ledgers", async () => {
  const sql = await readFile(migrationPath, "utf8");

  for (const relation of [
    "metrics.backfill_capacity_days",
    "metrics.backfill_source_month_ledger",
    "metrics.backfill_work_unit_runs",
    "metrics.backfill_reconciliation_results",
    "metrics.backfill_month_coverage",
  ]) {
    assert.match(sql, new RegExp(relation.replaceAll(".", "\\.")));
  }
  assert.match(sql, /backfill_request_percent <= 25/);
  assert.match(sql, /current_request_percent >= 60/);
  assert.match(sql, /reconciliation_request_percent >= 15/);
  assert.match(sql, /request_slice_limit between 1 and 250/);
  assert.match(sql, /max_attempts between 1 and 5/);
  assert.match(sql, /backfill_completion_gate_check/);
  assert.match(sql, /reconciliation_status = 'matched'/);
  assert.match(sql, /domain rollups/i);
});

test("migration 016 persists and gates authoritative traversal proof", async () => {
  const sql = await readFile(authoritativeMigrationPath, "utf8");

  for (const relation of [
    "metrics.backfill_traversal_manifests",
    "metrics.backfill_traversal_pages",
    "metrics.backfill_repair_plans",
  ]) {
    assert.match(sql, new RegExp(relation.replaceAll(".", "\\.")));
  }
  assert.match(sql, /exact_source_ids/);
  assert.match(sql, /required_target_keys/);
  assert.match(sql, /as_of_watermark/);
  assert.match(sql, /observed_boundary/);
  assert.match(sql, /empty_proof/);
  assert.match(sql, /open_quote_discovery/);
  assert.match(sql, /enforce_authoritative_backfill_manifest/);
  assert.match(sql, /record_authoritative_backfill_slice/);
  assert.match(sql, /backfill_declared_total_capacity_check/);
  assert.match(sql, /destructive_write_performed boolean not null default false/);
});

test("migration 029 gives every project child row a monotonic traversal generation", async () => {
  const sql = await readFile(nestedTraversalGenerationMigrationPath, "utf8");

  assert.match(sql, /create table if not exists metrics\.project_nested_traversals/);
  for (const relation of [
    "metrics_quote_cost_centers",
    "metrics_job_cost_centers",
    "metrics_quote_labor",
    "metrics_job_labor",
    "metrics_quote_items",
    "metrics_job_items",
    "metrics_work_orders",
    "metrics_schedules",
    "schedule_snapshots",
    "metrics_schedule_blocks",
  ]) {
    assert.match(sql, new RegExp(`alter table metrics\\.${relation}[\\s\\S]*?traversal_generation bigint`));
  }
  assert.match(sql, /status in \('active', 'completed', 'source_deleted'\)/);
});

test("migration 051 accepts fenced source-period authority and narrowly repairs July ledger rows", async () => {
  const sql = await readFile(sourcePeriodAuthorityMigrationPath, "utf8");

  assert.match(sql, /create or replace function metrics\.enforce_authoritative_backfill_manifest/);
  assert.match(sql, /source_manifest\.coverage_status = 'complete'/);
  assert.match(sql, /source_manifest\.reconciliation_status = 'matched'/);
  assert.match(sql, /source_manifest\.reconciliation_generation = source_manifest\.manifest_generation/);
  assert.match(sql, /source_manifest\.expected_page_count > 0/);
  assert.match(sql, /source_manifest\.completed_page_count = source_manifest\.expected_page_count/);
  assert.match(sql, /ledger\.month_start = date '2026-07-01'/);
  assert.match(sql, /ledger\.source_family <> 'invoices'/);
  assert.match(sql, /ledger\.status = 'queued'/);
  assert.match(sql, /'system:migration-051'/);
  assert.match(sql, /'backfill_source_month_ledger'/);
});

test("migration 052 twice-safely closes only authoritative July quote ledger rows", async () => {
  const sql = await readFile(julyQuoteAuthorityMigrationPath, "utf8");

  assert.match(sql, /ledger\.month_start = date '2026-07-01'/);
  assert.match(sql, /ledger\.source_family in \('quotes', 'quote_nested'\)/);
  assert.match(sql, /ledger\.status = 'queued'/);
  assert.match(sql, /source_manifest\.coverage_status = 'complete'/);
  assert.match(sql, /source_manifest\.reconciliation_status = 'matched'/);
  assert.match(sql, /source_manifest\.reconciliation_generation = source_manifest\.manifest_generation/);
  assert.match(sql, /source_manifest\.expected_page_count > 0/);
  assert.match(sql, /source_manifest\.completed_page_count = source_manifest\.expected_page_count/);
  assert.match(sql, /'system:migration-052'/);
  assert.match(sql, /to_jsonb\(ledger\) as before_value/);
  assert.match(sql, /to_jsonb\(ledger\) as after_value/);
});
