create schema if not exists metrics;

-- Migration 019 predates configurable tier multipliers. Supersede only its
-- exact verified default rows; commission config revisions remain immutable.
with candidates as materialized (
  select c.*
    from metrics.commission_period_configs c
   where c.active
     and c.actor_email = 'system:migration-019'
     and c.config_hash = '5966f042954aea4d9e8d7499655b76f7d4df9748693972cd386a8a7fb6735553'
     and not (c.config_json ? 'tierMultipliers')
), superseded as materialized (
  update metrics.commission_period_configs c
     set active = false,
         superseded_at = coalesce(c.superseded_at, now())
    from candidates old
   where c.period_id = old.period_id
     and c.revision = old.revision
  returning c.period_id, c.revision
), upgraded as materialized (
  insert into metrics.commission_period_configs (
    period_id, revision, pool_pct, min_bonus_pct, efficiency_enabled,
    max_efficiency_adjustment_pct, on_time_threshold_minutes,
    config_json, config_hash, actor_email, active, idempotency_key
  )
  select old.period_id, old.revision + 1, old.pool_pct, old.min_bonus_pct,
         old.efficiency_enabled, old.max_efficiency_adjustment_pct,
         old.on_time_threshold_minutes,
         old.config_json || jsonb_build_object(
           'tierMultipliers', jsonb_build_object(
             'Gold', 1.3,
             'Silver', 1.2,
             'Bronze', 1.1,
             'Standard', 1
           )
         ),
         '719dd0fb880a4ffd7447f35a97b8989a0c9bbf1350071edbcc5fb708ffa574fc',
         'system:migration-025', true,
         'verified-tier-config:025:' || old.period_id::text
    from candidates old
    join superseded s
      on s.period_id = old.period_id and s.revision = old.revision
   where not exists (
     select 1 from metrics.commission_period_configs existing
      where existing.idempotency_key = 'verified-tier-config:025:' || old.period_id::text
   )
  returning period_id, revision, config_json, config_hash
), synced_periods as (
  update metrics.commission_periods p
     set config = u.config_json,
         config_revision = u.revision,
         calculation_stale = true
    from upgraded u
   where p.id = u.period_id
     and p.config_revision = u.revision - 1
  returning p.id, p.period_start
), queued as (
  insert into metrics.rollup_rebuild_queue (
    metric_family, period_grain, period_start, dimensions_json, reason, idempotency_key
  )
  select 'commissions', 'month', p.period_start, '{}'::jsonb,
         'Verified commission tier multipliers added to period config',
         'commissions:month:' || p.period_start::text || ':verified-tier-config:025'
    from synced_periods p
   where not exists (
     select 1
       from metrics.rollup_rebuild_queue q
      where q.idempotency_key = 'commissions:month:' || p.period_start::text || ':verified-tier-config:025'
   )
  returning id, period_start
)
insert into metrics.audit_events (
  actor_email, action, entity_type, entity_id, before_value, after_value, reason
)
select 'system:migration-025', 'commission_tier_config_upgraded',
       'commission_period', u.period_id::text,
       jsonb_build_object(
         'configHash', '5966f042954aea4d9e8d7499655b76f7d4df9748693972cd386a8a7fb6735553',
         'tierMultipliers', null
       ),
       jsonb_build_object(
         'configRevision', u.revision,
         'configHash', u.config_hash,
         'tierMultipliers', u.config_json -> 'tierMultipliers',
         'rebuildQueued', exists (
           select 1 from queued q where q.period_start = p.period_start
         )
       ),
       'Added the locked default tier multipliers to the verified prior-dashboard config and queued an immutable recalculation.'
  from upgraded u
  join metrics.commission_periods p on p.id = u.period_id;
