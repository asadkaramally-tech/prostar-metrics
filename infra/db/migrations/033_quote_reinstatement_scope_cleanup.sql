create schema if not exists metrics;

do $$
begin
  create type metrics.quote_override_action as enum ('exclude', 'reinstate');
exception
  when duplicate_object then null;
end $$;

alter table metrics.quote_classification_overrides
  add column if not exists action metrics.quote_override_action;

-- Migration 017 remains immutable history. Only its reviewed exclusion set can
-- remain effective when this cleanup runs; legacy won/lost decisions never do.
update metrics.quote_classification_overrides
   set action = 'exclude'::metrics.quote_override_action
 where outcome = 'excluded'
   and action is null;

with ranked as (
  select o.id,
         row_number() over (
           partition by o.quote_id
           order by o.revision desc, o.created_at desc, o.id desc
         ) as active_rank
    from metrics.quote_classification_overrides o
   where o.active
     and o.outcome = 'excluded'
     and o.quote_id in (470, 757, 762, 768, 1867)
), deactivated as (
  update metrics.quote_classification_overrides o
     set active = false,
         superseded_at = coalesce(o.superseded_at, now())
   where o.active
     and (
       o.outcome is distinct from 'excluded'
       or o.quote_id not in (470, 757, 762, 768, 1867)
       or coalesce((select r.active_rank from ranked r where r.id = o.id), 2) > 1
     )
  returning o.id, o.quote_id, o.outcome, o.revision, o.idempotency_key, o.superseded_at
)
insert into metrics.audit_events (
  actor_email, action, entity_type, entity_id, before_value, after_value, reason
)
select 'migration-033@prostarmechanical.com',
       'quote_override_deactivated',
       'quote_classification_override',
       d.id::text,
       jsonb_build_object(
         'quote_id', d.quote_id,
         'outcome', d.outcome,
         'revision', d.revision,
         'active', true,
         'idempotency_key', d.idempotency_key
       ),
       jsonb_build_object(
         'quote_id', d.quote_id,
         'outcome', d.outcome,
         'revision', d.revision,
         'active', false,
         'superseded_at', d.superseded_at,
         'provenance', '033_quote_reinstatement_scope_cleanup'
       ),
       'Legacy outcome overrides are immutable history; only reviewed exclusions remain effective.'
  from deactivated d;

drop index if exists metrics.quote_override_active_exclusion_idx;
create unique index quote_override_active_exclusion_idx
  on metrics.quote_classification_overrides (quote_id)
  where active and outcome = 'excluded';

alter table metrics.quote_classification_overrides
  drop constraint if exists quote_override_action_outcome_check;
alter table metrics.quote_classification_overrides
  add constraint quote_override_action_outcome_check check (
    (action is null and (outcome is null or outcome in ('won', 'lost')))
    or (action = 'exclude' and outcome = 'excluded')
    or (action = 'reinstate' and outcome = 'manual_reinstated')
  );

alter table metrics.quote_classification_overrides
  drop constraint if exists quote_override_active_exclusion_check;
alter table metrics.quote_classification_overrides
  add constraint quote_override_active_exclusion_check check (
    not active or (action = 'exclude' and outcome = 'excluded')
  );

create temporary table quote_scope_cleanup_projection on commit drop as
with source_evidence as (
  select q.quote_id,
         q.date_approved,
         q.date_issued,
         q.total,
         q.outcome as old_outcome,
         q.outcome_reason as old_reason,
         lower(trim(coalesce(q.status_name, ''))) = 'quote accepted online' as accepted_online,
         (
           exists (
             select 1
               from metrics.metrics_jobs direct_job
              where direct_job.job_id = q.linked_job_id
                and direct_job.source_deleted_at is null
           )
           or exists (
             select 1
               from metrics.metrics_jobs numbered_job
              where q.job_no ~ '^[1-9][0-9]*$'
                and numbered_job.job_no = q.job_no
                and numbered_job.source_deleted_at is null
           )
           or exists (
             select 1
               from metrics.metrics_jobs inverse_job
              where lower(trim(coalesce(inverse_job.converted_from_type, ''))) = 'quote'
                and inverse_job.converted_from_id = q.quote_id
                and inverse_job.source_deleted_at is null
           )
         ) as converted,
         exists (
           select 1
             from metrics.quote_classification_overrides exclusion
            where exclusion.quote_id = q.quote_id
              and exclusion.active
              and exclusion.action = 'exclude'
              and exclusion.outcome = 'excluded'
         ) as excluded
    from metrics.metrics_quotes q
   where q.source_deleted_at is null
), classified as (
  select source.*,
         case
           when source.excluded then 'excluded'
           when source.accepted_online or source.converted then 'won'
           else 'lost'
         end as new_outcome,
         case
           when source.excluded then 'manual_excluded'
           when source.accepted_online and source.converted then 'accepted_online_and_converted'
           when source.accepted_online then 'accepted_online'
           when source.converted then 'converted_job'
           else 'no_acceptance_evidence'
         end as new_reason
    from source_evidence source
)
select classified.*,
       snapshot.won as old_snapshot_won,
       snapshot.won_value as old_snapshot_won_value,
       snapshot.win_loss_reason as old_snapshot_reason,
       snapshot.quote_id is not null as has_snapshot
  from classified
  left join metrics.quote_snapshots snapshot using (quote_id);

update metrics.metrics_quotes q
   set outcome = projection.new_outcome,
       outcome_reason = projection.new_reason,
       won_reason = projection.new_reason,
       updated_from_source_at = now()
  from quote_scope_cleanup_projection projection
 where q.quote_id = projection.quote_id
   and (
     q.outcome is distinct from projection.new_outcome
     or q.outcome_reason is distinct from projection.new_reason
     or q.won_reason is distinct from projection.new_reason
   );

update metrics.quote_snapshots snapshot
   set won = projection.new_outcome = 'won',
       won_value = case when projection.new_outcome = 'won' then coalesce(projection.total, 0) else 0 end,
       win_loss_reason = projection.new_reason,
       updated_at = now()
  from quote_scope_cleanup_projection projection
 where snapshot.quote_id = projection.quote_id
   and (
     snapshot.won is distinct from (projection.new_outcome = 'won')
     or snapshot.won_value is distinct from (
       case when projection.new_outcome = 'won' then coalesce(projection.total, 0) else 0 end
     )
     or snapshot.win_loss_reason is distinct from projection.new_reason
   );

insert into metrics.audit_events (
  actor_email, action, entity_type, entity_id, before_value, after_value, reason
)
select 'migration-033@prostarmechanical.com',
       'quote_source_classification_repaired',
       'quote',
       projection.quote_id::text,
       jsonb_build_object(
         'canonical_outcome', projection.old_outcome,
         'canonical_reason', projection.old_reason,
         'snapshot_won', projection.old_snapshot_won,
         'snapshot_won_value', projection.old_snapshot_won_value,
         'snapshot_reason', projection.old_snapshot_reason
       ),
       jsonb_build_object(
         'outcome', projection.new_outcome,
         'reason_code', projection.new_reason,
         'classification_authority', 'source_evidence_plus_active_exclusion',
         'source_paths', jsonb_build_array(
           'accepted_online_status',
           'linked_job_id',
           'exact_numeric_job_no',
           'inverse_converted_from_quote'
         ),
         'provenance', '033_quote_reinstatement_scope_cleanup'
       ),
       'Canonical and snapshot quote outcomes repaired without legacy won/lost override authority.'
  from quote_scope_cleanup_projection projection
 where projection.old_outcome is distinct from projection.new_outcome
    or projection.old_reason is distinct from projection.new_reason
    or (
      projection.has_snapshot
      and (
        projection.old_snapshot_won is distinct from (projection.new_outcome = 'won')
        or projection.old_snapshot_won_value is distinct from (
          case when projection.new_outcome = 'won' then coalesce(projection.total, 0) else 0 end
        )
        or projection.old_snapshot_reason is distinct from projection.new_reason
      )
    );

insert into metrics.rollup_rebuild_queue (
  metric_family, period_grain, period_start, dimensions_json, reason, idempotency_key
)
select 'quotes',
       'month',
       date_trunc('month', coalesce(projection.date_approved, projection.date_issued))::date,
       '{}'::jsonb,
       'quote_reinstatement_scope_cleanup',
       'migration-033:quote:' || projection.quote_id || ':'
         || date_trunc('month', coalesce(projection.date_approved, projection.date_issued))::date
  from quote_scope_cleanup_projection projection
 where coalesce(projection.date_approved, projection.date_issued) is not null
   and date_trunc('month', coalesce(projection.date_approved, projection.date_issued))::date >= date '2023-01-01'
   and date_trunc('month', coalesce(projection.date_approved, projection.date_issued))::date
         <= date_trunc('month', now() at time zone 'America/Los_Angeles')::date
   and (
     projection.old_outcome is distinct from projection.new_outcome
     or projection.old_reason is distinct from projection.new_reason
     or (
       projection.has_snapshot
       and (
         projection.old_snapshot_won is distinct from (projection.new_outcome = 'won')
         or projection.old_snapshot_won_value is distinct from (
           case when projection.new_outcome = 'won' then coalesce(projection.total, 0) else 0 end
         )
         or projection.old_snapshot_reason is distinct from projection.new_reason
       )
     )
   )
on conflict (idempotency_key) do nothing;

-- Release any capacity held by retired invoice backfills before preserving the
-- ledger rows as cancelled, non-required historical records.
with released as (
  select reserved_capacity_date, sum(reserved_requests)::integer as reserved_requests
    from metrics.backfill_source_month_ledger
   where source_family = 'invoices'
     and reserved_capacity_date is not null
   group by reserved_capacity_date
)
update metrics.backfill_capacity_days capacity
   set backfill_reserved_requests = greatest(
         0,
         capacity.backfill_reserved_requests - released.reserved_requests
       ),
       updated_at = now()
  from released
 where capacity.capacity_date = released.reserved_capacity_date;

with cancelled as (
  update metrics.backfill_source_month_ledger ledger
     set status = 'cancelled',
         required_for_completion = false,
         depends_on = array_remove(ledger.depends_on, 'invoices'),
         continuation_token = null,
         locked_by = null,
         locked_at = null,
         lease_expires_at = null,
         heartbeat_at = null,
         reserved_capacity_date = null,
         reserved_requests = 0,
         last_error = 'Invoice ingestion retired by migration 033',
         completed_at = null,
         updated_at = now()
   where ledger.source_family = 'invoices'
     and (
       ledger.status <> 'cancelled'
       or ledger.required_for_completion
       or ledger.reserved_requests <> 0
       or ledger.depends_on @> array['invoices']::text[]
     )
  returning ledger.id, ledger.month_start
)
insert into metrics.audit_events (
  actor_email, action, entity_type, entity_id, before_value, after_value, reason
)
select 'migration-033@prostarmechanical.com',
       'invoice_backfill_cancelled',
       'backfill_source_month_ledger',
       cancelled.id::text,
       jsonb_build_object('source_family', 'invoices', 'month_start', cancelled.month_start),
       jsonb_build_object(
         'status', 'cancelled',
         'required_for_completion', false,
         'provenance', '033_quote_reinstatement_scope_cleanup'
       ),
       'Owner reporting has no Simpro invoice dependency.'
  from cancelled;

update metrics.backfill_source_month_ledger
   set depends_on = array_remove(depends_on, 'invoices'),
       updated_at = now()
 where source_family <> 'invoices'
   and depends_on @> array['invoices']::text[];

update metrics.ingestion_runs
   set status = 'cancelled'::metrics.ingestion_job_status,
       finished_at = coalesce(finished_at, now()),
       error_message = coalesce(error_message, 'Invoice ingestion retired by migration 033')
 where entity_type::text in ('invoices', 'customer_invoice_logs')
   and status in ('queued', 'running');

with cancelled as (
  update metrics.ingestion_jobs job
     set status = 'cancelled'::metrics.ingestion_job_status,
         locked_by = null,
         locked_at = null,
         lock_expires_at = null,
         heartbeat_at = null,
         continuation_token = null,
         page_cursor = null,
         last_error = 'Invoice ingestion retired by migration 033',
         updated_at = now()
   where job.entity_type::text in ('invoices', 'customer_invoice_logs')
     and job.status in ('queued', 'running', 'failed')
  returning job.id, job.entity_type::text as entity_type, job.idempotency_key
)
insert into metrics.audit_events (
  actor_email, action, entity_type, entity_id, before_value, after_value, reason
)
select 'migration-033@prostarmechanical.com',
       'invoice_ingestion_cancelled',
       'ingestion_job',
       cancelled.id::text,
       jsonb_build_object(
         'entity_type', cancelled.entity_type,
         'idempotency_key', cancelled.idempotency_key
       ),
       jsonb_build_object(
         'status', 'cancelled',
         'provenance', '033_quote_reinstatement_scope_cleanup'
       ),
       'Owner reporting has no Simpro invoice dependency.'
  from cancelled;

-- Prior-image workers may still enqueue or reclaim invoice rows during a
-- candidate/rollback window. Preserve SQL write compatibility while making
-- every such row immediately non-runnable.
create or replace function metrics.quarantine_retired_invoice_ingestion_job()
returns trigger
language plpgsql
as $$
begin
  if new.entity_type::text in ('invoices', 'customer_invoice_logs')
     and (tg_op = 'INSERT' or new.status in ('queued', 'running')) then
    new.status := 'cancelled'::metrics.ingestion_job_status;
    new.locked_by := null;
    new.locked_at := null;
    new.lock_expires_at := null;
    new.heartbeat_at := null;
    new.continuation_token := null;
    new.page_cursor := null;
    new.last_error := 'Invoice ingestion retired by migration 033';
    new.updated_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists reject_retired_invoice_ingestion_job
  on metrics.ingestion_jobs;
drop function if exists metrics.reject_retired_invoice_ingestion_job();
drop trigger if exists quarantine_retired_invoice_ingestion_job
  on metrics.ingestion_jobs;
create trigger quarantine_retired_invoice_ingestion_job
before insert or update of entity_type, status on metrics.ingestion_jobs
for each row execute function metrics.quarantine_retired_invoice_ingestion_job();

create or replace function metrics.quarantine_retired_invoice_backfill()
returns trigger
language plpgsql
as $$
begin
  if new.source_family = 'invoices'
     and (tg_op = 'INSERT' or new.status in ('planned', 'queued', 'running', 'reconciliation_pending')) then
    new.status := 'cancelled';
    new.required_for_completion := false;
    new.depends_on := array_remove(new.depends_on, 'invoices');
    new.continuation_token := null;
    new.locked_by := null;
    new.locked_at := null;
    new.lease_expires_at := null;
    new.heartbeat_at := null;
    new.reserved_capacity_date := null;
    new.reserved_requests := 0;
    new.last_error := 'Invoice ingestion retired by migration 033';
    new.completed_at := null;
    new.updated_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists reject_retired_invoice_backfill
  on metrics.backfill_source_month_ledger;
drop function if exists metrics.reject_retired_invoice_backfill();
drop trigger if exists quarantine_retired_invoice_backfill
  on metrics.backfill_source_month_ledger;
create trigger quarantine_retired_invoice_backfill
before insert or update of source_family, status on metrics.backfill_source_month_ledger
for each row execute function metrics.quarantine_retired_invoice_backfill();

insert into metrics.audit_events (
  actor_email, action, entity_type, entity_id, before_value, after_value, reason
)
select 'migration-033@prostarmechanical.com',
       'quote_reinstatement_scope_cleanup_completed',
       'database_migration',
       '033_quote_reinstatement_scope_cleanup',
       null,
       jsonb_build_object(
         'legacy_outcomes_effective', false,
         'reviewed_active_exclusion_quote_ids', jsonb_build_array(470, 757, 762, 768, 1867),
         'classification_authority', 'source_evidence_plus_active_exclusion',
         'invoice_ingestion', 'retired',
         'provenance', '033_quote_reinstatement_scope_cleanup'
       ),
       'Q-18/Q-23 and F-04/F-18 additive scope cleanup.'
 where not exists (
   select 1
     from metrics.audit_events existing
    where existing.action = 'quote_reinstatement_scope_cleanup_completed'
      and existing.entity_type = 'database_migration'
      and existing.entity_id = '033_quote_reinstatement_scope_cleanup'
 );
