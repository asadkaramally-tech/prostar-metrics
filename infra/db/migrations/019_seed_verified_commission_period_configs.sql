create schema if not exists metrics;

-- This is historical evidence from the authoritative prior commissions dashboard,
-- not a projection of whichever config happens to be current when this migration runs.
do $$
begin
  if exists (
    select 1
      from metrics.commission_periods p
     where p.period_start >= date '2023-01-01'
       and p.period_start <= date_trunc('month', now() at time zone 'America/Los_Angeles')::date
       and not exists (
         select 1 from metrics.commission_period_configs c
          where c.period_id = p.id and c.active
       )
       and (
         coalesce((p.config->>'poolPercent')::numeric, -1) <> 0.50
         or coalesce((p.config->>'minBonusPercent')::numeric, -1) <> 5.00
         or coalesce((p.config->>'efficiencyEnabled')::boolean, true) <> false
         or coalesce((p.config->>'maxEfficiencyAdjustmentPercent')::numeric, -1) <> 20.00
       )
  ) then
    raise exception 'A 2023-current commission period differs from the verified prior-dashboard config; refusing historical config evidence seed.';
  end if;
end $$;

with eligible_periods as materialized (
  select p.id, p.period_start, p.period_end, p.config_revision
    from metrics.commission_periods p
   where p.period_start >= date '2023-01-01'
     and p.period_start <= date_trunc('month', now() at time zone 'America/Los_Angeles')::date
     and not exists (
       select 1 from metrics.commission_period_configs c
        where c.period_id = p.id and c.active
     )
), inserted as (
  insert into metrics.commission_period_configs (
    period_id, revision, pool_pct, min_bonus_pct, efficiency_enabled,
    max_efficiency_adjustment_pct, on_time_threshold_minutes,
    config_json, config_hash, actor_email, active, idempotency_key
  )
  select p.id, p.config_revision, 0.50, 5.00, false, 20.00, 15,
         jsonb_build_object(
           'poolPercent', 0.5,
           'minBonusPercent', 5,
           'efficiencyEnabled', false,
           'maxEfficiencyAdjustmentPercent', 20
         ),
         '5966f042954aea4d9e8d7499655b76f7d4df9748693972cd386a8a7fb6735553',
         'system:migration-019', true,
         'verified-prior-dashboard-config:' || p.period_start::text
    from eligible_periods p
  returning period_id, revision, config_hash
)
insert into metrics.audit_events (
  actor_email, action, entity_type, entity_id, before_value, after_value, reason
)
select 'system:migration-019', 'commission_period_config_evidence_seeded',
       'commission_period', p.id::text, null,
       jsonb_build_object(
         'periodStart', p.period_start,
         'periodEnd', p.period_end,
         'configRevision', i.revision,
         'configHash', i.config_hash,
         'config', jsonb_build_object(
           'poolPercent', 0.5,
           'minBonusPercent', 5,
           'efficiencyEnabled', false,
           'maxEfficiencyAdjustmentPercent', 20
         ),
         'evidence', jsonb_build_object(
           'source', 'docs/prostar-metrics/reference/commissions-dashboard.html',
           'sourceSha256', '037b1f6e0e5b7a4156a8eee8180307e92dfc3f0f17b8f19b5ea7011f2852538b',
           'sourceLines', '604-610',
           'planSection', '6.4 Technician Commissions / Base calculation order',
           'historicalBasis', 'The prior dashboard declares one global CONFIG used by its monthly calculations.'
         )
       ),
       'Persist period-effective evidence for the commission config already specified by the authoritative prior dashboard and locked implementation plan.'
  from inserted i
  join eligible_periods p on p.id = i.period_id;
