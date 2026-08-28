import pg from "pg";
import { verifiedPostgresClientConfig } from "./postgres-tls.mjs";

const { Client } = pg;
const connectionString = process.env.AZURE_POSTGRES_CONNECTION_STRING;
if (!connectionString) throw new Error("AZURE_POSTGRES_CONNECTION_STRING is required");

const client = new Client({
  ...await verifiedPostgresClientConfig(connectionString),
  connectionTimeoutMillis: 15_000,
  query_timeout: 30_000,
});

await client.connect();
try {
  const [ingestion, backfill, rollups] = await Promise.all([
    client.query(`
      select entity_type::text, status::text, left(last_error, 220) as error,
             count(*)::int as items, min(updated_at)::text as oldest, max(updated_at)::text as newest
        from metrics.ingestion_jobs
       where status in ('queued', 'running', 'failed')
         and (status = 'failed' or last_error is not null)
       group by entity_type, status, left(last_error, 220)
       order by entity_type, status, items desc, error`),
    client.query(`
      select ledger.source_family, ledger.month_start::text, ledger.status::text,
             ledger.retry_count, ledger.actual_requests, left(ledger.last_error, 220) as error,
             ledger.updated_at::text,
             manifest.coverage_status::text as manifest_coverage,
             manifest.reconciliation_status::text as manifest_reconciliation,
             manifest.continuation_token is null as manifest_at_end,
             manifest.manifest_generation is not null
               and manifest.manifest_generation = manifest.reconciliation_generation as generation_matched,
             manifest.expected_page_count,
             manifest.completed_page_count,
             manifest.reconciled_at::text
        from metrics.backfill_source_month_ledger ledger
        left join metrics.source_period_manifests manifest
          on manifest.source_family = ledger.source_family
         and manifest.period_start = ledger.month_start
       where ledger.status in ('queued', 'running', 'reconciliation_pending', 'dead_lettered')
       order by ledger.month_start, ledger.source_family`),
    client.query(`
      select metric_family, period_start::text, status::text, attempts,
             reason, left(error_message, 220) as error, locked_by, locked_until::text,
             created_at::text, finished_at::text
        from metrics.rollup_rebuild_queue
       where status in ('queued', 'running', 'failed')
       order by period_start, metric_family, id`),
  ]);
  console.log(JSON.stringify({
    capturedAt: new Date().toISOString(),
    ingestion: ingestion.rows,
    backfill: backfill.rows,
    rollups: rollups.rows,
  }, null, 2));
} finally {
  await client.end();
}
