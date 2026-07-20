-- Enforce the approved 2023-current dashboard boundary after production
-- verification exposed that later change-log events could recreate old rollups.

insert into metrics.audit_events (
  actor_email, action, entity_type, entity_id, before_value, after_value, reason
)
select 'metrics-migration@prostarmechanical.com',
       'out_of_scope_read_model_resuperseded',
       'dashboard_read_model',
       concat(metric_family, ':', period_grain, ':', period_start::text, ':', md5(dimensions_json::text)),
       jsonb_build_object(
         'metricFamily', metric_family,
         'periodStart', period_start,
         'status', status,
         'rebuiltAt', rebuilt_at,
         'suspectReason', suspect_reason
       ),
       jsonb_build_object(
         'superseded', true,
         'servingBoundaryStart', '2023-01-01',
         'servingBoundaryEnd', date_trunc('month', current_date)::date
       ),
       'Re-quarantine data recreated after the initial cleanup and enforce the approved serving window.'
  from metrics.dashboard_read_models
 where superseded_at is null
   and (
     period_start < date '2023-01-01'
     or period_start > date_trunc('month', current_date)::date
   );

update metrics.dashboard_read_models
   set superseded_at = now(),
       suspect_reason = 'Quarantined outside the enforced 2023-current serving window'
 where superseded_at is null
   and (
     period_start < date '2023-01-01'
     or period_start > date_trunc('month', current_date)::date
   );

insert into metrics.audit_events (
  actor_email, action, entity_type, entity_id, before_value, after_value, reason
)
select 'metrics-migration@prostarmechanical.com',
       'out_of_scope_rollup_recancelled',
       'rollup_rebuild_job',
       id::text,
       jsonb_build_object(
         'metricFamily', metric_family,
         'periodStart', period_start,
         'status', status,
         'attempts', attempts,
         'reason', reason,
         'error', error_message
       ),
       jsonb_build_object('status', 'cancelled'),
       'Cancel rollups recreated after the initial cleanup and enforce the approved serving window.'
  from metrics.rollup_rebuild_queue
 where status in ('queued', 'running', 'failed')
   and (
     period_start < date '2023-01-01'
     or period_start > date_trunc('month', current_date)::date
   );

update metrics.rollup_rebuild_queue
   set status = 'cancelled'::metrics.rollup_rebuild_status,
       locked_by = null,
       locked_until = null,
       finished_at = now(),
       error_message = 'Quarantined outside the enforced 2023-current serving window'
 where status in ('queued', 'running', 'failed')
   and (
     period_start < date '2023-01-01'
     or period_start > date_trunc('month', current_date)::date
   );

insert into metrics.audit_events (
  actor_email, action, entity_type, entity_id, before_value, after_value, reason
)
select 'metrics-migration@prostarmechanical.com',
       'unattempted_ingestion_error_cleared',
       'ingestion_job',
       id::text,
       jsonb_build_object('status', status, 'attempts', attempts, 'lastError', last_error),
       jsonb_build_object('status', status, 'attempts', attempts, 'lastError', null),
       'An unattempted queued ingestion job cannot own an ingestion failure; remove leaked rollup errors.'
  from metrics.ingestion_jobs
 where status = 'queued'
   and attempts = 0
   and dead_lettered_at is null
   and last_error is not null;

update metrics.ingestion_jobs
   set last_error = null,
       updated_at = now()
 where status = 'queued'
   and attempts = 0
   and dead_lettered_at is null
   and last_error is not null;

create or replace function metrics.enforce_dashboard_serving_period()
returns trigger
language plpgsql
as $$
begin
  if new.period_start < date '2023-01-01'
     or new.period_start > date_trunc('month', current_date)::date then
    raise exception 'Period % is outside the approved 2023-current dashboard serving window', new.period_start
      using errcode = '22023';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_rollup_serving_period on metrics.rollup_rebuild_queue;
create trigger enforce_rollup_serving_period
before insert or update of period_start on metrics.rollup_rebuild_queue
for each row execute function metrics.enforce_dashboard_serving_period();

drop trigger if exists enforce_read_model_serving_period on metrics.dashboard_read_models;
create trigger enforce_read_model_serving_period
before insert or update of period_start on metrics.dashboard_read_models
for each row execute function metrics.enforce_dashboard_serving_period();

drop trigger if exists enforce_commission_serving_period on metrics.commission_periods;
create trigger enforce_commission_serving_period
before insert or update of period_start on metrics.commission_periods
for each row execute function metrics.enforce_dashboard_serving_period();
