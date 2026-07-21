import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { RequestBudget } from "../../src/lib/simpro/client";
import type { SimproEndpoints } from "../../src/lib/simpro/endpoints";
import type {
  BoundedSourceWork,
  BoundedSourceWorkRequest,
} from "../../src/lib/store/bounded-source-work";
import {
  createPostgresReconciliationContinuationStore,
  type ReconciliationContinuationTransaction,
} from "../../src/lib/store/reconciliation-continuation-store";
import {
  collectDirectSourceMonth,
  isReconciliationNeeded,
  runSimproReconciliation,
  type ReconciliationRuntimeDependencies,
} from "../../src/lib/store/reconciliation";
import type { PostgresQuery } from "../../src/lib/store/postgres";

test("budget stop resumes at the committed day/page cursor without duplicate IDs", async () => {
  const fixture = await databaseFixture();
  let detailCalls = 0;
  const endpoints = fakeQuoteEndpoints({
    pages: { "2023-02-01:1": { ids: [1], nextPage: null } },
    details: { "1": { ID: 1, Total: { ExTax: 10 } } },
    onDetail: () => { detailCalls += 1; },
  });
  try {
    const first = await collectDirectSourceMonth({
      scope: "quotes",
      period: period,
      endpoints,
      budget: { limit: 2, used: 0 },
      leaseOwner: "worker-a",
      store: fixture.store,
    });
    assert.equal(first.complete, false);
    assert.match(first.reason ?? "", /budget exhausted/i);

    const resumed = await collectDirectSourceMonth({
      scope: "quotes",
      period,
      endpoints,
      budget: { limit: 100, used: 0 },
      leaseOwner: "worker-b",
      store: fixture.store,
    });
    assert.equal(resumed.complete, true);
    assert.deepEqual(resumed.source?.ids, ["1"]);
    assert.equal(resumed.source?.totalValue, 10);
    assert.equal(detailCalls, 1);
    assert.equal(resumed.source?.totalRequestsUsed, 57);
  } finally {
    await fixture.db.close();
  }
});

test("same-day multipage traversal checkpoints each page and resumes exact totals", async () => {
  const fixture = await databaseFixture();
  const endpoints = fakeQuoteEndpoints({
    pages: {
      "2023-02-01:1": { ids: [2], nextPage: 2 },
      "2023-02-01:2": { ids: [1, 2], nextPage: null },
    },
    details: {
      "1": { ID: 1, Total: { ExTax: 15 } },
      "2": { ID: 2, Total: { ExTax: 25 } },
    },
  });
  try {
    const result = await collectDirectSourceMonth({
      scope: "quotes",
      period,
      endpoints,
      budget: { limit: 100, used: 0 },
      leaseOwner: "multipage-worker",
      store: fixture.store,
    });
    assert.equal(result.complete, true);
    assert.deepEqual(result.source?.ids, ["1", "2"]);
    assert.equal(result.source?.count, 2);
    assert.equal(result.source?.totalValue, 40);
    assert.equal(result.source?.pageCount, 58);
  } finally {
    await fixture.db.close();
  }
});

test("failed detail retry is idempotent and cumulative request accounting includes the retry", async () => {
  const fixture = await databaseFixture();
  let detailAttempts = 0;
  const endpoints = fakeQuoteEndpoints({
    pages: { "2023-02-01:1": { ids: [1], nextPage: null } },
    details: { "1": { ID: 1, Total: { ExTax: 12 } } },
    onDetail: () => {
      detailAttempts += 1;
      if (detailAttempts === 1) throw new Error("simulated crash after request accounting");
    },
  });
  try {
    await assert.rejects(collectDirectSourceMonth({
      scope: "quotes",
      period,
      endpoints,
      budget: { limit: 100, used: 0 },
      leaseOwner: "crashing-worker",
      store: fixture.store,
    }), /simulated crash/);

    const retried = await collectDirectSourceMonth({
      scope: "quotes",
      period,
      endpoints,
      budget: { limit: 100, used: 0 },
      leaseOwner: "retry-worker",
      store: fixture.store,
    });
    assert.equal(retried.complete, true);
    assert.equal(retried.source?.count, 1);
    assert.equal(retried.source?.totalValue, 12);
    assert.equal(retried.source?.totalRequestsUsed, 58);
    assert.equal(detailAttempts, 2);
  } finally {
    await fixture.db.close();
  }
});

test("hard kill after a list response preserves the reservation and lease recovery cannot undercount", async () => {
  const fixture = await databaseFixture();
  let firstDayListCalls = 0;
  const endpoints = fakeQuoteEndpoints({
    pages: { "2023-02-01:1": { ids: [1], nextPage: null } },
    details: { "1": { ID: 1, Total: { ExTax: 18 } } },
    onList: (day) => {
      if (day === "2023-02-01") firstDayListCalls += 1;
    },
  });
  try {
    const crashed = await fixture.store.claim({
      scope: "quotes",
      periodStart: period.start,
      periodEnd: period.end,
      leaseOwner: "hard-killed-worker",
    });
    assert.equal(crashed.acquired, true);
    if (!crashed.acquired) return;
    assert.equal(await fixture.store.reserveRequest(crashed.claim, 100), 1);
    const crashBudget: RequestBudget = { limit: 100, used: 0 };
    await endpoints.listQuotes({
      page: 1,
      pageSize: 250,
      budget: crashBudget,
      query: { DateApproved: period.start },
    });
    assert.equal(crashBudget.used, 1);

    await fixture.db.exec(`
      update metrics.reconciliation_continuations
         set lease_expires_at = clock_timestamp() - interval '1 second'
       where scope = 'quotes' and period_start = '2023-02-01'
    `);
    const recovered = await collectDirectSourceMonth({
      scope: "quotes",
      period,
      endpoints,
      budget: { limit: 100, used: 0 },
      leaseOwner: "lease-recovery-worker",
      store: fixture.store,
    });
    assert.equal(recovered.complete, true);
    assert.deepEqual(recovered.source?.ids, ["1"]);
    assert.equal(recovered.source?.totalValue, 18);
    assert.equal(recovered.source?.totalRequestsUsed, 58);
    assert.equal(firstDayListCalls, 3);
  } finally {
    await fixture.db.close();
  }
});

test("every Simpro list and detail call observes its durable reservation before execution", async () => {
  const fixture = await databaseFixture();
  const observed: number[] = [];
  const observeReservation = async () => {
    const result = await fixture.db.query<{ requests_used: number }>(`
      select requests_used::int
        from metrics.reconciliation_continuations
       where scope = 'quotes' and period_start = '2023-02-01'
    `);
    observed.push(Number(result.rows[0]?.requests_used));
  };
  try {
    const result = await collectDirectSourceMonth({
      scope: "quotes",
      period,
      endpoints: fakeQuoteEndpoints({
        pages: { "2023-02-01:1": { ids: [1], nextPage: null } },
        details: { "1": { ID: 1, Total: { ExTax: 9 } } },
        onList: observeReservation,
        onDetail: observeReservation,
      }),
      budget: { limit: 100, used: 0 },
      leaseOwner: "reservation-order-worker",
      store: fixture.store,
    });
    assert.equal(result.complete, true);
    assert.deepEqual(observed, Array.from({ length: 57 }, (_, index) => index + 1));
  } finally {
    await fixture.db.close();
  }
});

test("quote reconciliation traverses the DateApproved/DateIssued union and fetches overlap once", async () => {
  const fixture = await databaseFixture();
  const listed: Array<{ dateField: string; day: string; page: number }> = [];
  let detailCalls = 0;
  try {
    const result = await collectDirectSourceMonth({
      scope: "quotes",
      period,
      endpoints: fakeQuoteEndpoints({
        pages: {
          "DateApproved:2023-02-01:1": { ids: [1, 2], nextPage: null },
          "DateIssued:2023-02-01:1": { ids: [2, 3], nextPage: null },
        },
        details: {
          "1": { ID: 1, Total: { ExTax: 10 } },
          "2": { ID: 2, Total: { ExTax: 20 } },
          "3": { ID: 3, Total: { ExTax: 30 } },
        },
        onList: (day, page, dateField) => { listed.push({ day, page, dateField }); },
        onDetail: () => { detailCalls += 1; },
      }),
      budget: { limit: 100, used: 0 },
      leaseOwner: "date-union-worker",
      store: fixture.store,
    });

    assert.equal(result.complete, true);
    assert.deepEqual(result.source?.ids, ["1", "2", "3"]);
    assert.equal(result.source?.totalValue, 60);
    assert.equal(detailCalls, 3);
    assert.deepEqual(listed.slice(0, 2), [
      { dateField: "DateApproved", day: "2023-02-01", page: 1 },
      { dateField: "DateIssued", day: "2023-02-01", page: 1 },
    ]);
  } finally {
    await fixture.db.close();
  }
});

test("DateIssued-only quotes satisfy source coverage without inflating the DateApproved dashboard cohort", async () => {
  const fixture = await databaseFixture();
  try {
    await fixture.db.exec(`
      insert into metrics.metrics_quotes (quote_id, total, date_issued) values (7, 70, '2023-02-01');
      insert into metrics.quote_snapshots (quote_id, total_value, date_issued) values (7, 70, '2023-02-01');
      insert into metrics.dashboard_read_models (
        metric_family, period_grain, period_start, values_json, source_hash, rebuilt_at
      ) values ('quotes', 'month', '2023-02-01', '{"quoteCount":0,"quoteValue":0}', 'issued-only', now());
    `);
    await seedQuoteNestedAuthority(fixture.db, 7);

    const result = await runSimproReconciliation({
      scope: "quotes",
      periodStart: period.start,
      requestBudget: 100,
      leaseOwner: "issued-only-worker",
      endpoints: fakeQuoteEndpoints({
        pages: { "DateIssued:2023-02-01:1": { ids: [7], nextPage: null } },
        details: { "7": { ID: 7, Total: { ExTax: 70 } } },
      }),
      dependencies: {
        query: fixture.query,
        transaction: fixture.transaction,
        continuationStore: fixture.store,
      },
    });

    assert.equal(result[0]?.status, "matched");
  } finally {
    await fixture.db.close();
  }
});

test("concurrent claim is rejected and a restarted generation fences stale checkpoints", async () => {
  const fixture = await databaseFixture();
  try {
    const first = await fixture.store.claim({
      scope: "quotes",
      periodStart: period.start,
      periodEnd: period.end,
      leaseOwner: "generation-one",
    });
    assert.equal(first.acquired, true);
    if (!first.acquired) return;
    const concurrent = await fixture.store.claim({
      scope: "quotes",
      periodStart: period.start,
      periodEnd: period.end,
      leaseOwner: "concurrent-worker",
    });
    assert.deepEqual(concurrent, { acquired: false, reason: "busy" });

    const restarted = await fixture.store.restartGeneration({
      scope: "quotes",
      periodStart: period.start,
      periodEnd: period.end,
      leaseOwner: "generation-two",
    });
    assert.equal(restarted.generation, first.claim.generation + 1);
    assert.equal(await fixture.store.checkpoint(first.claim, first.claim), false);
  } finally {
    await fixture.db.close();
  }
});

test("a missing continuation head resumes above sealed manifest generations", async () => {
  const fixture = await databaseFixture();
  try {
    await fixture.db.exec(`
      insert into metrics.source_period_manifests (
        source_family, period_start, period_end, coverage_status,
        reconciliation_status, evidence_as_of, manifest_generation,
        reconciliation_generation, expected_page_count, completed_page_count
      ) values (
        'quotes', '2023-02-01', '2023-02-28', 'complete',
        'matched', now(), 10, 10, 1, 1
      )
    `);

    const claimed = await fixture.store.claim({
      scope: "quotes",
      periodStart: period.start,
      periodEnd: period.end,
      leaseOwner: "post-bootstrap-worker",
    });

    assert.equal(claimed.acquired, true);
    if (claimed.acquired) assert.equal(claimed.claim.generation, 11);
  } finally {
    await fixture.db.close();
  }
});

test("exact missing IDs queue targeted repair before the same generation publishes matched", async () => {
  const fixture = await databaseFixture();
  const repairs: BoundedSourceWork[] = [];
  const endpoints = fakeQuoteEndpoints({
    pages: { "2023-02-01:1": { ids: [1, 2], nextPage: null } },
    details: {
      "1": { ID: 1, Total: { ExTax: 10 } },
      "2": { ID: 2, Total: { ExTax: 20 } },
    },
  });
  const dependencies: ReconciliationRuntimeDependencies = {
    query: fixture.query,
    transaction: fixture.transaction,
    continuationStore: fixture.store,
    enqueueBoundedWork: async (params) => {
      repairs.push(params.work);
      return {} as BoundedSourceWorkRequest;
    },
  };
  try {
    await fixture.db.exec(`
      insert into metrics.metrics_quotes (quote_id, total, date_approved) values (1, 10, '2023-02-01');
      insert into metrics.quote_snapshots (quote_id, total_value, date_approved) values (1, 10, '2023-02-01');
      insert into metrics.dashboard_read_models (
        metric_family, period_grain, period_start, values_json, source_hash, rebuilt_at
      ) values ('quotes', 'month', '2023-02-01', '{"quoteCount":1,"quoteValue":10}', 'first', now());
    `);
    await seedQuoteNestedAuthority(fixture.db, 1);

    const mismatch = await runSimproReconciliation({
      scope: "quotes",
      periodStart: period.start,
      requestBudget: 100,
      endpoints,
      leaseOwner: "repair-worker",
      dependencies,
    });
    assert.equal(mismatch[0]?.status, "mismatch");
    assert.deepEqual(repairs, [{ kind: "entity_refresh", entityType: "quote", entityId: 2 }]);
    const generation = mismatch[0]?.generation;

    await fixture.db.exec(`
      insert into metrics.metrics_quotes (quote_id, total, date_approved) values (2, 20, '2023-02-01');
      insert into metrics.quote_snapshots (quote_id, total_value, date_approved) values (2, 20, '2023-02-01');
      update metrics.dashboard_read_models
         set values_json = '{"quoteCount":2,"quoteValue":30}', source_hash = 'repaired', rebuilt_at = now()
      where metric_family = 'quotes' and period_start = '2023-02-01';
    `);
    await seedQuoteNestedAuthority(fixture.db, 2);

    const matched = await runSimproReconciliation({
      scope: "quotes",
      periodStart: period.start,
      requestBudget: 1,
      endpoints: throwingEndpoints(),
      leaseOwner: "final-worker",
      dependencies,
    });
    assert.equal(matched[0]?.status, "matched");
    assert.equal(matched[0]?.generation, generation);
    assert.equal(matched[0]?.completeTraversal, true);
    assert.equal(repairs.length, 1);

    const state = await fixture.db.query<{
      status: string;
      checks: number;
      manifests: number;
    }>(`
      select continuation.status,
             (select count(*)::integer from metrics.reconciliation_checks) as checks,
             (select count(*)::integer from metrics.source_period_manifests
               where coverage_status = 'complete' and reconciliation_generation = manifest_generation) as manifests
        from metrics.reconciliation_continuations continuation
       where scope = 'quotes' and period_start = '2023-02-01'
       order by generation desc limit 1
    `);
    assert.deepEqual(state.rows, [{ status: "completed", checks: 2, manifests: 2 }]);
    assert.equal(await isReconciliationNeeded("quotes", period, {
      query: fixture.query,
      continuationStore: fixture.store,
    }), false);
  } finally {
    await fixture.db.close();
  }
});

test("a stale manifest generation aborts publication before any authoritative check", async () => {
  const fixture = await databaseFixture();
  const endpoints = fakeQuoteEndpoints({
    pages: { "2023-02-01:1": { ids: [1], nextPage: null } },
    details: { "1": { ID: 1, Total: { ExTax: 10 } } },
    onDetail: async () => {
      // A newer generation seals the quotes manifest after this worker claimed
      // its continuation generation but before it publishes.
      await fixture.db.exec(`
        insert into metrics.source_period_manifests (
          source_family, period_start, period_end, coverage_status,
          reconciliation_status, evidence_as_of, manifest_generation,
          reconciliation_generation, expected_page_count, completed_page_count
        ) values (
          'quotes', '2023-02-01', '2023-02-28', 'complete',
          'matched', now(), 99, 99, 1, 1
        )
      `);
    },
  });
  try {
    await fixture.db.exec(`
      insert into metrics.metrics_quotes (quote_id, total, date_approved) values (1, 10, '2023-02-01');
      insert into metrics.quote_snapshots (quote_id, total_value, date_approved) values (1, 10, '2023-02-01');
      insert into metrics.dashboard_read_models (
        metric_family, period_grain, period_start, values_json, source_hash, rebuilt_at
      ) values ('quotes', 'month', '2023-02-01', '{"quoteCount":1,"quoteValue":10}', 'current', now());
    `);
    await seedQuoteNestedAuthority(fixture.db, 1);

    const result = await runSimproReconciliation({
      scope: "quotes",
      periodStart: period.start,
      requestBudget: 100,
      endpoints,
      leaseOwner: "stale-manifest-worker",
      dependencies: {
        query: fixture.query,
        transaction: fixture.transaction,
        continuationStore: fixture.store,
      },
    });

    assert.equal(result[0]?.status, "sample_missing");
    assert.match(String(result[0]?.detail.reason), /lost its fence/);

    const state = await fixture.db.query<{
      checks: number;
      nested_manifests: number;
      quotes_generation: number;
      continuation_status: string;
      reconciled_models: number;
    }>(`
      select (select count(*)::integer from metrics.reconciliation_checks) as checks,
             (select count(*)::integer from metrics.source_period_manifests
               where source_family = 'quote_nested') as nested_manifests,
             (select manifest_generation::integer from metrics.source_period_manifests
               where source_family = 'quotes' and period_start = '2023-02-01') as quotes_generation,
             (select status from metrics.reconciliation_continuations
               where scope = 'quotes' and period_start = '2023-02-01'
               order by generation desc limit 1) as continuation_status,
             (select count(*)::integer from metrics.dashboard_read_models
               where last_reconciled_at is not null) as reconciled_models
    `);
    assert.deepEqual(state.rows[0], {
      checks: 0,
      nested_manifests: 0,
      quotes_generation: 99,
      continuation_status: "collecting",
      reconciled_models: 0,
    });
  } finally {
    await fixture.db.close();
  }
});

test("quote comparison reads and publication share one transaction", async () => {
  const fixture = await databaseFixture();
  const transactionBatches: string[][] = [];
  const loggingTransaction = async <T>(callback: (query: PostgresQuery) => Promise<T>): Promise<T> =>
    fixture.transaction(async (transactionQuery) => {
      const batch: string[] = [];
      transactionBatches.push(batch);
      const logged: PostgresQuery = async (text, values) => {
        batch.push(text);
        return transactionQuery(text, values);
      };
      return callback(logged);
    });
  try {
    await fixture.db.exec(`
      insert into metrics.metrics_quotes (quote_id, total, date_approved) values (1, 10, '2023-02-01');
      insert into metrics.quote_snapshots (quote_id, total_value, date_approved) values (1, 10, '2023-02-01');
      insert into metrics.dashboard_read_models (
        metric_family, period_grain, period_start, values_json, source_hash, rebuilt_at
      ) values ('quotes', 'month', '2023-02-01', '{"quoteCount":1,"quoteValue":10}', 'current', now());
    `);
    await seedQuoteNestedAuthority(fixture.db, 1);

    const result = await runSimproReconciliation({
      scope: "quotes",
      periodStart: period.start,
      requestBudget: 100,
      endpoints: fakeQuoteEndpoints({
        pages: { "2023-02-01:1": { ids: [1], nextPage: null } },
        details: { "1": { ID: 1, Total: { ExTax: 10 } } },
      }),
      leaseOwner: "transaction-bound-worker",
      dependencies: {
        query: fixture.query,
        transaction: loggingTransaction,
        continuationStore: fixture.store,
      },
    });
    assert.equal(result[0]?.status, "matched");

    // Exactly one publication transaction, and it must contain the app-owned
    // comparison reads alongside the manifests, the authoritative check, and
    // the continuation publish so all describe one database snapshot.
    assert.equal(transactionBatches.length, 1);
    const batch = transactionBatches[0] ?? [];
    for (const marker of [
      "from metrics.metrics_quotes",
      "from metrics.quote_snapshots",
      "from metrics.dashboard_read_models",
      "insert into metrics.source_period_manifests",
      "insert into metrics.reconciliation_checks",
      "update metrics.reconciliation_continuations",
    ]) {
      assert.ok(
        batch.some((text) => text.includes(marker)),
        `publication transaction must include: ${marker}`,
      );
    }
  } finally {
    await fixture.db.close();
  }
});

for (const [label, mutation] of [
  ["project traversal", `update metrics.project_nested_traversals set status = 'active', finalized_at = null where project_id = 1`],
  ["cost-center child", `update metrics.metrics_quote_cost_centers set traversal_generation = null where quote_id = 1`],
  ["labor child", `update metrics.metrics_quote_labor set source_hash = 'changed' where quote_id = 1`],
  ["item child", `update metrics.metrics_quote_items set source_snapshot_id = null where quote_id = 1`],
  ["work-order child", `update metrics.metrics_work_orders set traversal_generation = 99 where project_type = 'quote' and project_id = 1`],
] as const) {
  test(`partial ${label} evidence cannot publish nested or dashboard authority`, async () => {
    const fixture = await databaseFixture();
    const repairs: BoundedSourceWork[] = [];
    try {
      await fixture.db.exec(`
        insert into metrics.metrics_quotes (quote_id, total, date_approved) values (1, 10, '2023-02-01');
        insert into metrics.quote_snapshots (quote_id, total_value, date_approved) values (1, 10, '2023-02-01');
        insert into metrics.dashboard_read_models (
          metric_family, period_grain, period_start, values_json, source_hash, rebuilt_at
        ) values ('quotes', 'month', '2023-02-01', '{"quoteCount":1,"quoteValue":10}', 'current', now());
      `);
      await seedQuoteNestedAuthority(fixture.db, 1);
      await fixture.db.exec(mutation);
      const result = await runSimproReconciliation({
        scope: "quotes",
        periodStart: period.start,
        requestBudget: 100,
        endpoints: fakeQuoteEndpoints({
          pages: { "2023-02-01:1": { ids: [1], nextPage: null } },
          details: { "1": { ID: 1, Total: { ExTax: 10 } } },
        }),
        leaseOwner: `partial-${label}`,
        dependencies: {
          query: fixture.query,
          transaction: fixture.transaction,
          continuationStore: fixture.store,
          enqueueBoundedWork: async (params) => {
            repairs.push(params.work);
            return {} as BoundedSourceWorkRequest;
          },
        },
      });
      assert.equal(result[0]?.status, "mismatch");
      assert.equal(result[0]?.completeTraversal, false);
      assert.deepEqual(repairs, [{ kind: "entity_refresh", entityType: "quote", entityId: 1 }]);
      const evidence = await fixture.db.query<{
        coverage_status: string;
        reconciliation_status: string;
        continuation_token: unknown;
        authoritative_checks: number;
      }>(`
        select manifest.coverage_status, manifest.reconciliation_status,
               manifest.continuation_token,
               (select count(*)::integer from metrics.authoritative_reconciliation_checks) as authoritative_checks
          from metrics.source_period_manifests manifest
         where manifest.source_family = 'quote_nested' and manifest.period_start = '2023-02-01'
      `);
      assert.equal(evidence.rows[0]?.coverage_status, "partial");
      assert.equal(evidence.rows[0]?.reconciliation_status, "pending");
      assert.ok(evidence.rows[0]?.continuation_token);
      assert.equal(evidence.rows[0]?.authoritative_checks, 0);
    } finally {
      await fixture.db.close();
    }
  });
}

const period = { start: "2023-02-01", end: "2023-02-28" };

async function databaseFixture() {
  const db = new PGlite();
  await db.exec(`
    create schema metrics;
    create table metrics.simpro_rate_limit_buckets (
      bucket_key text primary key, window_started_at timestamptz not null,
      request_count integer not null default 0, limit_per_second integer not null,
      updated_at timestamptz not null default now()
    );
    create table metrics.source_period_manifests (
      source_family text not null, period_start date not null, period_end date not null,
      coverage_status text not null, reconciliation_status text not null,
      listed_count integer, detail_count integer, normalized_count integer,
      source_id_hash text, normalized_id_hash text, source_value numeric(18,2),
      normalized_value numeric(18,2), continuation_token jsonb, evidence_as_of timestamptz not null,
      completed_at timestamptz, mutable_period boolean not null default false,
      evidence_json jsonb not null default '{}', updated_at timestamptz not null default now(),
      primary key (source_family, period_start)
    );
    create table metrics.reconciliation_checks (
      id bigserial primary key, scope text not null, period_start date not null,
      period_end date not null, rollup_value numeric(18,4), snapshot_value numeric(18,4),
      upstream_sample_value numeric(18,4), status text not null, detail jsonb not null default '{}',
      checked_at timestamptz not null default now()
    );
    create table metrics.reconciliation_runs (id bigserial primary key);
    create table metrics.reconciliation_differences (id bigserial primary key);
    create table metrics.raw_simpro_snapshots (
      id bigserial primary key, entity_type text not null, entity_id text not null,
      source_hash text not null, complete_traversal boolean not null default false,
      source_deleted_at timestamptz, parent_identity jsonb not null default '{}'
    );
    create table metrics.project_nested_traversals (
      project_type text not null, project_id bigint not null, generation bigint not null,
      status text not null, finalized_at timestamptz, primary key (project_type, project_id)
    );
    create table metrics.metrics_quotes (
      quote_id bigint primary key, total numeric not null, date_approved date, date_issued date,
      source_deleted_at timestamptz, source_snapshot_id bigint, source_hash text
    );
    create table metrics.metrics_quote_cost_centers (
      quote_id bigint not null, section_id bigint not null, cost_center_id bigint not null,
      source_snapshot_id bigint, source_hash text, source_deleted_at timestamptz,
      traversal_generation bigint
    );
    create table metrics.metrics_quote_labor (
      quote_id bigint not null, section_id bigint not null, cost_center_id bigint not null,
      labor_id bigint not null, source_snapshot_id bigint, source_hash text,
      source_deleted_at timestamptz, traversal_generation bigint
    );
    create table metrics.metrics_quote_items (
      quote_id bigint not null, section_id bigint not null, cost_center_id bigint not null,
      item_type text not null, item_id text not null, source_snapshot_id bigint,
      source_hash text, source_deleted_at timestamptz, traversal_generation bigint
    );
    create table metrics.metrics_work_orders (
      project_type text not null, project_id bigint not null, section_id bigint not null,
      cost_center_id bigint not null, work_order_id bigint not null, source_snapshot_id bigint,
      source_hash text, source_deleted_at timestamptz, traversal_generation bigint
    );
    create table metrics.quote_snapshots (
      quote_id bigint primary key, total_value numeric, date_approved date, date_issued date
    );
    create table metrics.dashboard_read_models (
      id bigserial primary key, metric_family text not null, period_grain text not null,
      period_start date not null, values_json jsonb not null default '{}', source_hash text,
      rebuilt_at timestamptz not null default now(), superseded_at timestamptz,
      last_reconciled_at timestamptz, suspect_reason text
    );
    create table metrics.audit_events (
      id bigserial primary key, actor_email text not null, action text not null,
      entity_type text not null, entity_id text not null, after_value jsonb, reason text
    );
  `);
  const migration = await readFile(
    path.join(process.cwd(), "infra/db/migrations/031_platform_data_trust_contract.sql"),
    "utf8",
  );
  await db.exec(migration);
  await db.exec(migration);
  const quoteUnionMigration = await readFile(
    path.join(process.cwd(), "infra/db/migrations/047_quote_date_union_reconciliation_cursor.sql"),
    "utf8",
  );
  await db.exec(quoteUnionMigration);
  const query: PostgresQuery = async <T>(sql: string, values?: unknown[]) => {
    const result = await db.query<T>(sql, values);
    return { rows: result.rows, rowCount: result.affectedRows ?? null };
  };
  const transaction: ReconciliationContinuationTransaction = async <T>(callback: (query: PostgresQuery) => Promise<T>) => {
    await db.exec("begin");
    try {
      const result = await callback(query);
      await db.exec("commit");
      return result;
    } catch (error) {
      await db.exec("rollback");
      throw error;
    }
  };
  const store = createPostgresReconciliationContinuationStore({ query, transaction, leaseMs: 60_000 });
  return { db, query, transaction, store };
}

async function seedQuoteNestedAuthority(db: PGlite, quoteId: number, generation = 1) {
  const rootHash = `quote-root-${quoteId}`;
  const root = await db.query<{ id: number }>(`
    insert into metrics.raw_simpro_snapshots (
      entity_type, entity_id, source_hash, complete_traversal, parent_identity
    ) values ('quote_details', $1::text, $2, true, jsonb_build_object('projectType', 'quote', 'projectId', $1))
    returning id
  `, [quoteId, rootHash]);
  await db.query(`
    update metrics.metrics_quotes
       set source_snapshot_id = $2, source_hash = $3
     where quote_id = $1
  `, [quoteId, root.rows[0]!.id, rootHash]);
  await db.query(`
    insert into metrics.project_nested_traversals (
      project_type, project_id, generation, status, finalized_at
    ) values ('quote', $1, $2, 'completed', now())
    on conflict (project_type, project_id) do update set
      generation = excluded.generation, status = excluded.status, finalized_at = excluded.finalized_at
  `, [quoteId, generation]);

  const childSnapshot = async (kind: string) => {
    const hash = `${kind}-${quoteId}`;
    const snapshot = await db.query<{ id: number }>(`
      insert into metrics.raw_simpro_snapshots (
        entity_type, entity_id, source_hash, complete_traversal, parent_identity
      ) values (
        $1, $2::text, $3, false,
        jsonb_build_object(
          'projectType', 'quote', 'projectId', $2::bigint,
          'sectionId', 1, 'costCenterId', 10
        )
      )
      returning id
    `, [kind, quoteId, hash]);
    return { id: snapshot.rows[0]!.id, hash };
  };
  const costCenter = await childSnapshot("quote_cost_center");
  const labor = await childSnapshot("quote_labor");
  const item = await childSnapshot("quote_item");
  const workOrder = await childSnapshot("quote_work_order");
  await db.query(`
    insert into metrics.metrics_quote_cost_centers (
      quote_id, section_id, cost_center_id, source_snapshot_id, source_hash, traversal_generation
    ) values ($1, 1, 10, $2, $3, $4)
  `, [quoteId, costCenter.id, costCenter.hash, generation]);
  await db.query(`
    insert into metrics.metrics_quote_labor (
      quote_id, section_id, cost_center_id, labor_id,
      source_snapshot_id, source_hash, traversal_generation
    ) values ($1, 1, 10, 20, $2, $3, $4)
  `, [quoteId, labor.id, labor.hash, generation]);
  await db.query(`
    insert into metrics.metrics_quote_items (
      quote_id, section_id, cost_center_id, item_type, item_id,
      source_snapshot_id, source_hash, traversal_generation
    ) values ($1, 1, 10, 'catalog', '30', $2, $3, $4)
  `, [quoteId, item.id, item.hash, generation]);
  await db.query(`
    insert into metrics.metrics_work_orders (
      project_type, project_id, section_id, cost_center_id, work_order_id,
      source_snapshot_id, source_hash, traversal_generation
    ) values ('quote', $1, 1, 10, 40, $2, $3, $4)
  `, [quoteId, workOrder.id, workOrder.hash, generation]);
}

function fakeQuoteEndpoints(params: {
  pages: Record<string, { ids: number[]; nextPage: number | null }>;
  details: Record<string, Record<string, unknown>>;
  onList?: (day: string, page: number, dateField: "DateApproved" | "DateIssued") => void | Promise<void>;
  onDetail?: () => void | Promise<void>;
}) {
  return {
    async listQuotes(options: { page?: number; budget?: RequestBudget; query?: Record<string, unknown> }) {
      consume(options.budget);
      const dateField = options.query?.DateIssued === undefined ? "DateApproved" : "DateIssued";
      const day = String(options.query?.[dateField]);
      const page = options.page ?? 1;
      await params.onList?.(day, page, dateField);
      const configured = params.pages[`${dateField}:${day}:${page}`]
        ?? params.pages[`${day}:${page}`]
        ?? { ids: [], nextPage: null };
      return {
        rows: configured.ids.map((ID) => ({ ID })),
        page,
        pageSize: 250,
        hasMore: configured.nextPage !== null,
        continuationToken: configured.nextPage ? { page: configured.nextPage } : null,
      };
    },
    async getQuote(id: string, budget?: RequestBudget) {
      consume(budget);
      await params.onDetail?.();
      return params.details[id] ?? { ID: Number(id), Total: { ExTax: 0 } };
    },
    async listJobs() { throw new Error("unexpected jobs list"); },
    async getJob() { throw new Error("unexpected job detail"); },
  } as unknown as SimproEndpoints;
}

function throwingEndpoints() {
  return {
    async listQuotes() { throw new Error("repair-pending continuation must not rescan source pages"); },
    async getQuote() { throw new Error("repair-pending continuation must not refetch details"); },
  } as unknown as SimproEndpoints;
}

function consume(budget: RequestBudget | undefined) {
  if (!budget || budget.used >= budget.limit) throw new Error("test request budget exhausted");
  budget.used += 1;
}
