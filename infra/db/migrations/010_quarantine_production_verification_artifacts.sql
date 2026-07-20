-- Quarantine rows created by production verification before the 2023-current
-- serving boundary was enforced. Records remain available for audit.

insert into metrics.audit_events (
  actor_email, action, entity_type, entity_id, before_value, after_value, reason
)
select 'metrics-migration@prostarmechanical.com',
       'out_of_scope_read_model_superseded',
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
       'Quarantine production verification data outside the approved 2023-current dashboard window.'
  from metrics.dashboard_read_models
 where superseded_at is null
   and (
     period_start < date '2023-01-01'
     or period_start > date_trunc('month', current_date)::date
   );

update metrics.dashboard_read_models
   set superseded_at = now(),
       suspect_reason = 'Quarantined production verification artifact outside the approved 2023-current window'
 where superseded_at is null
   and (
     period_start < date '2023-01-01'
     or period_start > date_trunc('month', current_date)::date
   );

insert into metrics.audit_events (
  actor_email, action, entity_type, entity_id, before_value, after_value, reason
)
select 'metrics-migration@prostarmechanical.com',
       'out_of_scope_rollup_cancelled',
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
       'Cancel non-serving production verification rollups outside the approved 2023-current window.'
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
       error_message = 'Quarantined production verification artifact outside the approved 2023-current window'
 where status in ('queued', 'running', 'failed')
   and (
     period_start < date '2023-01-01'
     or period_start > date_trunc('month', current_date)::date
   );

insert into metrics.audit_events (
  actor_email, action, entity_type, entity_id, before_value, after_value, reason
)
select 'metrics-migration@prostarmechanical.com',
       'verification_ingestion_job_cancelled',
       'ingestion_job',
       id::text,
       jsonb_build_object(
         'entityType', entity_type,
         'idempotencyKey', idempotency_key,
         'status', status,
         'attempts', attempts,
         'lastError', last_error
       ),
       jsonb_build_object('status', 'cancelled'),
       'Cancel explicit wp02 production verification fixtures that are not source ingestion work.'
  from metrics.ingestion_jobs
 where status in ('queued', 'running', 'failed')
   and idempotency_key like '%wp02-%';

update metrics.ingestion_jobs
   set status = 'cancelled'::metrics.ingestion_job_status,
       locked_by = null,
       locked_at = null,
       lock_expires_at = null,
       heartbeat_at = null,
       next_attempt_at = now(),
       completed_at = now(),
       dead_lettered_at = null,
       last_error = 'Quarantined explicit wp02 production verification fixture',
       updated_at = now()
 where status in ('queued', 'running', 'failed')
   and idempotency_key like '%wp02-%';

insert into metrics.audit_events (
  actor_email, action, entity_type, entity_id, before_value, after_value, reason
)
select 'metrics-migration@prostarmechanical.com',
       'succeeded_ingestion_error_cleared',
       'ingestion_job',
       id::text,
       jsonb_build_object('status', status, 'lastError', last_error),
       jsonb_build_object('status', status, 'lastError', null),
       'A succeeded ingestion job must not retain an error from an earlier retry.'
  from metrics.ingestion_jobs
 where status = 'succeeded'
   and last_error is not null;

update metrics.ingestion_jobs
   set last_error = null,
       updated_at = now()
 where status = 'succeeded'
   and last_error is not null;
