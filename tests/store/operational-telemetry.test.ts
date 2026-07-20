import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  acknowledgeOperationalTelemetrySignal,
  claimOperationalTelemetrySignals,
  DEAD_LETTER_ALERT_ID,
  INGESTION_FAILURE_ALERT_ID,
} from "../../src/lib/store/operational-telemetry";
import type { PostgresQuery } from "../../src/lib/store/postgres";

test("one or two durable ingestion failures do not emit the consecutive-failure signal", async () => {
  const fixture = await databaseFixture();
  try {
    await addRun(fixture.db, "quotes", "failed", "2026-07-09T10:00:00Z");
    assert.deepEqual(await claimOperationalTelemetrySignals(fixture.query), []);

    await addRun(fixture.db, "quotes", "failed", "2026-07-09T10:01:00Z");
    assert.deepEqual(await claimOperationalTelemetrySignals(fixture.query), []);
  } finally {
    await fixture.db.close();
  }
});

test("the third consecutive failure emits once from the threshold run", async () => {
  const fixture = await databaseFixture();
  try {
    await addRun(fixture.db, "quotes", "failed", "2026-07-09T10:00:00Z");
    await addRun(fixture.db, "quotes", "failed", "2026-07-09T10:01:00Z");
    await addRun(fixture.db, "quotes", "failed", "2026-07-09T10:02:00Z");

    const leaseOwner = "third-failure-worker";
    const emitted = await claimOperationalTelemetrySignals(fixture.query, { leaseOwner });
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]?.alertId, INGESTION_FAILURE_ALERT_ID);
    assert.equal(emitted[0]?.sourceFamily, "quotes");
    assert.equal(emitted[0]?.consecutiveFailures, 3);
    assert.equal(emitted[0]?.deadLetterCount, 0);
    assert.equal(emitted[0]?.occurredAt, "2026-07-09T10:02:00.000Z");
    assert.equal(await acknowledgeOperationalTelemetrySignal(emitted[0]!.eventKey, leaseOwner, fixture.query), true);
    assert.deepEqual(await claimOperationalTelemetrySignals(fixture.query), []);

    await addRun(fixture.db, "quotes", "failed", "2026-07-09T10:03:00Z");
    assert.deepEqual(await claimOperationalTelemetrySignals(fixture.query), []);
  } finally {
    await fixture.db.close();
  }
});

test("a completed success resets the source-family failure sequence", async () => {
  const fixture = await databaseFixture();
  try {
    await addRun(fixture.db, "jobs", "failed", "2026-07-09T10:00:00Z");
    await addRun(fixture.db, "jobs", "failed", "2026-07-09T10:01:00Z");
    await addRun(fixture.db, "jobs", "succeeded", "2026-07-09T10:02:00Z");
    await addRun(fixture.db, "jobs", "failed", "2026-07-09T10:03:00Z");
    await addRun(fixture.db, "jobs", "failed", "2026-07-09T10:04:00Z");
    assert.deepEqual(await claimOperationalTelemetrySignals(fixture.query), []);

    await addRun(fixture.db, "jobs", "failed", "2026-07-09T10:05:00Z");
    const concurrent = await Promise.all([
      claimOperationalTelemetrySignals(fixture.query, { leaseOwner: "concurrent-a" }),
      claimOperationalTelemetrySignals(fixture.query, { leaseOwner: "concurrent-b" }),
    ]);
    const emitted = concurrent.flat();
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]?.alertId, INGESTION_FAILURE_ALERT_ID);
    assert.equal(emitted[0]?.consecutiveFailures, 3);
    assert.equal(emitted[0]?.occurredAt, "2026-07-09T10:05:00.000Z");
    const owner = concurrent[0].length > 0 ? "concurrent-a" : "concurrent-b";
    assert.equal(await acknowledgeOperationalTelemetrySignal(emitted[0]!.eventKey, owner, fixture.query), true);
  } finally {
    await fixture.db.close();
  }
});

test("a newly dead-lettered item emits an immediate signal exactly once", async () => {
  const fixture = await databaseFixture();
  try {
    await fixture.db.exec(`
      insert into metrics.ingestion_jobs (entity_type, status, dead_lettered_at)
      values ('employees', 'failed', '2026-07-09T10:06:00Z')
    `);

    const leaseOwner = "dead-letter-worker";
    const emitted = await claimOperationalTelemetrySignals(fixture.query, { leaseOwner });
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]?.alertId, DEAD_LETTER_ALERT_ID);
    assert.equal(emitted[0]?.sourceFamily, "employees");
    assert.equal(emitted[0]?.consecutiveFailures, 0);
    assert.equal(emitted[0]?.deadLetterCount, 1);
    assert.equal(emitted[0]?.occurredAt, "2026-07-09T10:06:00.000Z");
    assert.equal(await acknowledgeOperationalTelemetrySignal(emitted[0]!.eventKey, leaseOwner, fixture.query), true);
    assert.deepEqual(await claimOperationalTelemetrySignals(fixture.query), []);
  } finally {
    await fixture.db.close();
  }
});

test("a crash before acknowledgement leaves a leased outbox item retryable exactly once", async () => {
  const fixture = await databaseFixture();
  try {
    await fixture.db.exec(`
      insert into metrics.ingestion_jobs (entity_type, status, dead_lettered_at)
      values ('quotes', 'failed', '2026-07-09T10:07:00Z')
    `);

    const first = await claimOperationalTelemetrySignals(fixture.query, { leaseOwner: "crashed-worker" });
    assert.equal(first.length, 1);
    assert.deepEqual(
      await claimOperationalTelemetrySignals(fixture.query, { leaseOwner: "blocked-worker" }),
      [],
    );

    await fixture.db.exec(`
      update metrics.operational_telemetry_emissions
         set lease_expires_at = clock_timestamp() - interval '1 second'
       where event_key = '${first[0]!.eventKey}'
    `);
    const retried = await claimOperationalTelemetrySignals(fixture.query, { leaseOwner: "retry-worker" });
    assert.equal(retried.length, 1);
    assert.equal(retried[0]?.eventKey, first[0]?.eventKey);
    assert.deepEqual(
      await claimOperationalTelemetrySignals(fixture.query, { leaseOwner: "concurrent-worker" }),
      [],
    );
    assert.equal(
      await acknowledgeOperationalTelemetrySignal(retried[0]!.eventKey, "crashed-worker", fixture.query),
      false,
    );
    assert.equal(
      await acknowledgeOperationalTelemetrySignal(retried[0]!.eventKey, "retry-worker", fixture.query),
      true,
    );
    const delivery = await fixture.db.query<{
      delivery_status: string;
      delivery_attempts: number;
      delivered_at: string | null;
    }>(`
      select delivery_status, delivery_attempts, delivered_at::text
        from metrics.operational_telemetry_emissions
       where event_key = $1
    `, [retried[0]!.eventKey]);
    assert.equal(delivery.rows[0]?.delivery_status, "delivered");
    assert.equal(Number(delivery.rows[0]?.delivery_attempts), 2);
    assert.ok(delivery.rows[0]?.delivered_at);
    assert.deepEqual(await claimOperationalTelemetrySignals(fixture.query), []);
  } finally {
    await fixture.db.close();
  }
});

async function databaseFixture() {
  const db = new PGlite();
  await db.exec(`
    create schema metrics;
    create table metrics.ingestion_runs (
      id bigserial primary key,
      entity_type text not null,
      source_family text,
      status text not null,
      finished_at timestamptz
    );
    create table metrics.ingestion_jobs (
      id bigserial primary key,
      entity_type text not null,
      status text not null,
      dead_lettered_at timestamptz
    );
    create table metrics.backfill_source_month_ledger (
      id bigserial primary key,
      source_family text not null,
      status text not null,
      dead_lettered_at timestamptz
    );
    create table metrics.operational_telemetry_emissions (
      event_key text primary key,
      event_name text not null,
      source_family text not null,
      evidence_kind text not null,
      evidence_id text not null,
      occurred_at timestamptz not null,
      metric_value integer not null,
      recorded_at timestamptz not null default clock_timestamp(),
      delivery_status text not null default 'pending',
      delivery_attempts integer not null default 0,
      lease_owner text,
      lease_expires_at timestamptz,
      last_attempted_at timestamptz,
      delivered_at timestamptz
    );
  `);
  const query = db.query.bind(db) as unknown as PostgresQuery;
  return { db, query };
}

async function addRun(db: PGlite, sourceFamily: string, status: string, finishedAt: string) {
  await db.query(
    `insert into metrics.ingestion_runs (entity_type, source_family, status, finished_at)
     values ($1, $1, $2, $3::timestamptz)`,
    [sourceFamily, status, finishedAt],
  );
}
