import assert from "node:assert/strict";
import test from "node:test";
import type { ReconciliationOptions } from "../../src/lib/store/reconciliation";
import type { ReconciliationCadenceOptions } from "../../src/lib/store/reconciliation-cadence";
import {
  parseReconciliationArgs,
  runReconciliationWorker,
} from "../../workers/reconcile-simpro";

test("--force parses and disables only-if-needed for direct technician reconciliation", async () => {
  const args = parseReconciliationArgs([
    "--scope", "technicians",
    "--period-start", "2024-01-01",
    "--request-budget", "250",
    "--force",
  ], {});
  assert.equal(args.force, true);

  let executed: ReconciliationOptions | undefined;
  await runReconciliationWorker(args, {
    reconcile: async (options) => {
      executed = options;
      return [];
    },
  });

  assert.equal(executed?.onlyIfNeeded, false);
  assert.equal(executed?.restartDirectTraversal, true);
});

test("--force reaches all-month cadence execution", async () => {
  const args = parseReconciliationArgs([
    "--scope", "technicians",
    "--mode", "all-months",
    "--batch-months", "60",
    "--runtime-minutes", "15",
    "--request-budget", "1000",
    "--force",
  ], {});
  let executed: ReconciliationCadenceOptions | undefined;

  await runReconciliationWorker(args, {
    runCadence: async (options) => {
      executed = options;
      return {
        mode: options.mode,
        cutoffMonth: "2024-01-01",
        cursorStart: "2023-01-01",
        cursorEnd: "2023-01-01",
        requestsUsed: 0,
        stopReason: "batch-limit",
        processed: [],
      };
    },
  });

  assert.equal(executed?.force, true);
  assert.equal(executed?.scope, "technicians");
  assert.equal(executed?.mode, "all-months");
});
