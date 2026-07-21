import { queryPostgres, type PostgresQuery } from "@/lib/store/postgres";

export type WorkerExecutionLease = {
  lockKey: string;
  owner: string;
};

const LEASE_SECONDS = 180;

export async function acquireWorkerExecutionLease(
  lease: WorkerExecutionLease,
  query: PostgresQuery = queryPostgres,
): Promise<boolean> {
  const result = await query<{ acquired: boolean }>(
    `with claimed as (
       insert into metrics.worker_execution_leases (
         lock_key, lease_owner, lease_expires_at, heartbeat_at, updated_at
       ) values ($1, $2, now() + make_interval(secs => $3), now(), now())
       on conflict (lock_key) do update set
         lease_owner = excluded.lease_owner,
         lease_expires_at = excluded.lease_expires_at,
         heartbeat_at = excluded.heartbeat_at,
         updated_at = now()
       where metrics.worker_execution_leases.lease_owner is null
          or metrics.worker_execution_leases.lease_expires_at is null
          or metrics.worker_execution_leases.lease_expires_at < now()
       returning lock_key
     ) select exists(select 1 from claimed) as acquired`,
    [lease.lockKey, lease.owner, LEASE_SECONDS],
  );
  return result.rows[0]?.acquired === true;
}

export async function heartbeatWorkerExecutionLease(
  lease: WorkerExecutionLease,
  query: PostgresQuery = queryPostgres,
): Promise<void> {
  const result = await query(
    `update metrics.worker_execution_leases
        set lease_expires_at = now() + make_interval(secs => $3),
            heartbeat_at = now(), updated_at = now()
      where lock_key = $1 and lease_owner = $2 and lease_expires_at > now()
      returning lock_key`,
    [lease.lockKey, lease.owner, LEASE_SECONDS],
  );
  if (!result.rowCount) throw new Error(`Lost worker execution lease ${lease.lockKey}.`);
}

export async function releaseWorkerExecutionLease(
  lease: WorkerExecutionLease,
  query: PostgresQuery = queryPostgres,
): Promise<void> {
  await query(
    `update metrics.worker_execution_leases
        set lease_owner = null, lease_expires_at = null, updated_at = now()
      where lock_key = $1 and lease_owner = $2`,
    [lease.lockKey, lease.owner],
  );
}
