import { acceptedOnlineStatusSql, isAcceptedOnlineStatus } from "@/lib/metrics/quotes";
import {
  loadAuthoritativeQuoteRelationships,
  type AuthoritativeJobInverseRelationship,
  type AuthoritativeQuoteRelationships,
} from "@/lib/store/quote-relationship-provenance";
import {
  queryPostgres,
  withPostgresTransaction,
  type PostgresQuery,
} from "@/lib/store/postgres";

export const QUOTE_CLASSIFICATION_REBUILD_CONFIRMATION = "RECLASSIFY-SOURCE-BACKED-QUOTE-OUTCOMES";
export const QUOTE_CLASSIFICATION_LOCK_KEY = 716_630_417;
export const QUOTE_CLASSIFICATION_ADVISORY_LOCK_KEY = QUOTE_CLASSIFICATION_LOCK_KEY;

export type QuoteClassificationOutcome = "won" | "lost" | "excluded";
export type QuoteClassificationCounts = Array<{ outcome: string; count: number }>;

export type QuoteClassificationState = {
  quoteId: number;
  dateApproved: string;
  dateIssued: string | null;
  totalValue: string;
  evidence: {
    statusName: string | null;
    acceptedOnlineExact: boolean;
    manualExcludedOverrideId: number | null;
    authoritativeSourceSnapshotId: number | null;
    authoritativeLinkedJobId: number | null;
    linkedJobMatchId: number | null;
    inverseConversionMatchId: number | null;
    inverseSourceSnapshotId: number | null;
    canonicalInverseMatchId: number | null;
    snapshotInverseMatchId: number | null;
    relationshipDriftJobIds: number[];
  };
  canonical: {
    outcome: string;
    outcomeReason: string;
    wonReason: string;
    linkedJobId: number | null;
  };
  snapshot: {
    exists: boolean;
    dateApproved: string | null;
    dateIssued: string | null;
    linkedJobId: number | null;
    won: boolean | null;
    wonValue: string | null;
    winLossReason: string | null;
  };
  projected: {
    outcome: QuoteClassificationOutcome;
    outcomeReason: string;
    wonReason: string;
    won: boolean;
    wonValue: string;
    winLossReason: string;
  };
  canonicalNeedsProjection: boolean;
  snapshotNeedsProjection: boolean;
  relationshipsNeedProjection: boolean;
};

export type QuoteClassificationRebuildPreview = {
  servingWindow: {
    firstApprovedDate: string | null;
    lastApprovedDate: string | null;
    firstPeriod: string | null;
    lastPeriod: string | null;
  };
  activeQuoteCount: number;
  missingSnapshotQuoteIds: number[];
  missingRelationshipJobSnapshotIds: number[];
  currentOutcomeCounts: QuoteClassificationCounts;
  projectedOutcomeCounts: QuoteClassificationCounts;
  canonicalQuotesNeedingProjection: number;
  snapshotsNeedingProjection: number;
  jobRelationshipsNeedingProjection: number;
  changedQuoteCount: number;
  changedQuoteIds: number[];
  affectedPeriods: string[];
  quoteStates: QuoteClassificationState[];
};

export type QuoteClassificationRebuildResult = {
  auditIds: string[];
  canonicalQuotesUpdated: number;
  snapshotsUpdated: number;
  canonicalJobRelationshipsUpdated: number;
  jobSnapshotRelationshipsUpdated: number;
  rollupsQueued: number;
  capturedQuoteIds: number[];
  before: QuoteClassificationRebuildPreview;
  after: QuoteClassificationRebuildPreview;
};

export type QuoteClassificationRebuildTransaction = <T>(
  callback: (query: PostgresQuery) => Promise<T>,
) => Promise<T>;

type ProjectionRow = {
  quote_id: string;
  date_approved: string;
  date_issued: string | null;
  total_value: string;
  status_name: string | null;
  canonical_outcome: string;
  canonical_outcome_reason: string;
  canonical_won_reason: string;
  canonical_linked_job_id: string | null;
  snapshot_quote_id: string | null;
  snapshot_date_approved: string | null;
  snapshot_date_issued: string | null;
  snapshot_linked_job_id: string | null;
  snapshot_won: boolean | null;
  snapshot_won_value: string | null;
  snapshot_win_loss_reason: string | null;
  excluded_override_id: string | null;
  authoritative_source_snapshot_id: string | null;
  authoritative_linked_job_id: string | null;
  linked_job_match_id: string | null;
  inverse_conversion_match_id: string | null;
  inverse_source_snapshot_id: string | null;
  canonical_inverse_match_id: string | null;
  snapshot_inverse_match_id: string | null;
  relationship_drift_job_ids: string[] | null;
  projected_outcome: QuoteClassificationOutcome;
  projected_reason: string;
  projected_won: boolean;
  projected_won_value: string;
  canonical_needs_projection: boolean;
  snapshot_needs_projection: boolean;
  relationships_need_projection: boolean;
};

type RelationshipImpact = {
  quote_id: number;
  job_id: number;
};

// Bulk bootstrap runs this only after migration 035 has installed the SQL
// implementations of the same conflict-aware relationship resolver contract.
export const quoteClassificationRebuildSql = `with authoritative_jobs as materialized (
  select j.job_id,
         case when authoritative.id is null then null
              else metrics.authoritative_job_source_quote_id(authoritative.payload)
          end as source_quote_id
    from metrics.metrics_jobs j
    left join lateral (
      select raw.id, raw.payload
        from metrics.raw_simpro_snapshots raw
       where raw.entity_type in ('job_details', 'jobs')
         and raw.entity_id = j.job_id::text
         and raw.complete_traversal = true
         and raw.source_deleted_at is null
       order by raw.extracted_at desc, raw.id desc
       limit 1
    ) authoritative on true
   where j.source_deleted_at is null
), canonical_jobs_updated as (
  update metrics.metrics_jobs j
     set converted_from_type = case when authoritative.source_quote_id is null then 'Direct service' else 'Quote' end,
         converted_from_id = authoritative.source_quote_id,
         job_source_type = case when authoritative.source_quote_id is null then 'Direct service' else 'Quote' end,
         job_source_id = authoritative.source_quote_id,
         updated_from_source_at = now()
    from authoritative_jobs authoritative
   where j.job_id = authoritative.job_id
     and (
       (authoritative.source_quote_id is not null and (
         j.converted_from_type is distinct from 'Quote'
         or j.converted_from_id is distinct from authoritative.source_quote_id
         or j.job_source_type is distinct from 'Quote'
         or j.job_source_id is distinct from authoritative.source_quote_id
       ))
       or (authoritative.source_quote_id is null and (
         lower(trim(coalesce(j.converted_from_type, ''))) = 'quote'
         or lower(trim(coalesce(j.job_source_type, ''))) = 'quote'
       ))
     )
  returning j.job_id
), job_snapshots_updated as (
  update metrics.job_snapshots snapshot
     set source_quote_id = authoritative.source_quote_id,
         updated_at = now()
    from authoritative_jobs authoritative
   where snapshot.job_id = authoritative.job_id
     and snapshot.source_quote_id is distinct from authoritative.source_quote_id
  returning snapshot.job_id
), authoritative_quotes as materialized (
  select q.quote_id,
         metrics.authoritative_quote_linked_job_id(authoritative.payload) as linked_job_id
    from metrics.metrics_quotes q
    left join lateral (
      select raw.payload
        from metrics.raw_simpro_snapshots raw
       where raw.entity_type in ('quote_details', 'quotes')
         and raw.entity_id = q.quote_id::text
         and raw.complete_traversal = true
         and raw.source_deleted_at is null
       order by raw.extracted_at desc, raw.id desc
       limit 1
    ) authoritative on true
   where q.source_deleted_at is null
), classified as materialized (
  select q.quote_id, q.date_approved, q.date_issued, q.total,
         authoritative.linked_job_id,
         case
           when excluded.id is not null then 'excluded'
           when ${acceptedOnlineStatusSql("q.status_name")}
             or direct_job.job_id is not null
             or inverse_job.job_id is not null then 'won'
           else 'lost'
         end as outcome,
         case
           when excluded.id is not null then 'manual_excluded'
           when ${acceptedOnlineStatusSql("q.status_name")}
             and (direct_job.job_id is not null or inverse_job.job_id is not null)
             then 'accepted_online_and_converted'
           when ${acceptedOnlineStatusSql("q.status_name")} then 'accepted_online'
           when direct_job.job_id is not null or inverse_job.job_id is not null then 'converted_job'
           else 'no_acceptance_evidence'
         end as reason
    from metrics.metrics_quotes q
    join authoritative_quotes authoritative using (quote_id)
    left join metrics.metrics_jobs direct_job
      on direct_job.job_id = authoritative.linked_job_id
     and direct_job.source_deleted_at is null
    left join lateral (
      select relationship.job_id
        from authoritative_jobs relationship
       where relationship.source_quote_id = q.quote_id
       order by relationship.job_id
       limit 1
    ) inverse_job on true
    left join lateral (
      select override.id
        from metrics.quote_classification_overrides override
       where override.quote_id = q.quote_id
         and override.active = true
         and override.outcome = 'excluded'
       order by override.created_at desc, override.id desc
       limit 1
    ) excluded on true
   where q.source_deleted_at is null
     and (select count(*) from canonical_jobs_updated) >= 0
     and (select count(*) from job_snapshots_updated) >= 0
), canonical_updated as (
  update metrics.metrics_quotes q
     set linked_job_id = classified.linked_job_id,
         outcome = classified.outcome,
         outcome_reason = classified.reason,
         won_reason = classified.reason,
         updated_from_source_at = now()
    from classified
   where q.quote_id = classified.quote_id
     and (q.linked_job_id is distinct from classified.linked_job_id
       or q.outcome is distinct from classified.outcome
       or q.outcome_reason is distinct from classified.reason
       or q.won_reason is distinct from classified.reason)
  returning q.quote_id
), snapshots_updated as (
  update metrics.quote_snapshots snapshot
     set linked_job_id = classified.linked_job_id,
         won = classified.outcome = 'won',
         won_value = case when classified.outcome = 'won' then classified.total else 0 end,
         win_loss_reason = classified.reason,
         updated_at = now()
    from classified
   where snapshot.quote_id = classified.quote_id
     and (snapshot.linked_job_id is distinct from classified.linked_job_id
       or snapshot.won is distinct from (classified.outcome = 'won')
       or snapshot.won_value is distinct from (case when classified.outcome = 'won' then classified.total else 0 end)
       or snapshot.win_loss_reason is distinct from classified.reason)
  returning snapshot.quote_id
), changed as (
  select quote_id from canonical_updated
  union
  select quote_id from snapshots_updated
)
select date_trunc('month', classified.date_approved)::date::text as period_start,
       count(*)::integer as quote_count
  from changed
  join classified using (quote_id)
 where classified.date_approved is not null
 group by date_trunc('month', classified.date_approved)
 order by period_start`;

export async function acquireQuoteClassificationAdvisoryLock(query: PostgresQuery): Promise<void> {
  await query("select pg_advisory_xact_lock($1::bigint)", [QUOTE_CLASSIFICATION_LOCK_KEY]);
}

export async function inspectQuoteClassificationRebuild(
  query: PostgresQuery = queryPostgres,
  capturedQuoteIds?: number[],
): Promise<QuoteClassificationRebuildPreview> {
  const quoteIds = capturedQuoteIds ?? await captureServingQuoteIds(query);
  const relationships = await loadAuthoritativeQuoteRelationships(query, quoteIds);
  return inspectWithRelationships(query, quoteIds, relationships);
}

export async function reclassifyPersistedQuotes(
  query: PostgresQuery = queryPostgres,
): Promise<QuoteClassificationRebuildPreview> {
  return inspectQuoteClassificationRebuild(query);
}

export async function executeQuoteClassificationRebuild(
  params: { actorEmail: string; confirmation: string },
  options: {
    query?: PostgresQuery;
    transaction?: QuoteClassificationRebuildTransaction;
  } = {},
): Promise<QuoteClassificationRebuildResult> {
  const actorEmail = params.actorEmail.trim();
  if (!isEmail(actorEmail)) throw new Error("actorEmail must be a valid email address.");
  if (params.confirmation !== QUOTE_CLASSIFICATION_REBUILD_CONFIRMATION) {
    throw new Error(`confirmation must equal ${QUOTE_CLASSIFICATION_REBUILD_CONFIRMATION}.`);
  }
  if (options.query && !options.transaction) {
    throw new Error("An injected query requires an injected transaction.");
  }
  const transaction = options.transaction ?? withPostgresTransaction;

  return transaction(async (transactionQuery) => {
    if (options.query && options.query !== transactionQuery) {
      throw new Error("Quote classification rebuild must use the query supplied by its transaction.");
    }

    await acquireQuoteClassificationAdvisoryLock(transactionQuery);
    const capturedQuoteIds = await captureServingQuoteIds(transactionQuery);
    await lockCapturedQuoteClassificationRows(transactionQuery, capturedQuoteIds);
    await lockAuthoritativeJobRelationshipRows(transactionQuery);
    const relationships = await loadAuthoritativeQuoteRelationships(transactionQuery, capturedQuoteIds);
    const before = await inspectWithRelationships(transactionQuery, capturedQuoteIds, relationships);
    assertExecutableCoverage(before);

    const relationshipTargets = relationships.jobs.filter((job) => (
      job.needsProjection && job.affectedQuoteIds.some((quoteId) => capturedQuoteIds.includes(quoteId))
    ));
    const jobUpdates = await reconcileJobRelationships(transactionQuery, relationshipTargets);

    const canonicalTargets = before.quoteStates.filter((state) => state.canonicalNeedsProjection);
    const canonicalUpdatedIds = await updateCanonicalQuotes(transactionQuery, canonicalTargets);
    assertExactUpdatedIds(
      "canonical quote",
      canonicalTargets.map((state) => state.quoteId),
      canonicalUpdatedIds,
    );

    const snapshotTargets = before.quoteStates.filter((state) => state.snapshotNeedsProjection);
    const snapshotUpdatedIds = await updateQuoteSnapshots(transactionQuery, snapshotTargets);
    assertExactUpdatedIds(
      "quote snapshot",
      snapshotTargets.map((state) => state.quoteId),
      snapshotUpdatedIds,
    );

    const afterRelationships = await loadAuthoritativeQuoteRelationships(transactionQuery, capturedQuoteIds);
    const after = await inspectWithRelationships(transactionQuery, capturedQuoteIds, afterRelationships);
    if (after.changedQuoteCount !== 0 || after.missingSnapshotQuoteIds.length > 0) {
      throw new Error("Quote relationship and outcome classification did not reach canonical and snapshot parity.");
    }

    const finalServingQuoteIds = await captureServingQuoteIds(transactionQuery);
    if (!sameIds(capturedQuoteIds, finalServingQuoteIds)) {
      throw new Error("The active served quote set changed during outcome repair; all writes were rolled back.");
    }

    const afterById = new Map(after.quoteStates.map((state) => [state.quoteId, state]));
    const changedStates = before.quoteStates.filter(stateNeedsProjection);
    const auditIds: string[] = [];
    for (const state of changedStates) {
      const afterState = afterById.get(state.quoteId);
      if (!afterState) throw new Error(`Quote ${state.quoteId} disappeared from the captured serving set.`);
      const audited = await transactionQuery<{ id: string }>(
        `insert into metrics.audit_events (
           actor_email, action, entity_type, entity_id, before_value, after_value, reason
         ) values (
           $1, 'quote_outcome_reclassified', 'quote', $2, $3::jsonb, $4::jsonb,
           'Source-backed quote relationship and outcome repair using current direct and inverse Simpro conversion provenance.'
         )
         returning id::text`,
        [
          actorEmail,
          String(state.quoteId),
          JSON.stringify(auditEvidence(state)),
          JSON.stringify(auditEvidence(afterState)),
        ],
      );
      const auditId = audited.rows[0]?.id;
      if (!auditId) throw new Error(`Audit evidence was not persisted for quote ${state.quoteId}.`);
      auditIds.push(auditId);
    }
    if (auditIds.length !== before.changedQuoteCount) {
      throw new Error("Not every changed quote relationship or outcome received an audit event.");
    }

    let rollupsQueued = 0;
    for (const periodStart of before.affectedPeriods) {
      const queued = await transactionQuery<{ id: string }>(
        `insert into metrics.rollup_rebuild_queue (
           metric_family, period_grain, period_start, dimensions_json, reason, idempotency_key
         ) values (
           'quotes', 'month', $1::date, '{}'::jsonb,
           'source-backed quote relationship and outcome reclassification audit ' || $2,
           'quote-outcome-reclassification:' || $2 || ':' || $1
         )
         returning id::text`,
        [periodStart, auditIds[0]],
      );
      if (!queued.rows[0]?.id) throw new Error(`Quote rollup was not queued for ${periodStart}.`);
      rollupsQueued += 1;
    }
    if (rollupsQueued !== before.affectedPeriods.length) {
      throw new Error("Not every old or new affected quote period received a rollup rebuild.");
    }

    return {
      auditIds,
      canonicalQuotesUpdated: canonicalUpdatedIds.length,
      snapshotsUpdated: snapshotUpdatedIds.length,
      canonicalJobRelationshipsUpdated: jobUpdates.canonicalUpdatedIds.length,
      jobSnapshotRelationshipsUpdated: jobUpdates.snapshotUpdatedIds.length,
      rollupsQueued,
      capturedQuoteIds,
      before,
      after,
    };
  });
}

export async function reclassifyPersistedQuote(
  quoteId: number,
  query: PostgresQuery = queryPostgres,
) {
  assertQuoteId(quoteId);
  const relationships = await loadAuthoritativeQuoteRelationships(query, [quoteId], {
    requireCompleteQuoteProvenance: false,
  });
  const relatedJobs = relationships.jobs.filter((job) => job.affectedQuoteIds.includes(quoteId));
  await reconcileJobRelationships(query, relatedJobs.filter((job) => job.needsProjection));

  const direct = relationships.quotes[0];
  if (!direct) throw new Error(`No authoritative direct relationship was resolved for quote ${quoteId}.`);
  const inverse = relationships.jobs
    .filter((job) => job.sourceQuoteId === quoteId)
    .sort((left, right) => left.jobId - right.jobId)[0];
  const result = await query<{ period_start: string; quote_count: number }>(
    singleQuoteClassificationSql(),
    [quoteId, direct.linkedJobId, direct.conversionJobId, inverse?.jobId ?? null],
  );
  return result.rows;
}

async function inspectWithRelationships(
  query: PostgresQuery,
  quoteIds: number[],
  relationships: AuthoritativeQuoteRelationships,
): Promise<QuoteClassificationRebuildPreview> {
  const quoteIdSet = new Set(quoteIds);
  const impacts: RelationshipImpact[] = relationships.jobs.flatMap((job) => (
    job.needsProjection
      ? job.affectedQuoteIds
          .filter((quoteId) => quoteIdSet.has(quoteId))
          .map((quoteId) => ({ quote_id: quoteId, job_id: job.jobId }))
      : []
  ));
  const result = await query<ProjectionRow>(
    projectionRowsSql(),
    [
      quoteIds,
      JSON.stringify(relationships.quotes.map((relationship) => ({
        quote_id: relationship.quoteId,
        source_snapshot_id: relationship.sourceSnapshotId,
        linked_job_id: relationship.linkedJobId,
        conversion_job_id: relationship.conversionJobId,
      }))),
      JSON.stringify(relationships.jobs.map((relationship) => ({
        job_id: relationship.jobId,
        source_snapshot_id: relationship.sourceSnapshotId,
        source_quote_id: relationship.sourceQuoteId,
        canonical_converted_from_quote_id: relationship.canonicalConvertedFromQuoteId,
        canonical_job_source_quote_id: relationship.canonicalJobSourceQuoteId,
        snapshot_source_quote_id: relationship.snapshotSourceQuoteId,
      }))),
      JSON.stringify(impacts),
    ],
  );
  const quoteStates = result.rows.map(toQuoteClassificationState);
  const changedStates = quoteStates.filter(stateNeedsProjection);
  const firstApprovedDate = quoteStates[0]?.dateApproved ?? null;
  const lastApprovedDate = quoteStates.at(-1)?.dateApproved ?? null;
  const relationshipJobIds = new Set(
    impacts.map((impact) => impact.job_id),
  );

  return {
    servingWindow: {
      firstApprovedDate,
      lastApprovedDate,
      firstPeriod: firstApprovedDate ? monthStart(firstApprovedDate) : null,
      lastPeriod: lastApprovedDate ? monthStart(lastApprovedDate) : null,
    },
    activeQuoteCount: quoteStates.length,
    missingSnapshotQuoteIds: quoteStates
      .filter((state) => !state.snapshot.exists)
      .map((state) => state.quoteId),
    missingRelationshipJobSnapshotIds: relationships.jobs
      .filter((job) => job.sourceQuoteId !== null && !job.snapshotExists && quoteIdSet.has(job.sourceQuoteId))
      .map((job) => job.jobId),
    currentOutcomeCounts: countOutcomes(quoteStates.map((state) => state.canonical.outcome)),
    projectedOutcomeCounts: countOutcomes(quoteStates.map((state) => state.projected.outcome)),
    canonicalQuotesNeedingProjection: quoteStates.filter((state) => state.canonicalNeedsProjection).length,
    snapshotsNeedingProjection: quoteStates.filter((state) => state.snapshotNeedsProjection).length,
    jobRelationshipsNeedingProjection: relationshipJobIds.size,
    changedQuoteCount: changedStates.length,
    changedQuoteIds: changedStates.map((state) => state.quoteId).sort(numericSort),
    affectedPeriods: affectedPeriodsForStates(changedStates),
    quoteStates,
  };
}

function projectionRowsSql(): string {
  const acceptedOnline = acceptedOnlineStatusSql("q.status_name");
  return `select q.quote_id::text, q.date_approved::text, q.date_issued::text,
              q.total::text as total_value, q.status_name,
              q.outcome as canonical_outcome,
              q.outcome_reason as canonical_outcome_reason,
              q.won_reason as canonical_won_reason,
              q.linked_job_id::text as canonical_linked_job_id,
              snapshot.quote_id::text as snapshot_quote_id,
              snapshot.date_approved::text as snapshot_date_approved,
              snapshot.date_issued::text as snapshot_date_issued,
              snapshot.linked_job_id::text as snapshot_linked_job_id,
              snapshot.won as snapshot_won,
              snapshot.won_value::text as snapshot_won_value,
              snapshot.win_loss_reason as snapshot_win_loss_reason,
              excluded.id::text as excluded_override_id,
              authoritative.source_snapshot_id::text as authoritative_source_snapshot_id,
              authoritative.linked_job_id::text as authoritative_linked_job_id,
              authoritative.conversion_job_id::text as linked_job_match_id,
              inverse.job_id::text as inverse_conversion_match_id,
              inverse.source_snapshot_id::text as inverse_source_snapshot_id,
              canonical_inverse.job_id::text as canonical_inverse_match_id,
              snapshot_inverse.job_id::text as snapshot_inverse_match_id,
              drift.job_ids::text[] as relationship_drift_job_ids,
              projected.outcome as projected_outcome,
              projected.reason as projected_reason,
              projected.outcome = 'won' as projected_won,
              (case when projected.outcome = 'won' then q.total else 0::numeric end)::text
                as projected_won_value,
              (q.outcome is distinct from projected.outcome
                or q.outcome_reason is distinct from projected.reason
                or q.won_reason is distinct from projected.reason
                or q.linked_job_id is distinct from authoritative.linked_job_id)
                as canonical_needs_projection,
              (snapshot.quote_id is null
                or snapshot.linked_job_id is distinct from authoritative.linked_job_id
                or snapshot.won is distinct from (projected.outcome = 'won')
                or snapshot.won_value is distinct from
                  (case when projected.outcome = 'won' then q.total else 0::numeric end)
                or snapshot.win_loss_reason is distinct from projected.reason)
                as snapshot_needs_projection,
              drift.job_ids is not null as relationships_need_projection
         from metrics.metrics_quotes q
         left join metrics.quote_snapshots snapshot on snapshot.quote_id = q.quote_id
         join jsonb_to_recordset($2::jsonb) as authoritative(
           quote_id bigint, source_snapshot_id bigint, linked_job_id bigint, conversion_job_id bigint
         ) on authoritative.quote_id = q.quote_id
         left join lateral (
           select override.id
             from metrics.quote_classification_overrides override
            where override.quote_id = q.quote_id
              and override.active = true
              and override.outcome = 'excluded'
            order by override.created_at desc, override.id desc
            limit 1
         ) excluded on true
         left join lateral (
           select relationship.job_id, relationship.source_snapshot_id
             from jsonb_to_recordset($3::jsonb) as relationship(
               job_id bigint, source_snapshot_id bigint, source_quote_id bigint,
               canonical_converted_from_quote_id bigint, canonical_job_source_quote_id bigint,
               snapshot_source_quote_id bigint
             )
            where relationship.source_quote_id = q.quote_id
            order by relationship.job_id
            limit 1
         ) inverse on true
         left join lateral (
           select relationship.job_id
             from jsonb_to_recordset($3::jsonb) as relationship(
               job_id bigint, source_snapshot_id bigint, source_quote_id bigint,
               canonical_converted_from_quote_id bigint, canonical_job_source_quote_id bigint,
               snapshot_source_quote_id bigint
             )
            where relationship.canonical_converted_from_quote_id = q.quote_id
               or relationship.canonical_job_source_quote_id = q.quote_id
            order by relationship.job_id
            limit 1
         ) canonical_inverse on true
         left join lateral (
           select relationship.job_id
             from jsonb_to_recordset($3::jsonb) as relationship(
               job_id bigint, source_snapshot_id bigint, source_quote_id bigint,
               canonical_converted_from_quote_id bigint, canonical_job_source_quote_id bigint,
               snapshot_source_quote_id bigint
             )
            where relationship.snapshot_source_quote_id = q.quote_id
            order by relationship.job_id
            limit 1
         ) snapshot_inverse on true
         left join lateral (
           select array_agg(impact.job_id order by impact.job_id) as job_ids
             from jsonb_to_recordset($4::jsonb) as impact(quote_id bigint, job_id bigint)
            where impact.quote_id = q.quote_id
         ) drift on true
         cross join lateral (
           select case
                    when excluded.id is not null then 'excluded'
                    when ${acceptedOnline}
                      or authoritative.conversion_job_id is not null
                      or inverse.job_id is not null then 'won'
                    else 'lost'
                  end as outcome,
                  case
                    when excluded.id is not null then 'manual_excluded'
                    when ${acceptedOnline}
                      and (authoritative.conversion_job_id is not null or inverse.job_id is not null)
                      then 'accepted_online_and_converted'
                    when ${acceptedOnline} then 'accepted_online'
                    when authoritative.conversion_job_id is not null or inverse.job_id is not null
                      then 'converted_job'
                    else 'no_acceptance_evidence'
                  end as reason
         ) projected
        where q.source_deleted_at is null and q.date_approved is not null
          and q.quote_id = any($1::bigint[])
        order by q.date_approved, q.quote_id`;
}

function singleQuoteClassificationSql(): string {
  const acceptedOnline = acceptedOnlineStatusSql("q.status_name");
  return `with classified as materialized (
       select q.quote_id, q.date_approved, q.date_issued, q.total,
              snapshot.date_approved as snapshot_date_approved,
              snapshot.date_issued as snapshot_date_issued,
              $2::bigint as linked_job_id,
              case
                when excluded.id is not null then 'excluded'
                when ${acceptedOnline} or $3::bigint is not null or $4::bigint is not null then 'won'
                else 'lost'
              end as outcome,
              case
                when excluded.id is not null then 'manual_excluded'
                when ${acceptedOnline} and ($3::bigint is not null or $4::bigint is not null)
                  then 'accepted_online_and_converted'
                when ${acceptedOnline} then 'accepted_online'
                when $3::bigint is not null or $4::bigint is not null then 'converted_job'
                else 'no_acceptance_evidence'
              end as reason
         from metrics.metrics_quotes q
         left join metrics.quote_snapshots snapshot using (quote_id)
         left join lateral (
           select override.id
             from metrics.quote_classification_overrides override
            where override.quote_id = q.quote_id
              and override.active = true
              and override.outcome = 'excluded'
            order by override.created_at desc, override.id desc
            limit 1
         ) excluded on true
        where q.quote_id = $1 and q.source_deleted_at is null
     ), canonical_updated as (
       update metrics.metrics_quotes q
          set linked_job_id = classified.linked_job_id,
              outcome = classified.outcome,
              outcome_reason = classified.reason,
              won_reason = classified.reason,
              updated_from_source_at = now()
         from classified
        where q.quote_id = classified.quote_id
          and (q.linked_job_id is distinct from classified.linked_job_id
            or q.outcome is distinct from classified.outcome
            or q.outcome_reason is distinct from classified.reason
            or q.won_reason is distinct from classified.reason)
        returning q.quote_id
     ), snapshots_updated as (
       update metrics.quote_snapshots snapshot
          set linked_job_id = classified.linked_job_id,
              won = classified.outcome = 'won',
              won_value = case when classified.outcome = 'won' then classified.total else 0 end,
              win_loss_reason = classified.reason,
              updated_at = now()
         from classified
        where snapshot.quote_id = classified.quote_id
          and (snapshot.linked_job_id is distinct from classified.linked_job_id
            or snapshot.won is distinct from (classified.outcome = 'won')
            or snapshot.won_value is distinct from
              (case when classified.outcome = 'won' then classified.total else 0 end)
            or snapshot.win_loss_reason is distinct from classified.reason)
        returning snapshot.quote_id
     ), changed as (
       select quote_id from canonical_updated
       union
       select quote_id from snapshots_updated
     ), affected as (
       select distinct date_trunc('month', source_date)::date as period_start
         from classified
         cross join lateral (values
           (classified.date_approved),
           (classified.date_issued),
           (classified.snapshot_date_approved),
           (classified.snapshot_date_issued)
         ) dates(source_date)
        where source_date is not null
          and exists (select 1 from changed)
     )
     select period_start::text, 1::integer as quote_count
       from affected
      order by period_start`;
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

async function lockCapturedQuoteClassificationRows(
  query: PostgresQuery,
  quoteIds: number[],
): Promise<void> {
  await query(
    `select quote_id from metrics.metrics_quotes
      where quote_id = any($1::bigint[]) order by quote_id for update`,
    [quoteIds],
  );
  await query(
    `select quote_id from metrics.quote_snapshots
      where quote_id = any($1::bigint[]) order by quote_id for update`,
    [quoteIds],
  );
  await query(
    `select id from metrics.quote_classification_overrides
      where quote_id = any($1::bigint[]) and active = true
      order by quote_id, id for update`,
    [quoteIds],
  );
  await query(
    `select id from metrics.raw_simpro_snapshots
      where entity_type in ('quote_details', 'quotes')
        and entity_id = any($1::text[])
        and complete_traversal = true
        and source_deleted_at is null
      order by entity_id, extracted_at desc, id desc for update`,
    [quoteIds.map(String)],
  );
}

async function lockAuthoritativeJobRelationshipRows(query: PostgresQuery): Promise<void> {
  await query(
    `select job_id from metrics.metrics_jobs
      where source_deleted_at is null order by job_id for update`,
  );
  await query(
    `select snapshot.job_id
       from metrics.job_snapshots snapshot
       join metrics.metrics_jobs job using (job_id)
      where job.source_deleted_at is null
      order by snapshot.job_id for update of snapshot`,
  );
  await query(
    `select raw.id
       from metrics.raw_simpro_snapshots raw
       join metrics.metrics_jobs job on job.job_id::text = raw.entity_id
      where raw.entity_type in ('job_details', 'jobs')
        and raw.complete_traversal = true
        and raw.source_deleted_at is null
        and job.source_deleted_at is null
      order by raw.entity_id, raw.extracted_at desc, raw.id desc for update of raw`,
  );
}

async function reconcileJobRelationships(
  query: PostgresQuery,
  targets: AuthoritativeJobInverseRelationship[],
): Promise<{ canonicalUpdatedIds: number[]; snapshotUpdatedIds: number[] }> {
  const canonicalTargets = targets.filter((target) => target.canonicalNeedsProjection);
  const canonicalUpdatedIds = canonicalTargets.length === 0
    ? []
    : (await query<{ job_id: string }>(
        `update metrics.metrics_jobs job
            set converted_from_type = case when projected.source_quote_id is null then 'Direct service' else 'Quote' end,
                converted_from_id = projected.source_quote_id,
                job_source_type = case when projected.source_quote_id is null then 'Direct service' else 'Quote' end,
                job_source_id = projected.source_quote_id,
                updated_from_source_at = now()
           from unnest($1::bigint[], $2::bigint[]) projected(job_id, source_quote_id)
          where job.job_id = projected.job_id
          returning job.job_id::text`,
        [
          canonicalTargets.map((target) => target.jobId),
          canonicalTargets.map((target) => target.sourceQuoteId),
        ],
      )).rows.map((row) => Number(row.job_id));
  assertExactUpdatedIds(
    "canonical job relationship",
    canonicalTargets.map((target) => target.jobId),
    canonicalUpdatedIds,
  );

  const snapshotTargets = targets.filter((target) => target.snapshotNeedsProjection && target.snapshotExists);
  const snapshotUpdatedIds = snapshotTargets.length === 0
    ? []
    : (await query<{ job_id: string }>(
        `update metrics.job_snapshots snapshot
            set source_quote_id = projected.source_quote_id,
                updated_at = now()
           from unnest($1::bigint[], $2::bigint[]) projected(job_id, source_quote_id)
          where snapshot.job_id = projected.job_id
            and snapshot.source_quote_id is distinct from projected.source_quote_id
          returning snapshot.job_id::text`,
        [
          snapshotTargets.map((target) => target.jobId),
          snapshotTargets.map((target) => target.sourceQuoteId),
        ],
      )).rows.map((row) => Number(row.job_id));
  assertExactUpdatedIds(
    "job snapshot relationship",
    snapshotTargets.map((target) => target.jobId),
    snapshotUpdatedIds,
  );
  return { canonicalUpdatedIds, snapshotUpdatedIds };
}

async function updateCanonicalQuotes(
  query: PostgresQuery,
  targets: QuoteClassificationState[],
): Promise<number[]> {
  if (targets.length === 0) return [];
  const result = await query<{ quote_id: string }>(
    `update metrics.metrics_quotes q
        set outcome = projected.outcome,
            outcome_reason = projected.outcome_reason,
            won_reason = projected.won_reason,
            linked_job_id = projected.linked_job_id,
            updated_from_source_at = now()
       from unnest(
         $1::bigint[], $2::text[], $3::text[], $4::text[], $5::bigint[]
       ) as projected(quote_id, outcome, outcome_reason, won_reason, linked_job_id)
      where q.quote_id = projected.quote_id
        and (q.outcome is distinct from projected.outcome
          or q.outcome_reason is distinct from projected.outcome_reason
          or q.won_reason is distinct from projected.won_reason
          or q.linked_job_id is distinct from projected.linked_job_id)
      returning q.quote_id::text`,
    [
      targets.map((state) => state.quoteId),
      targets.map((state) => state.projected.outcome),
      targets.map((state) => state.projected.outcomeReason),
      targets.map((state) => state.projected.wonReason),
      targets.map((state) => state.evidence.authoritativeLinkedJobId),
    ],
  );
  return result.rows.map((row) => Number(row.quote_id));
}

async function updateQuoteSnapshots(
  query: PostgresQuery,
  targets: QuoteClassificationState[],
): Promise<number[]> {
  if (targets.length === 0) return [];
  const result = await query<{ quote_id: string }>(
    `update metrics.quote_snapshots snapshot
        set linked_job_id = projected.linked_job_id,
            won = projected.won,
            won_value = projected.won_value,
            win_loss_reason = projected.win_loss_reason,
            updated_at = now()
       from unnest(
         $1::bigint[], $2::bigint[], $3::boolean[], $4::numeric[], $5::text[]
       ) as projected(quote_id, linked_job_id, won, won_value, win_loss_reason)
      where snapshot.quote_id = projected.quote_id
        and (snapshot.linked_job_id is distinct from projected.linked_job_id
          or snapshot.won is distinct from projected.won
          or snapshot.won_value is distinct from projected.won_value
          or snapshot.win_loss_reason is distinct from projected.win_loss_reason)
      returning snapshot.quote_id::text as quote_id`,
    [
      targets.map((state) => state.quoteId),
      targets.map((state) => state.evidence.authoritativeLinkedJobId),
      targets.map((state) => state.projected.won),
      targets.map((state) => state.projected.wonValue),
      targets.map((state) => state.projected.winLossReason),
    ],
  );
  return result.rows.map((row) => Number(row.quote_id));
}

function toQuoteClassificationState(row: ProjectionRow): QuoteClassificationState {
  return {
    quoteId: Number(row.quote_id),
    dateApproved: row.date_approved,
    dateIssued: row.date_issued,
    totalValue: row.total_value,
    evidence: {
      statusName: row.status_name,
      acceptedOnlineExact: isAcceptedOnlineStatus(row.status_name),
      manualExcludedOverrideId: optionalNumber(row.excluded_override_id),
      authoritativeSourceSnapshotId: optionalNumber(row.authoritative_source_snapshot_id),
      authoritativeLinkedJobId: optionalNumber(row.authoritative_linked_job_id),
      linkedJobMatchId: optionalNumber(row.linked_job_match_id),
      inverseConversionMatchId: optionalNumber(row.inverse_conversion_match_id),
      inverseSourceSnapshotId: optionalNumber(row.inverse_source_snapshot_id),
      canonicalInverseMatchId: optionalNumber(row.canonical_inverse_match_id),
      snapshotInverseMatchId: optionalNumber(row.snapshot_inverse_match_id),
      relationshipDriftJobIds: (row.relationship_drift_job_ids ?? []).map(Number),
    },
    canonical: {
      outcome: row.canonical_outcome,
      outcomeReason: row.canonical_outcome_reason,
      wonReason: row.canonical_won_reason,
      linkedJobId: optionalNumber(row.canonical_linked_job_id),
    },
    snapshot: {
      exists: row.snapshot_quote_id !== null,
      dateApproved: row.snapshot_date_approved,
      dateIssued: row.snapshot_date_issued,
      linkedJobId: optionalNumber(row.snapshot_linked_job_id),
      won: row.snapshot_won,
      wonValue: row.snapshot_won_value,
      winLossReason: row.snapshot_win_loss_reason,
    },
    projected: {
      outcome: row.projected_outcome,
      outcomeReason: row.projected_reason,
      wonReason: row.projected_reason,
      won: row.projected_won,
      wonValue: row.projected_won_value,
      winLossReason: row.projected_reason,
    },
    canonicalNeedsProjection: row.canonical_needs_projection,
    snapshotNeedsProjection: row.snapshot_needs_projection,
    relationshipsNeedProjection: row.relationships_need_projection,
  };
}

function assertExecutableCoverage(preview: QuoteClassificationRebuildPreview): void {
  if (preview.missingSnapshotQuoteIds.length > 0) {
    throw new Error(`Active served quotes lack quote snapshots: ${preview.missingSnapshotQuoteIds.join(", ")}.`);
  }
  if (preview.missingRelationshipJobSnapshotIds.length > 0) {
    throw new Error(
      `Authoritative inverse relationship jobs lack job snapshots: ${preview.missingRelationshipJobSnapshotIds.join(", ")}.`,
    );
  }
}

function assertExactUpdatedIds(label: string, expected: number[], actual: number[]): void {
  const expectedIds = [...expected].sort(numericSort);
  const actualIds = [...actual].sort(numericSort);
  if (!sameIds(expectedIds, actualIds)) {
    throw new Error(
      `Changed ${label} IDs did not match the captured projection; expected ${expectedIds.join(", ") || "none"}, got ${actualIds.join(", ") || "none"}.`,
    );
  }
}

function auditEvidence(state: QuoteClassificationState) {
  return {
    quoteId: state.quoteId,
    dateApproved: state.dateApproved,
    dateIssued: state.dateIssued,
    totalValue: state.totalValue,
    evidence: state.evidence,
    canonical: state.canonical,
    snapshot: state.snapshot,
    projected: state.projected,
  };
}

function stateNeedsProjection(state: QuoteClassificationState): boolean {
  return state.canonicalNeedsProjection
    || state.snapshotNeedsProjection
    || state.relationshipsNeedProjection;
}

function affectedPeriodsForStates(states: QuoteClassificationState[]): string[] {
  return [...new Set(states.flatMap((state) => [
    state.dateApproved,
    state.dateIssued,
    state.snapshot.dateApproved,
    state.snapshot.dateIssued,
  ].flatMap((date) => date ? [monthStart(date)] : [])))].sort();
}

function countOutcomes(outcomes: string[]): QuoteClassificationCounts {
  const counts = new Map<string, number>();
  for (const outcome of outcomes) counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
  return [...counts]
    .map(([outcome, count]) => ({ outcome, count }))
    .sort((left, right) => left.outcome.localeCompare(right.outcome));
}

function optionalNumber(value: string | null): number | null {
  return value === null ? null : Number(value);
}

function sameIds(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function numericSort(left: number, right: number): number {
  return left - right;
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

function assertQuoteId(quoteId: number): void {
  if (!Number.isSafeInteger(quoteId) || quoteId <= 0) {
    throw new Error("quoteId must be a positive integer.");
  }
}
