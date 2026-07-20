create schema if not exists metrics;

alter table metrics.ingestion_jobs
  add column if not exists operation text not null default 'sync',
  add column if not exists source_window_start timestamptz,
  add column if not exists source_window_end timestamptz,
  add column if not exists page_cursor jsonb,
  add column if not exists lock_expires_at timestamptz,
  add column if not exists heartbeat_at timestamptz,
  add column if not exists dead_lettered_at timestamptz,
  add column if not exists completed_at timestamptz;

create index if not exists ingestion_jobs_expired_lock_idx
  on metrics.ingestion_jobs (lock_expires_at, id)
  where status = 'running';

create index if not exists ingestion_jobs_queue_age_idx
  on metrics.ingestion_jobs (entity_type, created_at, id)
  where status = 'queued';

alter table metrics.ingestion_runs
  add column if not exists source_family text,
  add column if not exists source_window_start timestamptz,
  add column if not exists source_window_end timestamptz,
  add column if not exists page_cursor jsonb,
  add column if not exists normalized_count integer not null default 0,
  add column if not exists candidate_count integer not null default 0,
  add column if not exists source_hash text;

-- Job links may be known from Jobs[] even when an invoice has no cost-center split.
alter table metrics.invoice_job_links
  drop constraint if exists invoice_job_links_pkey;

alter table metrics.invoice_job_links
  alter column cost_center_id drop not null;

create unique index if not exists invoice_job_links_identity_idx
  on metrics.invoice_job_links (invoice_type, invoice_id, job_id, cost_center_id) nulls not distinct;

-- One fixed-window bucket coordinates every worker and manual Simpro execution.
create table if not exists metrics.simpro_rate_limit_buckets (
  bucket_key text primary key,
  window_started_at timestamptz not null,
  request_count integer not null default 0 check (request_count >= 0),
  limit_per_second integer not null check (limit_per_second between 1 and 5),
  updated_at timestamptz not null default now()
);

create table if not exists metrics.pipeline_telemetry (
  recorded_at timestamptz not null default now(),
  metric_name text not null,
  source_family text,
  metric_value numeric(18, 4) not null,
  dimensions jsonb not null default '{}'::jsonb,
  primary key (recorded_at, metric_name, source_family)
);

create index if not exists pipeline_telemetry_metric_time_idx
  on metrics.pipeline_telemetry (metric_name, recorded_at desc);

comment on table metrics.source_entities_raw is
  'Legacy expand-phase raw store. raw_simpro_snapshots is authoritative; no production writer may target source_entities_raw.';

comment on table metrics.raw_simpro_snapshots is
  'Authoritative immutable Simpro payload/provenance store for Metrics.';
