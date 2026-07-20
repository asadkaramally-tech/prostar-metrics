create table if not exists metrics.profit_capacity_exact_backfill_targets (
  id bigserial primary key,
  contract text not null,
  target_type text not null check (target_type in ('job', 'cost_center', 'employee')),
  target_key text not null,
  job_id bigint,
  section_id bigint,
  cost_center_id bigint,
  employee_id bigint,
  period_start date,
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'source_deleted', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  locked_by text,
  lock_expires_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  source_snapshot_id bigint references metrics.raw_simpro_snapshots(id),
  last_error text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (contract, target_type, target_key)
);

create index if not exists profit_capacity_exact_backfill_claim_idx
  on metrics.profit_capacity_exact_backfill_targets (status, next_attempt_at, target_type, id)
  where status in ('queued', 'running');

create table if not exists metrics.profit_capacity_exact_backfill_control (
  lock_key text primary key,
  locked_by text,
  lock_expires_at timestamptz,
  heartbeat_at timestamptz,
  updated_at timestamptz not null default now()
);

comment on table metrics.profit_capacity_exact_backfill_targets is
  'Durable migration-026 exact-detail ledger. A target is complete only after raw provenance, canonical normalization, and monthly rebuild publication are durable.';
