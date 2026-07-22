create schema if not exists metrics;

-- Quote manifests can become authoritative after the broader control-plane
-- repair has already run. Close only the two July quote work units that are
-- still queued and now have exact, generation-fenced source-period proof.
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
     and ledger.source_family in ('quotes', 'quote_nested')
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
           'migration', '052_close_july_quote_backfills_from_source_period_authority',
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
     and ledger.source_family in ('quotes', 'quote_nested')
  returning ledger.id, to_jsonb(ledger) as after_value
)
insert into metrics.audit_events (
  actor_email, action, entity_type, entity_id, before_value, after_value, reason
)
select 'system:migration-052',
       'july_quote_backfill_completed_from_source_period_authority',
       'backfill_source_month_ledger',
       completed.id::text,
       candidates.before_value,
       completed.after_value,
       'Completed a queued July 2026 quotes or quote_nested ledger row from exact complete, matched, generation-fenced source-period authority.'
  from completed
  join candidates on candidates.id = completed.id;
