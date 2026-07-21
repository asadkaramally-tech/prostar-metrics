create schema if not exists metrics;

-- Reconciliation-generated job detail refreshes are unnecessary only when the
-- exact job ID remains covered by a completed historical checksum-backed bulk
-- traversal. Manual requests, active leases, unverified rows, and current
-- month evidence are intentionally outside this repair.
with superseded as materialized (
  select q.id
    from metrics.ingestion_jobs q
   where q.entity_type = 'job_nested'
     and q.operation = 'bounded_refresh'
     and q.status = 'queued'
     and q.params->>'entityId' ~ '^[0-9]+$'
     and q.params->'boundedWork'->>'origin' = 'reconciliation'
     and exists (
       select 1
         from metrics.backfill_source_month_ledger ledger
         join metrics.backfill_traversal_manifests traversal
           on traversal.work_unit_id = ledger.id
        where ledger.source_family = 'job_nested'
          and ledger.month_start < date_trunc('month', now() at time zone 'America/Los_Angeles')::date
          and ledger.status = 'completed'
          and ledger.reconciliation_status = 'matched'
          and traversal.manifest_status = 'completed'
          and traversal.exact_source_ids @> jsonb_build_array(q.params->>'entityId')
          and exists (
            select 1
              from metrics.backfill_traversal_pages page
             where page.work_unit_id = traversal.work_unit_id
               and page.generation = traversal.generation
               and page.synthetic = true
               and page.source_method = 'checksum_verified_full_universe_artifact_projection:listJobs'
               and page.exact_ids @> jsonb_build_array(q.params->>'entityId')
               and page.request_query->'_bulkArtifactEvidence'->>'provenance'
                 = 'checksum_verified_full_universe_artifact_projection'
               and page.request_query->'_bulkArtifactEvidence'->>'fabricatedApiResponse' = 'false'
          )
          and exists (
            select 1
              from metrics.raw_simpro_snapshots root
             where root.entity_type = 'jobs'
               and root.entity_id = q.params->>'entityId'
               and root.source_deleted_at is null
               and root.complete_traversal = true
               and root.source_version like 'bulk-bootstrap:%'
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
         last_error = 'Superseded by completed checksum-verified historical job_nested bulk authority',
         updated_at = now()
    from superseded s
   where q.id = s.id
  returning q.id
)
insert into metrics.audit_events (
  actor_email, action, entity_type, entity_id, before_value, after_value, reason
)
select 'system:migration-049', 'historical_job_nested_refresh_cancelled',
       'ingestion_queue_batch', 'checksum_verified_historical_job_nested_authority',
       null,
       jsonb_build_object('cancelledJobs', count(*)),
       'Cancelled only queued reconciliation-originated job_nested bounded refreshes with exact completed checksum-backed historical authority.'
  from cancelled
having count(*) > 0;
