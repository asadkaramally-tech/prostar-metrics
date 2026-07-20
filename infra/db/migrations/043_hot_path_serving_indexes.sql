create index if not exists metrics_employee_timesheets_work_date_employee_active_idx
  on metrics.metrics_employee_timesheets (work_date, employee_id, timesheet_id)
  include (total_hours)
  where source_deleted_at is null
    and employee_id is not null;

create index if not exists metrics_jobs_completed_serving_active_idx
  on metrics.metrics_jobs (completed_date, job_id)
  where source_deleted_at is null
    and lower(trim(stage)) in ('complete', 'archived');

create index if not exists metrics_quotes_date_approved_serving_active_idx
  on metrics.metrics_quotes (date_approved, quote_id)
  where source_deleted_at is null
    and date_approved is not null;
