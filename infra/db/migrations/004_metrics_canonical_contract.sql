create schema if not exists metrics;

-- Expand the ingestion enum without breaking workers deployed from earlier revisions.
alter type metrics.ingestion_entity_type add value if not exists 'quote_logs';
alter type metrics.ingestion_entity_type add value if not exists 'job_logs';
alter type metrics.ingestion_entity_type add value if not exists 'schedule_logs';
alter type metrics.ingestion_entity_type add value if not exists 'customer_invoice_logs';
alter type metrics.ingestion_entity_type add value if not exists 'quote_nested';
alter type metrics.ingestion_entity_type add value if not exists 'job_nested';
alter type metrics.ingestion_entity_type add value if not exists 'invoices';

create table if not exists metrics.source_change_events (
  source_family text not null,
  log_id bigint not null,
  date_logged timestamptz not null,
  source_entity_type text not null,
  source_entity_id text,
  message text,
  staff_id bigint,
  payload jsonb not null,
  payload_hash text not null,
  ingestion_run_id bigint references metrics.ingestion_runs(id) on delete set null,
  fetched_at timestamptz not null default now(),
  processed_at timestamptz,
  primary key (source_family, log_id)
);

create index if not exists source_change_events_cursor_idx
  on metrics.source_change_events (source_family, date_logged, log_id);

alter table metrics.ingestion_watermarks
  add column if not exists source_family text,
  add column if not exists date_logged timestamptz,
  add column if not exists log_id bigint,
  add column if not exists committed_date_logged timestamptz,
  add column if not exists committed_log_id bigint,
  add column if not exists overlap_start timestamptz,
  add column if not exists page_cursor jsonb,
  add column if not exists gap_detected boolean not null default false,
  add column if not exists complete_window boolean not null default false,
  add column if not exists expected_through timestamptz;

alter table metrics.raw_simpro_snapshots
  add column if not exists source_version text not null default 'current',
  add column if not exists complete_traversal boolean not null default false,
  add column if not exists parent_identity jsonb not null default '{}'::jsonb,
  add column if not exists source_deleted_at timestamptz;

alter table metrics.metrics_quotes
  add column if not exists source_snapshot_id bigint references metrics.raw_simpro_snapshots(id) on delete set null,
  add column if not exists source_hash text,
  add column if not exists source_version text not null default 'current',
  add column if not exists fetched_at timestamptz;

alter table metrics.metrics_quote_cost_centers
  add column if not exists section_id bigint,
  add column if not exists configured_cost_center_id bigint,
  add column if not exists source_snapshot_id bigint references metrics.raw_simpro_snapshots(id) on delete set null,
  add column if not exists source_hash text,
  add column if not exists fetched_at timestamptz;

alter table metrics.metrics_jobs
  add column if not exists source_snapshot_id bigint references metrics.raw_simpro_snapshots(id) on delete set null,
  add column if not exists source_hash text,
  add column if not exists source_version text not null default 'current',
  add column if not exists fetched_at timestamptz;

alter table metrics.metrics_job_cost_centers
  add column if not exists section_id bigint,
  add column if not exists configured_cost_center_id bigint,
  add column if not exists sell_value numeric(14, 2),
  add column if not exists cost_value numeric(14, 2),
  add column if not exists source_snapshot_id bigint references metrics.raw_simpro_snapshots(id) on delete set null,
  add column if not exists source_hash text,
  add column if not exists fetched_at timestamptz;

alter table metrics.metrics_employee_timesheets
  add column if not exists source_snapshot_id bigint references metrics.raw_simpro_snapshots(id) on delete set null,
  add column if not exists source_hash text,
  add column if not exists fetched_at timestamptz;

alter table metrics.metrics_schedules
  add column if not exists source_snapshot_id bigint references metrics.raw_simpro_snapshots(id) on delete set null,
  add column if not exists source_hash text,
  add column if not exists fetched_at timestamptz;

alter table metrics.metrics_mobile_status_logs
  add column if not exists source_snapshot_id bigint references metrics.raw_simpro_snapshots(id) on delete set null,
  add column if not exists source_hash text;

create table if not exists metrics.metrics_quote_labor (
  quote_id bigint not null references metrics.metrics_quotes(quote_id) on delete cascade,
  section_id bigint not null,
  cost_center_id bigint not null,
  labor_id bigint not null,
  labor_type_id bigint,
  labor_type_name text,
  quantity_hours numeric(12, 4),
  sell_ex_tax numeric(14, 2),
  actual_cost numeric(14, 2),
  source_snapshot_id bigint references metrics.raw_simpro_snapshots(id) on delete set null,
  source_hash text,
  source_deleted_at timestamptz,
  fetched_at timestamptz not null default now(),
  primary key (quote_id, section_id, cost_center_id, labor_id)
);

create table if not exists metrics.metrics_job_labor (
  job_id bigint not null references metrics.metrics_jobs(job_id) on delete cascade,
  section_id bigint not null,
  cost_center_id bigint not null,
  labor_id bigint not null,
  labor_type_id bigint,
  labor_type_name text,
  quantity_hours numeric(12, 4),
  sell_ex_tax numeric(14, 2),
  actual_cost numeric(14, 2),
  source_snapshot_id bigint references metrics.raw_simpro_snapshots(id) on delete set null,
  source_hash text,
  source_deleted_at timestamptz,
  fetched_at timestamptz not null default now(),
  primary key (job_id, section_id, cost_center_id, labor_id)
);

create table if not exists metrics.metrics_quote_items (
  quote_id bigint not null references metrics.metrics_quotes(quote_id) on delete cascade,
  section_id bigint not null,
  cost_center_id bigint not null,
  item_type text not null check (item_type in ('catalog', 'service_fee', 'one_off', 'prebuild')),
  item_id text not null,
  source_item_id bigint,
  description text,
  quantity numeric(12, 4),
  billable_status text,
  sell_ex_tax numeric(14, 2),
  estimated_cost numeric(14, 2),
  actual_cost numeric(14, 2),
  source_snapshot_id bigint references metrics.raw_simpro_snapshots(id) on delete set null,
  source_hash text,
  source_deleted_at timestamptz,
  fetched_at timestamptz not null default now(),
  primary key (quote_id, section_id, cost_center_id, item_type, item_id)
);

create table if not exists metrics.metrics_job_items (
  job_id bigint not null references metrics.metrics_jobs(job_id) on delete cascade,
  section_id bigint not null,
  cost_center_id bigint not null,
  item_type text not null check (item_type in ('catalog', 'service_fee', 'one_off', 'prebuild', 'stock')),
  item_id text not null,
  source_item_id bigint,
  description text,
  quantity numeric(12, 4),
  billable_status text,
  sell_ex_tax numeric(14, 2),
  estimated_cost numeric(14, 2),
  actual_cost numeric(14, 2),
  source_snapshot_id bigint references metrics.raw_simpro_snapshots(id) on delete set null,
  source_hash text,
  source_deleted_at timestamptz,
  fetched_at timestamptz not null default now(),
  primary key (job_id, section_id, cost_center_id, item_type, item_id)
);

create table if not exists metrics.metrics_work_orders (
  project_type text not null check (project_type in ('quote', 'job')),
  project_id bigint not null,
  section_id bigint not null,
  cost_center_id bigint not null,
  work_order_id bigint not null,
  staff_id bigint,
  work_order_date date,
  approved boolean,
  scheduled_hours numeric(10, 2),
  scheduled_start_at timestamptz,
  scheduled_end_at timestamptz,
  source_snapshot_id bigint references metrics.raw_simpro_snapshots(id) on delete set null,
  source_hash text,
  source_deleted_at timestamptz,
  fetched_at timestamptz not null default now(),
  primary key (project_type, project_id, section_id, cost_center_id, work_order_id)
);

create table if not exists metrics.metrics_schedule_blocks (
  schedule_id bigint not null,
  block_index integer not null check (block_index >= 0),
  staff_id bigint,
  reference_type text,
  reference_id bigint,
  schedule_rate_id bigint,
  planned_hours numeric(10, 2),
  planned_start_at timestamptz,
  planned_end_at timestamptz,
  source_snapshot_id bigint references metrics.raw_simpro_snapshots(id) on delete set null,
  source_hash text,
  source_deleted_at timestamptz,
  fetched_at timestamptz not null default now(),
  primary key (schedule_id, block_index)
);

create index if not exists metrics_schedule_blocks_reference_idx
  on metrics.metrics_schedule_blocks (reference_type, reference_id, staff_id, planned_start_at);

create table if not exists metrics.invoice_snapshots (
  invoice_type text not null check (invoice_type in ('job', 'global', 'customer')),
  invoice_id bigint not null,
  stage text,
  status_id bigint,
  status_name text,
  date_issued date,
  date_approved timestamptz,
  due_date date,
  date_paid date,
  ex_tax numeric(14, 2),
  inc_tax numeric(14, 2),
  paid numeric(14, 2),
  balance_due numeric(14, 2),
  is_paid boolean,
  is_credit boolean,
  is_voided boolean,
  source_snapshot_id bigint references metrics.raw_simpro_snapshots(id) on delete set null,
  source_hash text,
  source_deleted_at timestamptz,
  fetched_at timestamptz not null default now(),
  primary key (invoice_type, invoice_id)
);

create table if not exists metrics.invoice_job_links (
  invoice_type text not null,
  invoice_id bigint not null,
  job_id bigint not null,
  cost_center_id bigint,
  ex_tax numeric(14, 2),
  primary key (invoice_type, invoice_id, job_id, cost_center_id),
  foreign key (invoice_type, invoice_id)
    references metrics.invoice_snapshots(invoice_type, invoice_id) on delete cascade
);

create index if not exists invoice_job_links_job_idx
  on metrics.invoice_job_links (job_id, invoice_id);

alter table metrics.metrics_freshness
  add column if not exists source_family text,
  add column if not exists source_window_start timestamptz,
  add column if not exists source_window_end timestamptz,
  add column if not exists expected_through timestamptz,
  add column if not exists continuation_count integer not null default 0,
  add column if not exists coverage_json jsonb not null default '{}'::jsonb,
  add column if not exists reconciliation_status text,
  add column if not exists status text not null default 'building',
  add column if not exists last_reconciled_at timestamptz;

create table if not exists metrics.reconciliation_runs (
  id bigserial primary key,
  scope text not null,
  period_start date not null,
  period_end date not null,
  status text not null check (status in ('running', 'matched', 'mismatch', 'failed')),
  upstream_count bigint,
  snapshot_count bigint,
  rollup_count bigint,
  upstream_value numeric(18, 4),
  snapshot_value numeric(18, 4),
  rollup_value numeric(18, 4),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  error_message text,
  requested_by text
);

create table if not exists metrics.reconciliation_differences (
  id bigserial primary key,
  reconciliation_run_id bigint not null references metrics.reconciliation_runs(id) on delete cascade,
  entity_type text not null,
  entity_id text,
  difference_type text not null,
  upstream_value jsonb,
  snapshot_value jsonb,
  rollup_value jsonb,
  reason text,
  created_at timestamptz not null default now()
);

create index if not exists reconciliation_differences_run_idx
  on metrics.reconciliation_differences (reconciliation_run_id, difference_type);

create table if not exists metrics.commission_period_configs (
  period_id bigint not null references metrics.commission_periods(id) on delete cascade,
  revision integer not null,
  pool_pct numeric(7, 4) not null,
  min_bonus_pct numeric(7, 4) not null,
  efficiency_enabled boolean not null,
  max_efficiency_adjustment_pct numeric(7, 4) not null,
  on_time_threshold_minutes integer not null default 15,
  config_json jsonb not null,
  config_hash text not null,
  actor_email text not null,
  created_at timestamptz not null default now(),
  primary key (period_id, revision)
);

alter table metrics.commission_calculation_runs
  add column if not exists revision integer not null default 1,
  add column if not exists run_status text not null default 'succeeded',
  add column if not exists input_manifest_hash text,
  add column if not exists source_hash text,
  add column if not exists config_hash text,
  add column if not exists source_complete boolean not null default false,
  add column if not exists superseded_at timestamptz;

with ranked_runs as (
  select
    id,
    row_number() over (partition by period_id order by created_at, id)::integer as calculated_revision
  from metrics.commission_calculation_runs
)
update metrics.commission_calculation_runs as runs
set revision = ranked_runs.calculated_revision
from ranked_runs
where runs.id = ranked_runs.id
  and runs.revision <> ranked_runs.calculated_revision;

create unique index if not exists commission_runs_period_revision_idx
  on metrics.commission_calculation_runs (period_id, revision);

create table if not exists metrics.commission_run_inputs (
  run_id bigint not null references metrics.commission_calculation_runs(id) on delete cascade,
  input_type text not null,
  source_identity text not null,
  source_version text not null,
  source_hash text not null,
  input_json jsonb not null,
  created_at timestamptz not null default now(),
  primary key (run_id, input_type, source_identity)
);

alter table metrics.commission_exports
  add column if not exists content_type text,
  add column if not exists file_size_bytes bigint,
  add column if not exists idempotency_key text,
  add column if not exists download_count integer not null default 0,
  add column if not exists last_downloaded_at timestamptz;

create unique index if not exists commission_exports_idempotency_idx
  on metrics.commission_exports (idempotency_key)
  where idempotency_key is not null;

alter table metrics.quote_classification_overrides
  add column if not exists outcome text,
  add column if not exists previous_outcome text,
  add column if not exists revision integer not null default 1,
  add column if not exists idempotency_key text,
  add column if not exists superseded_at timestamptz;

create unique index if not exists quote_override_idempotency_idx
  on metrics.quote_classification_overrides (idempotency_key)
  where idempotency_key is not null;

-- Compatibility views expose plan terminology without creating parallel authorities.
create or replace view metrics.source_freshness as
  select * from metrics.metrics_freshness;

create or replace view metrics.report_exports as
  select
    id,
    calculation_run_id,
    export_type,
    storage_key,
    file_hash,
    content_type,
    file_size_bytes,
    exported_by as actor_email,
    exported_at as created_at,
    retained_until,
    idempotency_key,
    download_count,
    last_downloaded_at
  from metrics.commission_exports;

create or replace view metrics.audit_log as
  select
    id,
    actor_email,
    action,
    entity_type,
    entity_id,
    before_value as before_json,
    after_value as after_json,
    reason,
    created_at
  from metrics.audit_events;
