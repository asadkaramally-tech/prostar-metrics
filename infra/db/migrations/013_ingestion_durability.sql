-- Track recurring executions without widening the queue's unique claim key.
-- A scheduled enqueue advances generation only while reopening a succeeded row,
-- so concurrent duplicate enqueues still converge on one claimable job.

alter table metrics.ingestion_jobs
  add column if not exists generation integer not null default 1;

alter table metrics.ingestion_runs
  add column if not exists job_generation integer not null default 1;

do $$
begin
  alter table metrics.ingestion_jobs
    add constraint ingestion_jobs_generation_positive check (generation > 0);
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter table metrics.ingestion_runs
    add constraint ingestion_runs_job_generation_positive check (job_generation > 0);
exception
  when duplicate_object then null;
end $$;

comment on column metrics.ingestion_jobs.generation is
  'Monotonic scheduled generation. The existing entity/idempotency uniqueness remains the single-claim boundary.';

comment on column metrics.ingestion_runs.job_generation is
  'Ingestion job generation captured when this physical run starts.';
