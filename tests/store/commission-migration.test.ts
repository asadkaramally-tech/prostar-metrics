import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../../infra/db/migrations/008_commission_lifecycle.sql", import.meta.url);
const evidenceMigrationUrl = new URL("../../infra/db/migrations/015_commission_manifest_evidence.sql", import.meta.url);

test("migration 008 defines commission lifecycle, manifests, protection, and idempotent exports", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  for (const contract of [
    "edit_revision",
    "current_run_id",
    "supersedes_period_id",
    "calculation_stale",
    "source_changed_after_export",
    "commission_overrides_active_field_idx",
    "read_model jsonb",
    "content_bytes bytea",
    "commission_exports_run_type_hash_idx",
    "reject_commission_immutable_change",
    "protect_commission_period_revision",
  ]) assert.match(sql, new RegExp(contract));
  assert.match(sql, /old\.status = 'locked'/);
  assert.match(sql, /exported commission revisions require a new draft revision/i);
  assert.match(sql, /commission export identity and content are immutable/i);
});

test("migration 015 adds fail-closed period evidence validation", async () => {
  const sql = await readFile(evidenceMigrationUrl, "utf8");
  for (const contract of [
    "source_evidence jsonb",
    "commission_source_evidence_complete",
    "peopleFieldMapping",
    "quoteLabor",
    "matchedReconciliations",
  ]) assert.match(sql, new RegExp(contract));
});
