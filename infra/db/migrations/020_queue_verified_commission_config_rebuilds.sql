create schema if not exists metrics;

with eligible_periods as materialized (
  select p.id, p.period_start
    from metrics.commission_periods p
    join metrics.commission_period_configs c
      on c.period_id = p.id
     and c.active
     and c.actor_email = 'system:migration-019'
   where p.period_start >= date '2023-01-01'
     and p.period_start <= date_trunc('month', now() at time zone 'America/Los_Angeles')::date
     and (
       p.current_run_id is null
       or exists (
         select 1 from metrics.commission_calculation_runs r
          where r.id = p.current_run_id and not r.source_complete
       )
     )
), inserted as (
  insert into metrics.rollup_rebuild_queue (
    metric_family, period_grain, period_start, dimensions_json, reason, idempotency_key
  )
  select 'commissions', 'month', p.period_start, '{}'::jsonb,
         'Verified prior-dashboard period config evidence became available',
         'commissions:month:' || p.period_start::text || ':verified-config-evidence:019'
    from eligible_periods p
   where not exists (
     select 1 from metrics.rollup_rebuild_queue q
      where q.idempotency_key = 'commissions:month:' || p.period_start::text || ':verified-config-evidence:019'
   )
  returning id, period_start
)
insert into metrics.audit_events (
  actor_email, action, entity_type, entity_id, before_value, after_value, reason
)
select 'system:migration-020', 'commission_config_evidence_rebuild_queued',
       'rollup_rebuild_queue', i.id::text, null,
       jsonb_build_object('periodStart', i.period_start, 'metricFamily', 'commissions'),
       'Queued a commission rebuild after verified period-effective config evidence was persisted.'
  from inserted i;
