create schema if not exists metrics;

create table if not exists metrics.backfill_capacity_days (
  capacity_date date primary key,
  daily_request_ceiling integer not null check (daily_request_ceiling > 0),
  current_request_percent smallint not null default 60,
  reconciliation_request_percent smallint not null default 15,
  backfill_request_percent smallint not null default 25,
  current_requests integer not null default 0 check (current_requests >= 0),
  reconciliation_requests integer not null default 0 check (reconciliation_requests >= 0),
  backfill_requests integer not null default 0 check (backfill_requests >= 0),
  backfill_reserved_requests integer not null default 0 check (backfill_reserved_requests >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint backfill_capacity_share_check check (
    current_request_percent >= 60
    and reconciliation_request_percent >= 15
    and backfill_request_percent <= 25
    and current_request_percent + reconciliation_request_percent + backfill_request_percent = 100
  )
);

create table if not exists metrics.backfill_source_month_ledger (
  id bigserial primary key,
  source_family text not null check (source_family in (
    'quotes',
    'quote_nested',
    'jobs',
    'job_nested',
    'employees',
    'timesheets',
    'jobs_from_timesheets',
    'schedules',
    'invoices',
    'mobile_status'
  )),
  month_start date not null,
  month_end_exclusive date not null,
  execution_mode text not null default 'ingest' check (execution_mode in ('ingest', 'coverage_only')),
  required_for_completion boolean not null default true,
  depends_on text[] not null default '{}'::text[],
  work_phase text not null default 'ingest' check (work_phase in ('ingest', 'reconcile')),
  status text not null default 'planned' check (status in (
    'planned',
    'queued',
    'running',
    'reconciliation_pending',
    'completed',
    'paused',
    'dead_lettered',
    'cancelled'
  )),
  expected_pages integer not null check (expected_pages >= 0),
  expected_records integer not null check (expected_records >= 0),
  estimated_nested_requests integer not null check (estimated_nested_requests >= 0),
  estimated_requests integer not null check (estimated_requests >= 0),
  daily_request_ceiling integer not null check (daily_request_ceiling > 0),
  queue_priority integer not null default 200,
  request_slice_limit integer not null default 250 check (request_slice_limit between 1 and 250),
  actual_requests integer not null default 0 check (actual_requests >= 0),
  snapshot_count integer not null default 0 check (snapshot_count >= 0),
  normalized_count integer not null default 0 check (normalized_count >= 0),
  reconciled_source_records integer,
  reconciled_normalized_records integer,
  source_max_date date,
  normalized_coverage numeric(7, 4),
  reconciliation_status text not null default 'pending' check (reconciliation_status in (
    'pending', 'matched', 'mismatch', 'partial', 'unavailable'
  )),
  reconciliation_detail jsonb not null default '{}'::jsonb,
  continuation_token jsonb,
  retry_count integer not null default 0 check (retry_count >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 5),
  next_attempt_at timestamptz not null default now(),
  locked_by text,
  locked_at timestamptz,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  reserved_capacity_date date,
  reserved_requests integer not null default 0 check (reserved_requests between 0 and 250),
  last_error text,
  dead_lettered_at timestamptz,
  approved_by text not null,
  approved_at timestamptz not null,
  plan_hash text not null,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_family, month_start),
  constraint backfill_month_window_check check (
    extract(day from month_start) = 1
    and month_end_exclusive = (month_start + interval '1 month')::date
  ),
  constraint backfill_completion_gate_check check (
    status <> 'completed'
    or (
      continuation_token is null
      and (
        reconciliation_status = 'matched'
        or (
          required_for_completion = false
          and reconciliation_status in ('partial', 'unavailable')
        )
      )
    )
  ),
  constraint backfill_active_lease_check check (
    (
      status = 'running'
      and locked_by is not null
      and locked_at is not null
      and lease_expires_at is not null
      and heartbeat_at is not null
      and reserved_capacity_date is not null
    )
    or (
      status <> 'running'
      and locked_by is null
      and locked_at is null
      and lease_expires_at is null
      and heartbeat_at is null
      and reserved_capacity_date is null
      and reserved_requests = 0
    )
  ),
  constraint backfill_reservation_limit_check check (
    reserved_requests <= request_slice_limit
  )
);

create index if not exists backfill_source_month_ready_idx
  on metrics.backfill_source_month_ledger (status, next_attempt_at, queue_priority, month_start, id)
  where status in ('queued', 'reconciliation_pending');

create index if not exists backfill_source_month_lease_idx
  on metrics.backfill_source_month_ledger (lease_expires_at, id)
  where status = 'running';

create index if not exists backfill_source_month_coverage_idx
  on metrics.backfill_source_month_ledger (month_start, required_for_completion, reconciliation_status);

create table if not exists metrics.backfill_work_unit_runs (
  work_unit_id bigint not null references metrics.backfill_source_month_ledger(id) on delete cascade,
  ingestion_run_id bigint not null unique references metrics.ingestion_runs(id) on delete cascade,
  target_key text,
  created_at timestamptz not null default now(),
  primary key (work_unit_id, ingestion_run_id)
);

create index if not exists backfill_work_unit_runs_unit_idx
  on metrics.backfill_work_unit_runs (work_unit_id, ingestion_run_id);

create table if not exists metrics.backfill_reconciliation_results (
  id bigserial primary key,
  work_unit_id bigint not null references metrics.backfill_source_month_ledger(id) on delete cascade,
  status text not null check (status in ('matched', 'mismatch', 'partial', 'unavailable')),
  source_record_count integer not null check (source_record_count >= 0),
  normalized_record_count integer not null check (normalized_record_count >= 0),
  source_max_date date,
  missing_source_ids jsonb not null default '[]'::jsonb,
  extra_normalized_ids jsonb not null default '[]'::jsonb,
  detail jsonb not null default '{}'::jsonb,
  checked_at timestamptz not null default now()
);

create index if not exists backfill_reconciliation_unit_idx
  on metrics.backfill_reconciliation_results (work_unit_id, checked_at desc);

create or replace view metrics.backfill_month_coverage as
  select
    month_start,
    count(*) filter (where required_for_completion) as required_source_count,
    count(*) filter (
      where required_for_completion and status = 'completed' and reconciliation_status = 'matched'
    ) as completed_required_source_count,
    bool_and(status = 'completed' and reconciliation_status = 'matched')
      filter (where required_for_completion) as required_sources_complete,
    count(*) filter (where source_family = 'mobile_status' and reconciliation_status = 'partial')
      as mobile_partial_source_count,
    count(*) filter (where source_family = 'mobile_status' and reconciliation_status = 'unavailable')
      as mobile_unavailable_source_count,
    sum(actual_requests) as actual_requests,
    max(updated_at) as updated_at
  from metrics.backfill_source_month_ledger
  group by month_start;

comment on table metrics.backfill_source_month_ledger is
  'WP-04 source-fact ledger. Completion is independent of domain rollups and requires source-to-normalized reconciliation.';

comment on column metrics.backfill_source_month_ledger.expected_pages is
  'Approved pre-execution capacity estimate; it is not overwritten by observed ingestion counts.';

comment on column metrics.backfill_source_month_ledger.required_for_completion is
  'False only for independently disclosed historical coverage such as mobile status; it never weakens another source gate.';
