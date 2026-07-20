create index if not exists metrics_quotes_active_linked_job_idx
  on metrics.metrics_quotes (linked_job_id, quote_id)
  where linked_job_id is not null
    and source_deleted_at is null;
