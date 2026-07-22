import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const migrationDirectory = fileURLToPath(new URL("../../infra/db/migrations/", import.meta.url));
const migration052 = "052_close_july_quote_backfills_from_source_period_authority.sql";

test("migration 052 closes only exact authoritative July quote ledgers and audits each transition", async () => {
  const db = new PGlite();
  try {
    const migrations = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
    for (const migration of migrations.filter((file) => file < migration052)) {
      await db.exec(await readFile(`${migrationDirectory}/${migration}`, "utf8"));
    }

    await seedLedger(db, "quotes", "2026-07-01", 6);
    await seedLedger(db, "quote_nested", "2026-07-01", 7);
    await seedLedger(db, "jobs", "2026-07-01", 8);
    await seedLedger(db, "quotes", "2026-06-01", 9);
    await seedManifest(db, "quotes", "2026-07-01", 6, 21, 21);
    await seedManifest(db, "quote_nested", "2026-07-01", 7, 22, 21);
    await seedManifest(db, "jobs", "2026-07-01", 8, 23, 23);
    await seedManifest(db, "quotes", "2026-06-01", 9, 24, 24);

    const sql052 = await readFile(`${migrationDirectory}/${migration052}`, "utf8");
    await db.exec(sql052);

    assert.deepEqual(await ledgerStates(db), [
      ["jobs", "2026-07-01", "queued"],
      ["quote_nested", "2026-07-01", "queued"],
      ["quotes", "2026-06-01", "queued"],
      ["quotes", "2026-07-01", "completed"],
    ]);

    const completedQuote = await db.query<{
      work_phase: string;
      reconciliation_status: string;
      reconciled_source_records: number;
      reconciled_normalized_records: number;
      normalized_coverage: string;
      reconciliation_detail: Record<string, unknown>;
      continuation_token: unknown;
      last_error: string | null;
      dead_lettered_at: string | null;
      completed_at: string | null;
    }>(`
      select work_phase, reconciliation_status, reconciled_source_records,
             reconciled_normalized_records, normalized_coverage::text,
             reconciliation_detail, continuation_token, last_error,
             dead_lettered_at::text, completed_at::text
        from metrics.backfill_source_month_ledger
       where source_family = 'quotes' and month_start = date '2026-07-01'
    `);
    assert.deepEqual(completedQuote.rows[0], {
      work_phase: "reconcile",
      reconciliation_status: "matched",
      reconciled_source_records: 6,
      reconciled_normalized_records: 6,
      normalized_coverage: "100.0000",
      reconciliation_detail: {
        authority: "source_period_manifest",
        migration: "052_close_july_quote_backfills_from_source_period_authority",
        listedCount: 6,
        detailCount: 6,
        normalizedCount: 6,
        manifestGeneration: 21,
        reconciliationGeneration: 21,
        expectedPageCount: 3,
        completedPageCount: 3,
        reconciledAt: completedQuote.rows[0].reconciliation_detail.reconciledAt,
      },
      continuation_token: null,
      last_error: null,
      dead_lettered_at: null,
      completed_at: completedQuote.rows[0].completed_at,
    });
    assert.ok(completedQuote.rows[0].reconciliation_detail.reconciledAt);
    assert.ok(completedQuote.rows[0].completed_at);
    await assertAuditRows(db, ["quotes"]);

    await db.exec(`
      update metrics.source_period_manifests
         set reconciliation_generation = manifest_generation
       where source_family = 'quote_nested' and period_start = date '2026-07-01'
    `);
    await db.exec(sql052);
    assert.deepEqual(await ledgerStates(db), [
      ["jobs", "2026-07-01", "queued"],
      ["quote_nested", "2026-07-01", "completed"],
      ["quotes", "2026-06-01", "queued"],
      ["quotes", "2026-07-01", "completed"],
    ]);
    await assertAuditRows(db, ["quote_nested", "quotes"]);

    await db.exec(sql052);
    await assertAuditRows(db, ["quote_nested", "quotes"]);
  } finally {
    await db.close();
  }
});

async function seedLedger(db: PGlite, sourceFamily: string, monthStart: string, expectedRecords: number) {
  await db.query(`
    insert into metrics.backfill_source_month_ledger (
      source_family, month_start, month_end_exclusive, expected_pages, expected_records,
      estimated_nested_requests, estimated_requests, daily_request_ceiling,
      approved_by, approved_at, plan_hash, status, continuation_token,
      last_error, dead_lettered_at
    ) values (
      $1, $2::date, ($2::date + interval '1 month')::date, 3, $3,
      0, 3, 10000, 'test@example.com', now(), repeat('c', 64), 'queued',
      '{"page":4}'::jsonb, 'stale quote backfill error', '2026-07-10T12:00:00.000Z'
    )
  `, [sourceFamily, monthStart, expectedRecords]);
}

async function seedManifest(
  db: PGlite,
  sourceFamily: string,
  monthStart: string,
  count: number,
  manifestGeneration: number,
  reconciliationGeneration: number,
) {
  await db.query(`
    insert into metrics.source_period_manifests (
      source_family, period_start, period_end, coverage_status, reconciliation_status,
      listed_count, detail_count, normalized_count, source_id_hash, normalized_id_hash,
      continuation_token, evidence_as_of, completed_at, manifest_generation,
      reconciliation_generation, expected_page_count, completed_page_count, reconciled_at
    ) values (
      $1, $2::date, ($2::date + interval '1 month - 1 day')::date, 'complete', 'matched',
      $3, $3, $3, repeat('d', 64), repeat('d', 64), null, now(), now(), $4, $5,
      3, 3, now()
    )
  `, [sourceFamily, monthStart, count, manifestGeneration, reconciliationGeneration]);
}

async function ledgerStates(db: PGlite) {
  const result = await db.query<{ source_family: string; month_start: string; status: string }>(`
    select source_family, month_start::text, status
      from metrics.backfill_source_month_ledger
     order by source_family, month_start
  `);
  return result.rows.map((row) => [row.source_family, row.month_start, row.status]);
}

async function assertAuditRows(db: PGlite, expectedFamilies: string[]) {
  const result = await db.query<{
    source_family: string;
    before_status: string;
    after_status: string;
    actor_email: string;
  }>(`
    select before_value->>'source_family' as source_family,
           before_value->>'status' as before_status,
           after_value->>'status' as after_status,
           actor_email
      from metrics.audit_events
     where action = 'july_quote_backfill_completed_from_source_period_authority'
     order by source_family
  `);
  assert.deepEqual(result.rows, expectedFamilies.map((sourceFamily) => ({
    source_family: sourceFamily,
    before_status: "queued",
    after_status: "completed",
    actor_email: "system:migration-052",
  })));
}
