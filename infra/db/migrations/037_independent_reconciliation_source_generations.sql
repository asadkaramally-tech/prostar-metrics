-- Each source family advances independently. The reconciliation generation map
-- fences every family to its own sealed manifest generation.

create or replace view metrics.authoritative_reconciliation_checks as
select distinct on (reconciliation.scope, reconciliation.period_start)
       reconciliation.id, reconciliation.scope, reconciliation.period_start,
       reconciliation.period_end, reconciliation.generation,
       reconciliation.complete_traversal, reconciliation.status,
       reconciliation.source_count, reconciliation.source_value,
       reconciliation.normalized_count, reconciliation.normalized_value,
       reconciliation.rollup_value, reconciliation.snapshot_value,
       reconciliation.upstream_sample_value,
       reconciliation.source_manifest_generations, reconciliation.detail,
       reconciliation.checked_at
  from metrics.reconciliation_checks reconciliation
 where reconciliation.complete_traversal
   and reconciliation.generation is not null
   and reconciliation.generation > 0
   and jsonb_typeof(reconciliation.source_manifest_generations) = 'object'
   and reconciliation.source_manifest_generations <> '{}'::jsonb
   and case reconciliation.scope
     when 'quotes' then
       reconciliation.source_manifest_generations ? 'quotes'
       and reconciliation.source_manifest_generations ? 'quote_nested'
     when 'jobs' then
       reconciliation.source_manifest_generations ? 'jobs'
       and reconciliation.source_manifest_generations ? 'job_nested'
     when 'commissions' then
       reconciliation.source_manifest_generations ? 'jobs'
       and reconciliation.source_manifest_generations ? 'job_nested'
     when 'technicians' then
       reconciliation.source_manifest_generations ?& array[
         'jobs', 'job_nested', 'employees', 'timesheets',
         'jobs_from_timesheets', 'schedules', 'mobile_status'
       ]::text[]
     else false
   end
   and not exists (
     select 1
       from jsonb_each_text(reconciliation.source_manifest_generations) declared(source_family, generation)
       left join metrics.source_period_manifests manifest
         on manifest.source_family = declared.source_family
        and manifest.period_start = reconciliation.period_start
        and manifest.period_end = reconciliation.period_end
        and manifest.manifest_generation = declared.generation::bigint
        and manifest.reconciliation_generation = declared.generation::bigint
        and manifest.coverage_status = 'complete'
        and manifest.reconciliation_status = 'matched'
        and manifest.continuation_token is null
        and manifest.expected_page_count > 0
        and manifest.completed_page_count = manifest.expected_page_count
        and manifest.reconciled_at is not null
      where manifest.source_family is null
   )
 order by reconciliation.scope, reconciliation.period_start,
          reconciliation.checked_at desc, reconciliation.id desc;

create or replace view metrics.authoritative_reconciliation_results as
select id, scope, period_start, period_end, generation, status,
       rollup_value, snapshot_value, upstream_sample_value,
       source_manifest_generations, detail, checked_at
  from metrics.authoritative_reconciliation_checks;

comment on view metrics.authoritative_reconciliation_checks is
  'Latest generation-fenced reconciliation per scope and period whose complete, matched source manifests prove every family at its independently declared generation.';
