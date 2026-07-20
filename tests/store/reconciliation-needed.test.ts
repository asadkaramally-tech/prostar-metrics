import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { isReconciliationNeeded } from "../../src/lib/store/reconciliation";
import type { PostgresQuery } from "../../src/lib/store/postgres";

test("technician reconciliation is needed when an expected employee result row is missing", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create schema metrics;
      create table metrics.authoritative_reconciliation_results (
        id bigint primary key,
        scope text not null,
        period_start date not null,
        status text not null,
        checked_at timestamptz not null,
        generation bigint,
        source_manifest_generations jsonb not null,
        detail jsonb not null
      );
      create table metrics.dashboard_read_models (
        metric_family text not null,
        period_start date not null,
        period_grain text not null,
        superseded_at timestamptz,
        rebuilt_at timestamptz not null
      );
      create table metrics.source_period_manifests (
        source_family text not null,
        period_start date not null,
        coverage_status text,
        reconciliation_status text,
        continuation_token jsonb,
        manifest_generation bigint,
        reconciliation_generation bigint,
        expected_page_count integer,
        completed_page_count integer,
        reconciled_at timestamptz
      );
      create table metrics.technician_reconciliation_results (
        reconciliation_check_id bigint not null,
        employee_id text not null,
        status text not null,
        primary key (reconciliation_check_id, employee_id)
      );
      insert into metrics.dashboard_read_models (
        metric_family, period_start, period_grain, rebuilt_at
      ) values ('technicians', '2024-01-01', 'month', clock_timestamp() - interval '1 minute');
      insert into metrics.authoritative_reconciliation_results (
        id, scope, period_start, status, checked_at, generation,
        source_manifest_generations, detail
      ) values (
        10, 'technicians', '2024-01-01', 'matched', clock_timestamp(), 3,
        '{"jobs":3}',
        '{"comparisons":{"technicians":{"matched":2,"mismatch":0}}}'
      );
      insert into metrics.technician_reconciliation_results (
        reconciliation_check_id, employee_id, status
      ) values (10, '101', 'matched');
    `);
    const query = pgliteQuery(db);
    const dependencies = {
      query,
      continuationStore: { hasIncomplete: async () => false },
    };
    const period = { start: "2024-01-01", end: "2024-01-31" };

    assert.equal(await isReconciliationNeeded("technicians", period, dependencies), true);

    await db.exec(`
      insert into metrics.technician_reconciliation_results (
        reconciliation_check_id, employee_id, status
      ) values (10, '102', 'matched');
    `);
    assert.equal(await isReconciliationNeeded("technicians", period, dependencies), false);
  } finally {
    await db.close();
  }
});

function pgliteQuery(db: PGlite): PostgresQuery {
  return async <T>(sql: string, values: unknown[] = []) => {
    const result = await db.query<T>(sql, values as never[]);
    return { rows: result.rows, rowCount: result.rows.length };
  };
}
