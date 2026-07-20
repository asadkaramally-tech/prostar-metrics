create schema if not exists metrics;

alter table metrics.commission_calculation_runs
  add column if not exists source_evidence jsonb not null default jsonb_build_object(
    'schemaVersion', 0,
    'status', 'missing',
    'complete', false,
    'units', jsonb_build_object(),
    'matchedReconciliations', jsonb_build_array()
  );

create or replace function metrics.commission_source_evidence_complete(evidence jsonb)
returns boolean
language sql
immutable
as $$
  select coalesce(
    jsonb_typeof(evidence) = 'object'
    and evidence ->> 'schemaVersion' = '2'
    and evidence ->> 'status' = 'complete'
    and evidence ->> 'complete' = 'true'
    and jsonb_typeof(evidence -> 'units') = 'object'
    and (evidence -> 'units') ? 'completedJobs'
    and (evidence -> 'units') ? 'timesheets'
    and (evidence -> 'units') ? 'peopleFieldMapping'
    and (evidence -> 'units') ? 'roster'
    and (evidence -> 'units') ? 'config'
    and (evidence -> 'units') ? 'overrides'
    and (evidence -> 'units') ? 'quoteLabor'
    and (evidence -> 'units') ? 'backfill'
    and (evidence -> 'units') ? 'reconciliation'
    and not exists (
      select 1
        from jsonb_each(
          case when jsonb_typeof(evidence -> 'units') = 'object'
            then evidence -> 'units'
            else '{}'::jsonb
          end
        ) as unit(key, value)
       where unit.value ->> 'required' = 'true'
         and unit.value ->> 'status' not in ('complete', 'complete_no_qualifying_work')
    )
    and jsonb_typeof(evidence -> 'matchedReconciliations') = 'array'
    and jsonb_typeof(evidence #> '{units,reconciliation,detail,requiredScopes}') = 'array'
    and jsonb_array_length(evidence #> '{units,reconciliation,detail,requiredScopes}') > 0
    and not exists (
      select 1
        from jsonb_array_elements_text(
          case when jsonb_typeof(evidence #> '{units,reconciliation,detail,requiredScopes}') = 'array'
            then evidence #> '{units,reconciliation,detail,requiredScopes}'
            else '[]'::jsonb
          end
        ) as required_scope(scope)
       where not exists (
         select 1
           from jsonb_array_elements(
             case when jsonb_typeof(evidence -> 'matchedReconciliations') = 'array'
               then evidence -> 'matchedReconciliations'
               else '[]'::jsonb
             end
           ) as matched(value)
          where matched.value ->> 'scope' = required_scope.scope
            and length(coalesce(matched.value ->> 'id', '')) > 0
            and coalesce(matched.value ->> 'hash', '') ~ '^[0-9a-f]{64}$'
       )
    ),
    false
  );
$$;

create index if not exists commission_runs_source_evidence_status_idx
  on metrics.commission_calculation_runs ((source_evidence ->> 'status'));
