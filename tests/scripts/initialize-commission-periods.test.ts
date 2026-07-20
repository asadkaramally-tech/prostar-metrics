import assert from "node:assert/strict";
import test from "node:test";
import {
  parseCommissionInitializationArgs,
  verifyLockedCommissionEvidenceContent,
  verifyLockedCommissionEvidenceFiles,
} from "../../scripts/initialize-commission-periods";
import {
  parseCommissionInitializationQueueArgs,
  processCommissionInitializationDrainJob,
} from "../../scripts/manage-commission-initialization-queue";
import {
  commissionInitializationDrainConfirmationToken,
  commissionInitializationRepairConfirmationToken,
} from "@/lib/store/commission-initialization-queue";
import { LOCKED_COMMISSION_POLICY_EVIDENCE } from "@/lib/store/commission-period-initialization";

const now = new Date("2026-07-13T12:00:00.000Z");
const confirmation = "INITIALIZE-COMMISSION-PERIODS-2023-01-THROUGH-2026-07";

test("commission initialization CLI is dry-run by default and resolves current in Pacific time", () => {
  assert.deepEqual(parseCommissionInitializationArgs([
    "--through", "current", "--actor", "ASAD@PROSTARMECHANICAL.COM",
  ], now), {
    actorEmail: "asad@prostarmechanical.com",
    throughMonth: "2026-07",
    execute: false,
    confirmation: undefined,
    help: false,
  });
  assert.deepEqual(parseCommissionInitializationArgs([
    "--through", "2026-07", "--actor", "laila@prostarmechanical.com", "--dry-run",
  ], now), {
    actorEmail: "laila@prostarmechanical.com",
    throughMonth: "2026-07",
    execute: false,
    confirmation: undefined,
    help: false,
  });
});

test("commission initialization CLI requires execute plus the exact range token", () => {
  assert.deepEqual(parseCommissionInitializationArgs([
    "--through", "2026-07",
    "--actor", "asad@prostarmechanical.com",
    "--execute",
    "--confirm", confirmation,
  ], now), {
    actorEmail: "asad@prostarmechanical.com",
    throughMonth: "2026-07",
    execute: true,
    confirmation,
    help: false,
  });
  assert.throws(() => parseCommissionInitializationArgs([
    "--through", "2026-07", "--actor", "asad@prostarmechanical.com", "--execute",
  ], now), new RegExp(confirmation));
  assert.throws(() => parseCommissionInitializationArgs([
    "--through", "2026-07", "--actor", "asad@prostarmechanical.com", "--confirm", confirmation,
  ], now), /only valid with --execute/);
  assert.throws(() => parseCommissionInitializationArgs([
    "--through", "2026-07", "--actor", "asad@prostarmechanical.com", "--execute", "--dry-run", "--confirm", confirmation,
  ], now), /cannot be combined/);
  assert.throws(() => parseCommissionInitializationArgs([
    "--through", "2026-07", "--actor", "outsider@prostarmechanical.com",
  ], now), /Asad.*Laila/i);
});

test("commission initialization CLI authenticates the checked-in locked evidence", async () => {
  await verifyLockedCommissionEvidenceFiles();
  assert.throws(() => verifyLockedCommissionEvidenceContent(
    LOCKED_COMMISSION_POLICY_EVIDENCE.rosterMigration.path,
    "missing migration 009 evidence",
  ), /hash mismatch.*009/i);
  assert.throws(() => verifyLockedCommissionEvidenceContent(
    LOCKED_COMMISSION_POLICY_EVIDENCE.lockedPlan.path,
    "free-floating Section 6.4 substring is not whole-file evidence",
  ), /hash mismatch.*execution-plan/i);
  assert.throws(() => verifyLockedCommissionEvidenceContent(
    LOCKED_COMMISSION_POLICY_EVIDENCE.integrityMigration.path,
    "tampered pending migration 036",
  ), /hash mismatch.*036/i);
});

test("bounded initialization queue CLI rejects scope and confirmation abuse", () => {
  assert.equal(parseCommissionInitializationQueueArgs([
    "--prerequisites", "--through", "2026-07", "--actor", "asad@prostarmechanical.com",
  ], now).action, "prerequisites");
  const drainToken = commissionInitializationDrainConfirmationToken("2026-07");
  assert.deepEqual(parseCommissionInitializationQueueArgs([
    "--drain", "--through", "2026-07", "--limit", "43",
    "--actor", "asad@prostarmechanical.com", "--confirm", drainToken,
  ], now), {
    action: "drain", throughMonth: "2026-07", actorEmail: "asad@prostarmechanical.com",
    limit: 43, confirmation: drainToken, help: false,
  });
  const repairToken = commissionInitializationRepairConfirmationToken("2023-01");
  assert.equal(parseCommissionInitializationQueueArgs([
    "--repair-failed", "--month", "2023-01", "--actor", "laila@prostarmechanical.com",
    "--reason", "Accepted source repair evidence.", "--confirm", repairToken,
  ], now).month, "2023-01");
  assert.throws(() => parseCommissionInitializationQueueArgs([
    "--drain", "--through", "2026-07", "--limit", "44",
    "--actor", "asad@prostarmechanical.com", "--confirm", drainToken,
  ], now), /1 through 43/);
  assert.throws(() => parseCommissionInitializationQueueArgs([
    "--status", "--through", "2026-07", "--limit", "1", "--actor", "asad@prostarmechanical.com",
  ], now), /only valid with --drain/);
  assert.throws(() => parseCommissionInitializationQueueArgs([
    "--status", "--through", "2026-07", "--actor", "asad@prostarmechanical.com",
    "--reason", "This must remain repair-only.",
  ], now), /only valid with --repair-failed/);
  assert.throws(() => parseCommissionInitializationQueueArgs([
    "--drain", "--through", "2026-07", "--limit", "1", "--limit", "2",
    "--actor", "asad@prostarmechanical.com", "--confirm", drainToken,
  ], now), /only be provided once/);
  assert.throws(() => parseCommissionInitializationQueueArgs([
    "--status", "--drain", "--through", "2026-07", "--actor", "asad@prostarmechanical.com",
  ], now), /exactly one queue action/);
  assert.throws(() => parseCommissionInitializationQueueArgs([
    "--drain", "--through", "2026-07", "--actor", "outsider@prostarmechanical.com", "--confirm", drainToken,
  ], now), /Asad.*Laila/i);
  assert.throws(() => parseCommissionInitializationQueueArgs([
    "--repair-failed", "--month", "2023-01", "--actor", "asad@prostarmechanical.com",
    "--reason", "Accepted source repair evidence.", "--confirm", "wrong",
  ], now), new RegExp(repairToken));
});

test("commission initialization drain fences heartbeat loss and verifies publication", async () => {
  const job = {
    id: 41,
    metric_family: "commissions" as const,
    period_grain: "month" as const,
    period_start: "2023-01-01",
    dimensions_json: {},
    locked_by: "test-worker",
  };
  let heartbeats = 0;
  let fenced = 0;
  let completionChecks = 0;
  const lost = await processCommissionInitializationDrainJob(job, {
    heartbeat: async () => {
      heartbeats += 1;
      if (heartbeats > 1) throw new Error("mock lease lost");
    },
    rebuild: async () => new Promise((resolve) => setTimeout(resolve, 15)),
    fail: async (_jobId, _error, options) => {
      assert.equal(options.lockedBy, job.locked_by);
      fenced += 1;
    },
    assertCompleted: async () => { completionChecks += 1; },
    heartbeatIntervalMs: 1,
  });
  assert.deepEqual(lost, { ok: false, error: "mock lease lost" });
  assert.equal(fenced, 1);
  assert.equal(completionChecks, 0);

  const completed = await processCommissionInitializationDrainJob(job, {
    heartbeat: async () => { heartbeats += 1; },
    rebuild: async () => undefined,
    fail: async () => { fenced += 1; },
    assertCompleted: async (completedJob) => {
      assert.equal(completedJob.id, job.id);
      completionChecks += 1;
    },
    heartbeatIntervalMs: 1_000,
  });
  assert.deepEqual(completed, { ok: true });
  assert.equal(completionChecks, 1);

  const publicationLost = await processCommissionInitializationDrainJob(job, {
    heartbeat: async () => undefined,
    rebuild: async () => undefined,
    fail: async (_jobId, _error, options) => {
      assert.equal(options.lockedBy, job.locked_by);
      fenced += 1;
    },
    assertCompleted: async () => {
      throw new Error("mock publication ownership lost");
    },
    heartbeatIntervalMs: 1_000,
  });
  assert.deepEqual(publicationLost, { ok: false, error: "mock publication ownership lost" });
  assert.equal(fenced, 2);
});
