create schema if not exists metrics;

do $$
begin
  create type metrics.ingestion_job_status as enum ('queued', 'running', 'succeeded', 'failed', 'cancelled');
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type metrics.ingestion_entity_type as enum (
    'quotes',
    'quote_details',
    'jobs',
    'job_details',
    'employees',
    'timesheets',
    'schedules',
    'mobile_status',
    'commission_period'
  );
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type metrics.commission_period_status as enum ('draft', 'reviewed', 'exported', 'locked', 'revised');
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type metrics.export_type as enum ('payroll_csv', 'worksheet_pdf', 'calculation_detail_csv');
exception
  when duplicate_object then null;
end $$;

create table if not exists metrics.ingestion_jobs (
  id bigserial primary key,
  entity_type metrics.ingestion_entity_type not null,
  status metrics.ingestion_job_status not null default 'queued',
  priority integer not null default 100,
  idempotency_key text not null,
  request_budget integer not null default 1000,
  requests_used integer not null default 0,
  continuation_token jsonb,
  date_window daterange,
  params jsonb not null default '{}'::jsonb,
  locked_by text,
  locked_at timestamptz,
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (entity_type, idempotency_key)
);

create index if not exists ingestion_jobs_ready_idx
  on metrics.ingestion_jobs (status, priority, next_attempt_at, id)
  where status = 'queued';

create table if not exists metrics.ingestion_runs (
  id bigserial primary key,
  job_id bigint references metrics.ingestion_jobs(id) on delete set null,
  entity_type metrics.ingestion_entity_type not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status metrics.ingestion_job_status not null default 'running',
  request_count integer not null default 0,
  snapshot_count integer not null default 0,
  continuation_token jsonb,
  source_min_at timestamptz,
  source_max_at timestamptz,
  error_message text,
  worker_id text not null
);

create table if not exists metrics.raw_simpro_snapshots (
  id bigserial primary key,
  entity_type text not null,
  entity_id text not null,
  source_path text not null,
  source_hash text not null,
  source_updated_at timestamptz,
  extracted_at timestamptz not null default now(),
  ingestion_run_id bigint references metrics.ingestion_runs(id) on delete set null,
  page_window jsonb,
  payload jsonb not null,
  unique (entity_type, entity_id, source_hash)
);

create index if not exists raw_simpro_snapshots_entity_idx
  on metrics.raw_simpro_snapshots (entity_type, entity_id, extracted_at desc);

create table if not exists metrics.quote_snapshots (
  quote_id bigint primary key,
  quote_no text,
  name text,
  status_name text,
  stage_name text,
  customer_stage_name text,
  salesperson_id bigint,
  salesperson_name text,
  owner_name text,
  linked_job_id bigint,
  job_no text,
  date_issued date,
  date_approved date,
  total_value numeric(14, 2),
  won_value numeric(14, 2),
  deal_tier text,
  category text,
  category_basis text,
  won boolean,
  win_loss_reason text,
  source_snapshot_id bigint references metrics.raw_simpro_snapshots(id) on delete set null,
  extracted_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists quote_snapshots_period_idx
  on metrics.quote_snapshots (coalesce(date_approved, date_issued), quote_id);

create table if not exists metrics.job_snapshots (
  job_id bigint primary key,
  job_no text,
  name text,
  status_name text,
  stage_name text,
  completed_date date,
  customer_id bigint,
  customer_name text,
  site_id bigint,
  site_name text,
  source_quote_id bigint,
  sell_value numeric(14, 2),
  cost_value numeric(14, 2),
  gross_profit numeric(14, 2),
  gross_margin_percent numeric(8, 4),
  labor_quoted_hours numeric(10, 2),
  labor_actual_hours numeric(10, 2),
  labor_coverage text not null default 'unknown',
  material_coverage text not null default 'coverage_only',
  source_snapshot_id bigint references metrics.raw_simpro_snapshots(id) on delete set null,
  extracted_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists job_snapshots_completed_idx
  on metrics.job_snapshots (completed_date, job_id);

create table if not exists metrics.employee_snapshots (
  employee_id bigint primary key,
  display_name text not null,
  email text,
  archived boolean not null default false,
  source_snapshot_id bigint references metrics.raw_simpro_snapshots(id) on delete set null,
  extracted_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists metrics.timesheet_snapshots (
  id bigserial primary key,
  employee_id bigint not null,
  simpro_timesheet_id text not null,
  reference_type text,
  reference_id text,
  reference_href text,
  work_date date,
  start_at timestamptz,
  end_at timestamptz,
  total_hours numeric(10, 2),
  cost_value numeric(14, 2),
  source_snapshot_id bigint references metrics.raw_simpro_snapshots(id) on delete set null,
  extracted_at timestamptz not null default now(),
  unique (employee_id, simpro_timesheet_id)
);

create index if not exists timesheet_snapshots_reference_idx
  on metrics.timesheet_snapshots (reference_type, reference_id, employee_id);

create table if not exists metrics.schedule_snapshots (
  schedule_id bigint primary key,
  reference_type text,
  reference_id text,
  project_type text,
  project_id text,
  staff jsonb not null default '[]'::jsonb,
  blocks jsonb not null default '[]'::jsonb,
  planned_start_at timestamptz,
  planned_end_at timestamptz,
  source_snapshot_id bigint references metrics.raw_simpro_snapshots(id) on delete set null,
  extracted_at timestamptz not null default now()
);

create index if not exists schedule_snapshots_reference_idx
  on metrics.schedule_snapshots (reference_type, reference_id);

create table if not exists metrics.mobile_status_snapshots (
  log_id bigint primary key,
  staff_id bigint,
  staff_name text,
  work_order_id bigint,
  job_id bigint,
  status_name text,
  latitude numeric(10, 7),
  longitude numeric(10, 7),
  logged_at timestamptz,
  source_snapshot_id bigint references metrics.raw_simpro_snapshots(id) on delete set null,
  extracted_at timestamptz not null default now()
);

create index if not exists mobile_status_snapshots_job_idx
  on metrics.mobile_status_snapshots (job_id, logged_at);

create table if not exists metrics.metric_rollups (
  id bigserial primary key,
  scope text not null,
  period_start date not null,
  period_end date not null,
  metric_key text not null,
  metric_value numeric(18, 4) not null,
  dimensions jsonb not null default '{}'::jsonb,
  source_snapshot_count integer not null default 0,
  provisional boolean not null default false,
  rebuilt_at timestamptz not null default now(),
  unique (scope, period_start, period_end, metric_key, dimensions)
);

create index if not exists metric_rollups_scope_period_idx
  on metrics.metric_rollups (scope, period_start desc);

create table if not exists metrics.metrics_freshness (
  page_key text primary key,
  data_through timestamptz,
  last_successful_run_at timestamptz,
  last_failed_run_at timestamptz,
  last_ingestion_run_id bigint references metrics.ingestion_runs(id) on delete set null,
  last_error text,
  max_age_hours integer not null default 24,
  updated_at timestamptz not null default now()
);

create table if not exists metrics.quote_classification_overrides (
  id bigserial primary key,
  quote_id bigint not null,
  category text not null,
  won_override boolean,
  reason text not null,
  evidence_url text,
  actor_email text not null,
  created_at timestamptz not null default now(),
  active boolean not null default true
);

create index if not exists quote_classification_overrides_quote_idx
  on metrics.quote_classification_overrides (quote_id, created_at desc);

create table if not exists metrics.commission_roster (
  id bigserial primary key,
  employee_id bigint not null,
  display_name text not null,
  included boolean not null default true,
  tier text not null default 'standard',
  effective_start date not null,
  effective_end date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists metrics.commission_periods (
  id bigserial primary key,
  period_start date not null,
  period_end date not null,
  status metrics.commission_period_status not null default 'draft',
  config jsonb not null,
  source_watermarks jsonb not null default '{}'::jsonb,
  override_hash text not null default '',
  revision integer not null default 1,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (period_start, period_end, revision)
);

create table if not exists metrics.commission_overrides (
  id bigserial primary key,
  period_id bigint not null references metrics.commission_periods(id) on delete cascade,
  employee_id bigint not null,
  field_name text not null,
  before_value jsonb,
  after_value jsonb,
  reason text not null,
  evidence_url text,
  actor_email text not null,
  pool_treatment text not null check (pool_treatment in ('included', 'excluded', 'neutral')),
  revision integer not null default 1,
  created_at timestamptz not null default now()
);

create table if not exists metrics.commission_calculation_runs (
  id bigserial primary key,
  period_id bigint not null references metrics.commission_periods(id) on delete cascade,
  config jsonb not null,
  source_watermarks jsonb not null,
  override_hash text not null,
  employee_results jsonb not null,
  job_allocations jsonb not null,
  calculation_hash text not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  immutable boolean not null default true
);

create table if not exists metrics.commission_exports (
  id bigserial primary key,
  calculation_run_id bigint not null references metrics.commission_calculation_runs(id) on delete restrict,
  export_type metrics.export_type not null,
  storage_key text not null,
  file_hash text not null,
  exported_by text not null,
  exported_at timestamptz not null default now(),
  retained_until date not null
);

create table if not exists metrics.app_roles (
  id bigserial primary key,
  email text not null,
  role text not null check (role in ('admin', 'finance', 'operator', 'viewer')),
  created_by text,
  created_at timestamptz not null default now(),
  active boolean not null default true,
  unique (email, role)
);

create table if not exists metrics.audit_events (
  id bigserial primary key,
  actor_email text not null,
  action text not null,
  entity_type text not null,
  entity_id text not null,
  before_value jsonb,
  after_value jsonb,
  reason text,
  created_at timestamptz not null default now()
);

create table if not exists metrics.reconciliation_checks (
  id bigserial primary key,
  scope text not null,
  period_start date not null,
  period_end date not null,
  rollup_value numeric(18, 4),
  snapshot_value numeric(18, 4),
  upstream_sample_value numeric(18, 4),
  status text not null check (status in ('matched', 'mismatch', 'sample_missing')),
  detail jsonb not null default '{}'::jsonb,
  checked_at timestamptz not null default now()
);
