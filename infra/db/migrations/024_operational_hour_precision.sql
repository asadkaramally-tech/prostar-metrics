create schema if not exists metrics;

alter table metrics.metrics_employee_timesheets
  alter column total_hours type numeric(12, 4);

alter table metrics.timesheet_snapshots
  alter column total_hours type numeric(12, 4);

alter table metrics.metrics_schedules
  alter column total_hours type numeric(12, 4);

alter table metrics.metrics_schedule_blocks
  alter column planned_hours type numeric(12, 4);
