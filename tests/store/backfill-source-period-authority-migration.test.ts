import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const migrationDirectory = fileURLToPath(new URL("../../infra/db/migrations/", import.meta.url));
const migration051 = "051_complete_backfill_ledger_from_source_period_authority.sql";

test("migration 051 repairs only July queued non-invoice rows with exact source-period authority", async () => {
  const db = new PGlite();
  try {
    const migrations = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
    for (const migration of migrations.filter((file) => file < migration051)) {
      await db.exec(await readFile(`${migrationDirectory}/${migration}`, "utf8"));
    }

    await seedLedger(db, "employees", "2026-07-01", {
      continuation: { page: 9 },
      lastError: "stale worker failure",
      deadLetteredAt: "2026-07-10T12:00:00.000Z",
    });
    await seedLedger(db, "jobs", "2026-07-01");
    await seedLedger(db, "schedules", "2026-07-01");
    await seedLedger(db, "invoices", "2026-07-01");
    await seedLedger(db, "quotes", "2026-06-01");

    await seedManifest(db, "employees", "2026-07-01", { listedCount: 4, generation: 11 });
    await seedManifest(db, "schedules", "2026-07-01", {
      listedCount: 3,
      generation: 12,
      reconciliationGeneration: 11,
    });
    await seedManifest(db, "invoices", "2026-07-01", { listedCount: 2, generation: 13 });
    await seedManifest(db, "quotes", "2026-06-01", { listedCount: 5, generation: 14 });

    const sql051 = await readFile(`${migrationDirectory}/${migration051}`, "utf8");
    await db.exec(sql051);

    const rows = await db.query<{
      source_family: string;
      month_start: string;
      status: string;
      work_phase: string;
      reconciliation_status: string;
      reconciled_source_records: number | null;
      reconciled_normalized_records: number | null;
      normalized_coverage: string | null;
      reconciliation_detail: Record<string, unknown>;
      continuation_token: unknown;
      last_error: string | null;
      dead_lettered_at: string | null;
      completed_at: string | null;
    }>(`
      select source_family, month_start::text, status, work_phase, reconciliation_status,
             reconciled_source_records, reconciled_normalized_records,
             normalized_coverage::text, reconciliation_detail, continuation_token,
             last_error, dead_lettered_at::text, completed_at::text
        from metrics.backfill_source_month_ledger
       order by source_family, month_start
    `);
    const employee = rows.rows.find((row) => row.source_family === "employees");
    assert.ok(employee);
    assert.equal(employee.status, "completed");
    assert.equal(employee.work_phase, "reconcile");
    assert.equal(employee.reconciliation_status, "matched");
    assert.equal(employee.reconciled_source_records, 4);
    assert.equal(employee.reconciled_normalized_records, 4);
    assert.equal(employee.normalized_coverage, "100.0000");
    assert.equal(employee.reconciliation_detail.authority, "source_period_manifest");
    assert.equal(employee.reconciliation_detail.manifestGeneration, 11);
    assert.equal(employee.continuation_token, null);
    assert.equal(employee.last_error, null);
    assert.equal(employee.dead_lettered_at, null);
    assert.ok(employee.completed_at);

    assert.deepEqual(
      rows.rows
        .filter((row) => row.source_family !== "employees")
        .map((row) => [row.source_family, row.month_start, row.status]),
      [
        ["invoices", "2026-07-01", "cancelled"],
        ["jobs", "2026-07-01", "queued"],
        ["quotes", "2026-06-01", "queued"],
        ["schedules", "2026-07-01", "queued"],
      ],
    );

    const audits = await db.query<{
      actor_email: string;
      entity_id: string;
      before_value: Record<string, unknown>;
      after_value: Record<string, unknown>;
    }>(`
      select actor_email, entity_id, before_value, after_value
        from metrics.audit_events
       where action = 'backfill_ledger_completed_from_source_period_authority'
    `);
    assert.equal(audits.rows.length, 1);
    assert.equal(audits.rows[0].actor_email, "system:migration-051");
    assert.equal(audits.rows[0].before_value.status, "queued");
    assert.equal(audits.rows[0].after_value.status, "completed");
    assert.equal(audits.rows[0].entity_id, String(audits.rows[0].after_value.id));

    await db.exec(`
      update metrics.backfill_source_month_ledger
         set reconciliation_status = 'matched', status = 'completed'
       where source_family = 'quotes' and month_start = date '2026-06-01'
    `);
    await assert.rejects(
      db.exec(`
        update metrics.backfill_source_month_ledger
           set reconciliation_status = 'matched', status = 'completed'
         where source_family = 'schedules' and month_start = date '2026-07-01'
      `),
      /cannot match or complete without an authoritative traversal manifest/,
    );

    await db.exec(sql051);
    const auditCount = await db.query<{ count: number }>(`
      select count(*)::integer as count
        from metrics.audit_events
       where action = 'backfill_ledger_completed_from_source_period_authority'
    `);
    assert.equal(auditCount.rows[0].count, 1);
  } finally {
    await db.close();
  }
});

async function seedLedger(
  db: PGlite,
  sourceFamily: string,
  monthStart: string,
  options: {
    continuation?: Record<string, unknown>;
    lastError?: string;
    deadLetteredAt?: string;
  } = {},
) {
  await db.query(`
    insert into metrics.backfill_source_month_ledger (
      source_family, month_start, month_end_exclusive, expected_pages, expected_records,
      estimated_nested_requests, estimated_requests, daily_request_ceiling,
      approved_by, approved_at, plan_hash, status, continuation_token,
      last_error, dead_lettered_at
    ) values (
      $1, $2::date, ($2::date + interval '1 month')::date, 1, 1,
      0, 1, 10000, 'test@example.com', now(), repeat('a', 64), 'queued',
      $3::jsonb, $4, $5::timestamptz
    )
  `, [
    sourceFamily,
    monthStart,
    options.continuation ? JSON.stringify(options.continuation) : null,
    options.lastError ?? null,
    options.deadLetteredAt ?? null,
  ]);
}

async function seedManifest(
  db: PGlite,
  sourceFamily: string,
  monthStart: string,
  options: {
    listedCount: number;
    generation: number;
    reconciliationGeneration?: number;
  },
) {
  await db.query(`
    insert into metrics.source_period_manifests (
      source_family, period_start, period_end, coverage_status, reconciliation_status,
      listed_count, detail_count, normalized_count, source_id_hash, normalized_id_hash,
      continuation_token, evidence_as_of, completed_at, manifest_generation,
      reconciliation_generation, expected_page_count, completed_page_count, reconciled_at
    ) values (
      $1, $2::date, ($2::date + interval '1 month - 1 day')::date, 'complete', 'matched',
      $3, $3, $3, repeat('b', 64), repeat('b', 64), null, now(), now(), $4, $5,
      2, 2, now()
    )
  `, [sourceFamily, monthStart, options.listedCount, options.generation, options.reconciliationGeneration ?? options.generation]);
}
