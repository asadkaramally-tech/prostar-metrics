create schema if not exists metrics;

create table if not exists metrics.reviewed_quote_exclusion_seeds (
  quote_id bigint primary key,
  reason text not null,
  actor_email text not null,
  reviewed_on date not null,
  evidence_sha256 text not null check (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  idempotency_key text not null unique,
  enabled boolean not null default true,
  reinstated_at timestamptz,
  reinstated_by text,
  provenance jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (enabled or reinstated_at is not null)
);

insert into metrics.reviewed_quote_exclusion_seeds (
  quote_id, reason, actor_email, reviewed_on, evidence_sha256,
  idempotency_key, provenance
)
values
  (470, 'Sample quote excluded from all quote reporting; reviewed 2026-03-06 in Quote_Manual_Review.xlsx (SHA-256 151ed4a3c6b186f6aaa6a26e4219b23163d8d0a91b5f40b22386c17f0585fa06)',
    'asad@prostarmechanical.com', date '2026-03-06', '151ed4a3c6b186f6aaa6a26e4219b23163d8d0a91b5f40b22386c17f0585fa06',
    'reviewed-quote-exclusion-seed-2026-03-06:470', jsonb_build_object('source', 'Quote_Manual_Review.xlsx', 'migration', '034_reviewed_quote_exclusion_registry')),
  (757, 'Blank-name quote excluded from all quote reporting; reviewed 2026-03-06 in Quote_Manual_Review.xlsx (SHA-256 151ed4a3c6b186f6aaa6a26e4219b23163d8d0a91b5f40b22386c17f0585fa06)',
    'asad@prostarmechanical.com', date '2026-03-06', '151ed4a3c6b186f6aaa6a26e4219b23163d8d0a91b5f40b22386c17f0585fa06',
    'reviewed-quote-exclusion-seed-2026-03-06:757', jsonb_build_object('source', 'Quote_Manual_Review.xlsx', 'migration', '034_reviewed_quote_exclusion_registry')),
  (762, 'Blank-name quote excluded from all quote reporting; reviewed 2026-03-06 in Quote_Manual_Review.xlsx (SHA-256 151ed4a3c6b186f6aaa6a26e4219b23163d8d0a91b5f40b22386c17f0585fa06)',
    'asad@prostarmechanical.com', date '2026-03-06', '151ed4a3c6b186f6aaa6a26e4219b23163d8d0a91b5f40b22386c17f0585fa06',
    'reviewed-quote-exclusion-seed-2026-03-06:762', jsonb_build_object('source', 'Quote_Manual_Review.xlsx', 'migration', '034_reviewed_quote_exclusion_registry')),
  (768, 'Simpro test quote excluded from all quote reporting; reviewed 2026-03-06 in Quote_Manual_Review.xlsx (SHA-256 151ed4a3c6b186f6aaa6a26e4219b23163d8d0a91b5f40b22386c17f0585fa06)',
    'asad@prostarmechanical.com', date '2026-03-06', '151ed4a3c6b186f6aaa6a26e4219b23163d8d0a91b5f40b22386c17f0585fa06',
    'reviewed-quote-exclusion-seed-2026-03-06:768', jsonb_build_object('source', 'Quote_Manual_Review.xlsx', 'migration', '034_reviewed_quote_exclusion_registry')),
  (1867, 'Blank-name quote excluded from all quote reporting; reviewed 2026-03-06 in Quote_Manual_Review.xlsx (SHA-256 151ed4a3c6b186f6aaa6a26e4219b23163d8d0a91b5f40b22386c17f0585fa06)',
    'asad@prostarmechanical.com', date '2026-03-06', '151ed4a3c6b186f6aaa6a26e4219b23163d8d0a91b5f40b22386c17f0585fa06',
    'reviewed-quote-exclusion-seed-2026-03-06:1867', jsonb_build_object('source', 'Quote_Manual_Review.xlsx', 'migration', '034_reviewed_quote_exclusion_registry'))
on conflict (quote_id) do update set
  reason = excluded.reason,
  actor_email = excluded.actor_email,
  reviewed_on = excluded.reviewed_on,
  evidence_sha256 = excluded.evidence_sha256,
  idempotency_key = excluded.idempotency_key,
  provenance = excluded.provenance,
  updated_at = now();

create or replace function metrics.disable_reviewed_quote_exclusion_seed_on_reinstatement()
returns trigger
language plpgsql
as $$
begin
  if new.action = 'reinstate' and new.outcome = 'manual_reinstated' then
    update metrics.reviewed_quote_exclusion_seeds seed
       set enabled = false,
           reinstated_at = coalesce(seed.reinstated_at, new.created_at),
           reinstated_by = coalesce(seed.reinstated_by, new.actor_email),
           updated_at = now()
     where seed.quote_id = new.quote_id
       and seed.enabled;
  end if;
  return new;
end;
$$;

drop trigger if exists disable_reviewed_quote_exclusion_seed_on_reinstatement
  on metrics.quote_classification_overrides;
create trigger disable_reviewed_quote_exclusion_seed_on_reinstatement
after insert on metrics.quote_classification_overrides
for each row execute function metrics.disable_reviewed_quote_exclusion_seed_on_reinstatement();

-- An explicit reinstatement is permanent policy: migration replay or later
-- source arrival must never reactivate the reviewed exclusion automatically.
update metrics.reviewed_quote_exclusion_seeds seed
   set enabled = false,
       reinstated_at = coalesce(seed.reinstated_at, (
         select o.created_at
           from metrics.quote_classification_overrides o
          where o.quote_id = seed.quote_id
            and o.action = 'reinstate'
            and o.outcome = 'manual_reinstated'
          order by o.revision desc, o.created_at desc, o.id desc
          limit 1
       )),
       reinstated_by = coalesce(seed.reinstated_by, (
         select o.actor_email
           from metrics.quote_classification_overrides o
          where o.quote_id = seed.quote_id
            and o.action = 'reinstate'
            and o.outcome = 'manual_reinstated'
          order by o.revision desc, o.created_at desc, o.id desc
          limit 1
       )),
       updated_at = now()
 where seed.enabled
   and exists (
     select 1 from metrics.quote_classification_overrides o
      where o.quote_id = seed.quote_id
        and o.action = 'reinstate'
        and o.outcome = 'manual_reinstated'
   );

create or replace function metrics.apply_reviewed_quote_exclusion_seeds(p_quote_ids bigint[])
returns table(applied_count integer)
language sql
as $function$
  with classification_lock as materialized (
    select pg_advisory_xact_lock(716630417::bigint)
  ), targets as materialized (
    select q.quote_id, q.category, q.date_approved, q.date_issued, q.total,
           seed.reason, seed.actor_email, seed.reviewed_on,
           seed.evidence_sha256, seed.idempotency_key, seed.provenance,
           case
             when lower(trim(coalesce(q.status_name, ''))) = 'quote accepted online'
               or exists (
                 select 1 from metrics.metrics_jobs j
                  where j.source_deleted_at is null
                    and (
                      j.job_id = q.linked_job_id
                      or (q.job_no ~ '^[1-9][0-9]*$' and j.job_no = q.job_no)
                      or (lower(trim(j.converted_from_type)) = 'quote' and j.converted_from_id = q.quote_id)
                    )
               ) then 'won'
             else 'lost'
           end as source_outcome
      from metrics.reviewed_quote_exclusion_seeds seed
      join metrics.metrics_quotes q using (quote_id)
      cross join classification_lock
     where seed.enabled
       and q.source_deleted_at is null
       and q.quote_id = any(p_quote_ids)
     order by q.quote_id
     for update of q
  ), inserted as (
    insert into metrics.quote_classification_overrides (
      quote_id, category, won_override, action, outcome, previous_outcome,
      reason, evidence_url, actor_email, revision, idempotency_key, active
    )
    select target.quote_id, coalesce(target.category, 'Unclassified'), null,
           'exclude'::metrics.quote_override_action, 'excluded', target.source_outcome,
           target.reason, null, target.actor_email,
           coalesce((
             select max(history.revision)
               from metrics.quote_classification_overrides history
              where history.quote_id = target.quote_id
                and history.outcome in ('excluded', 'manual_reinstated')
           ), 0) + 1,
           target.idempotency_key, true
      from targets target
     where not exists (
       select 1 from metrics.quote_classification_overrides active_override
        where active_override.quote_id = target.quote_id and active_override.active
     )
       and not exists (
         select 1 from metrics.quote_classification_overrides prior_seed
          where prior_seed.idempotency_key = target.idempotency_key
       )
    returning *
  ), canonical_updated as (
    update metrics.metrics_quotes q
       set outcome = 'excluded',
           outcome_reason = 'manual_excluded',
           won_reason = 'manual_excluded',
           updated_from_source_at = now()
      from inserted
     where q.quote_id = inserted.quote_id
    returning q.quote_id, q.date_approved, q.date_issued, q.total
  ), snapshot_updated as (
    update metrics.quote_snapshots snapshot
       set won = false,
           won_value = 0,
           win_loss_reason = 'manual_excluded',
           updated_at = now()
      from inserted
     where snapshot.quote_id = inserted.quote_id
    returning snapshot.quote_id
  ), audit_written as (
    insert into metrics.audit_events (
      actor_email, action, entity_type, entity_id, before_value, after_value, reason
    )
    select inserted.actor_email, 'reviewed_quote_exclusion_seed_applied',
           'quote_classification_override', inserted.quote_id::text,
           jsonb_build_object(
             'source_outcome', inserted.previous_outcome,
             'active_exclusion_revision', 0
           ),
           jsonb_build_object(
             'action', 'exclude',
             'outcome', 'excluded',
             'reason_code', 'manual_excluded',
             'revision', inserted.revision,
             'override_id', inserted.id,
             'idempotency_key', inserted.idempotency_key,
             'reviewed_on', target.reviewed_on,
             'evidence_sha256', target.evidence_sha256,
             'registry_provenance', target.provenance,
             'provenance', '034_reviewed_quote_exclusion_registry'
           ),
           inserted.reason
      from inserted
      join targets target using (quote_id)
    returning id
  ), rollup_requested as (
    insert into metrics.rollup_rebuild_queue (
      metric_family, period_grain, period_start, dimensions_json, reason, idempotency_key
    )
    select 'quotes', 'month', date_trunc('month', coalesce(q.date_approved, q.date_issued))::date,
           '{}'::jsonb, 'reviewed_quote_exclusion_seed',
           inserted.idempotency_key || ':quotes:'
             || date_trunc('month', coalesce(q.date_approved, q.date_issued))::date
      from inserted
      join metrics.metrics_quotes q using (quote_id)
     where coalesce(q.date_approved, q.date_issued) is not null
       and date_trunc('month', coalesce(q.date_approved, q.date_issued))::date >= date '2023-01-01'
       and date_trunc('month', coalesce(q.date_approved, q.date_issued))::date
             <= date_trunc('month', now() at time zone 'America/Los_Angeles')::date
    on conflict (idempotency_key) do nothing
    returning id
  )
  select count(*)::integer from inserted
  where (select count(*) from canonical_updated) >= 0
    and (select count(*) from snapshot_updated) >= 0
    and (select count(*) from audit_written) >= 0
    and (select count(*) from rollup_requested) >= 0;
$function$;

select applied_count
  from metrics.apply_reviewed_quote_exclusion_seeds(array[470, 757, 762, 768, 1867]::bigint[]);

insert into metrics.audit_events (
  actor_email, action, entity_type, entity_id, before_value, after_value, reason
)
select 'migration-034@prostarmechanical.com',
       'reviewed_quote_exclusion_registry_created',
       'database_migration',
       '034_reviewed_quote_exclusion_registry',
       null,
       jsonb_build_object(
         'quote_ids', jsonb_build_array(470, 757, 762, 768, 1867),
         'arrival_policy', 'apply_enabled_exclusion_when_source_quote_exists',
         'owner_reinstatement_disables_seed', true,
         'legacy_won_lost_seeded', false,
         'provenance', '034_reviewed_quote_exclusion_registry'
       ),
       'Durable owner-reviewed exclusions are applied on source arrival without reviving legacy outcomes.'
 where not exists (
   select 1 from metrics.audit_events existing
    where existing.action = 'reviewed_quote_exclusion_registry_created'
      and existing.entity_type = 'database_migration'
      and existing.entity_id = '034_reviewed_quote_exclusion_registry'
 );
