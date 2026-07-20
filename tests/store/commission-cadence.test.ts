import assert from "node:assert/strict";
import test from "node:test";
import {
  enqueueCurrentPacificCommissionRebuild,
  pacificDateTime,
} from "../../src/lib/store/commission-cadence";

test("Pacific business time handles daylight-saving and standard-time offsets", () => {
  assert.deepEqual(pacificDateTime(new Date("2026-07-09T10:00:00.000Z")), {
    localDate: "2026-07-09",
    hour: 3,
  });
  assert.deepEqual(pacificDateTime(new Date("2026-01-09T11:00:00.000Z")), {
    localDate: "2026-01-09",
    hour: 3,
  });
});

test("nightly commission cadence is a no-op outside local hour 03", async () => {
  let calls = 0;
  const result = await enqueueCurrentPacificCommissionRebuild(3, {
    now: new Date("2026-07-09T09:59:59.000Z"),
    enqueue: async () => {
      calls += 1;
      return { id: 1, status: "queued" };
    },
  });

  assert.equal(calls, 0);
  assert.equal(result.enqueued, false);
  assert.equal(result.periodStart, "2026-07-01");
});

test("nightly commission cadence uses Pacific local date as retry idempotency key", async () => {
  const calls: unknown[] = [];
  const enqueue = async (params: unknown) => {
    calls.push(params);
    return calls.length === 1 ? { id: 42, status: "queued" } : null;
  };

  const first = await enqueueCurrentPacificCommissionRebuild(3, {
    now: new Date("2026-07-09T10:15:00.000Z"),
    enqueue,
  });
  const retry = await enqueueCurrentPacificCommissionRebuild(3, {
    now: new Date("2026-07-09T10:45:00.000Z"),
    enqueue,
  });

  assert.deepEqual(calls, [
    {
      metricFamily: "commissions",
      periodStart: "2026-07-01",
      reason: "Nightly commission rebuild for Pacific business date 2026-07-09",
      idempotencyKey: "commissions:nightly:2026-07-09",
      preserveSucceeded: true,
    },
    {
      metricFamily: "commissions",
      periodStart: "2026-07-01",
      reason: "Nightly commission rebuild for Pacific business date 2026-07-09",
      idempotencyKey: "commissions:nightly:2026-07-09",
      preserveSucceeded: true,
    },
  ]);
  assert.equal(first.enqueued, true);
  assert.equal(first.queueJobId, 42);
  assert.equal(retry.enqueued, false);
});

test("commission cadence rejects invalid local-hour configuration", async () => {
  await assert.rejects(enqueueCurrentPacificCommissionRebuild(24), /localHour/);
});
