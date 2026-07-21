-- Expand-only rollout for the versioned technician read-model contract.
-- Existing rows remain immutable and serveable only when they already carry
-- the verified roster fields. Every stale served month receives a rebuild job
-- so publication replaces it through the normal owner-fenced rollup path.

insert into metrics.rollup_rebuild_queue (
  metric_family,
  period_grain,
  period_start,
  dimensions_json,
  reason,
  idempotency_key,
  locked_until
)
select
  'technicians',
  'month',
  model.period_start,
  '{}'::jsonb,
  'migration 048: publish current versioned technician read-model contract',
  'migration-048:technicians:month:' || model.period_start::text,
  -- The migration is applied before the new worker image is cut over. Delay
  -- claims so the prior image cannot republish the legacy schema in that gap;
  -- deployment follow-up explicitly releases these jobs after cutover.
  now() + interval '2 hours'
from metrics.dashboard_read_models model
where model.metric_family = 'technicians'
  and model.period_grain = 'month'
  and model.status = 'ready'
  and model.superseded_at is null
  and model.period_start >= date '2023-01-01'
  and model.period_start <= date_trunc('month', current_timestamp at time zone 'America/Los_Angeles')::date
  and not coalesce((
    model.values_json ->> 'schemaVersion' = '1'
    and model.values_json ->> 'netProfitBasis' = 'simpro_job_net_profit_actual'
    and jsonb_typeof(model.values_json -> 'rosterApplied') = 'boolean'
    and jsonb_typeof(model.values_json -> 'outsideRoster') = 'array'
    and jsonb_typeof(model.values_json -> 'technicians') = 'array'
    and jsonb_typeof(model.values_json -> 'coverage') = 'object'
  ), false)
on conflict (idempotency_key) do update set
  status = case
    when metrics.rollup_rebuild_queue.status = 'running'
      and metrics.rollup_rebuild_queue.locked_until > now()
      then metrics.rollup_rebuild_queue.status
    else 'queued'::metrics.rollup_rebuild_status
  end,
  attempts = case
    when metrics.rollup_rebuild_queue.status = 'running'
      and metrics.rollup_rebuild_queue.locked_until > now()
      then metrics.rollup_rebuild_queue.attempts
    else 0
  end,
  locked_by = case
    when metrics.rollup_rebuild_queue.status = 'running'
      and metrics.rollup_rebuild_queue.locked_until > now()
      then metrics.rollup_rebuild_queue.locked_by
    else null
  end,
  locked_until = case
    when metrics.rollup_rebuild_queue.status = 'running'
      and metrics.rollup_rebuild_queue.locked_until > now()
      then metrics.rollup_rebuild_queue.locked_until
    else excluded.locked_until
  end,
  reason = excluded.reason,
  finished_at = null,
  error_message = null;
