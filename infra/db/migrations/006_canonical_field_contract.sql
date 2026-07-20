create schema if not exists metrics;

alter table metrics.metrics_quotes
  add column if not exists name text,
  add column if not exists description text,
  add column if not exists status_id bigint,
  add column if not exists status_name text,
  add column if not exists is_closed boolean,
  add column if not exists outcome text not null default 'unknown',
  add column if not exists outcome_reason text not null default 'unclassified',
  add column if not exists deal_tier text,
  add column if not exists category_basis text;

alter table metrics.metrics_quotes
  drop constraint if exists metrics_quotes_outcome_check;

alter table metrics.metrics_quotes
  add constraint metrics_quotes_outcome_check
  check (outcome in ('won', 'lost', 'open', 'excluded', 'unknown'));

alter table metrics.metrics_jobs
  add column if not exists name text,
  add column if not exists description text,
  add column if not exists status_id bigint,
  add column if not exists status_name text,
  add column if not exists converted_from_at timestamptz;

alter table metrics.metrics_quote_cost_centers
  add column if not exists gross_profit_actual numeric(14, 2),
  add column if not exists gross_margin_actual numeric(8, 4);

alter table metrics.metrics_job_cost_centers
  add column if not exists gross_profit_actual numeric(14, 2),
  add column if not exists gross_margin_actual numeric(8, 4);

-- Legacy embedded rows did not retain section identity. Zero is an explicit
-- migration-only unknown section, never a Simpro section ID.
update metrics.metrics_quote_cost_centers set section_id = 0 where section_id is null;
update metrics.metrics_job_cost_centers set section_id = 0 where section_id is null;

alter table metrics.metrics_quote_cost_centers alter column section_id set not null;
alter table metrics.metrics_job_cost_centers alter column section_id set not null;

alter table metrics.metrics_quote_cost_centers
  drop constraint if exists metrics_quote_cost_centers_pkey;
alter table metrics.metrics_quote_cost_centers
  add primary key (quote_id, section_id, cost_center_id);

alter table metrics.metrics_job_cost_centers
  drop constraint if exists metrics_job_cost_centers_pkey;
alter table metrics.metrics_job_cost_centers
  add primary key (job_id, section_id, cost_center_id);

alter table metrics.dim_people
  add column if not exists email text,
  add column if not exists position text,
  add column if not exists source_created_at timestamptz,
  add column if not exists source_modified_at timestamptz;

alter table metrics.metrics_employee_timesheets
  add column if not exists schedule_rate_id bigint,
  add column if not exists schedule_rate_name text;

do $$
begin
  if not exists (select 1 from metrics.metrics_employee_timesheets where employee_id is null) then
    alter table metrics.metrics_employee_timesheets alter column employee_id set not null;
  end if;
end $$;

alter table metrics.metrics_employee_timesheets
  drop constraint if exists metrics_employee_timesheets_pkey;

create unique index if not exists metrics_employee_timesheets_employee_uid_idx
  on metrics.metrics_employee_timesheets (employee_id, timesheet_id) nulls not distinct;

alter table metrics.metrics_schedules
  add column if not exists schedule_rate_id bigint,
  add column if not exists schedule_rate_name text,
  add column if not exists reference_raw text,
  add column if not exists source_modified_at timestamptz;

create index if not exists metrics_quotes_outcome_period_idx
  on metrics.metrics_quotes (outcome, date_approved, quote_id)
  where source_deleted_at is null;

create index if not exists metrics_jobs_conversion_idx
  on metrics.metrics_jobs (converted_from_type, converted_from_id, job_id)
  where source_deleted_at is null and converted_from_id is not null;
