create schema if not exists metrics;

-- A nested project refresh always reads the project's current Simpro state.
-- Multiple queued refreshes for the same project therefore do not represent
-- distinct work: the newest request subsumes every older queued request. Keep
-- one request per project and preserve running/completed work unchanged.
--
-- This lock covers the cleanup and the partial unique index below. It blocks
-- queue writers only for this migration transaction, so no duplicate can slip
-- in between the cleanup and enforcement. Running jobs are not selected or
-- updated; a queued successor remains valid while its predecessor runs.
lock table metrics.ingestion_jobs in share row exclusive mode;

with ranked as materialized (
  select q.id,
         q.entity_type,
         q.params->>'entityId' as entity_id,
         row_number() over (
           partition by q.entity_type, q.params->>'entityId'
           order by q.updated_at desc, q.created_at desc, q.id desc
         ) as queue_rank
    from metrics.ingestion_jobs q
   where q.entity_type in ('quote_nested', 'job_nested')
     and q.status = 'queued'
     and q.params->>'entityId' ~ '^[1-9][0-9]*$'
), superseded as materialized (
  select id
    from ranked
   where queue_rank > 1
), cancelled as (
  update metrics.ingestion_jobs q
     set status = 'cancelled',
         locked_by = null,
         locked_at = null,
         lock_expires_at = null,
         heartbeat_at = null,
         completed_at = coalesce(q.completed_at, now()),
         last_error = 'Superseded by a newer queued current-state refresh for the same project',
         updated_at = now()
    from superseded s
   where q.id = s.id
  returning q.id, q.entity_type
)
insert into metrics.audit_events (
  actor_email, action, entity_type, entity_id, before_value, after_value, reason
)
select 'system:migration-050', 'duplicate_nested_refresh_coalesced',
       'ingestion_queue_batch', 'current_state_project_refreshes',
       null,
       jsonb_build_object(
         'cancelledJobs', count(*),
         'quoteNested', count(*) filter (where entity_type = 'quote_nested'),
         'jobNested', count(*) filter (where entity_type = 'job_nested')
       ),
       'Kept the newest queued current-state refresh per project and cancelled only older queued duplicates.'
  from cancelled
having count(*) > 0;

-- Enforce the ongoing invariant while allowing a running refresh plus one
-- queued successor. Runtime enqueueing reuses that successor for every later
-- change observed before the running refresh completes.
create unique index if not exists ingestion_jobs_nested_queued_entity_uidx
  on metrics.ingestion_jobs (entity_type, (params->>'entityId'))
  where status = 'queued'
    and entity_type in ('quote_nested', 'job_nested')
    and params->>'entityId' ~ '^[1-9][0-9]*$';
