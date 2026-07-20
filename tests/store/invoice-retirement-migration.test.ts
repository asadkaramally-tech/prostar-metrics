import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const migrationDirectory = new URL("../../infra/db/migrations/", import.meta.url);

test("migration 033 retires invoice work idempotently while preserving historical tables", async () => {
  const db = new PGlite();
  try {
    const files = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
    const cleanupName = "033_quote_reinstatement_scope_cleanup.sql";
    const cleanupIndex = files.indexOf(cleanupName);
    assert.notEqual(cleanupIndex, -1);

    for (const file of files.slice(0, cleanupIndex)) {
      await db.exec(await readFile(new URL(file, migrationDirectory), "utf8"));
    }

    await db.exec(`
      insert into metrics.invoice_snapshots (invoice_type, invoice_id)
      values ('global', 8001);
      insert into metrics.invoice_job_links (invoice_type, invoice_id, job_id, cost_center_id, ex_tax)
      values ('global', 8001, 9001, null, 125);

      insert into metrics.ingestion_jobs (
        entity_type, status, idempotency_key, locked_by, locked_at, lock_expires_at, heartbeat_at
      ) values (
        'invoices', 'running', 'legacy-invoice-job', 'legacy-worker', now(),
        now() + interval '10 minutes', now()
      );
      insert into metrics.ingestion_runs (job_id, entity_type, status, worker_id)
      select id, 'invoices', 'running', 'legacy-worker'
        from metrics.ingestion_jobs
       where idempotency_key = 'legacy-invoice-job';

      insert into metrics.backfill_source_month_ledger (
        source_family, month_start, month_end_exclusive, required_for_completion,
        depends_on, status, expected_pages, expected_records, estimated_nested_requests,
        estimated_requests, daily_request_ceiling, approved_by, approved_at, plan_hash
      ) values (
        'invoices', '2025-06-01', '2025-07-01', true, '{}', 'queued',
        1, 1, 0, 1, 1000, 'legacy@example.com', now(), repeat('a', 64)
      ), (
        'quotes', '2025-06-01', '2025-07-01', true, array['invoices'], 'queued',
        1, 1, 0, 1, 1000, 'legacy@example.com', now(), repeat('b', 64)
      );
    `);

    const cleanup = await readFile(new URL(cleanupName, migrationDirectory), "utf8");
    await db.exec(cleanup);
    const firstAuditCount = await auditCount(db);
    await db.exec(cleanup);
    assert.equal(await auditCount(db), firstAuditCount);

    const state = await db.query<{
      invoice_snapshots: number;
      invoice_links: number;
      job_status: string;
      run_status: string;
      invoice_backfill_status: string;
      invoice_backfill_required: boolean;
      dependent_sources: string[];
    }>(`
      select
        (select count(*)::int from metrics.invoice_snapshots where invoice_id = 8001) invoice_snapshots,
        (select count(*)::int from metrics.invoice_job_links where invoice_id = 8001) invoice_links,
        (select status::text from metrics.ingestion_jobs where idempotency_key = 'legacy-invoice-job') job_status,
        (select status::text from metrics.ingestion_runs where worker_id = 'legacy-worker') run_status,
        (select status from metrics.backfill_source_month_ledger
          where source_family = 'invoices' and month_start = '2025-06-01') invoice_backfill_status,
        (select required_for_completion from metrics.backfill_source_month_ledger
          where source_family = 'invoices' and month_start = '2025-06-01') invoice_backfill_required,
        (select depends_on from metrics.backfill_source_month_ledger
          where source_family = 'quotes' and month_start = '2025-06-01') dependent_sources
    `);
    assert.deepEqual(state.rows[0], {
      invoice_snapshots: 1,
      invoice_links: 1,
      job_status: "cancelled",
      run_status: "cancelled",
      invoice_backfill_status: "cancelled",
      invoice_backfill_required: false,
      dependent_sources: [],
    });

    await db.exec(`
      insert into metrics.ingestion_jobs (entity_type, idempotency_key)
      values ('customer_invoice_logs', 'quarantined-customer-invoice-log');
      update metrics.ingestion_jobs
         set status = 'queued', locked_by = 'legacy-worker', locked_at = now()
       where idempotency_key = 'legacy-invoice-job';
      insert into metrics.backfill_source_month_ledger (
        source_family, month_start, month_end_exclusive, status,
        expected_pages, expected_records, estimated_nested_requests, estimated_requests,
        daily_request_ceiling, approved_by, approved_at, plan_hash
      ) values (
        'invoices', '2025-07-01', '2025-08-01', 'queued',
        1, 1, 0, 1, 1000, 'test@example.com', now(), repeat('c', 64)
      );
    `);
    const quarantined = await db.query<{
      inserted_status: string;
      updated_status: string;
      updated_locked_by: string | null;
      backfill_status: string;
      backfill_required: boolean;
    }>(`
      select
        (select status::text from metrics.ingestion_jobs
          where idempotency_key = 'quarantined-customer-invoice-log') inserted_status,
        (select status::text from metrics.ingestion_jobs
          where idempotency_key = 'legacy-invoice-job') updated_status,
        (select locked_by from metrics.ingestion_jobs
          where idempotency_key = 'legacy-invoice-job') updated_locked_by,
        (select status from metrics.backfill_source_month_ledger
          where source_family = 'invoices' and month_start = '2025-07-01') backfill_status,
        (select required_for_completion from metrics.backfill_source_month_ledger
          where source_family = 'invoices' and month_start = '2025-07-01') backfill_required
    `);
    assert.deepEqual(quarantined.rows[0], {
      inserted_status: "cancelled",
      updated_status: "cancelled",
      updated_locked_by: null,
      backfill_status: "cancelled",
      backfill_required: false,
    });
  } finally {
    await db.close();
  }
});

test("migrations 029 through 035 execute over a migration-028 baseline with prior-runtime writes intact", async () => {
  const db = new PGlite();
  try {
    const files = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
    const baselineEnd = files.findIndex((file) => file.startsWith("029_"));
    assert.ok(baselineEnd > 0);
    for (const file of files.slice(0, baselineEnd)) {
      await db.exec(await readFile(new URL(file, migrationDirectory), "utf8"));
    }
    for (const file of files.slice(baselineEnd).filter((name) => /^(029|030|031|032|033|034|035)_/.test(name))) {
      await db.exec(await readFile(new URL(file, migrationDirectory), "utf8"));
    }

    await db.exec(`
      insert into metrics.ingestion_jobs (entity_type, status, idempotency_key)
      values ('jobs', 'queued', 'prior-runtime-general-write');
      update metrics.ingestion_jobs set status = 'running', locked_by = 'prior-runtime'
       where idempotency_key = 'prior-runtime-general-write';
      insert into metrics.ingestion_jobs (entity_type, status, idempotency_key)
      values ('invoices', 'queued', 'prior-runtime-invoice-insert');
      update metrics.ingestion_jobs set status = 'queued', locked_by = 'prior-runtime'
       where idempotency_key = 'prior-runtime-invoice-insert';
    `);
    const result = await db.query<{ general: string; invoice: string; invoice_lock: string | null }>(`
      select
        (select status::text from metrics.ingestion_jobs where idempotency_key = 'prior-runtime-general-write') general,
        (select status::text from metrics.ingestion_jobs where idempotency_key = 'prior-runtime-invoice-insert') invoice,
        (select locked_by from metrics.ingestion_jobs where idempotency_key = 'prior-runtime-invoice-insert') invoice_lock
    `);
    assert.deepEqual(result.rows[0], { general: "running", invoice: "cancelled", invoice_lock: null });
  } finally {
    await db.close();
  }
});

async function auditCount(db: PGlite) {
  const result = await db.query<{ count: number }>(`
    select count(*)::int count
      from metrics.audit_events
     where actor_email = 'migration-033@prostarmechanical.com'
  `);
  return result.rows[0]?.count ?? 0;
}
