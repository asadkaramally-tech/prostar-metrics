import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const migrationUrl = new URL(
  "../../infra/db/migrations/038_job_source_quote_lookup_index.sql",
  import.meta.url,
);

test("migration 038 indexes active quote-to-job lookups and is twice-safe", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create schema metrics;
      create table metrics.metrics_quotes (
        quote_id bigint primary key,
        linked_job_id bigint,
        source_deleted_at timestamptz
      );
    `);

    const migration = await readFile(migrationUrl, "utf8");
    await db.exec(migration);
    await db.exec(migration);

    const result = await db.query<{ indexdef: string }>(`
      select indexdef
        from pg_indexes
       where schemaname = 'metrics'
         and indexname = 'metrics_quotes_active_linked_job_idx'
    `);

    assert.equal(result.rows.length, 1);
    assert.match(result.rows[0].indexdef, /\(linked_job_id, quote_id\)/i);
    assert.match(result.rows[0].indexdef, /linked_job_id is not null/i);
    assert.match(result.rows[0].indexdef, /source_deleted_at is null/i);
  } finally {
    await db.close();
  }
});
