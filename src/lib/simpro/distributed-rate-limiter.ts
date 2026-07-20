import { getDatabaseConfigStatus, queryPostgres, type PostgresQuery } from "@/lib/store/postgres";

type ReservationRow = {
  scheduled_at: Date | string;
  wait_ms: number | string;
  reservation_count: number | string;
};

export type DistributedRateLimiterDependencies = {
  query?: PostgresQuery;
  sleep?: (ms: number) => Promise<void>;
  maxWaitMs?: number;
};

export class DistributedRateLimitCapacityError extends Error {
  constructor(readonly bucketKey: string, readonly maxWaitMs: number) {
    super(`Distributed Simpro rate-limit capacity exceeds the bounded ${maxWaitMs}ms wait for ${bucketKey}.`);
    this.name = "DistributedRateLimitCapacityError";
  }
}

export type DistributedRateLimitReservation = {
  scheduledAt: string;
  waitMs: number;
  reservationCount: number;
};

// One statement reserves one theoretical arrival time. The row update commits
// before wait() sleeps, so no connection or transaction is held by the delay.
export const reserveDistributedRateLimitSql = `with input as materialized (
  select $1::text as bucket_key,
         $2::integer as requests_per_second,
         $3::integer as max_wait_ms
), clock as materialized (
  select clock_timestamp() as db_now
), reserved as (
  insert into metrics.simpro_rate_limit_buckets (
    bucket_key, window_started_at, request_count, limit_per_second,
    updated_at, next_permitted_at, reservation_count
  )
  select input.bucket_key, clock.db_now, 1::integer, input.requests_per_second, clock.db_now,
         clock.db_now + (interval '1 second' / input.requests_per_second::double precision),
         1::bigint
    from input
   cross join clock
  on conflict (bucket_key) do update set
    window_started_at = excluded.window_started_at,
    request_count = least(
      2147483647::bigint,
      metrics.simpro_rate_limit_buckets.request_count::bigint + 1
    )::integer,
    limit_per_second = excluded.limit_per_second,
    updated_at = excluded.updated_at,
    next_permitted_at = greatest(
      metrics.simpro_rate_limit_buckets.next_permitted_at,
      excluded.window_started_at
    ) + (excluded.next_permitted_at - excluded.window_started_at),
    reservation_count = metrics.simpro_rate_limit_buckets.reservation_count + 1
  where greatest(
          metrics.simpro_rate_limit_buckets.next_permitted_at,
          excluded.window_started_at
        ) <= excluded.window_started_at
          + ((select max_wait_ms::double precision from input) * interval '1 millisecond')
  returning
    next_permitted_at - (interval '1 second' / limit_per_second::double precision) as scheduled_at,
    updated_at as reserved_at,
    reservation_count
)
select scheduled_at::text,
       greatest(
         0,
         ceiling(extract(epoch from (scheduled_at - reserved_at)) * 1000)
       )::integer as wait_ms,
       reservation_count::text
  from reserved`;

export class DistributedSimproRateLimiter {
  private readonly query: PostgresQuery;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxWaitMs: number;
  private readonly usesDefaultQuery: boolean;

  constructor(
    private readonly requestsPerSecond: number,
    private readonly bucketKey = "simpro-global",
    dependencies: DistributedRateLimiterDependencies = {},
  ) {
    this.query = dependencies.query ?? queryPostgres;
    this.sleep = dependencies.sleep ?? sleep;
    this.maxWaitMs = boundedWait(dependencies.maxWaitMs ?? 10_000);
    this.usesDefaultQuery = !dependencies.query;
  }

  async wait(): Promise<void> {
    if (this.usesDefaultQuery && !getDatabaseConfigStatus().configured) {
      throw new Error("AZURE_POSTGRES_CONNECTION_STRING is required for distributed Simpro rate limiting.");
    }

    const reservation = await reserveDistributedRateLimitSlot({
      bucketKey: this.bucketKey,
      requestsPerSecond: this.requestsPerSecond,
      maxWaitMs: this.maxWaitMs,
      query: this.query,
    });
    if (reservation.waitMs > 0) await this.sleep(reservation.waitMs);
  }
}

export async function reserveDistributedRateLimitSlot(params: {
  bucketKey: string;
  requestsPerSecond: number;
  maxWaitMs: number;
  query?: PostgresQuery;
}): Promise<DistributedRateLimitReservation> {
  const query = params.query ?? queryPostgres;
  const limit = Math.max(1, Math.min(5, Math.trunc(params.requestsPerSecond)));
  const maxWaitMs = boundedWait(params.maxWaitMs);
  const result = await query<ReservationRow>(reserveDistributedRateLimitSql, [
    params.bucketKey,
    limit,
    maxWaitMs,
  ]);
  const reservation = result.rows[0];
  if (!reservation) throw new DistributedRateLimitCapacityError(params.bucketKey, maxWaitMs);

  const waitMs = Number(reservation.wait_ms);
  const reservationCount = Number(reservation.reservation_count);
  const scheduledAt = new Date(reservation.scheduled_at);
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > maxWaitMs) {
    throw new Error(`Invalid distributed Simpro rate-limit reservation wait: ${String(reservation.wait_ms)}.`);
  }
  if (!Number.isSafeInteger(reservationCount) || reservationCount <= 0 || Number.isNaN(scheduledAt.getTime())) {
    throw new Error("Invalid distributed Simpro rate-limit reservation response.");
  }
  return { scheduledAt: scheduledAt.toISOString(), waitMs, reservationCount };
}

function boundedWait(value: number) {
  if (!Number.isInteger(value) || value < 0 || value > 60_000) {
    throw new Error("Distributed rate limiter maxWaitMs must be an integer from 0 through 60000.");
  }
  return value;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
