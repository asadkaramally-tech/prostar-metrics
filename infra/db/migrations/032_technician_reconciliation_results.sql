create schema if not exists metrics;

create table if not exists metrics.technician_reconciliation_results (
  reconciliation_check_id bigint not null references metrics.reconciliation_checks(id) on delete restrict,
  period_start date not null,
  period_end date not null,
  employee_id text not null,
  status text not null check (status in ('matched', 'mismatch')),
  source_count numeric(18, 6) not null,
  served_count numeric(18, 6) not null,
  source_value numeric(18, 6) not null,
  served_value numeric(18, 6) not null,
  source_hours numeric(18, 6) not null,
  served_hours numeric(18, 6) not null,
  source_input_hash text not null,
  read_model_source_hash text not null,
  detail jsonb not null default '{}'::jsonb,
  checked_at timestamptz not null,
  primary key (reconciliation_check_id, employee_id),
  constraint technician_reconciliation_results_month_check check (
    extract(day from period_start) = 1
    and period_end = (period_start + interval '1 month - 1 day')::date
  )
);

create index if not exists technician_reconciliation_results_period_employee_idx
  on metrics.technician_reconciliation_results (period_start, employee_id, checked_at desc);

create or replace function metrics.reject_technician_reconciliation_result_change()
returns trigger
language plpgsql
as $$
begin
  raise exception 'technician reconciliation results are immutable' using errcode = '55000';
end;
$$;

drop trigger if exists technician_reconciliation_results_immutable
  on metrics.technician_reconciliation_results;
create trigger technician_reconciliation_results_immutable
before update or delete on metrics.technician_reconciliation_results
for each row execute function metrics.reject_technician_reconciliation_result_change();

comment on table metrics.technician_reconciliation_results is
  'Immutable employee-keyed source-versus-read-model comparisons published with an authoritative complete technician reconciliation check. No monthly aggregate may be copied into these rows.';
comment on column metrics.technician_reconciliation_results.source_count is
  'The technician completed-job credit derived independently from mapped source timesheet shares.';
comment on column metrics.technician_reconciliation_results.served_count is
  'The same technician completed-job credit served by the persisted monthly read model.';
