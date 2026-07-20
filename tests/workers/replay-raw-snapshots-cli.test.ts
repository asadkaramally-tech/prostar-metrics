import assert from "node:assert/strict";
import test from "node:test";
import type { RawSnapshotReplayProgress } from "../../src/lib/store/raw-snapshot-replay";
import {
  configureReplayProcessLifecycle,
  REPLAY_POSTGRES_IDLE_TIMEOUT_MS,
  runReplayCli,
} from "../../workers/replay-raw-snapshots";

test("replay CLI gives its one-shot Postgres pool the minimum idle lifetime", () => {
  const env: Record<string, string | undefined> = {
    POSTGRES_POOL_IDLE_TIMEOUT_MS: "300000",
  };

  configureReplayProcessLifecycle(env);

  assert.equal(REPLAY_POSTGRES_IDLE_TIMEOUT_MS, 1000);
  assert.equal(env.POSTGRES_POOL_IDLE_TIMEOUT_MS, "1000");
});

test("replay CLI awaits replay completion before logging finished and returning", async () => {
  const env: Record<string, string | undefined> = {};
  const logs: string[] = [];
  let finishReplay!: (result: RawSnapshotReplayProgress) => void;
  const replayCompletion = new Promise<RawSnapshotReplayProgress>((resolve) => {
    finishReplay = resolve;
  });

  const cliCompletion = runReplayCli([], {
    env,
    log: (message) => logs.push(message),
    replay: async () => replayCompletion,
  });

  await Promise.resolve();
  assert.equal(env.POSTGRES_POOL_IDLE_TIMEOUT_MS, "1000");
  assert.deepEqual(logs, []);

  finishReplay({
    runId: "awaited-audit-run",
    processed: 1,
    succeeded: 1,
    failed: 0,
    remaining: 0,
  });

  assert.equal(await cliCompletion, 0);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /"mode": "finished"/);
  assert.match(logs[0], /"runId": "awaited-audit-run"/);
});

test("replay CLI returns failure only after an awaited replay reports failures", async () => {
  const exitCode = await runReplayCli([], {
    env: {},
    log: () => undefined,
    replay: async () => ({
      runId: "failed-run",
      processed: 1,
      succeeded: 0,
      failed: 1,
      remaining: 1,
    }),
  });

  assert.equal(exitCode, 1);
});
