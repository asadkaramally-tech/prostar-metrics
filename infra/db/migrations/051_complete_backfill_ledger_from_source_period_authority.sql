create schema if not exists metrics;

-- A complete, generation-fenced source-period manifest is independently
-- authoritative for the same source family and month. Preserve every existing
-- traversal-manifest rule as the fallback so this only adds a second proof path.
create or replace function metrics.enforce_authoritative_backfill_manifest()
returns trigger
language plpgsql
as $$
declare
  manifest metrics.backfill_traversal_manifests%rowtype;
  source_period_authoritative boolean := false;
  current_pacific_month date := date_trunc('month', now() at time zone 'America/Los_Angeles')::date;
begin
  if new.reconciliation_status = 'matched' or new.status = 'completed' then
    select exists (
      select 1
        from metrics.source_period_manifests source_manifest
       where source_manifest.source_family = new.source_family
         and source_manifest.period_start = new.month_start
         and source_manifest.coverage_status = 'complete'
         and source_manifest.reconciliation_status = 'matched'
         and source_manifest.continuation_token is null
         and source_manifest.manifest_generation is not null
         and source_manifest.reconciliation_generation is not null
         and source_manifest.reconciliation_generation = source_manifest.manifest_generation
         and source_manifest.expected_page_count > 0
         and source_manifest.completed_page_count = source_manifest.expected_page_count
         and source_manifest.reconciled_at is not null
    ) into source_period_authoritative;

    if source_period_authoritative then
      return new;
    end if;

    select * into manifest
      from metrics.backfill_traversal_manifests
     where work_unit_id = new.id;

    if not found then
      raise exception 'work unit % cannot match or complete without an authoritative traversal manifest', new.id;
    end if;

    if new.required_for_completion then
      if new.month_start = current_pacific_month then
        if manifest.manifest_status not in ('completed', 'provisional') then
          raise exception 'current work unit % requires a completed or provisional authoritative manifest', new.id;
        end if;
      elsif manifest.manifest_status <> 'completed' then
        raise exception 'historical work unit % requires a completed authoritative manifest', new.id;
      end if;
    elsif manifest.manifest_status not in ('completed', 'provisional', 'unavailable') then
      raise exception 'optional work unit % lacks authoritative coverage or an explicit unavailable manifest', new.id;
    end if;

    if new.source_family = 'quotes'
       and new.month_start = current_pacific_month
       and (
         coalesce((manifest.open_quote_discovery->>'required')::boolean, false) = false
         or manifest.open_quote_discovery->>'status' <> 'complete'
       ) then
      raise exception 'current quote work unit % lacks authoritative open-quote discovery', new.id;
    end if;
  end if;
  return new;
end
$$;

-- Repair only the stale July control-plane rows whose already-published source
-- manifest satisfies the new proof path. The update and its one-event-per-row
-- audit are a single statement inside the migration transaction.
with candidates as materialized (
  select ledger.id,
         to_jsonb(ledger) as before_value,
         source_manifest.listed_count,
         source_manifest.detail_count,
         source_manifest.normalized_count,
         source_manifest.manifest_generation,
         source_manifest.reconciliation_generation,
         source_manifest.expected_page_count,
         source_manifest.completed_page_count,
         source_manifest.reconciled_at
    from metrics.backfill_source_month_ledger ledger
    join metrics.source_period_manifests source_manifest
      on source_manifest.source_family = ledger.source_family
     and source_manifest.period_start = ledger.month_start
   where ledger.month_start = date '2026-07-01'
     and ledger.source_family <> 'invoices'
     and ledger.status = 'queued'
     and source_manifest.coverage_status = 'complete'
     and source_manifest.reconciliation_status = 'matched'
     and source_manifest.continuation_token is null
     and source_manifest.manifest_generation is not null
     and source_manifest.reconciliation_generation is not null
     and source_manifest.reconciliation_generation = source_manifest.manifest_generation
     and source_manifest.expected_page_count > 0
     and source_manifest.completed_page_count = source_manifest.expected_page_count
     and source_manifest.reconciled_at is not null
   for update of ledger
), completed as (
  update metrics.backfill_source_month_ledger ledger
     set status = 'completed',
         work_phase = 'reconcile',
         reconciliation_status = 'matched',
         reconciled_source_records = candidates.listed_count,
         reconciled_normalized_records = candidates.normalized_count,
         normalized_coverage = case
           when candidates.listed_count = 0 then 100
           else round((candidates.normalized_count::numeric / candidates.listed_count::numeric) * 100, 4)
         end,
         reconciliation_detail = jsonb_build_object(
           'authority', 'source_period_manifest',
           'migration', '051_complete_backfill_ledger_from_source_period_authority',
           'listedCount', candidates.listed_count,
           'detailCount', candidates.detail_count,
           'normalizedCount', candidates.normalized_count,
           'manifestGeneration', candidates.manifest_generation,
           'reconciliationGeneration', candidates.reconciliation_generation,
           'expectedPageCount', candidates.expected_page_count,
           'completedPageCount', candidates.completed_page_count,
           'reconciledAt', candidates.reconciled_at
         ),
         continuation_token = null,
         locked_by = null,
         locked_at = null,
         lease_expires_at = null,
         heartbeat_at = null,
         reserved_capacity_date = null,
         reserved_requests = 0,
         last_error = null,
         dead_lettered_at = null,
         completed_at = now(),
         updated_at = now()
    from candidates
   where ledger.id = candidates.id
     and ledger.status = 'queued'
     and ledger.month_start = date '2026-07-01'
     and ledger.source_family <> 'invoices'
  returning ledger.id, to_jsonb(ledger) as after_value
)
insert into metrics.audit_events (
  actor_email, action, entity_type, entity_id, before_value, after_value, reason
)
select 'system:migration-051',
       'backfill_ledger_completed_from_source_period_authority',
       'backfill_source_month_ledger',
       completed.id::text,
       candidates.before_value,
       completed.after_value,
       'Completed a queued July 2026 non-invoice ledger row from an exact complete, matched, generation-fenced source-period manifest.'
  from completed
  join candidates on candidates.id = completed.id;

comment on function metrics.enforce_authoritative_backfill_manifest() is
  'Allows backfill match/completion from either the exact traversal-manifest rules or a same-family/month complete, matched, generation-fenced source-period manifest.';
