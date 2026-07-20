import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { normalizeSimproSnapshot } from "../../src/lib/simpro/normalize";
import {
  beginProjectNestedTraversal,
  emptyNestedTraversalSeen,
  finalizeProjectNestedTraversal,
  markProjectSourceUnavailable,
  withCurrentProjectNestedTraversal,
} from "../../src/lib/simpro/normalize-nested";
import {
  categoryForVerifiedConfiguredCostCenterId,
  executeQuoteCategoryRebuild,
  inspectQuoteCategoryRebuild,
  QUOTE_CATEGORY_BASIS,
  QUOTE_CATEGORY_REBUILD_CONFIRMATION,
  QUOTE_CATEGORY_TIE_BREAK,
  reprojectPersistedQuoteCategory,
  type QuoteCategoryRebuildTransaction,
} from "../../src/lib/store/quote-category-rebuild";
import type { PostgresQuery } from "../../src/lib/store/postgres";
import { parseReprojectQuoteCategoryArgs } from "../../workers/reproject-quote-categories";

test("root quote refresh preserves category parity and does not tombstone partial embedded Sections", async () => {
  const db = await normalizationDatabase();
  const baseQuery = pgliteQuery(db);
  const normalizationSql: string[] = [];
  const query = (async <T>(sql: string, values: unknown[] = []) => {
    normalizationSql.push(sql);
    return baseQuery<T>(sql, values);
  }) as PostgresQuery;
  try {
    await db.exec(`
      insert into metrics.metrics_quotes (
        quote_id, date_approved, category, category_basis, name, outcome, outcome_reason
      ) values (41, date '2025-05-10', 'HVAC', '${QUOTE_CATEGORY_BASIS}', 'Original', 'lost', 'seed');
      insert into metrics.metrics_quote_cost_centers (
        quote_id, section_id, cost_center_id, configured_cost_center_id, name, category, sell_value
      ) values
        (41, 1, 101, 7, 'HVAC Service', 'HVAC', 1250),
        (41, 2, 102, 6, 'Water Heating Service', 'Water Heating', 250);
      insert into metrics.quote_snapshots (
        quote_id, name, date_approved, category, category_basis
      ) values (41, 'Original', date '2025-05-10', 'HVAC', '${QUOTE_CATEGORY_BASIS}')
    `);

    await normalizeSimproSnapshot({
      entity: "quotes",
      entityId: "41",
      payload: {
        QuoteNo: "Q-41",
        Name: "Root refresh without nested sections",
        DateApproved: "2025-05-10",
        Total: { ExTax: 1250 },
        Status: { ID: 3, Name: "Pending" },
        Sections: [{
          ID: 1,
          CostCenters: [{
            ID: 101,
            Name: "arbitrary free text must not classify",
            CostCenter: { ID: 7, Name: "arbitrary configured name" },
            Total: { ExTax: 1250 },
          }],
        }],
      },
      query,
    });

    const categories = await db.query<{
      canonical_category: string;
      canonical_basis: string;
      snapshot_category: string;
      snapshot_basis: string;
    }>(`
      select q.category canonical_category, q.category_basis canonical_basis,
             s.category snapshot_category, s.category_basis snapshot_basis
        from metrics.metrics_quotes q
        join metrics.quote_snapshots s using (quote_id)
       where q.quote_id = 41
    `);
    assert.deepEqual(categories.rows[0], {
      canonical_category: "HVAC",
      canonical_basis: QUOTE_CATEGORY_BASIS,
      snapshot_category: "HVAC",
      snapshot_basis: QUOTE_CATEGORY_BASIS,
    });
    const children = await db.query<{ cost_center_id: number; configured_cost_center_id: number | null; name: string; sell_value: string; source_deleted_at: string | null }>(`
      select cost_center_id::integer, configured_cost_center_id::integer, name, sell_value::text, source_deleted_at::text
        from metrics.metrics_quote_cost_centers where quote_id = 41 order by cost_center_id
    `);
    assert.deepEqual(children.rows, [
      { cost_center_id: 101, configured_cost_center_id: 7, name: "HVAC Service", sell_value: "1250.00", source_deleted_at: null },
      { cost_center_id: 102, configured_cost_center_id: 6, name: "Water Heating Service", sell_value: "250.00", source_deleted_at: null },
    ]);
    assert.equal(normalizationSql.some((sql) => sql.includes("metrics.metrics_quote_cost_centers")), false);
    assert.equal(normalizationSql.some((sql) => /set\s+category\s*=/.test(sql)), false);
  } finally {
    await db.close();
  }
});

test("dry-run derives exact quote, child, category, serving-window, and affected-period counts", async () => {
  const db = await rebuildDatabase();
  try {
    const preview = await inspectQuoteCategoryRebuild(pgliteQuery(db));
    assert.deepEqual(preview.servingWindow, {
      firstApprovedDate: "2025-05-10",
      lastApprovedDate: "2025-06-03",
      firstPeriod: "2025-05-01",
      lastPeriod: "2025-06-01",
    });
    assert.equal(preview.activeQuoteCount, 3);
    assert.equal(preview.activeQuoteChildCount, 4);
    assert.equal(preview.mappedQuoteChildCount, 3);
    assert.equal(preview.invalidConfiguredCostCenterChildCount, 1);
    assert.equal(preview.quotesWithCostCenterCoverage, 3);
    assert.deepEqual(preview.missingCostCenterQuoteIds, []);
    assert.deepEqual(preview.currentCategoryCounts, [
      { category: "HVAC", count: 1 },
      { category: "Unclassified", count: 2 },
    ]);
    assert.deepEqual(preview.projectedCategoryCounts, [
      { category: "HVAC", count: 1 },
      { category: "Unclassified", count: 1 },
      { category: "Water Heating", count: 1 },
    ]);
    assert.equal(preview.affectedQuoteCount, 3);
    assert.deepEqual(preview.affectedPeriods, ["2025-05-01", "2025-06-01"]);
    assert.deepEqual(preview.invalidConfiguredCostCenterChildren, [{
      quoteId: 3,
      sectionId: 1,
      costCenterId: 31,
      configuredCostCenterId: null,
    }]);
  } finally {
    await db.close();
  }
});

test("execution reprojects canonical and snapshot categories, audits once, and invalidates every affected month", async () => {
  const db = await rebuildDatabase();
  const query = pgliteQuery(db);
  try {
    const result = await executeQuoteCategoryRebuild({
      actorEmail: "Owner@Example.com",
      confirmation: QUOTE_CATEGORY_REBUILD_CONFIRMATION,
    }, { query, transaction: pgliteTransaction(db, query) });

    assert.equal(result.canonicalQuotesUpdated, 3);
    assert.equal(result.snapshotsUpdated, 3);
    assert.equal(result.rollupsQueued, 2);
    assert.equal(result.after.affectedQuoteCount, 0);
    assert.deepEqual(result.after.projectedCategoryCounts, result.after.currentCategoryCounts);

    const parity = await db.query<{ mismatches: number }>(`
      select count(*)::integer mismatches
        from metrics.metrics_quotes q
        join metrics.quote_snapshots s using (quote_id)
       where q.source_deleted_at is null and q.date_approved is not null
         and (q.category is distinct from s.category
           or q.category_basis is distinct from s.category_basis)
    `);
    assert.equal(parity.rows[0]?.mismatches, 0);

    const audit = await db.query<{ count: number; actor_email: string; action: string }>(`
      select count(*)::integer count, max(actor_email) actor_email, max(action) action
        from metrics.audit_events
    `);
    assert.deepEqual(audit.rows[0], {
      count: 1,
      actor_email: "Owner@Example.com",
      action: "quote_categories_reprojected",
    });
    const rollups = await db.query<{ period_start: string; metric_family: string; status: string }>(`
      select period_start::text, metric_family, status::text
        from metrics.rollup_rebuild_queue
       order by period_start
    `);
    assert.deepEqual(rollups.rows, [
      { period_start: "2025-05-01", metric_family: "quotes", status: "queued" },
      { period_start: "2025-06-01", metric_family: "quotes", status: "queued" },
    ]);
    const evidence = await db.query<{ before_value: Record<string, unknown>; after_value: Record<string, unknown> }>(`
      select before_value, after_value from metrics.audit_events
    `);
    const beforeEvidence = evidence.rows[0]?.before_value as {
      summary: { affectedPeriods: string[] };
      quotes: Array<{ quoteId: number; canonical: { category: string }; snapshot: { category: string } }>;
      children: Array<{ quoteId: number; costCenterId: number; category: string; projectedCategory: string }>;
    };
    const afterEvidence = evidence.rows[0]?.after_value as typeof beforeEvidence;
    assert.deepEqual(beforeEvidence.summary.affectedPeriods, ["2025-05-01", "2025-06-01"]);
    assert.deepEqual(afterEvidence.summary.affectedPeriods, []);
    assert.equal(beforeEvidence.quotes.length, 3);
    assert.equal(afterEvidence.quotes.length, 3);
    assert.equal(beforeEvidence.quotes[0]?.canonical.category, "Unclassified");
    assert.equal(afterEvidence.quotes[0]?.canonical.category, "HVAC");
    assert.equal(beforeEvidence.children.length, 4);
    assert.equal(afterEvidence.children.length, 4);
    assert.deepEqual(
      beforeEvidence.children.map((child) => [child.quoteId, child.costCenterId, child.category, child.projectedCategory]),
      [
        [1, 11, "Water Heating", "HVAC"],
        [1, 12, "HVAC", "Water Heating"],
        [2, 21, "HVAC", "Water Heating"],
        [3, 31, "HVAC", "Unclassified"],
      ],
    );
    assert.deepEqual(
      afterEvidence.children.map((child) => [child.quoteId, child.costCenterId, child.category, child.projectedCategory]),
      [
        [1, 11, "HVAC", "HVAC"],
        [1, 12, "Water Heating", "Water Heating"],
        [2, 21, "Water Heating", "Water Heating"],
        [3, 31, "Unclassified", "Unclassified"],
      ],
    );
  } finally {
    await db.close();
  }
});

test("execution rejects a mismatched transaction query before lock, read, or write", async () => {
  const db = await rebuildDatabase();
  const baseQuery = pgliteQuery(db);
  const suppliedSql: string[] = [];
  const transactionSql: string[] = [];
  const suppliedQuery = (async <T>(sql: string, values: unknown[] = []) => {
    suppliedSql.push(sql);
    return baseQuery<T>(sql, values);
  }) as PostgresQuery;
  const transactionQuery = (async <T>(sql: string, values: unknown[] = []) => {
    transactionSql.push(sql);
    return baseQuery<T>(sql, values);
  }) as PostgresQuery;
  try {
    const before = await inspectQuoteCategoryRebuild(baseQuery);
    await assert.rejects(
      executeQuoteCategoryRebuild({
        actorEmail: "owner@example.com",
        confirmation: QUOTE_CATEGORY_REBUILD_CONFIRMATION,
      }, { query: suppliedQuery, transaction: pgliteTransaction(db, transactionQuery) }),
      /must use the query supplied by its transaction/,
    );

    assert.deepEqual(suppliedSql, []);
    assert.deepEqual(transactionSql, []);
    assert.deepEqual(await inspectQuoteCategoryRebuild(baseQuery), before);
  } finally {
    await db.close();
  }
});

test("audit failure rolls canonical, snapshot, audit, and rollup writes back", async () => {
  const db = await rebuildDatabase();
  const query = pgliteQuery(db);
  try {
    await db.exec(`
      alter table metrics.audit_events
      add constraint reject_reprojection check (action <> 'quote_categories_reprojected')
    `);
    await assert.rejects(
      executeQuoteCategoryRebuild({
        actorEmail: "owner@example.com",
        confirmation: QUOTE_CATEGORY_REBUILD_CONFIRMATION,
      }, { query, transaction: pgliteTransaction(db, query) }),
      /reject_reprojection/,
    );

    const canonical = await db.query<{ category: string; category_basis: string | null }>(`
      select category, category_basis from metrics.metrics_quotes where quote_id = 1
    `);
    assert.deepEqual(canonical.rows[0], { category: "Unclassified", category_basis: "nested traversal pending" });
    const snapshot = await db.query<{ category: string; category_basis: string | null }>(`
      select category, category_basis from metrics.quote_snapshots where quote_id = 1
    `);
    assert.deepEqual(snapshot.rows[0], { category: "Unclassified", category_basis: "nested traversal pending" });
    const writes = await db.query<{ audits: number; rollups: number }>(`
      select (select count(*)::integer from metrics.audit_events) audits,
             (select count(*)::integer from metrics.rollup_rebuild_queue) rollups
    `);
    assert.deepEqual(writes.rows[0], { audits: 0, rollups: 0 });
  } finally {
    await db.close();
  }
});

test("execution fails closed when an active served quote lacks a persisted cost center", async () => {
  const db = await rebuildDatabase();
  const query = pgliteQuery(db);
  try {
    await db.exec(`
      insert into metrics.metrics_quotes (quote_id, date_approved, category, category_basis)
      values (4, date '2025-06-04', 'Unclassified', 'nested traversal pending');
      insert into metrics.quote_snapshots (quote_id, date_approved, category, category_basis)
      values (4, date '2025-06-04', 'Unclassified', 'nested traversal pending')
    `);
    await assert.rejects(
      executeQuoteCategoryRebuild({
        actorEmail: "owner@example.com",
        confirmation: QUOTE_CATEGORY_REBUILD_CONFIRMATION,
      }, { query, transaction: pgliteTransaction(db, query) }),
      /lack persisted cost-center coverage: 4/,
    );
    const writes = await db.query<{ audits: number; rollups: number }>(`
      select (select count(*)::integer from metrics.audit_events) audits,
             (select count(*)::integer from metrics.rollup_rebuild_queue) rollups
    `);
    assert.deepEqual(writes.rows[0], { audits: 0, rollups: 0 });
  } finally {
    await db.close();
  }
});

test("verified configured IDs are authoritative and null or unknown IDs map to visible Unclassified", async () => {
  assert.equal(categoryForVerifiedConfiguredCostCenterId(4), "Water Heating");
  assert.equal(categoryForVerifiedConfiguredCostCenterId(7), "HVAC");
  assert.equal(categoryForVerifiedConfiguredCostCenterId(9), "Unclassified");
  assert.equal(categoryForVerifiedConfiguredCostCenterId(null), "Unclassified");
  assert.equal(categoryForVerifiedConfiguredCostCenterId(999), "Unclassified");

  const db = await rebuildDatabase();
  try {
    const preview = await inspectQuoteCategoryRebuild(pgliteQuery(db));
    const nullMapped = preview.quoteStates.find((state) => state.quoteId === 3);
    assert.equal(nullMapped?.activeChildCount, 1);
    assert.equal(nullMapped?.mappedChildCount, 0);
    assert.equal(nullMapped?.projected.category, "Unclassified");
    assert.equal(preview.missingCostCenterQuoteIds.includes(3), false);
  } finally {
    await db.close();
  }
});

test("parent projection ranks Unclassified sell contribution and uses the documented category-name tie-break", async () => {
  const db = await rebuildDatabase();
  try {
    await db.exec(`
      insert into metrics.metrics_quotes (quote_id, date_approved, category, category_basis) values
        (4, date '2025-06-10', 'HVAC', '${QUOTE_CATEGORY_BASIS}'),
        (5, date '2025-06-11', 'Water Heating', '${QUOTE_CATEGORY_BASIS}');
      insert into metrics.quote_snapshots (quote_id, date_approved, category, category_basis) values
        (4, date '2025-06-10', 'HVAC', '${QUOTE_CATEGORY_BASIS}'),
        (5, date '2025-06-11', 'Water Heating', '${QUOTE_CATEGORY_BASIS}');
      insert into metrics.metrics_quote_cost_centers (
        quote_id, section_id, cost_center_id, configured_cost_center_id, category, sell_value
      ) values
        (4, 1, 41, 7, 'HVAC', 100),
        (4, 1, 42, 6, 'Water Heating', 300),
        (4, 1, 43, 9, 'Unclassified', 50),
        (4, 1, 44, 999, 'Unclassified', 200),
        (4, 1, 45, null, 'Unclassified', 100),
        (5, 1, 51, 7, 'HVAC', 100),
        (5, 1, 52, 6, 'Water Heating', 100),
        (5, 1, 53, 9, 'Unclassified', 100)
    `);

    const preview = await inspectQuoteCategoryRebuild(pgliteQuery(db));
    assert.equal(QUOTE_CATEGORY_TIE_BREAK, "category name ascending");
    assert.equal(preview.quoteStates.find((state) => state.quoteId === 4)?.projected.category, "Unclassified");
    assert.equal(preview.quoteStates.find((state) => state.quoteId === 5)?.projected.category, "HVAC");
  } finally {
    await db.close();
  }
});

test("child-only correction is audited exactly and invalidates its quote month once", async () => {
  const db = await rebuildDatabase();
  const query = pgliteQuery(db);
  try {
    await db.exec(`
      update metrics.metrics_quote_cost_centers
         set category = case cost_center_id
           when 11 then 'HVAC'
           when 12 then 'Water Heating'
           when 21 then 'Water Heating'
           when 31 then 'Unclassified'
         end;
      update metrics.metrics_quotes
         set category = case quote_id
           when 1 then 'HVAC'
           when 2 then 'Water Heating'
           when 3 then 'Unclassified'
         end,
             category_basis = '${QUOTE_CATEGORY_BASIS}'
       where quote_id in (1, 2, 3);
      update metrics.quote_snapshots
         set category = case quote_id
           when 1 then 'HVAC'
           when 2 then 'Water Heating'
           when 3 then 'Unclassified'
         end,
             category_basis = '${QUOTE_CATEGORY_BASIS}'
       where quote_id in (1, 2, 3);
      update metrics.metrics_quote_cost_centers
         set category = 'HVAC'
       where quote_id = 2 and section_id = 1 and cost_center_id = 21
    `);

    const preview = await inspectQuoteCategoryRebuild(query);
    assert.equal(preview.canonicalQuotesNeedingProjection, 0);
    assert.equal(preview.snapshotsNeedingProjection, 0);
    assert.equal(preview.childRowsNeedingCategoryMapping, 1);
    assert.equal(preview.affectedQuoteCount, 1);
    assert.deepEqual(preview.affectedPeriods, ["2025-05-01"]);
    assert.deepEqual(preview.childCategoryCorrections, [{
      quoteId: 2,
      sectionId: 1,
      costCenterId: 21,
      configuredCostCenterId: 6,
      category: "HVAC",
      projectedCategory: "Water Heating",
      sellValue: "200.00",
    }]);

    const result = await executeQuoteCategoryRebuild({
      actorEmail: "owner@example.com",
      confirmation: QUOTE_CATEGORY_REBUILD_CONFIRMATION,
    }, { query, transaction: pgliteTransaction(db, query) });
    assert.equal(result.canonicalQuotesUpdated, 0);
    assert.equal(result.snapshotsUpdated, 0);
    assert.equal(result.childRowsUpdated, 1);
    assert.equal(result.rollupsQueued, 1);
    assert.equal(result.after.affectedQuoteCount, 0);

    const audit = await db.query<{ before_value: Record<string, unknown>; after_value: Record<string, unknown> }>(`
      select before_value, after_value from metrics.audit_events
    `);
    const before = audit.rows[0]?.before_value as {
      summary: { affectedPeriods: string[] };
      quotes: Array<{ quoteId: number }>;
      children: Array<{ quoteId: number; sectionId: number; costCenterId: number; category: string; projectedCategory: string }>;
    };
    const after = audit.rows[0]?.after_value as typeof before;
    assert.deepEqual(before.summary.affectedPeriods, ["2025-05-01"]);
    assert.deepEqual(before.quotes.map((quote) => quote.quoteId), [2]);
    assert.deepEqual(before.children, [{
      quoteId: 2,
      sectionId: 1,
      costCenterId: 21,
      configuredCostCenterId: 6,
      category: "HVAC",
      projectedCategory: "Water Heating",
      sellValue: "200.00",
    }]);
    assert.deepEqual(after.children, [{
      quoteId: 2,
      sectionId: 1,
      costCenterId: 21,
      configuredCostCenterId: 6,
      category: "Water Heating",
      projectedCategory: "Water Heating",
      sellValue: "200.00",
    }]);
    const rollups = await db.query<{ period_start: string }>(`
      select period_start::text from metrics.rollup_rebuild_queue
    `);
    assert.deepEqual(rollups.rows, [{ period_start: "2025-05-01" }]);
  } finally {
    await db.close();
  }
});

test("nested finalization atomically updates canonical and snapshot category and invalidates its month", async () => {
  const db = await rebuildDatabase();
  const query = pgliteQuery(db);
  try {
    let finalizationStatements = 0;
    const observedQuery = (async <T>(sql: string, values: unknown[] = []) => {
      if (sql.includes("canonical_updated") && sql.includes("snapshot_updated") && sql.includes("rollup_queued")) {
        finalizationStatements += 1;
      }
      return query<T>(sql, values);
    }) as PostgresQuery;
    const projection = await reprojectPersistedQuoteCategory(1, observedQuery);
    assert.deepEqual(projection.affectedPeriods, ["2025-05-01"]);
    assert.equal(finalizationStatements, 1);
    const parity = await db.query<{ canonical: string; snapshot: string; basis: string }>(`
      select q.category canonical, s.category snapshot, q.category_basis basis
        from metrics.metrics_quotes q join metrics.quote_snapshots s using (quote_id)
       where q.quote_id = 1
    `);
    assert.deepEqual(parity.rows[0], { canonical: "HVAC", snapshot: "HVAC", basis: QUOTE_CATEGORY_BASIS });
    const queue = await db.query<{ period_start: string }>(`
      select period_start::text from metrics.rollup_rebuild_queue
    `);
    assert.deepEqual(queue.rows, [{ period_start: "2025-05-01" }]);
    const root = await db.query<{ complete_traversal: boolean }>(`
      select complete_traversal from metrics.raw_simpro_snapshots where id = 1
    `);
    assert.equal(root.rows[0]?.complete_traversal, false);
  } finally {
    await db.close();
  }
});

test("nested rollup insertion failure leaves canonical and snapshot category unchanged", async () => {
  const db = await rebuildDatabase();
  const query = pgliteQuery(db);
  try {
    await db.exec("alter table metrics.rollup_rebuild_queue add constraint reject_nested_rollup check (metric_family <> 'quotes')");
    await assert.rejects(reprojectPersistedQuoteCategory(1, query), /reject_nested_rollup/);
    const parity = await db.query<{ canonical: string; snapshot: string; canonical_basis: string; snapshot_basis: string }>(`
      select q.category canonical, s.category snapshot,
             q.category_basis canonical_basis, s.category_basis snapshot_basis
        from metrics.metrics_quotes q join metrics.quote_snapshots s using (quote_id)
       where q.quote_id = 1
    `);
    assert.deepEqual(parity.rows[0], {
      canonical: "Unclassified",
      snapshot: "Unclassified",
      canonical_basis: "nested traversal pending",
      snapshot_basis: "nested traversal pending",
    });
  } finally {
    await db.close();
  }
});

test("complete nested traversal returns the quote period when category finalization changes", async () => {
  const db = await rebuildDatabase();
  const query = pgliteQuery(db);
  try {
    const affected = await finalizeProjectNestedTraversal({
      projectType: "quote",
      projectId: 1,
      generation: 1,
      rootSnapshotId: 1,
      seen: {
        ...emptyNestedTraversalSeen(),
        costCenters: ["1:11", "1:12"],
      },
      query,
      transaction: pgliteTransaction(db, query),
    });
    assert.deepEqual(affected, {
      applied: true,
      affectedPeriods: [{ scope: "quotes", periodStart: "2025-05-01" }],
    });
    const root = await db.query<{ complete_traversal: boolean; status: string }>(`
      select snapshot.complete_traversal, traversal.status
        from metrics.raw_simpro_snapshots snapshot
        cross join metrics.project_nested_traversals traversal
       where snapshot.id = 1 and traversal.project_type = 'quote' and traversal.project_id = 1
    `);
    assert.deepEqual(root.rows[0], { complete_traversal: true, status: "completed" });
  } finally {
    await db.close();
  }
});

test("complete nested traversal rolls every cleanup mutation back when final publication fails", async () => {
  const db = await rebuildDatabase();
  const query = pgliteQuery(db);
  try {
    await db.exec(`
      insert into metrics.metrics_quote_labor (
        quote_id, section_id, cost_center_id, labor_id, quantity_hours
      ) values (1, 1, 11, 101, 3.5);
      insert into metrics.metrics_quote_items (
        quote_id, section_id, cost_center_id, item_type, item_id
      ) values (1, 1, 11, 'catalog', 'item-101');
      insert into metrics.metrics_work_orders (
        project_type, project_id, section_id, cost_center_id, work_order_id
      ) values ('quote', 1, 1, 11, 1001);
      insert into metrics.metrics_schedules (
        schedule_id, reference_type, reference_id
      ) values (2001, 'quote', 1);
      insert into metrics.schedule_snapshots (
        schedule_id, project_type, project_id
      ) values (2001, 'quote', '1');
      insert into metrics.metrics_schedule_blocks (
        schedule_id, block_index, reference_type, reference_id
      ) values (2001, 0, 'quote', 1);
      alter table metrics.rollup_rebuild_queue
        add constraint reject_complete_nested_rollup check (metric_family <> 'quotes');
    `);

    const before = await nestedFinalizationState(db);
    await assert.rejects(
      finalizeProjectNestedTraversal({
        projectType: "quote",
        projectId: 1,
        generation: 1,
        rootSnapshotId: 1,
        seen: {
          ...emptyNestedTraversalSeen(),
          costCenters: ["1:11"],
        },
        query,
        transaction: pgliteTransaction(db, query),
      }),
      /reject_complete_nested_rollup/,
    );

    assert.deepEqual(await nestedFinalizationState(db), before);
    const queue = await db.query<{ count: number }>(
      "select count(*)::integer count from metrics.rollup_rebuild_queue",
    );
    assert.equal(queue.rows[0]?.count, 0);
  } finally {
    await db.close();
  }
});

test("complete quote finalization locks before cleanup and uses one transaction query", async () => {
  const db = await rebuildDatabase();
  const query = pgliteQuery(db);
  const observedSql: string[] = [];
  const observedQuery = (async <T>(sql: string, values: unknown[] = []) => {
    observedSql.push(sql);
    return query<T>(sql, values);
  }) as PostgresQuery;
  try {
    await finalizeProjectNestedTraversal({
      projectType: "quote",
      projectId: 1,
      generation: 1,
      rootSnapshotId: 1,
      seen: {
        ...emptyNestedTraversalSeen(),
        costCenters: ["1:11", "1:12"],
      },
      query: observedQuery,
      transaction: pgliteTransaction(db, observedQuery),
    });
    assert.match(observedSql[0] ?? "", /pg_advisory_xact_lock/);
    assert.equal(observedSql.some((sql) => sql.includes("source_deleted_at = now()")), true);
  } finally {
    await db.close();
  }
});

test("complete nested traversal rejects an injected query without a transaction", async () => {
  const db = await rebuildDatabase();
  try {
    await assert.rejects(
      finalizeProjectNestedTraversal({
        projectType: "quote",
        projectId: 1,
        generation: 1,
        rootSnapshotId: 1,
        seen: emptyNestedTraversalSeen(),
        query: pgliteQuery(db),
      }),
      /requires an explicit transaction/,
    );
  } finally {
    await db.close();
  }
});

test("a newer traversal generation makes older finalization harmless", async () => {
  const db = await rebuildDatabase();
  const query = pgliteQuery(db);
  try {
    const generation = await beginProjectNestedTraversal(
      "quote",
      1,
      pgliteTransaction(db, query),
    );
    assert.equal(generation, 2);
    const before = await nestedFinalizationState(db);

    const stale = await finalizeProjectNestedTraversal({
      projectType: "quote",
      projectId: 1,
      generation: 1,
      rootSnapshotId: 1,
      seen: emptyNestedTraversalSeen(),
      query,
      transaction: pgliteTransaction(db, query),
    });

    assert.deepEqual(stale, { applied: false, affectedPeriods: [] });
    assert.deepEqual(await nestedFinalizationState(db), before);
    const traversal = await db.query<{ generation: number; status: string }>(`
      select generation::integer, status
        from metrics.project_nested_traversals
       where project_type = 'quote' and project_id = 1
    `);
    assert.deepEqual(traversal.rows[0], { generation: 2, status: "active" });

    let callbackRuns = 0;
    const staleRoot = await withCurrentProjectNestedTraversal({
      projectType: "quote",
      projectId: 1,
      generation: 1,
      transaction: pgliteTransaction(db, query),
      callback: async () => {
        callbackRuns += 1;
        return "unexpected";
      },
    });
    assert.deepEqual(staleRoot, { applied: false, value: null });
    assert.equal(callbackRuns, 0);
  } finally {
    await db.close();
  }
});

test("quote source-unavailable publication locks first and rolls every mutation back on failure", async () => {
  const db = await rebuildDatabase();
  const baseQuery = pgliteQuery(db);
  const observedSql: string[] = [];
  const query = (async <T>(sql: string, values: unknown[] = []) => {
    observedSql.push(sql);
    return baseQuery<T>(sql, values);
  }) as PostgresQuery;
  try {
    await db.exec(`
      alter table metrics.metrics_quote_cost_centers
        add constraint reject_source_unavailable check (source_deleted_at is null);
    `);
    await assert.rejects(
      markProjectSourceUnavailable("quote", 1, {
        expectedGeneration: 1,
        query,
        transaction: pgliteTransaction(db, query),
      }),
      /reject_source_unavailable/,
    );

    assert.match(observedSql[0] ?? "", /pg_advisory_xact_lock/);
    const state = await db.query<{
      quote_deleted: string | null;
      snapshot_count: number;
      child_deleted: number;
      status: string;
    }>(`
      select q.source_deleted_at::text quote_deleted,
             (select count(*)::integer from metrics.quote_snapshots where quote_id = 1) snapshot_count,
             (select count(*)::integer from metrics.metrics_quote_cost_centers
               where quote_id = 1 and source_deleted_at is not null) child_deleted,
             (select status from metrics.project_nested_traversals
               where project_type = 'quote' and project_id = 1) status
        from metrics.metrics_quotes q where q.quote_id = 1
    `);
    assert.deepEqual(state.rows[0], {
      quote_deleted: null,
      snapshot_count: 1,
      child_deleted: 0,
      status: "active",
    });
  } finally {
    await db.close();
  }
});

test("source-unavailable atomically inserts its tombstone, deletes nested raw evidence, and queues its month", async () => {
  const db = await rebuildDatabase();
  const query = pgliteQuery(db);
  try {
    await db.query(
      `insert into metrics.raw_simpro_snapshots (
         id, entity_type, entity_id, source_path, source_hash, parent_identity
       ) values (99, 'quote_labor_detail', '1:1:11:labor:9', '/quotes/1/labor/9', 'child-raw', $1::jsonb)`,
      [JSON.stringify({ projectType: "quote", projectId: 1, sectionId: 1 })],
    );

    const result = await markProjectSourceUnavailable("quote", 1, {
      expectedGeneration: 1,
      tombstoneSnapshot: {
        entityType: "quote_details",
        entityId: "1",
        sourcePath: "/quotes/1",
        payload: { sourceUnavailable: true, projectType: "quote", projectId: 1 },
        sourceHash: "quote-1-not-found",
        parentIdentity: { projectType: "quote", projectId: 1 },
      },
      query,
      transaction: pgliteTransaction(db, query),
    });

    assert.deepEqual(result, {
      applied: true,
      affectedPeriods: [{ scope: "quotes", periodStart: "2025-05-01" }],
      snapshotInserted: true,
    });
    const state = await db.query<{
      raw_active: number;
      raw_deleted: number;
      quote_deleted: boolean;
      snapshot_count: number;
      rollups: number;
      status: string;
    }>(`
      select
        (select count(*)::integer from metrics.raw_simpro_snapshots
          where ((entity_type = 'quote_details' and entity_id = '1')
             or (parent_identity->>'projectType' = 'quote' and parent_identity->>'projectId' = '1'))
            and source_deleted_at is null) raw_active,
        (select count(*)::integer from metrics.raw_simpro_snapshots
          where ((entity_type = 'quote_details' and entity_id = '1')
             or (parent_identity->>'projectType' = 'quote' and parent_identity->>'projectId' = '1'))
            and source_deleted_at is not null) raw_deleted,
        (select source_deleted_at is not null from metrics.metrics_quotes where quote_id = 1) quote_deleted,
        (select count(*)::integer from metrics.quote_snapshots where quote_id = 1) snapshot_count,
        (select count(*)::integer from metrics.rollup_rebuild_queue
          where metric_family = 'quotes' and period_start = date '2025-05-01') rollups,
        (select status from metrics.project_nested_traversals
          where project_type = 'quote' and project_id = 1) status
    `);
    assert.deepEqual(state.rows[0], {
      raw_active: 0,
      raw_deleted: 3,
      quote_deleted: true,
      snapshot_count: 0,
      rollups: 1,
      status: "source_deleted",
    });
  } finally {
    await db.close();
  }
});

test("stale source-unavailable authority inserts no tombstone and changes nothing", async () => {
  const db = await rebuildDatabase();
  const query = pgliteQuery(db);
  try {
    await beginProjectNestedTraversal("quote", 1, pgliteTransaction(db, query));
    const before = await nestedFinalizationState(db);
    const rawBefore = await db.query<{ count: number }>("select count(*)::integer count from metrics.raw_simpro_snapshots");
    const result = await markProjectSourceUnavailable("quote", 1, {
      expectedGeneration: 1,
      tombstoneSnapshot: {
        entityType: "quote_details",
        entityId: "1",
        sourcePath: "/quotes/1",
        payload: { sourceUnavailable: true },
        sourceHash: "stale-not-found",
        parentIdentity: { projectType: "quote", projectId: 1 },
      },
      query,
      transaction: pgliteTransaction(db, query),
    });
    assert.deepEqual(result, { applied: false, affectedPeriods: [] });
    assert.deepEqual(await nestedFinalizationState(db), before);
    const rawAfter = await db.query<{ count: number }>("select count(*)::integer count from metrics.raw_simpro_snapshots");
    assert.equal(rawAfter.rows[0]?.count, rawBefore.rows[0]?.count);
  } finally {
    await db.close();
  }
});

test("source-unavailable rollup failure rolls tombstone, raw deletion, canonical deletion, and authority back", async () => {
  const db = await rebuildDatabase();
  const query = pgliteQuery(db);
  try {
    await db.exec("alter table metrics.rollup_rebuild_queue add constraint reject_source_rollup check (metric_family <> 'quotes')");
    const before = await nestedFinalizationState(db);
    const rawBefore = await db.query<{ count: number }>("select count(*)::integer count from metrics.raw_simpro_snapshots");
    await assert.rejects(
      markProjectSourceUnavailable("quote", 1, {
        expectedGeneration: 1,
        tombstoneSnapshot: {
          entityType: "quote_details",
          entityId: "1",
          sourcePath: "/quotes/1",
          payload: { sourceUnavailable: true },
          sourceHash: "rollback-not-found",
          parentIdentity: { projectType: "quote", projectId: 1 },
        },
        query,
        transaction: pgliteTransaction(db, query),
      }),
      /reject_source_rollup/,
    );
    assert.deepEqual(await nestedFinalizationState(db), before);
    const rawAfter = await db.query<{ count: number }>("select count(*)::integer count from metrics.raw_simpro_snapshots");
    assert.equal(rawAfter.rows[0]?.count, rawBefore.rows[0]?.count);
  } finally {
    await db.close();
  }
});

test("execution fails closed without a snapshot and leaves canonical rows untouched", async () => {
  const db = await rebuildDatabase();
  const query = pgliteQuery(db);
  try {
    await db.exec("delete from metrics.quote_snapshots where quote_id = 2");
    await assert.rejects(
      executeQuoteCategoryRebuild({
        actorEmail: "owner@example.com",
        confirmation: QUOTE_CATEGORY_REBUILD_CONFIRMATION,
      }, { query, transaction: pgliteTransaction(db, query) }),
      /lack quote snapshots: 2/,
    );
    const quote = await db.query<{ category: string }>("select category from metrics.metrics_quotes where quote_id = 1");
    assert.equal(quote.rows[0]?.category, "Unclassified");
  } finally {
    await db.close();
  }
});

test("rollup queue insertion failure rolls canonical, snapshot, and audit writes back", async () => {
  const db = await rebuildDatabase();
  const query = pgliteQuery(db);
  try {
    await db.exec("alter table metrics.rollup_rebuild_queue add constraint reject_quote_rollup check (metric_family <> 'quotes')");
    await assert.rejects(
      executeQuoteCategoryRebuild({
        actorEmail: "owner@example.com",
        confirmation: QUOTE_CATEGORY_REBUILD_CONFIRMATION,
      }, { query, transaction: pgliteTransaction(db, query) }),
      /reject_quote_rollup/,
    );
    const parity = await db.query<{ canonical: string; snapshot: string; audits: number }>(`
      select q.category canonical, s.category snapshot,
             (select count(*)::integer from metrics.audit_events) audits
        from metrics.metrics_quotes q join metrics.quote_snapshots s using (quote_id)
       where q.quote_id = 1
    `);
    assert.deepEqual(parity.rows[0], { canonical: "Unclassified", snapshot: "Unclassified", audits: 0 });
  } finally {
    await db.close();
  }
});

test("captured serving-set drift aborts the serialized repair without escaping audit", async () => {
  const db = await rebuildDatabase();
  const baseQuery = pgliteQuery(db);
  let injected = false;
  let advisoryLockObserved = false;
  const query = (async <T>(sql: string, values: unknown[] = []) => {
    if (sql.includes("pg_advisory_xact_lock")) advisoryLockObserved = true;
    if (!injected && sql.startsWith("update metrics.metrics_quotes q")) {
      injected = true;
      await db.exec(`
        insert into metrics.metrics_quotes (quote_id, date_approved, category, category_basis)
        values (44, date '2025-06-10', 'Unclassified', 'nested traversal pending');
        insert into metrics.metrics_quote_cost_centers (
          quote_id, section_id, cost_center_id, configured_cost_center_id, category, sell_value
        ) values (44, 1, 441, 6, 'Water Heating', 100);
        insert into metrics.quote_snapshots (quote_id, date_approved, category, category_basis)
        values (44, date '2025-06-10', 'Unclassified', 'nested traversal pending')
      `);
    }
    return baseQuery<T>(sql, values);
  }) as PostgresQuery;
  try {
    await assert.rejects(
      executeQuoteCategoryRebuild({
        actorEmail: "owner@example.com",
        confirmation: QUOTE_CATEGORY_REBUILD_CONFIRMATION,
      }, { query, transaction: pgliteTransaction(db, query) }),
      /served quote set changed/,
    );
    assert.equal(advisoryLockObserved, true);
    const state = await db.query<{ added: number; category: string; audits: number }>(`
      select (select count(*)::integer from metrics.metrics_quotes where quote_id = 44) added,
             (select category from metrics.metrics_quotes where quote_id = 1) category,
             (select count(*)::integer from metrics.audit_events) audits
    `);
    assert.deepEqual(state.rows[0], { added: 0, category: "Unclassified", audits: 0 });
  } finally {
    await db.close();
  }
});

test("worker is dry-run by default and gates execution on actor plus exact token", () => {
  assert.deepEqual(parseReprojectQuoteCategoryArgs([]), {
    execute: false,
    actorEmail: "",
    confirmation: "",
  });
  assert.throws(() => parseReprojectQuoteCategoryArgs(["--execute"]), /--actor is required/);
  assert.throws(
    () => parseReprojectQuoteCategoryArgs(["--execute", "--actor", "owner@example.com", "--confirm", "wrong"]),
    /--confirm must equal/,
  );
  assert.throws(
    () => parseReprojectQuoteCategoryArgs(["--execute", "--actor", "not-an-email", "--confirm", QUOTE_CATEGORY_REBUILD_CONFIRMATION]),
    /valid email/,
  );
  assert.deepEqual(parseReprojectQuoteCategoryArgs([
    "--execute", "--actor", "owner@example.com", "--confirm", QUOTE_CATEGORY_REBUILD_CONFIRMATION,
  ]), {
    execute: true,
    actorEmail: "owner@example.com",
    confirmation: QUOTE_CATEGORY_REBUILD_CONFIRMATION,
  });
});

async function rebuildDatabase(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    create schema metrics;
    create type metrics.rollup_rebuild_status as enum ('queued', 'running', 'succeeded', 'failed', 'cancelled');
    create table metrics.raw_simpro_snapshots (
      id bigserial primary key,
      entity_type text not null,
      entity_id text not null,
      source_path text not null default '',
      source_hash text not null default '',
      unique (entity_type, entity_id, source_hash),
      source_updated_at timestamptz,
      extracted_at timestamptz not null default now(),
      payload jsonb not null default '{}'::jsonb,
      source_version text not null default 'current',
      ingestion_run_id bigint,
      page_window jsonb,
      complete_traversal boolean not null default false,
      parent_identity jsonb not null default '{}'::jsonb,
      source_deleted_at timestamptz
    );
    create table metrics.project_nested_traversals (
      project_type text not null,
      project_id bigint not null,
      generation bigint not null,
      status text not null,
      started_at timestamptz not null default now(),
      finalized_at timestamptz,
      updated_at timestamptz not null default now(),
      primary key (project_type, project_id)
    );
    create table metrics.metrics_quotes (
      quote_id bigint primary key,
      date_issued date,
      date_approved date,
      status_name text,
      total numeric(14, 2) not null default 0,
      linked_job_id bigint,
      outcome text not null default 'unknown',
      outcome_reason text not null default 'unclassified',
      won_reason text not null default 'not_won',
      category text not null default 'Unclassified',
      category_basis text,
      source_deleted_at timestamptz,
      updated_from_source_at timestamptz not null default now()
    );
    create table metrics.metrics_quote_cost_centers (
      quote_id bigint not null references metrics.metrics_quotes(quote_id),
      section_id bigint not null,
      cost_center_id bigint not null,
      configured_cost_center_id bigint,
      name text,
      category text,
      labor_hours numeric(10,2),
      sell_value numeric(14,2),
      traversal_generation bigint,
      source_deleted_at timestamptz,
      updated_from_source_at timestamptz not null default now(),
      primary key (quote_id, section_id, cost_center_id)
    );
    create table metrics.quote_snapshots (
      quote_id bigint primary key references metrics.metrics_quotes(quote_id),
      date_issued date,
      date_approved date,
      total_value numeric(14, 2) not null default 0,
      linked_job_id bigint,
      won boolean,
      won_value numeric(14, 2),
      win_loss_reason text,
      category text,
      category_basis text,
      updated_at timestamptz not null default now()
    );
    create table metrics.metrics_jobs (
      job_id bigint primary key,
      converted_from_type text,
      converted_from_id bigint,
      job_source_type text,
      job_source_id bigint,
      source_deleted_at timestamptz,
      updated_from_source_at timestamptz not null default now()
    );
    create table metrics.job_snapshots (
      job_id bigint primary key references metrics.metrics_jobs(job_id),
      source_quote_id bigint,
      updated_at timestamptz not null default now()
    );
    create table metrics.quote_classification_overrides (
      id bigserial primary key,
      quote_id bigint not null references metrics.metrics_quotes(quote_id),
      outcome text,
      active boolean not null default true,
      created_at timestamptz not null default now()
    );
    create table metrics.audit_events (
      id bigserial primary key,
      actor_email text not null,
      action text not null,
      entity_type text not null,
      entity_id text not null,
      before_value jsonb,
      after_value jsonb,
      reason text,
      created_at timestamptz not null default now()
    );
    create table metrics.rollup_rebuild_queue (
      id bigserial primary key,
      metric_family text not null,
      period_grain text not null,
      period_start date not null,
      dimensions_json jsonb not null default '{}'::jsonb,
      reason text not null,
      status metrics.rollup_rebuild_status not null default 'queued',
      attempts integer not null default 0,
      locked_by text,
      locked_until timestamptz,
      idempotency_key text not null unique,
      created_at timestamptz not null default now(),
      finished_at timestamptz,
      error_message text
    );
    create table metrics.metrics_quote_labor (
      quote_id bigint not null,
      section_id bigint not null,
      cost_center_id bigint not null,
      labor_id bigint not null,
      quantity_hours numeric(10,2),
      traversal_generation bigint,
      source_deleted_at timestamptz,
      fetched_at timestamptz
    );
    create function metrics.authoritative_job_source_quote_id(payload jsonb)
    returns bigint language sql immutable as $$
      select case
        when payload #>> '{ConvertedFrom,Type}' = 'Quote'
          then (payload #>> '{ConvertedFrom,ID}')::bigint
        else null
      end
    $$;
    create table metrics.metrics_quote_items (
      quote_id bigint not null,
      section_id bigint not null,
      cost_center_id bigint not null,
      item_type text not null,
      item_id text not null,
      traversal_generation bigint,
      source_deleted_at timestamptz,
      fetched_at timestamptz
    );
    create table metrics.metrics_work_orders (
      project_type text not null,
      project_id bigint not null,
      section_id bigint not null,
      cost_center_id bigint not null,
      work_order_id bigint not null,
      traversal_generation bigint,
      source_deleted_at timestamptz,
      fetched_at timestamptz
    );
    create table metrics.metrics_schedules (
      schedule_id bigint primary key,
      reference_type text,
      reference_id bigint,
      traversal_generation bigint,
      source_deleted_at timestamptz,
      updated_from_source_at timestamptz not null default now()
    );
    create table metrics.schedule_snapshots (
      schedule_id bigint primary key,
      project_type text,
      project_id text,
      traversal_generation bigint
    );
    create table metrics.metrics_schedule_blocks (
      schedule_id bigint not null,
      block_index integer not null,
      reference_type text,
      reference_id bigint,
      traversal_generation bigint,
      source_deleted_at timestamptz,
      fetched_at timestamptz,
      primary key (schedule_id, block_index)
    );

    insert into metrics.metrics_quotes (quote_id, date_approved, category, category_basis) values
      (1, date '2025-05-10', 'Unclassified', 'nested traversal pending'),
      (2, date '2025-05-20', 'HVAC', '${QUOTE_CATEGORY_BASIS}'),
      (3, date '2025-06-03', 'Unclassified', 'nested traversal pending'),
      (9, date '2022-01-01', 'Unclassified', null);
    update metrics.metrics_quotes set source_deleted_at = now() where quote_id = 9;

    insert into metrics.project_nested_traversals (project_type, project_id, generation, status)
    values ('quote', 1, 1, 'active');
    insert into metrics.raw_simpro_snapshots (id, entity_type, entity_id)
    values (1, 'quote_details', '1');
    select setval(
      pg_get_serial_sequence('metrics.raw_simpro_snapshots', 'id'),
      (select max(id) from metrics.raw_simpro_snapshots)
    );

    insert into metrics.metrics_quote_cost_centers (
      quote_id, section_id, cost_center_id, configured_cost_center_id, category, sell_value
    ) values
      (1, 1, 11, 7, 'Water Heating', 100),
      (1, 1, 12, 6, 'HVAC', 50),
      (2, 1, 21, 6, 'HVAC', 200),
      (3, 1, 31, null, 'HVAC', 300);
    update metrics.metrics_quote_cost_centers
       set traversal_generation = 1
     where quote_id = 1 and cost_center_id = 11;

    insert into metrics.quote_snapshots (quote_id, date_approved, category, category_basis) values
      (1, date '2025-05-10', 'Unclassified', 'nested traversal pending'),
      (2, date '2025-05-20', 'HVAC', '${QUOTE_CATEGORY_BASIS}'),
      (3, date '2025-06-03', 'Unclassified', 'nested traversal pending'),
      (9, date '2022-01-01', 'Unclassified', null)
  `);
  return db;
}

async function normalizationDatabase(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    create schema metrics;
    create table metrics.dim_people (
      simpro_employee_id bigint primary key,
      display_name text not null,
      role_type text not null,
      active boolean not null default true,
      last_seen_at timestamptz not null default now()
    );
    create table metrics.metrics_quotes (
      quote_id bigint primary key,
      quote_no text, date_issued date, date_approved date, stage text, customer_stage text,
      salesperson_id bigint, salesperson_name text, total numeric(14,2) not null default 0,
      linked_job_id bigint, job_no text, won_reason text, category text not null default 'Unclassified',
      source_snapshot_id bigint, source_hash text, source_version text, fetched_at timestamptz,
      name text, description text, status_id bigint, status_name text, is_closed boolean,
      customer_id bigint, customer_name text, site_id bigint, site_name text,
      outcome text not null default 'unknown', outcome_reason text not null default 'unclassified',
      deal_tier text, category_basis text, source_deleted_at timestamptz,
      updated_from_source_at timestamptz not null default now()
    );
    create table metrics.metrics_jobs (
      job_id bigint primary key,
      job_no text,
      converted_from_type text,
      converted_from_id bigint,
      job_source_type text,
      job_source_id bigint,
      source_deleted_at timestamptz
    );
    create table metrics.job_snapshots (
      job_id bigint primary key,
      source_quote_id bigint
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
    create table metrics.quote_classification_overrides (
      id bigserial primary key,
      quote_id bigint not null,
      outcome text not null,
      active boolean not null default true,
      created_at timestamptz not null default now()
    );
    create table metrics.metrics_quote_cost_centers (
      quote_id bigint not null references metrics.metrics_quotes(quote_id),
      section_id bigint not null,
      cost_center_id bigint not null,
      configured_cost_center_id bigint,
      name text,
      category text,
      labor_hours numeric(10,2),
      sell_value numeric(14,2),
      cost_value numeric(14,2),
      source_deleted_at timestamptz,
      updated_from_source_at timestamptz not null default now(),
      primary key (quote_id, section_id, cost_center_id)
    );
    create table metrics.quote_snapshots (
      quote_id bigint primary key,
      quote_no text, name text, status_name text, stage_name text, customer_stage_name text,
      salesperson_id bigint, salesperson_name text, owner_name text, linked_job_id bigint,
      job_no text, date_issued date, date_approved date, total_value numeric(14,2),
      won_value numeric(14,2), deal_tier text, category text, category_basis text,
      won boolean, win_loss_reason text, source_snapshot_id bigint,
      updated_at timestamptz not null default now()
    );
    create function metrics.authoritative_job_source_quote_id(payload jsonb)
    returns bigint language sql immutable as $$
      select case
        when payload #>> '{ConvertedFrom,Type}' = 'Quote'
          then (payload #>> '{ConvertedFrom,ID}')::bigint
        else null
      end
    $$
  `);
  return db;
}

function pgliteQuery(db: PGlite): PostgresQuery {
  return (async <T>(sql: string, values: unknown[] = []) => {
    const result = await db.query<T>(sql, values as never[]);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  }) as PostgresQuery;
}

async function nestedFinalizationState(db: PGlite) {
  const [quote, children, labor, items, workOrders, schedules, scheduleSnapshots, scheduleBlocks, rawSnapshot] = await Promise.all([
    db.query<{ category: string; category_basis: string | null }>(`
      select category, category_basis from metrics.metrics_quotes where quote_id = 1
    `),
    db.query<{ cost_center_id: number; labor_hours: string | null; source_deleted_at: string | null }>(`
      select cost_center_id::integer, labor_hours::text, source_deleted_at::text
        from metrics.metrics_quote_cost_centers where quote_id = 1 order by cost_center_id
    `),
    db.query<{ labor_id: number; source_deleted_at: string | null }>(`
      select labor_id::integer, source_deleted_at::text
        from metrics.metrics_quote_labor where quote_id = 1 order by labor_id
    `),
    db.query<{ item_id: string; source_deleted_at: string | null }>(`
      select item_id, source_deleted_at::text
        from metrics.metrics_quote_items where quote_id = 1 order by item_id
    `),
    db.query<{ work_order_id: number; source_deleted_at: string | null }>(`
      select work_order_id::integer, source_deleted_at::text
        from metrics.metrics_work_orders
       where project_type = 'quote' and project_id = 1 order by work_order_id
    `),
    db.query<{ schedule_id: number; source_deleted_at: string | null }>(`
      select schedule_id::integer, source_deleted_at::text
        from metrics.metrics_schedules
       where reference_type = 'quote' and reference_id = 1 order by schedule_id
    `),
    db.query<{ schedule_id: number }>(`
      select schedule_id::integer from metrics.schedule_snapshots
       where project_type = 'quote' and project_id = '1' order by schedule_id
    `),
    db.query<{ schedule_id: number; block_index: number; source_deleted_at: string | null }>(`
      select schedule_id::integer, block_index, source_deleted_at::text
        from metrics.metrics_schedule_blocks
       where reference_type = 'quote' and reference_id = 1 order by schedule_id, block_index
    `),
    db.query<{ complete_traversal: boolean; source_deleted_at: string | null }>(`
      select complete_traversal, source_deleted_at::text
        from metrics.raw_simpro_snapshots where id = 1
    `),
  ]);
  return {
    quote: quote.rows,
    children: children.rows,
    labor: labor.rows,
    items: items.rows,
    workOrders: workOrders.rows,
    schedules: schedules.rows,
    scheduleSnapshots: scheduleSnapshots.rows,
    scheduleBlocks: scheduleBlocks.rows,
    rawSnapshot: rawSnapshot.rows,
  };
}

function pgliteTransaction(db: PGlite, query: PostgresQuery): QuoteCategoryRebuildTransaction {
  return async <T>(callback: (transactionQuery: PostgresQuery) => Promise<T>) => {
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
}
