import { queryPostgres } from "@/lib/store/postgres";
import { acceptedOnlineStatusSql } from "@/lib/metrics/quotes";
import { QUOTE_CLASSIFICATION_LOCK_KEY } from "@/lib/store/quote-classification-rebuild";
import type { QuoteOutcome } from "@/lib/store/quote-dashboard-read-model";

export const quoteOverrideActions = ["exclude", "reinstate"] as const;
export type QuoteOverrideAction = (typeof quoteOverrideActions)[number];
export type QuoteOverrideHistoryOutcome = Extract<QuoteOutcome, "won" | "lost" | "excluded"> | "manual_reinstated";

export type QuoteOverrideRecord = {
  id: number;
  quoteId: number;
  action: QuoteOverrideAction | null;
  outcome: QuoteOverrideHistoryOutcome;
  previousOutcome: QuoteOutcome;
  reason: string;
  evidenceUrl: string | null;
  actorEmail: string;
  revision: number;
  active: boolean;
  createdAt: string;
  supersededAt: string | null;
};

type QueryResult<T> = { rows: T[]; rowCount: number | null };
export type QuoteOverrideQuery = <T = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<QueryResult<T>>;

type PersistResultRow = {
  quote_found: boolean;
  current_revision: string | number | null;
  id: string | number | null;
  quote_id: string | number | null;
  action: QuoteOverrideAction | null;
  outcome: QuoteOverrideHistoryOutcome | null;
  previous_outcome: QuoteOutcome | null;
  reason: string | null;
  evidence_url: string | null;
  actor_email: string | null;
  revision: string | number | null;
  active: boolean | null;
  created_at: string | null;
  superseded_at: string | null;
  idempotent_match: boolean;
};

type HistoryRow = {
  id: string | number;
  quote_id: string | number;
  action: QuoteOverrideAction | null;
  outcome: QuoteOverrideHistoryOutcome;
  previous_outcome: QuoteOutcome;
  reason: string;
  evidence_url: string | null;
  actor_email: string;
  revision: string | number;
  active: boolean;
  created_at: string;
  superseded_at: string | null;
};

export class QuoteOverrideConflictError extends Error {
  readonly currentRevision: number;

  constructor(expectedRevision: number, currentRevision: number) {
    super(`Quote exclusion changed since it was loaded. Expected active revision ${expectedRevision}; current active revision is ${currentRevision}.`);
    this.name = "QuoteOverrideConflictError";
    this.currentRevision = currentRevision;
  }
}

export class QuoteOverrideIdempotencyConflictError extends Error {
  constructor() {
    super("The idempotency key has already been used for a different quote override action.");
    this.name = "QuoteOverrideIdempotencyConflictError";
  }
}

export async function persistQuoteOverrideAction(
  params: {
    quoteId: number;
    action: QuoteOverrideAction;
    expectedActiveExclusionRevision: number;
    idempotencyKey: string;
    reason: string;
    evidenceUrl?: string | null;
    previousDateApproved?: string | null;
    actorEmail: string;
  },
  query: QuoteOverrideQuery = queryPostgres,
): Promise<QuoteOverrideRecord> {
  validateQuoteOverrideAction(params);
  const acceptedOnline = acceptedOnlineStatusSql("q.status_name");

  let result: QueryResult<PersistResultRow>;
  try {
    result = await query<PersistResultRow>(
      `with classification_lock as materialized (
         select pg_advisory_xact_lock($9::bigint)
       ), locked_quote as materialized (
         select q.*
           from metrics.metrics_quotes q
           cross join classification_lock
          where q.quote_id = $1
            and q.source_deleted_at is null
          for update of q
       ), locked_snapshot as materialized (
         select s.quote_id
           from metrics.quote_snapshots s
           join locked_quote q using (quote_id)
          order by s.quote_id
          for update of s
       ), locked_active_overrides as materialized (
         select o.*
           from metrics.quote_classification_overrides o
           join locked_quote q using (quote_id)
          where o.active = true
            and (select count(*) from locked_snapshot) >= 0
          order by o.quote_id, o.id
          for update of o
       ), locked_raw_quotes as materialized (
         select raw.id, raw.payload, raw.extracted_at
           from metrics.raw_simpro_snapshots raw
           join locked_quote q on raw.entity_id = q.quote_id::text
          where raw.entity_type in ('quote_details', 'quotes')
            and raw.complete_traversal = true
            and raw.source_deleted_at is null
            and (select count(*) from locked_active_overrides) >= 0
          order by raw.entity_id, raw.extracted_at desc, raw.id desc
          for update of raw
       ), authoritative_quote as materialized (
         select raw.id, raw.payload
           from locked_raw_quotes raw
          order by raw.extracted_at desc, raw.id desc
          limit 1
       ), authoritative_direct as materialized (
         select metrics.authoritative_quote_linked_job_id(
                  (select source.payload from authoritative_quote source)
                ) as linked_job_id
       ), locked_jobs as materialized (
         select j.*
           from metrics.metrics_jobs j
          where j.source_deleted_at is null
            and (select count(*) from authoritative_direct) >= 0
          order by j.job_id
          for update of j
       ), locked_raw_jobs as materialized (
         select raw.id, raw.entity_id, raw.payload, raw.extracted_at
           from metrics.raw_simpro_snapshots raw
           join locked_jobs job on raw.entity_id = job.job_id::text
          where raw.entity_type in ('job_details', 'jobs')
            and raw.complete_traversal = true
            and raw.source_deleted_at is null
          order by raw.entity_id, raw.extracted_at desc, raw.id desc
          for update of raw
       ), authoritative_jobs as materialized (
         select job.job_id,
                case when source.id is null then null
                     else metrics.authoritative_job_source_quote_id(source.payload)
                 end as source_quote_id
           from locked_jobs job
           left join lateral (
             select raw.id, raw.payload
               from locked_raw_jobs raw
              where raw.entity_id = job.job_id::text
              order by raw.extracted_at desc, raw.id desc
              limit 1
           ) source on true
       ), locked_evidence_jobs as materialized (
         select job.*
           from locked_jobs job
           join authoritative_jobs inverse using (job_id)
           cross join locked_quote quote
           cross join authoritative_direct direct
          where job.job_id = direct.linked_job_id
             or inverse.source_quote_id = quote.quote_id
          order by job.job_id
       ), target as materialized (
         select q.quote_id, q.category, q.outcome, q.date_approved, q.total,
                case
                  when ${acceptedOnline}
                    or exists (select 1 from locked_evidence_jobs) then 'won'
                  else 'lost'
                end as source_outcome,
                case
                  when ${acceptedOnline}
                    and exists (select 1 from locked_evidence_jobs) then 'accepted_online_and_converted'
                  when ${acceptedOnline} then 'accepted_online'
                  when exists (select 1 from locked_evidence_jobs) then 'converted_job'
                  else 'no_acceptance_evidence'
                end as source_reason
           from locked_quote q
          where (select count(*) from locked_evidence_jobs) >= 0
       ), idempotent as materialized (
         select o.*,
                coalesce(
                  o.action::text = $2
                  and o.outcome = case when $2 = 'exclude' then 'excluded' else 'manual_reinstated' end
                  and o.reason = $4
                  and o.evidence_url is not distinct from $5
                  and lower(o.actor_email) = lower($7)
                  and o.revision > 0
                  and (
                    ($2 = 'exclude' and $3 = 0)
                    or ($2 = 'reinstate' and o.revision = $3 + 1)
                  ),
                  false
                ) as request_matches
           from metrics.quote_classification_overrides o
          where o.quote_id = $1
            and o.idempotency_key = $6
            and (select count(*) from target) >= 0
          limit 1
          for update of o
       ), current_exclusion as materialized (
         select o.* from locked_active_overrides o
          where o.active = true
            and o.outcome = 'excluded'
          order by o.revision desc, o.created_at desc, o.id desc
          limit 1
       ), superseded as (
         update metrics.quote_classification_overrides o
            set active = false,
                superseded_at = now()
          where $2 = 'reinstate'
            and o.quote_id = $1
            and o.active = true
            and o.outcome = 'excluded'
            and not exists (select 1 from idempotent)
            and exists (
              select 1 from current_exclusion c where c.revision = $3
            )
         returning o.id
       ), inserted as (
         insert into metrics.quote_classification_overrides (
           quote_id, category, won_override, action, outcome, previous_outcome, reason,
           evidence_url, actor_email, revision, idempotency_key, active, superseded_at
         )
         select t.quote_id, t.category, null, $2::metrics.quote_override_action,
                case when $2 = 'exclude' then 'excluded' else 'manual_reinstated' end,
                case when $2 = 'exclude' then t.source_outcome else 'excluded' end,
                $4, $5, $7,
                coalesce((
                  select max(history.revision)
                    from metrics.quote_classification_overrides history
                   where history.quote_id = $1
                     and history.outcome in ('excluded', 'manual_reinstated')
                ), 0) + 1,
                $6, $2 = 'exclude',
                case when $2 = 'reinstate' then now() else null end
           from target t
          where not exists (select 1 from idempotent)
            and (
              ($2 = 'exclude' and $3 = 0 and not exists (select 1 from current_exclusion))
              or (
                $2 = 'reinstate'
                and exists (select 1 from current_exclusion c where c.revision = $3)
                and exists (select 1 from superseded)
              )
            )
         returning *
       ), projected as materialized (
         select i.*,
                case when i.action = 'exclude' then 'excluded' else t.source_outcome end as projected_outcome,
                case when i.action = 'exclude' then 'manual_excluded' else t.source_reason end as projected_reason,
                t.outcome as canonical_before_outcome,
                t.date_approved,
                t.total
           from inserted i
           join target t using (quote_id)
       ), canonical_updated as (
         update metrics.metrics_quotes q
            set outcome = p.projected_outcome,
                outcome_reason = p.projected_reason,
                won_reason = p.projected_reason,
                updated_from_source_at = now()
           from projected p
          where q.quote_id = p.quote_id
         returning q.quote_id
       ), snapshot_updated as (
         update metrics.quote_snapshots s
            set won = p.projected_outcome = 'won',
                won_value = case when p.projected_outcome = 'won' then p.total else 0 end,
                win_loss_reason = p.projected_reason,
                updated_at = now()
           from projected p
          where s.quote_id = p.quote_id
         returning s.quote_id
       ), audit_written as (
         insert into metrics.audit_events (
           actor_email, action, entity_type, entity_id, before_value, after_value, reason
         )
         select p.actor_email,
                case when p.action = 'exclude' then 'quote_excluded' else 'quote_reinstated' end,
                'quote_classification_override', p.quote_id::text,
                jsonb_build_object(
                  'outcome', p.canonical_before_outcome,
                  'active_exclusion_revision', case when p.action = 'reinstate' then $3 else 0 end
                ),
                jsonb_build_object(
                  'action', p.action,
                  'outcome', p.projected_outcome,
                  'reason_code', p.projected_reason,
                  'revision', p.revision,
                  'override_id', p.id,
                  'evidence_url', p.evidence_url,
                  'idempotency_key', p.idempotency_key
                ),
                p.reason
           from projected p
         returning id
       ), affected_periods as materialized (
         select distinct period_start
           from (
             select date_trunc('month', p.date_approved)::date as period_start
               from projected p
              where p.date_approved is not null
             union all
             select date_trunc('month', $8::date)::date
              where $8::date is not null
           ) periods
          where period_start >= date '2023-01-01'
            and period_start <= date_trunc('month', now() at time zone 'America/Los_Angeles')::date
       ), rollup_requested as (
         insert into metrics.rollup_rebuild_queue (
           metric_family, period_grain, period_start, dimensions_json, reason, idempotency_key
         )
         select 'quotes', 'month', period.period_start, '{}'::jsonb,
                'quote_' || p.action,
                'quote:' || p.quote_id || ':' || p.action || ':revision:' || p.revision || ':quotes:' || period.period_start
           from projected p
           cross join affected_periods period
         on conflict (idempotency_key) do nothing
         returning id
       ), selected as (
         select i.id, i.quote_id, i.action::text as action, i.outcome, i.previous_outcome,
                i.reason, i.evidence_url, i.actor_email, i.revision, i.active,
                i.created_at, i.superseded_at, true as request_matches
           from inserted i
         union all
         select i.id, i.quote_id, i.action::text as action, i.outcome, i.previous_outcome,
                i.reason, i.evidence_url, i.actor_email, i.revision, i.active,
                i.created_at, i.superseded_at, i.request_matches
           from idempotent i
          where not exists (select 1 from inserted)
       )
       select exists (select 1 from target) as quote_found,
              coalesce((select revision from current_exclusion), 0) as current_revision,
              s.id, s.quote_id, s.action, s.outcome, s.previous_outcome, s.reason,
              s.evidence_url, s.actor_email, s.revision, s.active, s.created_at::text,
              s.superseded_at::text,
              coalesce(s.request_matches, not exists (select 1 from idempotent), false) as idempotent_match
         from (select 1) seed
         left join selected s on true
        limit 1`,
      [
        params.quoteId,
        params.action,
        params.expectedActiveExclusionRevision,
        params.reason.trim(),
        params.evidenceUrl ?? null,
        params.idempotencyKey,
        params.actorEmail.trim().toLowerCase(),
        params.previousDateApproved ?? null,
        QUOTE_CLASSIFICATION_LOCK_KEY,
      ],
    );
  } catch (error) {
    if (isUniqueViolation(error)) throw new QuoteOverrideIdempotencyConflictError();
    throw error;
  }

  const row = result.rows[0];
  if (!row?.quote_found) {
    throw new Error(`Quote ${params.quoteId} does not exist in the canonical metrics store.`);
  }
  if (row.idempotent_match !== true) throw new QuoteOverrideIdempotencyConflictError();
  if (!row.id) {
    const currentRevision = Number(row.current_revision);
    throw new QuoteOverrideConflictError(
      params.expectedActiveExclusionRevision,
      Number.isSafeInteger(currentRevision) && currentRevision >= 0 ? currentRevision : 0,
    );
  }

  const record = mapOverrideRecord(row);
  if (!matchesRequestedAction(record, params)) throw new QuoteOverrideIdempotencyConflictError();
  return record;
}

export async function getQuoteOverrideHistory(
  quoteId: number,
  query: QuoteOverrideQuery = queryPostgres,
): Promise<QuoteOverrideRecord[]> {
  const result = await query<HistoryRow>(
    `select id::text, quote_id::text, action::text, outcome, previous_outcome, reason,
            evidence_url, actor_email, revision::text, active, created_at::text,
            superseded_at::text
       from metrics.quote_classification_overrides
      where quote_id = $1
        and outcome in ('won', 'lost', 'excluded', 'manual_reinstated')
      order by revision desc, created_at desc, id desc`,
    [quoteId],
  );
  return result.rows.map(mapOverrideRecord);
}

export function currentActiveExclusionRevision(
  history: ReadonlyArray<Pick<QuoteOverrideRecord, "outcome" | "active" | "revision">>,
): number {
  return history.reduce(
    (current, record) => record.active && record.outcome === "excluded" ? Math.max(current, record.revision) : current,
    0,
  );
}

function validateQuoteOverrideAction(params: {
  quoteId: number;
  action: unknown;
  expectedActiveExclusionRevision: number;
  idempotencyKey: string;
  reason: string;
  evidenceUrl?: string | null;
  actorEmail: string;
}) {
  if (!Number.isSafeInteger(params.quoteId) || params.quoteId <= 0) throw new Error("quoteId must be a positive integer.");
  if (!quoteOverrideActions.includes(params.action as QuoteOverrideAction)) {
    throw new Error("action must be exclude or reinstate.");
  }
  if (!Number.isSafeInteger(params.expectedActiveExclusionRevision) || params.expectedActiveExclusionRevision < 0) {
    throw new Error("expectedActiveExclusionRevision must be a non-negative integer.");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(params.idempotencyKey)) {
    throw new Error("idempotencyKey must be 8 to 200 URL-safe characters.");
  }
  const reason = params.reason.trim();
  if (reason.length < 5 || reason.length > 1000) throw new Error("reason must be between 5 and 1000 characters.");
  if (params.evidenceUrl !== undefined && params.evidenceUrl !== null) {
    if (params.evidenceUrl.length > 2000 || !isHttpUrl(params.evidenceUrl)) {
      throw new Error("evidenceUrl must be an http(s) URL when supplied.");
    }
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(params.actorEmail.trim())) {
    throw new Error("actorEmail must be a valid email address.");
  }
}

function mapOverrideRecord(row: HistoryRow | PersistResultRow): QuoteOverrideRecord {
  if (!row.id || !row.quote_id || !row.outcome || !row.previous_outcome || !row.reason || !row.actor_email || !row.revision || !row.created_at) {
    throw new Error("The quote override store returned an incomplete audit record.");
  }
  return {
    id: Number(row.id),
    quoteId: Number(row.quote_id),
    action: row.action,
    outcome: row.outcome,
    previousOutcome: row.previous_outcome,
    reason: row.reason,
    evidenceUrl: row.evidence_url,
    actorEmail: row.actor_email,
    revision: Number(row.revision),
    active: Boolean(row.active),
    createdAt: row.created_at,
    supersededAt: row.superseded_at,
  };
}

function matchesRequestedAction(
  record: QuoteOverrideRecord,
  params: {
    quoteId: number;
    action: QuoteOverrideAction;
    expectedActiveExclusionRevision: number;
  },
) {
  if (record.quoteId !== params.quoteId || record.action !== params.action) return false;
  if (!Number.isSafeInteger(record.revision) || record.revision <= 0) return false;
  if (params.action === "exclude") {
    return record.outcome === "excluded"
      && record.previousOutcome !== "excluded"
      && params.expectedActiveExclusionRevision === 0;
  }
  return record.outcome === "manual_reinstated"
    && record.previousOutcome === "excluded"
    && !record.active
    && record.revision === params.expectedActiveExclusionRevision + 1;
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isUniqueViolation(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "23505");
}
