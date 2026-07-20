create schema if not exists metrics;

with decisions(quote_id, outcome, decision_reason) as (
  values
    (116::bigint, 'won', 'PM/maintenance quote; job created as an independent recurring job'),
    (298, 'won', 'PM/maintenance quote; job created as an independent recurring job'),
    (459, 'won', 'PM/maintenance quote; job created as an independent recurring job'),
    (481, 'won', 'PM/maintenance quote; job created as an independent recurring job'),
    (519, 'won', 'PM/maintenance quote; job created as an independent recurring job'),
    (532, 'won', 'PM/maintenance quote; job created as an independent recurring job'),
    (534, 'won', 'PM/maintenance quote; job created as an independent recurring job'),
    (555, 'won', 'PM/maintenance quote; job created as an independent recurring job'),
    (564, 'won', 'PM/maintenance quote; job created as an independent recurring job'),
    (595, 'won', 'PM/maintenance quote; job created as an independent recurring job'),
    (652, 'won', 'PM/maintenance quote; job created as an independent recurring job'),
    (675, 'won', 'PM/maintenance quote; job created as an independent recurring job'),
    (732, 'won', 'PM/maintenance quote; job created as an independent recurring job'),
    (780, 'won', 'PM/maintenance quote; job created as an independent recurring job'),
    (787, 'won', 'PM/maintenance quote; job created as an independent recurring job'),
    (891, 'won', 'PM/maintenance quote; job created as an independent recurring job'),
    (936, 'won', 'PM/maintenance quote; job created as an independent recurring job'),
    (1029, 'won', 'PM/maintenance quote; job created as an independent recurring job'),
    (1045, 'won', 'PM/maintenance quote; job created as an independent recurring job'),
    (1136, 'won', 'PM/maintenance quote; job created as an independent recurring job'),
    (1209, 'won', 'PM/maintenance quote; job created as an independent recurring job'),
    (1217, 'won', 'PM/maintenance quote; job created as an independent recurring job'),
    (1271, 'won', 'PM/maintenance quote; job created as an independent recurring job'),
    (1287, 'won', 'PM/maintenance quote; job created as an independent recurring job'),
    (1305, 'won', 'PM/maintenance quote; job created as an independent recurring job'),
    (1506, 'won', 'PM/maintenance quote; job created as an independent recurring job'),
    (1521, 'won', 'PM/maintenance quote; job created as an independent recurring job'),
    (1643, 'won', 'PM/maintenance quote; job created as an independent recurring job'),
    (1748, 'won', 'PM/maintenance quote; job created as an independent recurring job'),
    (1771, 'won', 'PM/maintenance quote; job created as an independent recurring job'),
    (1882, 'won', 'PM/maintenance quote; job created as an independent recurring job'),
    (602, 'lost', 'Confirmed loss via email during the reviewed legacy quote workflow'),
    (796, 'lost', 'Confirmed loss via email during the reviewed legacy quote workflow'),
    (797, 'lost', 'Confirmed loss via email during the reviewed legacy quote workflow'),
    (470, 'excluded', 'Sample quote excluded from all quote reporting'),
    (757, 'excluded', 'Blank-name quote excluded from all quote reporting'),
    (762, 'excluded', 'Blank-name quote excluded from all quote reporting'),
    (768, 'excluded', 'Simpro test quote excluded from all quote reporting'),
    (1867, 'excluded', 'Blank-name quote excluded from all quote reporting')
), seed as (
  select d.quote_id,
         d.outcome,
         d.decision_reason || '; reviewed 2026-03-06 in Quote_Manual_Review.xlsx'
           || ' (SHA-256 151ed4a3c6b186f6aaa6a26e4219b23163d8d0a91b5f40b22386c17f0585fa06)' as reason,
         'legacy-quote-review-2026-03-06:' || d.quote_id as idempotency_key
    from decisions d
), inserted as (
  insert into metrics.quote_classification_overrides (
    quote_id, category, won_override, outcome, previous_outcome, reason,
    evidence_url, actor_email, revision, idempotency_key, active
  )
  select q.quote_id,
         coalesce(q.category, 'Unclassified'),
         null,
         s.outcome,
         coalesce(q.outcome, 'unknown'),
         s.reason,
         null,
         'asad@prostarmechanical.com',
         coalesce(revisions.max_revision, 0) + 1,
         s.idempotency_key,
         true
    from seed s
    join metrics.metrics_quotes q on q.quote_id = s.quote_id and q.source_deleted_at is null
    left join lateral (
      select max(revision) as max_revision
        from metrics.quote_classification_overrides history
       where history.quote_id = s.quote_id
    ) revisions on true
   where not exists (
     select 1
       from metrics.quote_classification_overrides active_override
      where active_override.quote_id = s.quote_id and active_override.active = true
   )
     and not exists (
       select 1
         from metrics.quote_classification_overrides prior_seed
        where prior_seed.idempotency_key = s.idempotency_key
     )
  returning *
), canonical_updated as (
  update metrics.metrics_quotes q
     set outcome = i.outcome,
         outcome_reason = 'manual_' || i.outcome,
         won_reason = 'manual_' || i.outcome,
         updated_from_source_at = now()
    from inserted i
   where q.quote_id = i.quote_id
  returning q.quote_id, q.date_approved, q.total, q.outcome
), snapshots_updated as (
  update metrics.quote_snapshots snapshot
     set won = canonical.outcome = 'won',
         won_value = case when canonical.outcome = 'won' then coalesce(canonical.total, 0) else 0 end,
         win_loss_reason = 'manual_' || canonical.outcome,
         updated_at = now()
    from canonical_updated canonical
   where snapshot.quote_id = canonical.quote_id
  returning snapshot.quote_id
), audit_written as (
  insert into metrics.audit_events (
    actor_email, action, entity_type, entity_id, before_value, after_value, reason
  )
  select i.actor_email,
         'quote_review_seeded',
         'quote_classification_override',
         i.quote_id::text,
         jsonb_build_object('outcome', i.previous_outcome, 'revision', i.revision - 1),
         jsonb_build_object(
           'outcome', i.outcome,
           'revision', i.revision,
           'override_id', i.id,
           'reviewed_on', '2026-03-06',
           'evidence_sha256', '151ed4a3c6b186f6aaa6a26e4219b23163d8d0a91b5f40b22386c17f0585fa06'
         ),
         i.reason
    from inserted i
  returning id
), rollup_requested as (
  insert into metrics.rollup_rebuild_queue (
    metric_family, period_grain, period_start, dimensions_json, reason, idempotency_key
  )
  select 'quotes',
         'month',
         date_trunc('month', canonical.date_approved)::date,
         '{}'::jsonb,
         'reviewed_quote_decision_seed',
         'legacy-quote-review-2026-03-06:' || canonical.quote_id || ':quotes'
    from canonical_updated canonical
   where canonical.date_approved is not null
  on conflict (idempotency_key) do nothing
  returning id
)
select
  (select count(*) from inserted) as inserted_overrides,
  (select count(*) from snapshots_updated) as updated_snapshots,
  (select count(*) from audit_written) as audit_events,
  (select count(*) from rollup_requested) as rollup_requests;

