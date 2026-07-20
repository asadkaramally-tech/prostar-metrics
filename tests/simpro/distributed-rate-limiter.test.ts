import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  DistributedRateLimitCapacityError,
  DistributedSimproRateLimiter,
  reserveDistributedRateLimitSql,
  reserveDistributedRateLimitSlot,
} from "../../src/lib/simpro/distributed-rate-limiter";
import type { PostgresQuery } from "../../src/lib/store/postgres";

test("GCRA reservations do not burst across a fixed-second boundary", async () => {
  const dbNow = 999;
  let nextPermittedAt: number | null = null;
  let reservationCount = 0;
  const scheduled: number[] = [];
  const query: PostgresQuery = async <T>(_sql: string, values?: unknown[]) => {
    const rate = Number(values?.[1]);
    const maxWaitMs = Number(values?.[2]);
    const spacing = 1000 / rate;
    const arrival = Math.max(dbNow, nextPermittedAt ?? dbNow);
    if (arrival - dbNow > maxWaitMs) return { rows: [], rowCount: 0 };
    nextPermittedAt = arrival + spacing;
    reservationCount += 1;
    scheduled.push(arrival);
    return {
      rows: [{
        scheduled_at: new Date(arrival).toISOString(),
        wait_ms: arrival - dbNow,
        reservation_count: reservationCount,
      }] as T[],
      rowCount: 1,
    };
  };
  const waits: number[] = [];
  const limiters = Array.from({ length: 10 }, () => new DistributedSimproRateLimiter(
    5,
    "simulated-boundary",
    { query, maxWaitMs: 2_000, sleep: async (ms) => { waits.push(ms); } },
  ));

  await Promise.all(limiters.map((limiter) => limiter.wait()));

  assert.deepEqual(scheduled, [999, 1199, 1399, 1599, 1799, 1999, 2199, 2399, 2599, 2799]);
  assert.deepEqual(waits, [200, 400, 600, 800, 1000, 1200, 1400, 1600, 1800]);
  for (const start of scheduled) {
    assert.ok(scheduled.filter((value) => value >= start && value < start + 1000).length <= 5);
  }
});

test("reservation capacity is bounded and fails without polling", async () => {
  let queries = 0;
  let sleeps = 0;
  const limiter = new DistributedSimproRateLimiter(5, "bounded", {
    maxWaitMs: 250,
    query: async <T>() => {
      queries += 1;
      return { rows: [] as T[], rowCount: 0 };
    },
    sleep: async () => { sleeps += 1; },
  });

  await assert.rejects(limiter.wait(), DistributedRateLimitCapacityError);
  assert.equal(queries, 1);
  assert.equal(sleeps, 0);
});

test("the production reservation is one atomic DB-clock statement with no database sleep", () => {
  assert.match(reserveDistributedRateLimitSql, /clock_timestamp\(\)/);
  assert.match(reserveDistributedRateLimitSql, /on conflict \(bucket_key\) do update/);
  assert.match(reserveDistributedRateLimitSql, /greatest\([\s\S]*next_permitted_at/);
  assert.doesNotMatch(reserveDistributedRateLimitSql, /date_trunc\('second'/);
  assert.doesNotMatch(reserveDistributedRateLimitSql, /pg_sleep/);
  assert.deepEqual(
    [...reserveDistributedRateLimitSql.matchAll(/\$\d+/g)].map((match) => match[0]),
    ["$1", "$2", "$3"],
  );
  assert.match(
    reserveDistributedRateLimitSql,
    /select \$1::text as bucket_key,[\s\S]*\$2::integer as requests_per_second,[\s\S]*\$3::integer as max_wait_ms/,
  );
});

test("PostgreSQL resolves limiter parameter and interval types without ambiguity", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create schema metrics;
      create table metrics.simpro_rate_limit_buckets (
        bucket_key text primary key,
        window_started_at timestamptz not null,
        request_count integer not null default 0 check (request_count >= 0),
        limit_per_second integer not null check (limit_per_second between 1 and 5),
        updated_at timestamptz not null default now(),
        next_permitted_at timestamptz not null,
        reservation_count bigint not null default 0
      );
    `);
    const query: PostgresQuery = async <T>(sql: string, values?: unknown[]) => {
      const result = await db.query<T>(sql, values);
      return { rows: result.rows, rowCount: result.affectedRows ?? null };
    };

    const first = await reserveDistributedRateLimitSlot({
      bucketKey: "pglite-type-regression",
      requestsPerSecond: 5,
      maxWaitMs: 1_000,
      query,
    });
    const second = await reserveDistributedRateLimitSlot({
      bucketKey: "pglite-type-regression",
      requestsPerSecond: 5,
      maxWaitMs: 1_000,
      query,
    });

    assert.equal(first.reservationCount, 1);
    assert.equal(second.reservationCount, 2);
    assert.ok(Date.parse(second.scheduledAt) - Date.parse(first.scheduledAt) >= 199);
    assert.ok(second.waitMs >= 0 && second.waitMs <= 1_000);
  } finally {
    await db.close();
  }
});
