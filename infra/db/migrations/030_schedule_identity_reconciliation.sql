create schema if not exists metrics;

alter table metrics.metrics_schedule_blocks
  add column if not exists work_order_id bigint;

alter table metrics.metrics_schedule_blocks
  add column if not exists cancelled boolean not null default false;

create index if not exists metrics_schedule_blocks_visit_identity_idx
  on metrics.metrics_schedule_blocks (
    staff_id, reference_type, reference_id, work_order_id, planned_start_at
  )
  where source_deleted_at is null and not cancelled;

create index if not exists reconciliation_checks_technician_period_latest_idx
  on metrics.reconciliation_checks (period_start, period_end, checked_at desc, id desc)
  where scope = 'technicians';

comment on column metrics.metrics_schedule_blocks.work_order_id is
  'Nullable Simpro work-order identity from the schedule block or its parent schedule payload.';

comment on column metrics.metrics_schedule_blocks.cancelled is
  'Explicit Simpro cancellation state. Legacy rows default false and are never inferred cancelled from missing payload fields or text.';
