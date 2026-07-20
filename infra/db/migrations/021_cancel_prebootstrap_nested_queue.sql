create schema if not exists metrics;

with superseded as materialized (
  select q.id
    from metrics.ingestion_jobs q
   where q.entity_type in ('quote_nested', 'job_nested')
     and q.status = 'queued'
     and q.created_at <= timestamptz '2026-07-10T16:40:52.693Z'
     and q.params->>'entityId' ~ '^[0-9]+$'
     and (
       (
         q.entity_type = 'quote_nested'
         and exists (
           select 1 from metrics.metrics_quotes quote
            where quote.quote_id = (q.params->>'entityId')::bigint
              and quote.source_deleted_at is null
              and quote.fetched_at >= timestamptz '2026-07-10T16:40:52.693Z'
         )
       )
       or (
         q.entity_type = 'job_nested'
         and exists (
           select 1 from metrics.metrics_jobs job
            where job.job_id = (q.params->>'entityId')::bigint
              and job.source_deleted_at is null
              and job.fetched_at >= timestamptz '2026-07-10T16:40:52.693Z'
         )
       )
     )
), cancelled as (
  update metrics.ingestion_jobs q
     set status = 'cancelled',
         locked_by = null,
         locked_at = null,
         lock_expires_at = null,
         heartbeat_at = null,
         completed_at = coalesce(completed_at, now()),
         last_error = 'Superseded by checksum-verified bulk project artifact 762284c132d8ec064eb2a066c2097b9e9e3801e04251037056016cd766b40103',
         updated_at = now()
    from superseded s
   where q.id = s.id
  returning q.id, q.entity_type
)
insert into metrics.audit_events (
  actor_email, action, entity_type, entity_id, before_value, after_value, reason
)
select 'system:migration-021', 'prebootstrap_nested_queue_cancelled',
       'ingestion_queue_batch',
       '762284c132d8ec064eb2a066c2097b9e9e3801e04251037056016cd766b40103',
       null,
       jsonb_build_object(
         'cancelledJobs', count(*),
         'quoteNested', count(*) filter (where entity_type = 'quote_nested'),
         'jobNested', count(*) filter (where entity_type = 'job_nested'),
         'artifactCompletedAt', '2026-07-10T16:40:52.693Z'
       ),
       'Cancelled only queued nested work created before and superseded by the checksum-verified bulk project artifact.'
  from cancelled
having count(*) > 0;
