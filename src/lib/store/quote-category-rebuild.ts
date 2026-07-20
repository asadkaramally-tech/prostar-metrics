import {
  queryPostgres,
  withPostgresTransaction,
  type PostgresQuery,
} from "@/lib/store/postgres";

export type QuoteBusinessCategory = "HVAC" | "Water Heating" | "Unclassified";

export const QUOTE_CATEGORY_BASIS = "verified configured cost-center ID mapping";
export const QUOTE_CATEGORY_REBUILD_CONFIRMATION = "REPROJECT-SOURCE-BACKED-QUOTE-CATEGORIES";
export const QUOTE_CATEGORY_ADVISORY_LOCK_KEY = 716_630_416;
export const QUOTE_CATEGORY_TIE_BREAK = "category name ascending";

// Tenant-verified Simpro configuration identities. Names and child category text
// are deliberately not inputs to authoritative quote classification.
export const VERIFIED_CONFIGURED_COST_CENTER_CATEGORIES: Readonly<Record<number, QuoteBusinessCategory>> = Object.freeze({
  4: "Water Heating",
  5: "HVAC",
  6: "Water Heating",
  7: "HVAC",
  8: "Water Heating",
  9: "Unclassified",
  11: "Unclassified",
  12: "Unclassified",
});

export function categoryForVerifiedConfiguredCostCenterId(
  configuredCostCenterId: number | null,
): QuoteBusinessCategory {
  if (configuredCostCenterId === null) return "Unclassified";
  return VERIFIED_CONFIGURED_COST_CENTER_CATEGORIES[configuredCostCenterId] ?? "Unclassified";
}

export function dominantQuoteBusinessCategory(
  contributions: ReadonlyArray<{ category: QuoteBusinessCategory; sellValue: number | null }>,
): QuoteBusinessCategory {
  const totals = new Map<QuoteBusinessCategory, number>();
  for (const contribution of contributions) {
    totals.set(
      contribution.category,
      (totals.get(contribution.category) ?? 0) + (contribution.sellValue ?? 0),
    );
  }
  return [...totals.entries()]
    .sort(([leftCategory, leftValue], [rightCategory, rightValue]) => (
      rightValue - leftValue || leftCategory.localeCompare(rightCategory)
    ))[0]?.[0] ?? "Unclassified";
}

export type QuoteCategoryProjection = {
  quoteId: number;
  category: QuoteBusinessCategory;
  activeChildCount: number;
  mappedChildCount: number;
  invalidChildCount: number;
  hasCoverage: boolean;
};

export type QuoteCategoryCounts = Array<{ category: string; count: number }>;

export type QuoteCategoryState = {
  quoteId: number;
  dateApproved: string;
  activeChildCount: number;
  mappedChildCount: number;
  invalidChildCount: number;
  canonical: { category: string; categoryBasis: string | null };
  snapshot: { exists: boolean; category: string | null; categoryBasis: string | null };
  projected: { category: QuoteBusinessCategory; categoryBasis: string };
  canonicalNeedsProjection: boolean;
  snapshotNeedsProjection: boolean;
};

export type InvalidConfiguredCostCenterChild = {
  quoteId: number;
  sectionId: number;
  costCenterId: number;
  configuredCostCenterId: number | null;
};

export type QuoteCategoryChildEvidence = {
  quoteId: number;
  sectionId: number;
  costCenterId: number;
  configuredCostCenterId: number | null;
  category: string | null;
  projectedCategory: QuoteBusinessCategory;
  sellValue: string | null;
};

export type QuoteCategoryRebuildPreview = {
  servingWindow: {
    firstApprovedDate: string | null;
    lastApprovedDate: string | null;
    firstPeriod: string | null;
    lastPeriod: string | null;
  };
  activeQuoteCount: number;
  activeQuoteChildCount: number;
  mappedQuoteChildCount: number;
  invalidConfiguredCostCenterChildCount: number;
  childRowsNeedingCategoryMapping: number;
  quotesWithCostCenterCoverage: number;
  missingCostCenterQuoteIds: number[];
  missingSnapshotQuoteIds: number[];
  invalidConfiguredCostCenterChildren: InvalidConfiguredCostCenterChild[];
  childCategoryCorrections: QuoteCategoryChildEvidence[];
  currentCategoryCounts: QuoteCategoryCounts;
  projectedCategoryCounts: QuoteCategoryCounts;
  canonicalQuotesNeedingProjection: number;
  snapshotsNeedingProjection: number;
  affectedQuoteCount: number;
  affectedPeriods: string[];
  quoteStates: QuoteCategoryState[];
};

export type QuoteCategoryRebuildResult = {
  auditId: string;
  canonicalQuotesUpdated: number;
  snapshotsUpdated: number;
  childRowsUpdated: number;
  rollupsQueued: number;
  capturedQuoteIds: number[];
  before: QuoteCategoryRebuildPreview;
  after: QuoteCategoryRebuildPreview;
};

export type QuoteCategoryRebuildTransaction = <T>(
  callback: (query: PostgresQuery) => Promise<T>,
) => Promise<T>;

type ProjectionRow = {
  quote_id: string;
  date_approved: string;
  canonical_category: string;
  canonical_category_basis: string | null;
  snapshot_quote_id: string | null;
  snapshot_category: string | null;
  snapshot_category_basis: string | null;
  active_child_count: string;
  mapped_child_count: string;
  projected_category: QuoteBusinessCategory;
};

type ChildEvidenceRow = {
  quote_id: string;
  section_id: string;
  cost_center_id: string;
  configured_cost_center_id: string | null;
  category: string | null;
  projected_category: QuoteBusinessCategory;
  sell_value: string | null;
};

type FinalizationRow = {
  quote_id: string;
  date_approved: string | null;
  snapshot_exists: boolean;
  active_child_count: string;
  mapped_child_count: string;
  projected_category: QuoteBusinessCategory;
  previous_category: string;
  previous_category_basis: string | null;
  previous_snapshot_category: string | null;
  previous_snapshot_category_basis: string | null;
  canonical_updated: string;
  snapshot_updated: string;
  rollups_queued: string;
};

export async function acquireQuoteCategoryAdvisoryLock(query: PostgresQuery): Promise<void> {
  await query("select pg_advisory_xact_lock($1::bigint)", [QUOTE_CATEGORY_ADVISORY_LOCK_KEY]);
}

export async function loadPersistedQuoteCategoryProjection(
  quoteId: number,
  query: PostgresQuery = queryPostgres,
): Promise<QuoteCategoryProjection> {
  assertQuoteId(quoteId);
  const result = await query<{
    active_child_count: string;
    mapped_child_count: string;
    projected_category: QuoteBusinessCategory;
  }>(
    `select child_counts.active_child_count::text,
            child_counts.mapped_child_count::text,
            ${projectedCategoryExpression("target")} as projected_category
       from (select $1::bigint as quote_id) target
       cross join lateral (${childCountsSql("target")}) child_counts`,
    [quoteId],
  );
  const row = result.rows[0];
  const activeChildCount = Number(row?.active_child_count ?? 0);
  const mappedChildCount = Number(row?.mapped_child_count ?? 0);
  return {
    quoteId,
    category: row?.projected_category ?? "Unclassified",
    activeChildCount,
    mappedChildCount,
    invalidChildCount: activeChildCount - mappedChildCount,
    hasCoverage: activeChildCount > 0,
  };
}

export async function reprojectPersistedQuoteCategory(
  quoteId: number,
  query: PostgresQuery = queryPostgres,
): Promise<QuoteCategoryProjection & { affectedPeriods: string[] }> {
  assertQuoteId(quoteId);
  const result = await query<FinalizationRow>(quoteCategoryFinalizationSql(), [
    quoteId,
    QUOTE_CATEGORY_BASIS,
    QUOTE_CATEGORY_ADVISORY_LOCK_KEY,
  ]);
  const row = result.rows[0];
  if (!row) throw new Error(`Quote ${quoteId} does not exist.`);
  const activeChildCount = Number(row.active_child_count);
  const mappedChildCount = Number(row.mapped_child_count);
  if (!row.snapshot_exists) throw new Error(`Quote ${quoteId} lacks a quote snapshot; category finalization was not applied.`);
  if (activeChildCount === 0) {
    throw new Error(`Quote ${quoteId} lacks persisted cost-center coverage; category finalization was not applied.`);
  }
  const changed = Number(row.canonical_updated) > 0 || Number(row.snapshot_updated) > 0;
  return {
    quoteId,
    category: row.projected_category,
    activeChildCount,
    mappedChildCount,
    invalidChildCount: activeChildCount - mappedChildCount,
    hasCoverage: true,
    affectedPeriods: changed && row.date_approved ? [monthStart(row.date_approved)] : [],
  };
}

export async function reprojectImportedQuoteCategories(
  quoteIds: readonly number[],
  query: PostgresQuery = queryPostgres,
): Promise<void> {
  const targets = [...new Set(quoteIds)];
  if (targets.length === 0) return;
  if (targets.some((quoteId) => !Number.isSafeInteger(quoteId) || quoteId <= 0)) {
    throw new Error("Imported quote category IDs must be positive integers.");
  }
  await query(
    `with category_serialization as materialized (
       select pg_advisory_xact_lock($3::bigint)
     ), locked_quotes as materialized (
       select q.quote_id
         from metrics.metrics_quotes q
         cross join category_serialization
        where q.quote_id = any($1::bigint[])
        order by q.quote_id
        for update of q
     ), child_updated as (
       update metrics.metrics_quote_cost_centers child
          set category = ${effectiveCategorySql("child")},
              updated_from_source_at = now()
        where child.quote_id = any($1::bigint[])
          and child.source_deleted_at is null
          and child.category is distinct from ${effectiveCategorySql("child")}
       returning child.quote_id
     ), projection as materialized (
       select q.quote_id, ${projectedCategoryExpression("q")} as projected_category
         from metrics.metrics_quotes q
         join locked_quotes locked using (quote_id)
        where (select count(*) from child_updated) >= 0
     ), canonical_updated as (
       update metrics.metrics_quotes q
          set category = projection.projected_category,
              category_basis = $2,
              updated_from_source_at = now()
         from projection
        where q.quote_id = projection.quote_id
          and (
            q.category is distinct from projection.projected_category
            or q.category_basis is distinct from $2
          )
       returning q.quote_id
     ), snapshot_updated as (
       update metrics.quote_snapshots snapshot
          set category = projection.projected_category,
              category_basis = $2,
              updated_at = now()
         from projection
        where snapshot.quote_id = projection.quote_id
          and (
            snapshot.category is distinct from projection.projected_category
            or snapshot.category_basis is distinct from $2
          )
       returning snapshot.quote_id
     )
     select (select count(*) from child_updated) as children_updated,
            (select count(*) from canonical_updated) as canonical_updated,
            (select count(*) from snapshot_updated) as snapshots_updated`,
    [targets, QUOTE_CATEGORY_BASIS, QUOTE_CATEGORY_ADVISORY_LOCK_KEY],
  );
}

export async function inspectQuoteCategoryRebuild(
  query: PostgresQuery = queryPostgres,
  capturedQuoteIds?: number[],
): Promise<QuoteCategoryRebuildPreview> {
  const values = capturedQuoteIds ? [capturedQuoteIds] : [];
  const [projectionResult, invalidResult, childCorrectionResult] = await Promise.all([
    query<ProjectionRow>(projectionRowsSql(Boolean(capturedQuoteIds)), values),
    query<{
      quote_id: string;
      section_id: string;
      cost_center_id: string;
      configured_cost_center_id: string | null;
    }>(invalidChildrenSql(Boolean(capturedQuoteIds)), values),
    query<ChildEvidenceRow>(childCorrectionsSql(Boolean(capturedQuoteIds)), values),
  ]);
  const quoteStates = projectionResult.rows.map(toQuoteCategoryState);
  const missingCostCenterQuoteIds = quoteStates
    .filter((state) => state.activeChildCount === 0)
    .map((state) => state.quoteId);
  const missingSnapshotQuoteIds = quoteStates
    .filter((state) => !state.snapshot.exists)
    .map((state) => state.quoteId);
  const childCategoryCorrections = childCorrectionResult.rows.map(toChildEvidence);
  const affectedQuoteIds = new Set([
    ...quoteStates
      .filter((state) => state.canonicalNeedsProjection || state.snapshotNeedsProjection)
      .map((state) => state.quoteId),
    ...childCategoryCorrections.map((child) => child.quoteId),
  ]);
  const affected = quoteStates.filter((state) => affectedQuoteIds.has(state.quoteId));
  const firstApprovedDate = quoteStates[0]?.dateApproved ?? null;
  const lastApprovedDate = quoteStates.at(-1)?.dateApproved ?? null;
  const invalidConfiguredCostCenterChildren = invalidResult.rows.map((row) => ({
    quoteId: Number(row.quote_id),
    sectionId: Number(row.section_id),
    costCenterId: Number(row.cost_center_id),
    configuredCostCenterId: row.configured_cost_center_id === null ? null : Number(row.configured_cost_center_id),
  }));

  return {
    servingWindow: {
      firstApprovedDate,
      lastApprovedDate,
      firstPeriod: firstApprovedDate ? monthStart(firstApprovedDate) : null,
      lastPeriod: lastApprovedDate ? monthStart(lastApprovedDate) : null,
    },
    activeQuoteCount: quoteStates.length,
    activeQuoteChildCount: sum(quoteStates.map((state) => state.activeChildCount)),
    mappedQuoteChildCount: sum(quoteStates.map((state) => state.mappedChildCount)),
    invalidConfiguredCostCenterChildCount: invalidConfiguredCostCenterChildren.length,
    childRowsNeedingCategoryMapping: childCategoryCorrections.length,
    quotesWithCostCenterCoverage: quoteStates.length - missingCostCenterQuoteIds.length,
    missingCostCenterQuoteIds,
    missingSnapshotQuoteIds,
    invalidConfiguredCostCenterChildren,
    childCategoryCorrections,
    currentCategoryCounts: countCategories(quoteStates.map((state) => state.canonical.category)),
    projectedCategoryCounts: countCategories(quoteStates.map((state) => state.projected.category)),
    canonicalQuotesNeedingProjection: quoteStates.filter((state) => state.canonicalNeedsProjection).length,
    snapshotsNeedingProjection: quoteStates.filter((state) => state.snapshotNeedsProjection).length,
    affectedQuoteCount: affected.length,
    affectedPeriods: [...new Set(affected.map((state) => monthStart(state.dateApproved)))].sort(),
    quoteStates,
  };
}

export async function executeQuoteCategoryRebuild(
  params: { actorEmail: string; confirmation: string },
  options: { query?: PostgresQuery; transaction?: QuoteCategoryRebuildTransaction } = {},
): Promise<QuoteCategoryRebuildResult> {
  const actorEmail = params.actorEmail.trim();
  if (!isEmail(actorEmail)) throw new Error("actorEmail must be a valid email address.");
  if (params.confirmation !== QUOTE_CATEGORY_REBUILD_CONFIRMATION) {
    throw new Error(`confirmation must equal ${QUOTE_CATEGORY_REBUILD_CONFIRMATION}.`);
  }
  if (options.query && !options.transaction) throw new Error("An injected query requires an injected transaction.");
  const transaction = options.transaction ?? withPostgresTransaction;

  return transaction(async (transactionQuery) => {
    if (options.query && options.query !== transactionQuery) {
      throw new Error("Quote category rebuild must use the query supplied by its transaction.");
    }
    await acquireQuoteCategoryAdvisoryLock(transactionQuery);
    const capturedQuoteIds = await captureServingQuoteIds(transactionQuery);
    await lockCapturedQuoteCategoryRows(transactionQuery, capturedQuoteIds);
    const before = await inspectQuoteCategoryRebuild(transactionQuery, capturedQuoteIds);
    assertExecutableCoverage(before);

    const childRows = await transactionQuery<{ quote_id: string }>(
      `update metrics.metrics_quote_cost_centers c
          set category = ${effectiveCategorySql("c")},
              updated_from_source_at = now()
        where c.quote_id = any($1::bigint[])
          and c.source_deleted_at is null
          and c.category is distinct from ${effectiveCategorySql("c")}
      returning c.quote_id::text`,
      [capturedQuoteIds],
    );
    if (childRows.rows.length !== before.childCategoryCorrections.length) {
      throw new Error("Quote category repair did not update the exact captured child target set.");
    }
    const canonical = await transactionQuery<{ quote_id: string }>(
      `update metrics.metrics_quotes q
          set category = ${projectedCategoryExpression("q")},
              category_basis = $1,
              updated_from_source_at = now()
        where q.quote_id = any($2::bigint[])
          and (
            q.category is distinct from ${projectedCategoryExpression("q")}
            or q.category_basis is distinct from $1
          )
      returning q.quote_id::text`,
      [QUOTE_CATEGORY_BASIS, capturedQuoteIds],
    );
    const snapshots = await transactionQuery<{ quote_id: string }>(
      `update metrics.quote_snapshots s
          set category = q.category,
              category_basis = $1,
              updated_at = now()
         from metrics.metrics_quotes q
        where q.quote_id = any($2::bigint[])
          and s.quote_id = q.quote_id
          and (
            s.category is distinct from q.category
            or s.category_basis is distinct from $1
          )
      returning s.quote_id::text`,
      [QUOTE_CATEGORY_BASIS, capturedQuoteIds],
    );

    const after = await inspectQuoteCategoryRebuild(transactionQuery, capturedQuoteIds);
    if (after.affectedQuoteCount !== 0 || after.childRowsNeedingCategoryMapping !== 0
      || after.missingCostCenterQuoteIds.length > 0 || after.missingSnapshotQuoteIds.length > 0) {
      throw new Error("Quote category projection did not reach canonical and snapshot parity.");
    }
    const finalServingQuoteIds = await captureServingQuoteIds(transactionQuery);
    if (!sameIds(capturedQuoteIds, finalServingQuoteIds)) {
      throw new Error("The active served quote set changed during category repair; all writes were rolled back.");
    }

    const affectedQuoteIds = [...new Set([
      ...before.quoteStates
        .filter((state) => state.canonicalNeedsProjection || state.snapshotNeedsProjection)
        .map((state) => state.quoteId),
      ...before.childCategoryCorrections.map((child) => child.quoteId),
    ])].sort((left, right) => left - right);
    const afterChildEvidence = await loadChildEvidence(
      transactionQuery,
      before.childCategoryCorrections,
    );
    if (afterChildEvidence.length !== before.childCategoryCorrections.length) {
      throw new Error("Quote category repair could not verify every changed child row after mutation.");
    }
    const audited = await transactionQuery<{ id: string }>(
      `insert into metrics.audit_events (
         actor_email, action, entity_type, entity_id, before_value, after_value, reason
       ) values (
         $1, 'quote_categories_reprojected', 'quotes', $2,
         $3::jsonb, $4::jsonb,
         'Source-backed category repair from tenant-verified configured cost-center IDs.'
       )
       returning id::text`,
      [
        actorEmail,
        servingWindowIdentity(before),
        JSON.stringify(auditEvidence(before, affectedQuoteIds, before.childCategoryCorrections)),
        JSON.stringify(auditEvidence(after, affectedQuoteIds, afterChildEvidence)),
      ],
    );
    const auditId = audited.rows[0]?.id;
    if (!auditId) throw new Error("Quote category repair audit event was not persisted.");

    let rollupsQueued = 0;
    for (const periodStart of before.affectedPeriods) {
      const queued = await transactionQuery<{ id: string }>(
        `insert into metrics.rollup_rebuild_queue (
           metric_family, period_grain, period_start, dimensions_json, reason, idempotency_key
         ) values (
           'quotes', 'month', $1::date, '{}'::jsonb,
           'source-backed quote category reprojection audit ' || $2,
           'quote-category-reprojection:' || $2 || ':' || $1
         )
         returning id::text`,
        [periodStart, auditId],
      );
      if (!queued.rows[0]?.id) throw new Error(`Quote rollup was not queued for ${periodStart}.`);
      rollupsQueued += 1;
    }
    if (rollupsQueued !== before.affectedPeriods.length) {
      throw new Error("Not every affected quote period received a rollup rebuild.");
    }

    return {
      auditId,
      canonicalQuotesUpdated: canonical.rows.length,
      snapshotsUpdated: snapshots.rows.length,
      childRowsUpdated: childRows.rows.length,
      rollupsQueued,
      capturedQuoteIds,
      before,
      after,
    };
  });
}

function quoteCategoryFinalizationSql(): string {
  return `with category_serialization as materialized (
      select pg_advisory_xact_lock($3::bigint)
    ), child_counts as materialized (
      select target.quote_id, counts.active_child_count, counts.mapped_child_count
        from (select $1::bigint as quote_id) target
        cross join lateral (${childCountsSql("target")}) counts
    ), projection as materialized (
      select q.quote_id, q.date_approved,
             q.category as previous_category,
             q.category_basis as previous_category_basis,
             s.quote_id is not null as snapshot_exists,
             s.category as previous_snapshot_category,
             s.category_basis as previous_snapshot_category_basis,
             counts.active_child_count, counts.mapped_child_count,
             ${projectedCategoryExpression("q")} as projected_category
        from metrics.metrics_quotes q
        cross join category_serialization
        cross join child_counts counts
        left join metrics.quote_snapshots s on s.quote_id = q.quote_id
       where q.quote_id = $1
    ), eligible as materialized (
      select *,
             previous_category is distinct from projected_category
               or previous_category_basis is distinct from $2 as canonical_changed,
             previous_snapshot_category is distinct from projected_category
               or previous_snapshot_category_basis is distinct from $2 as snapshot_changed
        from projection
       where snapshot_exists and active_child_count > 0
    ), canonical_updated as (
      update metrics.metrics_quotes q
         set category = eligible.projected_category,
             category_basis = $2,
             updated_from_source_at = now()
        from eligible
       where q.quote_id = eligible.quote_id and eligible.canonical_changed
       returning q.quote_id
    ), snapshot_updated as (
      update metrics.quote_snapshots s
         set category = eligible.projected_category,
             category_basis = $2,
             updated_at = now()
        from eligible
       where s.quote_id = eligible.quote_id and eligible.snapshot_changed
       returning s.quote_id
    ), rollup_queued as (
      insert into metrics.rollup_rebuild_queue (
        metric_family, period_grain, period_start, dimensions_json, reason, idempotency_key
      )
      select 'quotes', 'month', date_trunc('month', eligible.date_approved)::date, '{}'::jsonb,
             'nested quote category finalization',
             'quote-category-finalization:' || eligible.quote_id::text || ':' ||
               replace(clock_timestamp()::text, ' ', 'T')
        from eligible
       where (eligible.canonical_changed or eligible.snapshot_changed)
         and eligible.date_approved is not null
      returning id
    )
    select projection.quote_id::text, projection.date_approved::text,
           projection.snapshot_exists,
           projection.active_child_count::text, projection.mapped_child_count::text,
           projection.projected_category,
           projection.previous_category, projection.previous_category_basis,
           projection.previous_snapshot_category, projection.previous_snapshot_category_basis,
           (select count(*)::text from canonical_updated) as canonical_updated,
           (select count(*)::text from snapshot_updated) as snapshot_updated,
           (select count(*)::text from rollup_queued) as rollups_queued
      from projection`;
}

function projectionRowsSql(captured: boolean): string {
  return `select q.quote_id::text, q.date_approved::text,
       q.category as canonical_category, q.category_basis as canonical_category_basis,
       s.quote_id::text as snapshot_quote_id, s.category as snapshot_category,
       s.category_basis as snapshot_category_basis,
       child_counts.active_child_count::text, child_counts.mapped_child_count::text,
       ${projectedCategoryExpression("q")} as projected_category
    from metrics.metrics_quotes q
    left join metrics.quote_snapshots s on s.quote_id = q.quote_id
    cross join lateral (${childCountsSql("q")}) child_counts
   where q.source_deleted_at is null and q.date_approved is not null
     ${captured ? "and q.quote_id = any($1::bigint[])" : ""}
   order by q.date_approved, q.quote_id`;
}

function invalidChildrenSql(captured: boolean): string {
  return `select c.quote_id::text, c.section_id::text, c.cost_center_id::text,
                 c.configured_cost_center_id::text
            from metrics.metrics_quote_cost_centers c
            join metrics.metrics_quotes q on q.quote_id = c.quote_id
           where q.source_deleted_at is null and q.date_approved is not null
             and c.source_deleted_at is null
             and ${mappedCategorySql("c")} is null
             ${captured ? "and q.quote_id = any($1::bigint[])" : ""}
           order by c.quote_id, c.section_id, c.cost_center_id`;
}

function childCorrectionsSql(captured: boolean): string {
  return `select c.quote_id::text, c.section_id::text, c.cost_center_id::text,
                 c.configured_cost_center_id::text, c.category,
                 ${effectiveCategorySql("c")} as projected_category,
                 c.sell_value::text
            from metrics.metrics_quote_cost_centers c
            join metrics.metrics_quotes q on q.quote_id = c.quote_id
           where q.source_deleted_at is null and q.date_approved is not null
             and c.source_deleted_at is null
             and c.category is distinct from ${effectiveCategorySql("c")}
             ${captured ? "and q.quote_id = any($1::bigint[])" : ""}
           order by c.quote_id, c.section_id, c.cost_center_id`;
}

function childCountsSql(quoteAlias: string): string {
  return `select count(*)::integer as active_child_count,
                 count(*) filter (where ${mappedCategorySql("child")} is not null)::integer as mapped_child_count
            from metrics.metrics_quote_cost_centers child
           where child.quote_id = ${quoteAlias}.quote_id
             and child.source_deleted_at is null`;
}

function projectedCategoryExpression(quoteAlias: string): string {
  return `coalesce((
    select mapped.category
      from (
        select ${effectiveCategorySql("c")} as category, c.sell_value
          from metrics.metrics_quote_cost_centers c
         where c.quote_id = ${quoteAlias}.quote_id and c.source_deleted_at is null
      ) mapped
     group by mapped.category
     order by sum(coalesce(mapped.sell_value, 0)) desc, mapped.category asc
     limit 1
  ), 'Unclassified')`;
}

function mappedCategorySql(costCenterAlias: string): string {
  const cases = Object.entries(VERIFIED_CONFIGURED_COST_CENTER_CATEGORIES)
    .map(([id, category]) => `when ${id} then '${category}'`)
    .join(" ");
  return `(case ${costCenterAlias}.configured_cost_center_id ${cases} else null end)`;
}

function effectiveCategorySql(costCenterAlias: string): string {
  return `coalesce(${mappedCategorySql(costCenterAlias)}, 'Unclassified')`;
}

async function captureServingQuoteIds(query: PostgresQuery): Promise<number[]> {
  const result = await query<{ quote_id: string }>(
    `select quote_id::text
       from metrics.metrics_quotes
      where source_deleted_at is null and date_approved is not null
      order by quote_id`,
  );
  return result.rows.map((row) => Number(row.quote_id));
}

async function lockCapturedQuoteCategoryRows(query: PostgresQuery, quoteIds: number[]): Promise<void> {
  await query(
    `select quote_id from metrics.metrics_quotes
      where quote_id = any($1::bigint[]) order by quote_id for update`,
    [quoteIds],
  );
  await query(
    `select c.quote_id, c.section_id, c.cost_center_id
       from metrics.metrics_quote_cost_centers c
      where c.quote_id = any($1::bigint[]) and c.source_deleted_at is null
      order by c.quote_id, c.section_id, c.cost_center_id for update`,
    [quoteIds],
  );
  await query(
    `select quote_id from metrics.quote_snapshots
      where quote_id = any($1::bigint[]) order by quote_id for update`,
    [quoteIds],
  );
}

function toQuoteCategoryState(row: ProjectionRow): QuoteCategoryState {
  const activeChildCount = Number(row.active_child_count);
  const mappedChildCount = Number(row.mapped_child_count);
  return {
    quoteId: Number(row.quote_id),
    dateApproved: row.date_approved,
    activeChildCount,
    mappedChildCount,
    invalidChildCount: activeChildCount - mappedChildCount,
    canonical: { category: row.canonical_category, categoryBasis: row.canonical_category_basis },
    snapshot: {
      exists: row.snapshot_quote_id !== null,
      category: row.snapshot_category,
      categoryBasis: row.snapshot_category_basis,
    },
    projected: { category: row.projected_category, categoryBasis: QUOTE_CATEGORY_BASIS },
    canonicalNeedsProjection: row.canonical_category !== row.projected_category
      || row.canonical_category_basis !== QUOTE_CATEGORY_BASIS,
    snapshotNeedsProjection: row.snapshot_quote_id === null
      || row.snapshot_category !== row.projected_category
      || row.snapshot_category_basis !== QUOTE_CATEGORY_BASIS,
  };
}

function toChildEvidence(row: ChildEvidenceRow): QuoteCategoryChildEvidence {
  return {
    quoteId: Number(row.quote_id),
    sectionId: Number(row.section_id),
    costCenterId: Number(row.cost_center_id),
    configuredCostCenterId: row.configured_cost_center_id === null
      ? null
      : Number(row.configured_cost_center_id),
    category: row.category,
    projectedCategory: row.projected_category,
    sellValue: row.sell_value,
  };
}

async function loadChildEvidence(
  query: PostgresQuery,
  targets: QuoteCategoryChildEvidence[],
): Promise<QuoteCategoryChildEvidence[]> {
  if (targets.length === 0) return [];
  const values = targets.flatMap((target) => [target.quoteId, target.sectionId, target.costCenterId]);
  const identities = targets.map((_, index) => {
    const offset = index * 3;
    return `($${offset + 1}::bigint, $${offset + 2}::bigint, $${offset + 3}::bigint)`;
  }).join(", ");
  const result = await query<ChildEvidenceRow>(
    `select c.quote_id::text, c.section_id::text, c.cost_center_id::text,
            c.configured_cost_center_id::text, c.category,
            ${effectiveCategorySql("c")} as projected_category,
            c.sell_value::text
       from metrics.metrics_quote_cost_centers c
      where (c.quote_id, c.section_id, c.cost_center_id) in (${identities})
      order by c.quote_id, c.section_id, c.cost_center_id`,
    values,
  );
  return result.rows.map(toChildEvidence);
}

function assertExecutableCoverage(preview: QuoteCategoryRebuildPreview): void {
  if (preview.activeQuoteCount === 0) throw new Error("No active served quotes were found; refusing to execute.");
  if (preview.missingCostCenterQuoteIds.length > 0) {
    throw new Error(`Active served quotes lack persisted cost-center coverage: ${preview.missingCostCenterQuoteIds.join(", ")}.`);
  }
  if (preview.missingSnapshotQuoteIds.length > 0) {
    throw new Error(`Active served quotes lack quote snapshots: ${preview.missingSnapshotQuoteIds.join(", ")}.`);
  }
}

function auditEvidence(
  preview: QuoteCategoryRebuildPreview,
  affectedQuoteIds: number[],
  children: QuoteCategoryChildEvidence[],
) {
  const affected = new Set(affectedQuoteIds);
  const summary: Partial<QuoteCategoryRebuildPreview> = { ...preview };
  delete summary.quoteStates;
  delete summary.childCategoryCorrections;
  return {
    summary,
    quotes: preview.quoteStates.filter((state) => affected.has(state.quoteId)),
    children,
  };
}

function countCategories(categories: string[]): QuoteCategoryCounts {
  const counts = new Map<string, number>();
  for (const category of categories) counts.set(category, (counts.get(category) ?? 0) + 1);
  return [...counts]
    .map(([category, count]) => ({ category, count }))
    .sort((left, right) => left.category.localeCompare(right.category));
}

function sameIds(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

function servingWindowIdentity(preview: QuoteCategoryRebuildPreview): string {
  return `${preview.servingWindow.firstApprovedDate}:${preview.servingWindow.lastApprovedDate}`;
}

function assertQuoteId(quoteId: number): void {
  if (!Number.isSafeInteger(quoteId) || quoteId <= 0) throw new Error("quoteId must be a positive integer.");
}
