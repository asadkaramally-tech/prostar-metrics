create index if not exists metrics_employee_timesheets_job_reference_active_idx
  on metrics.metrics_employee_timesheets (reference_id, employee_id, timesheet_id)
  include (work_date, total_hours)
  where source_deleted_at is null
    and reference_id is not null
    and total_hours > 0
    and lower(trim(coalesce(reference_type, ''))) = 'job';

create index if not exists metrics_quote_labor_active_quote_idx
  on metrics.metrics_quote_labor (quote_id)
  include (quantity_hours)
  where source_deleted_at is null;
