import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  acknowledgeOperationalTelemetrySignal,
  claimOperationalTelemetrySignals,
  type OperationalTelemetrySignal,
} from "../../src/lib/store/operational-telemetry";
import type { PostgresQuery } from "../../src/lib/store/postgres";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));

test("a subprocess output error never acknowledges and leaves the claimed event retryable", async () => {
  const fixture = await persistentClaimedSignal("failed-output-worker");
  try {
    const child = runChild(`
      import { Writable } from 'node:stream';
      import { PGlite } from '@electric-sql/pglite';
      import { emitClaimedOperationalTelemetrySignal } from './workers/emit-operational-telemetry.ts';
      import { acknowledgeOperationalTelemetrySignal } from './src/lib/store/operational-telemetry.ts';

      const signal = JSON.parse(process.env.OPERATIONAL_TELEMETRY_TEST_SIGNAL);
      const leaseOwner = process.env.OPERATIONAL_TELEMETRY_TEST_OWNER;
      const db = new PGlite(process.env.OPERATIONAL_TELEMETRY_TEST_DATABASE);
      const query = db.query.bind(db);
      let acknowledgeAttempted = false;
      let failureMessage = null;
      let output;
      output = new Writable({
        highWaterMark: 1,
        write(_chunk, _encoding, callback) {
          setImmediate(() => callback(new Error('simulated stdout handoff failure')));
        },
      });

      try {
        await emitClaimedOperationalTelemetrySignal(signal, leaseOwner, {
          output,
          acknowledge: async (eventKey, owner) => {
            acknowledgeAttempted = true;
            return acknowledgeOperationalTelemetrySignal(eventKey, owner, query);
          },
        });
      } catch (error) {
        failureMessage = error instanceof Error ? error.message : String(error);
      }

      await db.close();
      process.stdout.write(JSON.stringify({ acknowledgeAttempted, failureMessage }));
      process.exitCode = acknowledgeAttempted ? 91 : 73;
    `, fixture);

    assert.equal(child.status, 73, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), {
      acknowledgeAttempted: false,
      failureMessage: "simulated stdout handoff failure",
    });
    assert.deepEqual(await deliveryState(fixture.directory, fixture.signal.eventKey), {
      deliveryStatus: "pending",
      deliveryAttempts: 1,
      deliveredAt: null,
    });

    const retried = await expireAndClaim(fixture.directory, "failed-output-retry");
    assert.equal(retried.eventKey, fixture.signal.eventKey);
    await withDatabase(fixture.directory, async (db, query) => {
      assert.equal(
        await acknowledgeOperationalTelemetrySignal(retried.eventKey, "failed-output-retry", query),
        true,
      );
    });
    assert.deepEqual(await deliveryState(fixture.directory, fixture.signal.eventKey), {
      deliveryStatus: "delivered",
      deliveryAttempts: 2,
      deliveredAt: "set",
    });
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("a subprocess crash after handoff retries the stable eventKey and acknowledges only after drain", async () => {
  const fixture = await persistentClaimedSignal("pre-ack-crash-worker");
  try {
    const crashed = runChild(`
      import { writeOperationalTelemetryLine } from './workers/emit-operational-telemetry.ts';

      const signal = JSON.parse(process.env.OPERATIONAL_TELEMETRY_TEST_SIGNAL);
      await writeOperationalTelemetryLine(signal);
      process.exit(86);
    `, fixture);

    assert.equal(crashed.status, 86, crashed.stderr);
    const firstHandoff = JSON.parse(crashed.stdout.trim());
    assert.equal(firstHandoff.eventKey, fixture.signal.eventKey);
    assert.deepEqual(await deliveryState(fixture.directory, fixture.signal.eventKey), {
      deliveryStatus: "pending",
      deliveryAttempts: 1,
      deliveredAt: null,
    });

    const retried = await expireAndClaim(fixture.directory, "pre-ack-retry-worker");
    assert.equal(retried.eventKey, fixture.signal.eventKey);
    const delivered = runChild(`
      import { Writable } from 'node:stream';
      import { PGlite } from '@electric-sql/pglite';
      import { emitClaimedOperationalTelemetrySignal } from './workers/emit-operational-telemetry.ts';
      import { acknowledgeOperationalTelemetrySignal } from './src/lib/store/operational-telemetry.ts';

      const signal = JSON.parse(process.env.OPERATIONAL_TELEMETRY_TEST_SIGNAL);
      const leaseOwner = process.env.OPERATIONAL_TELEMETRY_TEST_OWNER;
      const db = new PGlite(process.env.OPERATIONAL_TELEMETRY_TEST_DATABASE);
      const query = db.query.bind(db);
      let drainObserved = false;
      const output = new Writable({
        highWaterMark: 1,
        write(chunk, _encoding, callback) {
          process.stdout.write(chunk, callback);
        },
      });
      output.on('drain', () => {
        drainObserved = true;
      });

      await emitClaimedOperationalTelemetrySignal(signal, leaseOwner, {
        output,
        acknowledge: async (eventKey, owner) => {
          if (!drainObserved) throw new Error('acknowledgement ran before backpressure drained');
          return acknowledgeOperationalTelemetrySignal(eventKey, owner, query);
        },
      });
      await db.close();
    `, {
      directory: fixture.directory,
      signal: retried,
      leaseOwner: "pre-ack-retry-worker",
    });

    assert.equal(delivered.status, 0, delivered.stderr);
    const retryHandoff = JSON.parse(delivered.stdout.trim());
    assert.equal(retryHandoff.eventKey, fixture.signal.eventKey);
    assert.equal(new Set([firstHandoff.eventKey, retryHandoff.eventKey]).size, 1);
    assert.deepEqual(await deliveryState(fixture.directory, fixture.signal.eventKey), {
      deliveryStatus: "delivered",
      deliveryAttempts: 2,
      deliveredAt: "set",
    });
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

function runChild(
  source: string,
  fixture: { directory: string; signal: OperationalTelemetrySignal; leaseOwner: string },
) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", source],
    {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        OPERATIONAL_TELEMETRY_TEST_DATABASE: fixture.directory,
        OPERATIONAL_TELEMETRY_TEST_OWNER: fixture.leaseOwner,
        OPERATIONAL_TELEMETRY_TEST_SIGNAL: JSON.stringify(fixture.signal),
      },
    },
  );
}

async function persistentClaimedSignal(leaseOwner: string) {
  const directory = await mkdtemp(join(tmpdir(), "prostar-operational-telemetry-"));
  try {
    const signal = await withDatabase(directory, async (db, query) => {
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
        insert into metrics.ingestion_jobs (entity_type, status, dead_lettered_at)
        values ('quotes', 'failed', '2026-07-13T20:00:00Z');
      `);
      const signals = await claimOperationalTelemetrySignals(query, { leaseOwner });
      assert.equal(signals.length, 1);
      return signals[0]!;
    });
    return { directory, signal, leaseOwner };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function expireAndClaim(directory: string, leaseOwner: string) {
  return withDatabase(directory, async (db, query) => {
    await db.exec(`
      update metrics.operational_telemetry_emissions
         set lease_expires_at = clock_timestamp() - interval '1 second'
       where delivery_status = 'pending'
    `);
    const signals = await claimOperationalTelemetrySignals(query, { leaseOwner });
    assert.equal(signals.length, 1);
    return signals[0]!;
  });
}

async function deliveryState(directory: string, eventKey: string) {
  return withDatabase(directory, async (db) => {
    const result = await db.query<{
      delivery_status: string;
      delivery_attempts: number;
      delivered_at: string | null;
    }>(`
      select delivery_status, delivery_attempts, delivered_at::text
        from metrics.operational_telemetry_emissions
       where event_key = $1
    `, [eventKey]);
    const row = result.rows[0]!;
    return {
      deliveryStatus: row.delivery_status,
      deliveryAttempts: Number(row.delivery_attempts),
      deliveredAt: row.delivered_at === null ? null : "set",
    };
  });
}

async function withDatabase<T>(
  directory: string,
  action: (db: PGlite, query: PostgresQuery) => Promise<T>,
) {
  const db = new PGlite(directory);
  try {
    const query = db.query.bind(db) as unknown as PostgresQuery;
    return await action(db, query);
  } finally {
    await db.close();
  }
}
