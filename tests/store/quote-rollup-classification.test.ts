import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  buildQuoteMonthlyRollup,
  getQuoteSnapshots,
  type RollupRebuildQuery,
} from "../../src/lib/store/read-model-rebuilds";

const readModelRebuildsSource = readFileSync(
  path.join(process.cwd(), "src/lib/store/read-model-rebuilds.ts"),
  "utf8",
);

test("quote rollup accepts only exact status and direct/inverse relationships", async () => {
  const db = new PGlite();
  const query = pgliteQuery(db);
  try {
    await db.exec(`
      create schema metrics;
      create table metrics.metrics_quotes (
        quote_id bigint primary key,
        quote_no text,
        date_issued date,
        date_approved date,
        status_name text,
        total numeric(14, 2) not null,
        linked_job_id bigint,
        job_no text,
        source_deleted_at timestamptz
      );
      create table metrics.metrics_jobs (
        job_id bigint primary key,
        job_no text,
        converted_from_type text,
        converted_from_id bigint,
        source_deleted_at timestamptz
      );
      create table metrics.quote_classification_overrides (
        id bigserial primary key,
        quote_id bigint not null,
        outcome text,
        active boolean not null default true,
        created_at timestamptz not null default now()
      );
      create table metrics.raw_simpro_snapshots (
        id bigserial primary key,
        entity_type text not null,
        entity_id text not null,
        payload jsonb not null,
        complete_traversal boolean not null default false,
        source_deleted_at timestamptz,
        extracted_at timestamptz not null default now()
      );
      create function metrics.authoritative_quote_linked_job_id(payload jsonb)
      returns bigint language sql immutable as \$\$
        select case
          when payload ? 'LinkedJobID' and jsonb_typeof(payload -> 'LinkedJobID') <> 'null'
            then (payload ->> 'LinkedJobID')::bigint
          else null
        end
      \$\$;
      create function metrics.authoritative_job_source_quote_id(payload jsonb)
      returns bigint language sql immutable as \$\$
        select case
          when payload #>> '{ConvertedFrom,Type}' = 'Quote'
            then (payload #>> '{ConvertedFrom,ID}')::bigint
          else null
        end
      \$\$;
      create view metrics.job_source_quotes as
      select j.job_id,
             case
               when lower(trim(coalesce(j.converted_from_type, ''))) = 'quote'
                 then j.converted_from_id
               else null
             end as source_quote_id
        from metrics.metrics_jobs j
       where j.source_deleted_at is null;

      insert into metrics.metrics_quotes (
        quote_id, quote_no, date_issued, date_approved, status_name, total, linked_job_id, job_no
      ) values
        (1, 'Q1', date '2026-06-01', date '2026-06-01', '  QuOtE AcCePtEd OnLiNe  ', 100, null, null),
        (2, 'Q2', date '2026-06-02', date '2026-06-02', 'Pending', 200, 200, null),
        (3, 'Q3', date '2026-06-03', date '2026-06-03', 'Pending', 300, null, '300'),
        (4, 'Q4', date '2026-06-04', date '2026-06-04', 'Pending', 400, null, null),
        (5, 'Q5', date '2026-06-05', date '2026-06-05', 'Pending', 500, null, null),
        (6, 'Q6', date '2026-06-06', date '2026-06-06', 'Quote Accepted Online', 600, null, null),
        (7, 'Q7', date '2026-06-07', date '2026-06-07', 'Pending', 700, 700, null),
        (8, 'Q8', date '2026-06-08', date '2026-06-08', 'Quote Accepted Online - Pending', 800, null, null),
        (9, 'Q9', date '2026-06-09', date '2026-06-09', 'Quote: Quote Accepted Online', 900, null, null);

      insert into metrics.metrics_jobs (
        job_id, job_no, converted_from_type, converted_from_id, source_deleted_at
      ) values
        (200, 'J-200', null, null, null),
        (300, '300', null, null, null),
        (400, 'J-400', ' Quote ', 4, null),
        (700, 'J-700', null, null, timestamptz '2026-06-09 00:00:00+00');

      insert into metrics.quote_classification_overrides (quote_id, outcome, active)
      values (6, 'excluded', true);
      insert into metrics.raw_simpro_snapshots (
        entity_type, entity_id, payload, complete_traversal, extracted_at
      ) values
        ('quote_details', '1', '{"ID":1,"LinkedJobID":null}', true, '2026-07-01T00:00:00Z'),
        ('quote_details', '2', '{"ID":2,"LinkedJobID":200}', true, '2026-07-01T00:00:00Z'),
        ('quote_details', '3', '{"ID":3,"LinkedJobID":null,"JobNo":"300"}', true, '2026-07-01T00:00:00Z'),
        ('quote_details', '4', '{"ID":4,"LinkedJobID":null}', true, '2026-07-01T00:00:00Z'),
        ('quote_details', '5', '{"ID":5,"LinkedJobID":null}', true, '2026-07-01T00:00:00Z'),
        ('quote_details', '6', '{"ID":6,"LinkedJobID":null}', true, '2026-07-01T00:00:00Z'),
        ('quote_details', '7', '{"ID":7,"LinkedJobID":700}', true, '2026-07-01T00:00:00Z'),
        ('quote_details', '8', '{"ID":8,"LinkedJobID":null}', true, '2026-07-01T00:00:00Z'),
        ('quote_details', '9', '{"ID":9,"LinkedJobID":null}', true, '2026-07-01T00:00:00Z'),
        ('job_details', '200', '{"ID":200,"ConvertedFrom":null}', true, '2026-07-01T00:00:00Z'),
        ('job_details', '300', '{"ID":300,"ConvertedFrom":null}', true, '2026-07-01T00:00:00Z'),
        ('job_details', '400', '{"ID":400,"ConvertedFrom":{"Type":"Quote","ID":4}}', true, '2026-07-01T00:00:00Z'),
        ('job_details', '700', '{"ID":700,"ConvertedFrom":null}', true, '2026-07-01T00:00:00Z');
    `);

    const snapshots = await getQuoteSnapshots("2026-06-01", "2026-06-30", query);
    const byId = new Map(snapshots.map((quote) => [Number(quote.quoteId), quote]));
    assert.equal(byId.get(1)?.statusName, "  QuOtE AcCePtEd OnLiNe  ");
    assert.equal(byId.get(2)?.linkedJobId, "200");
    assert.equal(byId.get(3)?.linkedJobId, null);
    assert.equal(byId.get(4)?.convertedFromJobId, "400");
    assert.equal(byId.get(6)?.outcomeOverride, "excluded");
    assert.equal(byId.get(7)?.linkedJobId, null);

    const rollup = await buildQuoteMonthlyRollup("2026-06-01", "2026-06-30", query);
    assert.equal(rollup.quoteCount, 8);
    assert.equal(rollup.acceptedCount, 4);
    assert.equal(rollup.notAcceptedCount, 4);
    assert.equal(rollup.excludedCount, 1);
    assert.deepEqual(rollup.acceptancePaths, {
      accepted_online_and_converted: 0,
      accepted_online_only: 2,
      converted_only: 2,
      not_accepted: 4,
      excluded: 1,
    });
  } finally {
    await db.close();
  }
});

test("quote rollup serving path uses persisted relationships instead of raw snapshot traversal", () => {
  const getQuoteSnapshotsSource = readModelRebuildsSource.slice(
    readModelRebuildsSource.indexOf("export async function getQuoteSnapshots"),
    readModelRebuildsSource.indexOf("function monthWindow"),
  );
  assert.match(getQuoteSnapshotsSource, /metrics\.job_source_quotes/);
  assert.match(getQuoteSnapshotsSource, /linked_job\.job_id = q\.linked_job_id/);
  assert.doesNotMatch(getQuoteSnapshotsSource, /raw_simpro_snapshots/);
  assert.doesNotMatch(getQuoteSnapshotsSource, /authoritative_job_source_quote_id|authoritative_quote_linked_job_id/);
});

function pgliteQuery(db: PGlite): RollupRebuildQuery {
  return async <T>(sql: string, values: unknown[] = []) => {
    const result = await db.query<T>(sql, values);
    return { rows: result.rows };
  };
}
