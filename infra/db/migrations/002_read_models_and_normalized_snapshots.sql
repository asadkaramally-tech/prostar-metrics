create schema if not exists metrics;

do $$
begin
  create type metrics.rollup_rebuild_status as enum ('queued', 'running', 'succeeded', 'failed', 'cancelled');
exception
  when duplicate_object then null;
end $$;

create table if not exists metrics.ingestion_watermarks (
  entity text not null,
  window_key text not null,
  last_success_at timestamptz,
  last_attempt_at timestamptz,
  status text not null default 'missing',
  record_count integer not null default 0,
  source_hash text,
  error_message text,
  updated_at timestamptz not null default now(),
  primary key (entity, window_key)
);

create table if not exists metrics.source_entities_raw (
  company_id integer not null default 0,
  entity text not null,
  source_endpoint text not null,
  parent_key text not null default '',
  source_id text not null,
  source_version text not null default 'current',
  payload_json jsonb not null,
  payload_hash text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  fetched_at timestamptz not null default now(),
  deleted_at timestamptz,
  source_window_start date,
  source_window_end date,
  primary key (company_id, entity, source_endpoint, parent_key, source_id, source_version)
);

create index if not exists source_entities_raw_entity_seen_idx
  on metrics.source_entities_raw (entity, last_seen_at desc);

create table if not exists metrics.dim_people (
  person_id bigserial primary key,
  simpro_employee_id bigint unique,
  display_name text not null,
  role_type text not null default 'unknown',
  active boolean not null default true,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  aliases_json jsonb not null default '[]'::jsonb
);

create table if not exists metrics.metrics_quotes (
  quote_id bigint primary key,
  quote_no text,
  date_issued date,
  date_approved date,
  stage text,
  customer_stage text,
  salesperson_id bigint references metrics.dim_people(simpro_employee_id) on delete set null,
  salesperson_name text,
  total numeric(14, 2) not null default 0,
  linked_job_id bigint,
  job_no text,
  won_reason text not null default 'not_won',
  category text not null default 'Unclassified',
  source_deleted_at timestamptz,
  updated_from_source_at timestamptz not null default now()
);

create index if not exists metrics_quotes_activity_idx
  on metrics.metrics_quotes (date_approved, quote_id)
  where source_deleted_at is null;

create table if not exists metrics.metrics_quote_cost_centers (
  quote_id bigint not null references metrics.metrics_quotes(quote_id) on delete cascade,
  cost_center_id bigint not null,
  name text,
  category text,
  labor_hours numeric(10, 2),
  sell_value numeric(14, 2),
  cost_value numeric(14, 2),
  source_deleted_at timestamptz,
  updated_from_source_at timestamptz not null default now(),
  primary key (quote_id, cost_center_id)
);

create table if not exists metrics.metrics_jobs (
  job_id bigint primary key,
  job_no text,
  completed_date date,
  stage text,
  customer_id bigint,
  site_id bigint,
  total numeric(14, 2) not null default 0,
  gross_profit_actual numeric(14, 2),
  gross_margin_actual numeric(8, 4),
  converted_from_type text,
  converted_from_id bigint,
  category text not null default 'Unclassified',
  source_deleted_at timestamptz,
  updated_from_source_at timestamptz not null default now()
);

create index if not exists metrics_jobs_completed_idx
  on metrics.metrics_jobs (completed_date, job_id)
  where source_deleted_at is null;

create table if not exists metrics.metrics_job_cost_centers (
  job_id bigint not null references metrics.metrics_jobs(job_id) on delete cascade,
  cost_center_id bigint not null,
  name text,
  category text,
  labor_quoted_hours numeric(10, 2),
  material_sell_value numeric(14, 2),
  material_cost_value numeric(14, 2),
  source_deleted_at timestamptz,
  updated_from_source_at timestamptz not null default now(),
  primary key (job_id, cost_center_id)
);

create table if not exists metrics.metrics_employee_timesheets (
  timesheet_id text primary key,
  employee_id bigint,
  person_id bigint references metrics.dim_people(person_id) on delete set null,
  reference_type text,
  reference_id bigint,
  reference_raw text,
  work_date date,
  start_time timestamptz,
  end_time timestamptz,
  total_hours numeric(10, 2) not null default 0,
  schedule_rate numeric(14, 2),
  cost numeric(14, 2),
  overhead_cost numeric(14, 2),
  total_cost numeric(14, 2),
  parse_status text not null default 'parsed',
  source_deleted_at timestamptz,
  updated_from_source_at timestamptz not null default now()
);

create index if not exists metrics_employee_timesheets_job_idx
  on metrics.metrics_employee_timesheets (reference_type, reference_id, employee_id, work_date);

create table if not exists metrics.metrics_schedules (
  schedule_id bigint primary key,
  reference_type text,
  reference_id bigint,
  staff_person_id bigint references metrics.dim_people(person_id) on delete set null,
  schedule_date date,
  total_hours numeric(10, 2),
  start_time time,
  end_time time,
  iso_start_time timestamptz,
  iso_end_time timestamptz,
  schedule_rate numeric(14, 2),
  source_deleted_at timestamptz,
  updated_from_source_at timestamptz not null default now()
);

create index if not exists metrics_schedules_reference_idx
  on metrics.metrics_schedules (reference_type, reference_id, staff_person_id);

create table if not exists metrics.metrics_mobile_status_logs (
  simpro_log_id bigint primary key,
  staff_person_id bigint references metrics.dim_people(person_id) on delete set null,
  work_order_id bigint,
  work_order_type text,
  project_id bigint,
  cost_center_id bigint,
  status_id bigint,
  status_name text,
  latitude numeric(10, 7),
  longitude numeric(10, 7),
  date_logged timestamptz,
  coverage_window_start timestamptz,
  coverage_window_end timestamptz,
  fetched_at timestamptz not null default now()
);

create index if not exists metrics_mobile_status_project_idx
  on metrics.metrics_mobile_status_logs (project_id, date_logged);

create table if not exists metrics.dashboard_read_models (
  metric_family text not null,
  period_grain text not null,
  period_start date not null,
  dimensions_json jsonb not null default '{}'::jsonb,
  values_json jsonb not null,
  status text not null default 'ready',
  source_watermark_json jsonb not null default '{}'::jsonb,
  source_hash text,
  rebuilt_by_job_id bigint,
  rebuilt_at timestamptz not null default now(),
  last_reconciled_at timestamptz,
  suspect_reason text,
  superseded_at timestamptz,
  source_coverage_json jsonb not null default '{}'::jsonb,
  primary key (metric_family, period_grain, period_start, dimensions_json)
);

create index if not exists dashboard_read_models_family_period_idx
  on metrics.dashboard_read_models (metric_family, period_start desc)
  where superseded_at is null;

create table if not exists metrics.rollup_rebuild_queue (
  id bigserial primary key,
  metric_family text not null,
  period_grain text not null,
  period_start date not null,
  dimensions_json jsonb not null default '{}'::jsonb,
  reason text not null,
  status metrics.rollup_rebuild_status not null default 'queued',
  attempts integer not null default 0,
  locked_by text,
  locked_until timestamptz,
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  error_message text
);

create index if not exists rollup_rebuild_queue_ready_idx
  on metrics.rollup_rebuild_queue (status, period_start, id)
  where status = 'queued';

create table if not exists metrics.commission_employee_results (
  run_id bigint not null references metrics.commission_calculation_runs(id) on delete cascade,
  employee_id bigint not null,
  tier text not null,
  allocated_value numeric(14, 2) not null default 0,
  raw_bonus numeric(14, 2) not null default 0,
  forfeited_bonus numeric(14, 2) not null default 0,
  reallocation_received numeric(14, 2) not null default 0,
  inside_pool_adjustment numeric(14, 2) not null default 0,
  outside_pool_adjustment numeric(14, 2) not null default 0,
  final_bonus numeric(14, 2) not null default 0,
  notes_json jsonb not null default '{}'::jsonb,
  primary key (run_id, employee_id)
);

create table if not exists metrics.commission_job_allocations (
  run_id bigint not null references metrics.commission_calculation_runs(id) on delete cascade,
  job_id bigint not null,
  employee_id bigint not null,
  job_total numeric(14, 2) not null default 0,
  employee_hours numeric(10, 2) not null default 0,
  job_total_hours numeric(10, 2) not null default 0,
  share numeric(12, 8) not null default 0,
  allocated_value numeric(14, 2) not null default 0,
  primary key (run_id, job_id, employee_id)
);
