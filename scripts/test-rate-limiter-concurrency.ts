import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  reserveDistributedRateLimitSlot,
  type DistributedRateLimitReservation,
} from "../src/lib/simpro/distributed-rate-limiter";
import { closePostgresPool, queryPostgres } from "../src/lib/store/postgres";

const RATE_LIMIT_POSTGRES_ENV = Object.freeze({
  POSTGRES_POOL_MAX: "1",
  POSTGRES_CONNECTION_TIMEOUT_MS: "60000",
  POSTGRES_POOL_IDLE_TIMEOUT_MS: "1000",
});
const RESERVATION_COUNT = 12;
// Azure Flexible Server keeps several connections for platform maintenance. Keep
// enough independent workers to exercise cross-process serialization without
// making the deploy gate depend on every remaining customer connection slot.
const WORKER_BATCH_SIZE = 4;

async function main() {
  for (const [name, value] of Object.entries(RATE_LIMIT_POSTGRES_ENV)) {
    process.env[name] ??= value;
  }

  const workerIndex = process.argv.indexOf("--worker");
  if (workerIndex >= 0) {
    const bucketKey = process.argv[workerIndex + 1];
    if (!bucketKey) throw new Error("Rate-limit worker bucket key is required.");
    try {
      const reservation = await reserveDistributedRateLimitSlot({
        bucketKey,
        requestsPerSecond: 5,
        maxWaitMs: 5_000,
      });
      process.stdout.write(`${JSON.stringify(reservation)}\n`);
    } finally {
      await closePostgresPool();
    }
    return;
  }

  const bucketKey = `simpro-real-concurrency-${process.pid}`;
  try {
    await queryPostgres("delete from metrics.simpro_rate_limit_buckets where bucket_key = $1", [bucketKey]);
  } finally {
    await closePostgresPool();
  }

  const reservations: DistributedRateLimitReservation[] = [];
  for (let offset = 0; offset < RESERVATION_COUNT; offset += WORKER_BATCH_SIZE) {
    const batchSize = Math.min(WORKER_BATCH_SIZE, RESERVATION_COUNT - offset);
    reservations.push(...await Promise.all(
      Array.from({ length: batchSize }, () => runWorker(bucketKey)),
    ));
  }
  const scheduled = reservations
    .map((reservation) => Date.parse(reservation.scheduledAt))
    .sort((left, right) => left - right);
  assert.equal(
    new Set(reservations.map((reservation) => reservation.reservationCount)).size,
    RESERVATION_COUNT,
  );
  for (let index = 1; index < scheduled.length; index += 1) {
    assert.ok(
      scheduled[index] - scheduled[index - 1] >= 199,
      `Reservations ${index} and ${index + 1} were spaced ${scheduled[index] - scheduled[index - 1]}ms apart.`,
    );
  }
  for (const start of scheduled) {
    const rollingCount = scheduled.filter((value) => value >= start && value < start + 1000).length;
    assert.ok(rollingCount <= 5, `Rolling one-second window beginning ${start} contained ${rollingCount} reservations.`);
  }
  console.log(`Real PostgreSQL concurrent-worker GCRA test passed with ${RESERVATION_COUNT} reservations.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

function runWorker(bucketKey: string): Promise<DistributedRateLimitReservation> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", fileURLToPath(import.meta.url), "--worker", bucketKey],
      {
        cwd: process.cwd(),
        env: { ...process.env, ...RATE_LIMIT_POSTGRES_ENV },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== 0) {
        reject(new Error(signal
          ? `Rate-limit worker exited from ${signal}`
          : `Rate-limit worker exited ${code}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()) as DistributedRateLimitReservation);
      } catch (error) {
        reject(new Error(`Invalid rate-limit worker output: ${stdout}`, { cause: error }));
      }
    });
  });
}
