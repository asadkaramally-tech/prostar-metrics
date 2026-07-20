create table if not exists metrics.project_nested_traversals (
  project_type text not null check (project_type in ('quote', 'job')),
  project_id bigint not null,
  generation bigint not null check (generation > 0),
  status text not null check (status in ('active', 'completed', 'source_deleted')),
  started_at timestamptz not null default now(),
  finalized_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (project_type, project_id)
);

alter table metrics.metrics_quote_cost_centers
  add column if not exists traversal_generation bigint;
alter table metrics.metrics_job_cost_centers
  add column if not exists traversal_generation bigint;
alter table metrics.metrics_quote_labor
  add column if not exists traversal_generation bigint;
alter table metrics.metrics_job_labor
  add column if not exists traversal_generation bigint;
alter table metrics.metrics_quote_items
  add column if not exists traversal_generation bigint;
alter table metrics.metrics_job_items
  add column if not exists traversal_generation bigint;
alter table metrics.metrics_work_orders
  add column if not exists traversal_generation bigint;
alter table metrics.metrics_schedules
  add column if not exists traversal_generation bigint;
alter table metrics.schedule_snapshots
  add column if not exists traversal_generation bigint;
alter table metrics.metrics_schedule_blocks
  add column if not exists traversal_generation bigint;

create index if not exists metrics_quote_cost_centers_traversal_generation_idx
  on metrics.metrics_quote_cost_centers (quote_id, traversal_generation);
create index if not exists metrics_job_cost_centers_traversal_generation_idx
  on metrics.metrics_job_cost_centers (job_id, traversal_generation);
create index if not exists metrics_quote_labor_traversal_generation_idx
  on metrics.metrics_quote_labor (quote_id, traversal_generation);
create index if not exists metrics_job_labor_traversal_generation_idx
  on metrics.metrics_job_labor (job_id, traversal_generation);
create index if not exists metrics_quote_items_traversal_generation_idx
  on metrics.metrics_quote_items (quote_id, traversal_generation);
create index if not exists metrics_job_items_traversal_generation_idx
  on metrics.metrics_job_items (job_id, traversal_generation);
create index if not exists metrics_work_orders_traversal_generation_idx
  on metrics.metrics_work_orders (project_type, project_id, traversal_generation);
create index if not exists metrics_schedules_traversal_generation_idx
  on metrics.metrics_schedules (reference_type, reference_id, traversal_generation);
create index if not exists schedule_snapshots_traversal_generation_idx
  on metrics.schedule_snapshots (project_type, project_id, traversal_generation);
create index if not exists metrics_schedule_blocks_traversal_generation_idx
  on metrics.metrics_schedule_blocks (reference_type, reference_id, traversal_generation);

comment on table metrics.project_nested_traversals is
  'Monotonic per-project authority for resumable nested Simpro traversals. Child writes and finalization apply only while their generation remains active.';
