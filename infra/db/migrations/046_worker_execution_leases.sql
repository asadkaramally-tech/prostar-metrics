-- Cross-execution leases for scheduled workers. Azure Container Apps may
-- start a new scheduled execution while the prior execution is still active;
-- these durable leases make that overlap an inexpensive no-op.

create table if not exists metrics.worker_execution_leases (
  lock_key text primary key,
  lease_owner text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (lease_owner is null and lease_expires_at is null)
    or (lease_owner is not null and lease_expires_at is not null)
  )
);

comment on table metrics.worker_execution_leases is
  'Prevents overlapping scheduled executions of the same worker lane while allowing expired owners to be recovered.';
