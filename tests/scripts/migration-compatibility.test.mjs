import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { inspect } from "node:util";
import test from "node:test";

import {
  assertCompatibilityDatabaseName,
  cleanupNamedContainerUntilStable,
  cleanupCompatibilityDatabase,
  createActiveChildRegistry,
  createCompatibilityDatabase,
  createCompatibilityDatabaseName,
  createProbeContainerName,
  createRedactedCompatibilityError,
  isStandardRollupEvidenceFallbackError,
  parseStructuredCommandOutput,
  redactCompatibilityDiagnostic,
  reconcileCompatibilityDatabaseCreation,
  runExecutableMigrationCompatibility,
  runWithRegisteredProbeContainer,
  runWithOwnedCompatibilityDatabase,
  validatePriorImageProbeResult,
  validateLegacyRollupProbeOutput,
} from "../../scripts/lib/migration-compatibility.mjs";

const previousImage = `acrprostardispatchprod.azurecr.io/prostar-metrics@sha256:${"a".repeat(64)}`;
const databaseName = `metrics_compat_${"1".repeat(32)}`;

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function passingProbe(mode = "standard") {
  const runtimeNames = mode === "standard"
    ? ["databaseHealth", "dashboardStores", "ingestionLifecycle", "ingestionWorker", "rollupWorker", "commissionWorker"]
    : ["ingestionWorker", "ingestionQueueDiagnostic", "rollupWorker", "commissionWorker"];
  return {
    schemaVersion: 1,
    mode,
    platform: "linux/amd64",
    previousImage,
    probePeriods: { jobs: "2026-07-01", commissions: "2026-07-01" },
    application: {
      succeeded: true,
      routes: ["/api/health", "/api/jobs", "/api/quotes", "/api/technicians", "/api/commissions"],
    },
    runtime: Object.fromEntries(runtimeNames.map((name) => [name,
      ["rollupWorker", "commissionWorker"].includes(name)
        ? {
            succeeded: true,
            outcome: "rebuilt",
            metricFamily: name === "commissionWorker" ? "commissions" : "jobs",
            periodStart: "2026-07-01",
          }
        : { succeeded: true },
    ])),
  };
}

test("compatibility database names are internally generated full UUIDs", () => {
  const generated = createCompatibilityDatabaseName();
  assert.match(generated, /^metrics_compat_[a-f0-9]{32}$/);
  assert.equal(assertCompatibilityDatabaseName(generated), generated);
  for (const unsafe of [
    "postgres",
    "metrics_compat_short",
    `metrics_compat_${"A".repeat(32)}`,
    `${databaseName};drop database postgres`,
  ]) assert.throws(() => assertCompatibilityDatabaseName(unsafe), /internally generated/);
});

test("pre-create absence proof refuses an existing reserved name without creating", async () => {
  const events = [];
  await assert.rejects(createCompatibilityDatabase({
    databaseName,
    operationTimeoutMs: 100,
    operations: {
      async listDatabases() { events.push("list"); return ["postgres", databaseName]; },
      async createDatabase() { events.push("create"); },
    },
  }), /already exists/);
  assert.deepEqual(events, ["list"]);
});

test("unobserved ambiguous create failure proves absence and never drops a database", async () => {
  const signalTarget = new EventEmitter();
  const events = [];
  await assert.rejects(runWithOwnedCompatibilityDatabase({
    signalTarget,
    exit: () => assert.fail("unexpected exit"),
    createDatabase: async () => { events.push("create"); throw new Error("duplicate or timed-out create"); },
    run: async () => { events.push("run"); },
    cleanup: async () => { events.push("cleanup"); },
  }), /duplicate or timed-out create/);
  assert.deepEqual(events, ["create"]);
  assert.equal(signalTarget.listenerCount("SIGINT"), 0);
  assert.equal(signalTarget.listenerCount("SIGTERM"), 0);
});

test("ambiguous CREATE that succeeded server-side is observed, owned, and removed with final absence proof", async () => {
  const events = [];
  let ownedName;
  let exists = false;
  await assert.rejects(runExecutableMigrationCompatibility({
    previousImage,
    signalTarget: new EventEmitter(),
    exit: () => assert.fail("unexpected exit"),
    operations: {
      async listDatabases() { events.push(`list:${exists}`); return exists ? ["postgres", ownedName] : ["postgres"]; },
      async createDatabase(name) { ownedName = name; exists = true; events.push("create-server-succeeded"); throw new Error("client timed out"); },
      async reconcileCreate(name) {
        assert.equal(name, ownedName);
        events.push(`reconcile:${exists}`);
        return { databaseExists: exists, createOperationActive: false };
      },
      async materializeClone() { events.push("unexpected-materialize"); },
      async applyPendingMigrations() { return []; },
      async runPriorImageProbes() { return passingProbe(); },
      async terminateSessions() { events.push("terminate"); },
      async dropDatabase() { events.push("drop"); exists = false; },
    },
  }), /client timed out/);
  assert.deepEqual(events, [
    "list:false", "create-server-succeeded", "reconcile:true", "terminate", "drop", "list:false",
  ]);
  assert.equal(exists, false);
});

test("create completion after the former outer timeout is quiescent before absence can be accepted", async () => {
  const releaseCreation = deferred();
  const events = [];
  let exists = false;
  const running = runWithOwnedCompatibilityDatabase({
    signalTarget: new EventEmitter(),
    exit: () => assert.fail("unexpected exit"),
    createDatabase: ({ markOwned }) => createCompatibilityDatabase({
      databaseName,
      operationTimeoutMs: 5,
      operations: {
        async listDatabases() { return exists ? ["postgres", databaseName] : ["postgres"]; },
        async createDatabase() {
          events.push("create-started");
          await releaseCreation.promise;
          exists = true;
          events.push("create-committed");
          throw new Error("client observed commit late");
        },
        async reconcileCreate() {
          events.push(`reconcile:${exists}`);
          return { databaseExists: exists, createOperationActive: false };
        },
      },
      onOwnershipProven: markOwned,
    }),
    reconcileOwnership: async () => ({ owned: exists, verifiedAbsent: !exists }),
    run: async () => events.push("unexpected-run"),
    cleanup: async () => { events.push("drop"); exists = false; },
  });
  const earlySettlement = await Promise.race([
    running.then(() => "settled", () => "settled"),
    new Promise((resolveDelay) => setTimeout(() => resolveDelay("pending"), 15)),
  ]);
  assert.equal(earlySettlement, "pending");
  releaseCreation.resolve();
  await assert.rejects(running, /client observed commit late/);
  assert.equal(exists, false);
  assert.deepEqual(events, ["create-started", "create-committed", "reconcile:true", "drop"]);
});

test("normal failure finalization re-reconciles exhausted ambiguous creation and removes observed database", async () => {
  const events = [];
  let reconciliationAttempt = 0;
  let exists = false;
  await assert.rejects(runExecutableMigrationCompatibility({
    previousImage,
    signalTarget: new EventEmitter(),
    exit: () => assert.fail("unexpected exit"),
    operations: {
      async listDatabases() { events.push(`list:${exists}`); return exists ? ["postgres", "placeholder"] : ["postgres"]; },
      async createDatabase(name) { exists = true; events.push(`create:${name}`); },
      async reconcileCreate() {
        reconciliationAttempt += 1;
        events.push(`reconcile:${reconciliationAttempt}`);
        return reconciliationAttempt <= 4
          ? { databaseExists: false, createOperationActive: true }
          : { databaseExists: true, createOperationActive: false };
      },
      async materializeClone() { events.push("unexpected-materialize"); },
      async applyPendingMigrations() { return []; },
      async runPriorImageProbes() { return passingProbe(); },
      async terminateSessions() { events.push("terminate"); },
      async dropDatabase() { events.push("drop"); exists = false; },
    },
  }), /ownership could not be reconciled/);
  assert.equal(reconciliationAttempt, 5);
  assert.deepEqual(events.slice(-4), ["reconcile:5", "terminate", "drop", "list:false"]);
  assert.equal(exists, false);
});

test("create reconciliation retries active backends and only reports stable observed or absent state", async () => {
  let attempt = 0;
  const observed = await reconcileCompatibilityDatabaseCreation({
    databaseName,
    maxAttempts: 3,
    operationTimeoutMs: 100,
    retryDelay: async () => {},
    operations: {
      async reconcileCreate() {
        attempt += 1;
        return attempt === 1
          ? { databaseExists: false, createOperationActive: true }
          : { databaseExists: true, createOperationActive: false };
      },
    },
  });
  assert.deepEqual(observed, { attempts: 2, databaseName, owned: true, verifiedAbsent: false });
});

test("owned clone lifecycle orders verification, materialization, probes, artifact cleanup, and forced drop", async () => {
  const events = [];
  let ownedName;
  let exists = false;
  const result = await runExecutableMigrationCompatibility({
    previousImage,
    signalTarget: new EventEmitter(),
    exit: () => assert.fail("unexpected exit"),
    operations: {
      async listDatabases() { events.push("list"); return exists ? ["postgres", ownedName] : ["postgres"]; },
      async createDatabase(name) { ownedName = name; exists = true; events.push("create"); },
      async reconcileCreate() { events.push("reconcile"); return { databaseExists: exists, createOperationActive: false }; },
      async materializeClone(name) { assert.equal(name, ownedName); events.push("materialize"); },
      async applyPendingMigrations() { events.push("migrate"); return ["034.sql"]; },
      async runPriorImageProbes(name, image) {
        assert.equal(name, ownedName);
        assert.equal(image, previousImage);
        events.push("probe");
        return passingProbe();
      },
      async cleanupArtifacts() { events.push("artifacts"); },
      async terminateSessions() { events.push("terminate"); },
      async dropDatabase() { events.push("drop"); exists = false; },
    },
  });
  assert.equal(result.databaseName, ownedName);
  assert.deepEqual(result.appliedMigrations, ["034.sql"]);
  assert.deepEqual(events, [
    "list", "create", "reconcile", "list", "materialize", "migrate", "probe", "artifacts", "terminate", "drop", "list",
  ]);
});

test("post-ownership failure is preserved together with failed verified cleanup", async () => {
  let ownedName;
  let exists = false;
  let caught;
  try {
    await runExecutableMigrationCompatibility({
      previousImage,
      signalTarget: new EventEmitter(),
      exit: () => assert.fail("unexpected exit"),
      operations: {
        async listDatabases() { return exists ? ["postgres", ownedName] : ["postgres"]; },
        async createDatabase(name) { ownedName = name; exists = true; },
        async reconcileCreate() { return { databaseExists: exists, createOperationActive: false }; },
        async materializeClone() { throw new Error("restore failed"); },
        async applyPendingMigrations() { return []; },
        async runPriorImageProbes() { return passingProbe(); },
        async terminateSessions() {},
        async dropDatabase() { throw new Error("drop failed"); },
      },
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof AggregateError);
  assert.equal(caught.errors[0].message, "restore failed");
  assert.ok(caught.errors[1] instanceof AggregateError);
  assert.match(caught.errors[1].message, /cleanup failed absence verification/);
});

test("cleanup retries termination and forced drop until absence is proven", async () => {
  const events = [];
  let attempt = 0;
  const result = await cleanupCompatibilityDatabase({
    databaseName,
    maxAttempts: 3,
    operationTimeoutMs: 100,
    retryDelay: async (failedAttempt) => events.push(`retry:${failedAttempt}`),
    operations: {
      async terminateSessions() { attempt += 1; events.push(`terminate:${attempt}`); },
      async dropDatabase() { events.push(`force-drop:${attempt}`); },
      async listDatabases() { events.push(`list:${attempt}`); return attempt < 2 ? [databaseName] : ["postgres"]; },
    },
  });
  assert.deepEqual(result, { attempts: 2, verifiedAbsent: true });
  assert.deepEqual(events, [
    "terminate:1", "force-drop:1", "list:1", "retry:1",
    "terminate:2", "force-drop:2", "list:2",
  ]);
});

test("first signal during unresolved creation fails closed at its deadline", async () => {
  const signalTarget = new EventEmitter();
  const creationStarted = deferred();
  const creation = deferred();
  const events = [];
  const exited = deferred();
  const running = runWithOwnedCompatibilityDatabase({
    signalTarget,
    signalCleanupDeadlineMs: 20,
    createDatabase: async () => { creationStarted.resolve(); return creation.promise; },
    run: async () => events.push("run"),
    cleanup: async () => events.push("cleanup"),
    exit: (code) => { events.push(`exit:${code}`); exited.resolve(); },
  });
  await creationStarted.promise;
  signalTarget.emit("SIGTERM");
  await exited.promise;
  assert.deepEqual(events, ["exit:1"]);
  creation.reject(new Error("creation interrupted"));
  await assert.rejects(running, /creation interrupted/);
  assert.deepEqual(events, ["exit:1"]);
});

test("signal during ambiguous creation reconciles an observed database and proves cleanup once", async () => {
  const signalTarget = new EventEmitter();
  const creationStarted = deferred();
  const releaseCreation = deferred();
  const exited = deferred();
  const events = [];
  let exists = true;
  const running = runWithOwnedCompatibilityDatabase({
    signalTarget,
    signalCleanupDeadlineMs: 1_000,
    createDatabase: async () => {
      creationStarted.resolve();
      await releaseCreation.promise;
      throw new Error("create client interrupted");
    },
    reconcileOwnership: async () => {
      events.push(`reconcile:${exists}`);
      return { owned: exists, verifiedAbsent: !exists };
    },
    run: async () => events.push("unexpected-run"),
    cleanup: async () => { events.push("cleanup"); exists = false; },
    exit: (code) => { events.push(`exit:${code}`); exited.resolve(); },
  });
  await creationStarted.promise;
  signalTarget.emit("SIGTERM");
  releaseCreation.resolve();
  await exited.promise;
  await assert.rejects(running, /create client interrupted/);
  assert.deepEqual(events, ["reconcile:true", "reconcile:true", "cleanup", "exit:143"]);
  assert.equal(exists, false);
});

test("owned signal cleanup has a deadline and a second signal forces immediate exit", async () => {
  const signalTarget = new EventEmitter();
  const runStarted = deferred();
  const releaseRun = deferred();
  const cleanupStarted = deferred();
  const releaseCleanup = deferred();
  const exits = [];
  const running = runWithOwnedCompatibilityDatabase({
    signalTarget,
    signalCleanupDeadlineMs: 1_000,
    createDatabase: async ({ markOwned }) => { markOwned(); },
    run: async () => { runStarted.resolve(); await releaseRun.promise; },
    cleanup: async () => { cleanupStarted.resolve(); await releaseCleanup.promise; },
    exit: (code) => exits.push(code),
  });
  await runStarted.promise;
  signalTarget.emit("SIGINT");
  await cleanupStarted.promise;
  signalTarget.emit("SIGTERM");
  assert.deepEqual(exits, [143]);
  releaseCleanup.resolve();
  releaseRun.resolve();
  await running;
  assert.deepEqual(exits, [143]);
});

test("probe validation rejects missing, failed, extra, and falsely claimed coverage", () => {
  for (const mode of ["standard", "legacy"]) {
    assert.equal(validatePriorImageProbeResult(passingProbe(mode), previousImage).mode, mode);
  }
  for (const mutate of [
    (value) => { value.previousImage = value.previousImage.replace(/a/g, "b"); },
    (value) => { value.platform = "linux/arm64"; },
    (value) => { value.application.routes.pop(); },
    (value) => { value.runtime.rollupWorker.succeeded = false; },
    (value) => { value.runtime.unexecuted = { succeeded: true }; },
    (value) => { delete value.runtime.ingestionLifecycle; },
    (value) => { value.runtime.rollupWorker.periodStart = "2026-06-01"; },
    (value) => { value.runtime.commissionWorker.metricFamily = "jobs"; },
  ]) {
    const value = passingProbe();
    mutate(value);
    assert.throws(() => validatePriorImageProbeResult(value, previousImage), /probe|digest|coverage|application/);
  }
});

test("predetermined probe container is registered before launch and cleaned after crash", async () => {
  const containerName = createProbeContainerName();
  const events = [];
  await assert.rejects(runWithRegisteredProbeContainer({
    containerName,
    register: (name) => events.push(`register:${name}`),
    run: async (name) => { events.push(`run:${name}`); throw new Error("docker cli timed out"); },
    cleanup: async (name) => events.push(`remove-and-verify:${name}`),
  }), /docker cli timed out/);
  assert.deepEqual(events, [
    `register:${containerName}`, `run:${containerName}`, `remove-and-verify:${containerName}`,
  ]);
  await assert.rejects(runWithRegisteredProbeContainer({
    containerName: "caller-controlled-container",
    register: () => {},
    run: async () => {},
    cleanup: async () => {},
  }), /internally generated UUID name/);
});

test("child termination waits for delayed close before cleanup can begin", async () => {
  const events = [];
  const sigkillSent = deferred();
  const child = new EventEmitter();
  child.kill = (signal) => {
    events.push(`kill:${signal}`);
    if (signal === "SIGKILL") sigkillSent.resolve();
    return true;
  };
  const registry = createActiveChildRegistry({
    gracePeriodMs: 1,
    closeTimeoutMs: 1_000,
    wait: async () => events.push("grace"),
  });
  const record = registry.track(child, "delayed docker run");
  const termination = registry.terminate(record, new Error("docker timeout"));
  await sigkillSent.promise;
  assert.deepEqual(events, ["kill:SIGTERM", "grace", "kill:SIGKILL"]);
  assert.equal(registry.activeCount(), 1);
  let cleanupStarted = false;
  void termination.then(() => { cleanupStarted = true; });
  await Promise.resolve();
  assert.equal(cleanupStarted, false);
  events.push("close");
  child.emit("close", null, "SIGKILL");
  await termination;
  assert.equal(cleanupStarted, true);
  assert.equal(registry.activeCount(), 0);
});

test("signal handler awaits child quiescence before stable cleanup and catches a late named-container create", async () => {
  const events = [];
  const signalTarget = new EventEmitter();
  const sigkillSent = deferred();
  const runStarted = deferred();
  const releaseRun = deferred();
  const exited = deferred();
  const child = new EventEmitter();
  child.kill = (signal) => {
    events.push(`kill:${signal}`);
    if (signal === "SIGKILL") sigkillSent.resolve();
    return true;
  };
  const registry = createActiveChildRegistry({
    gracePeriodMs: 1,
    closeTimeoutMs: 1_000,
    wait: async () => events.push("grace"),
  });
  registry.track(child, "signal docker run");
  let check = 0;
  const running = runWithOwnedCompatibilityDatabase({
    signalTarget,
    signalCleanupDeadlineMs: 1_000,
    createDatabase: async ({ markOwned }) => markOwned(),
    run: async () => { runStarted.resolve(); await releaseRun.promise; },
    cleanup: async () => {
      await registry.quiesceAll(new Error("SIGTERM"));
      events.push("quiescent");
      return cleanupNamedContainerUntilStable({
        containerName: createProbeContainerName(),
        maxAttempts: 6,
        requiredAbsentChecks: 3,
        retryDelay: async () => events.push("stability-delay"),
        forceRemove: async () => events.push("force-remove"),
        isPresent: async () => {
          check += 1;
          const lateCreate = check === 2;
          events.push(lateCreate ? "late-create-observed" : "absent");
          return lateCreate;
        },
      });
    },
    exit: (code) => { events.push(`exit:${code}`); exited.resolve(code); },
  });
  await runStarted.promise;
  signalTarget.emit("SIGTERM");
  await sigkillSent.promise;
  assert.deepEqual(events, ["kill:SIGTERM", "grace", "kill:SIGKILL"]);
  child.emit("close", null, "SIGKILL");
  assert.equal(await exited.promise, 143);
  assert.ok(events.indexOf("quiescent") < events.indexOf("force-remove"));
  assert.equal(events.filter((event) => event === "force-remove").length, 5);
  assert.ok(events.includes("late-create-observed"));
  assert.equal(events.at(-1), "exit:143");
  releaseRun.resolve();
  await running;
  assert.equal(events.filter((event) => event === "quiescent").length, 1);
});

test("redacted compatibility errors expose no secret through nested serialization or inspection", () => {
  const connection = "postgresql://migration-user:swordfish@db.example.test:5432/metrics_compat_secret";
  const nested = new AggregateError([
    new Error(`outer ${connection}`, { cause: new Error("password=swordfish") }),
    new Error("token=swordfish"),
  ], "aggregate contains swordfish");
  const error = createRedactedCompatibilityError("compatibility failed", nested, [connection, "swordfish"]);
  assert.equal(Object.hasOwn(error, "cause"), false);
  const serialized = [String(error), error.stack, JSON.stringify(error), inspect(error, { depth: 10 })].join("\n");
  assert.doesNotMatch(serialized, /swordfish|migration-user|db\.example\.test/);
  assert.match(serialized, /REDACTED/);
});

test("compatibility redaction removes separately emitted database identity", () => {
  const connection = "postgresql://migration-user:swordfish@db.example.test:5432/metrics_compat_secret";
  const redacted = redactCompatibilityDiagnostic(
    "authentication failed for migration-user on db.example.test",
    [connection],
  );
  assert.doesNotMatch(redacted, /migration-user|db\.example\.test|swordfish/);
  assert.match(redacted, /REDACTED/);
});

test("structured command evidence must be one exact JSON object", () => {
  assert.deepEqual(parseStructuredCommandOutput('{"ok":true}', "probe"), { ok: true });
  for (const value of ["", "banner\n{\"ok\":true}", "[]", "not-json"]) {
    assert.throws(() => parseStructuredCommandOutput(value, "probe"), /structured output/);
  }
});

test("legacy commission probe accepts only the exact source-evidence safety refusal", () => {
  const periodStart = "2026-07-01";
  const expected = {
    workerId: "metrics-rollup-18",
    commissionCadence: null,
    claimed: true,
    rebuilt: [],
    failures: [{
      jobId: 797,
      metricFamily: "commissions",
      periodStart,
      error: `Commission source evidence is loading for ${periodStart}; refusing immutable-run and ready read-model publication.`,
    }],
  };
  assert.deepEqual(validateLegacyRollupProbeOutput(expected, {
    scope: "commissions", periodStart, exitCode: 1,
  }), { outcome: "expected-source-evidence-safety-gate" });
  const postgresBigint = structuredClone(expected);
  postgresBigint.failures[0].jobId = "797";
  assert.deepEqual(validateLegacyRollupProbeOutput(postgresBigint, {
    scope: "commissions", periodStart, exitCode: 1,
  }), { outcome: "expected-source-evidence-safety-gate" });
  const currentIntegrityRefusal = structuredClone(expected);
  currentIntegrityRefusal.failures[0].error =
    `Commission integrity verification failed for ${periodStart}; refusing immutable-run and ready read-model publication: source_complete is false`;
  assert.deepEqual(validateLegacyRollupProbeOutput(currentIntegrityRefusal, {
    scope: "commissions", periodStart, exitCode: 1,
  }), { outcome: "expected-source-evidence-safety-gate" });

  for (const mutate of [
    (value) => { value.failures[0].periodStart = "2026-06-01"; },
    (value) => { value.failures[0].metricFamily = "jobs"; },
    (value) => { value.failures[0].error = "Commission integrity verification failed for 2026-07-01; refusing immutable-run and ready read-model publication: payout mismatch"; },
    (value) => { value.failures.push({ ...value.failures[0] }); },
    (value) => { value.failures[0].sqlState = "42P01"; },
    (value) => { value.workerId = null; value.commissionCadence = { error: "relation missing" }; },
    (value) => { value.untrusted = true; },
  ]) {
    const attacked = structuredClone(expected);
    mutate(attacked);
    assert.throws(() => validateLegacyRollupProbeOutput(attacked, {
      scope: "commissions", periodStart, exitCode: 1,
    }), /compatible clone execution|evidence envelope/);
  }
  assert.throws(() => validateLegacyRollupProbeOutput(expected, {
    scope: "jobs", periodStart, exitCode: 1,
  }), /compatible clone execution/);
});

test("legacy rollup probe requires a successful exact-scope exact-period rebuild", () => {
  const output = {
    workerId: "metrics-rollup-18",
    commissionCadence: null,
    claimed: true,
    rebuilt: [{ jobId: 91, metricFamily: "jobs", periodStart: "2026-06-01", keys: ["summary"] }],
    failures: [],
  };
  assert.deepEqual(validateLegacyRollupProbeOutput(output, {
    scope: "jobs", periodStart: "2026-06-01", exitCode: 0,
  }), { outcome: "rebuilt" });
  const postgresBigint = structuredClone(output);
  postgresBigint.rebuilt[0].jobId = "91";
  assert.deepEqual(validateLegacyRollupProbeOutput(postgresBigint, {
    scope: "jobs", periodStart: "2026-06-01", exitCode: 0,
  }), { outcome: "rebuilt" });
  assert.throws(() => validateLegacyRollupProbeOutput(output, {
    scope: "jobs", periodStart: "2026-07-01", exitCode: 0,
  }), /compatible clone execution/);
  const extra = structuredClone(output);
  extra.rebuilt.push({ jobId: 92, metricFamily: "jobs", periodStart: "2026-07-01", keys: ["summary"] });
  assert.throws(() => validateLegacyRollupProbeOutput(extra, {
    scope: "jobs", periodStart: "2026-06-01", exitCode: 0,
  }), /compatible clone execution/);
});

test("standard probe fallback is limited to the exact prior-image rollup evidence failure", () => {
  assert.equal(isStandardRollupEvidenceFallbackError(new Error(
    "Run exact prior-image compatibility entrypoint failed with exit 1: Actual jobs rollup worker did not rebuild or safely refuse its clone-only period",
  )), true);
  assert.equal(isStandardRollupEvidenceFallbackError(new Error(
    "Run exact prior-image compatibility entrypoint failed with exit 1: Actual commissions rollup worker did not rebuild or safely refuse its clone-only period",
  )), true);
  for (const message of [
    "Run exact prior-image compatibility entrypoint failed with exit 1: relation metrics.jobs does not exist",
    "Run candidate compatibility entrypoint failed with exit 1: Actual jobs rollup worker did not rebuild or safely refuse its clone-only period",
    "Actual jobs rollup worker did not rebuild or safely refuse its clone-only period",
  ]) assert.equal(isStandardRollupEvidenceFallbackError(new Error(message)), false);
});

test("checker executes only existing exact-image files and never injects candidate code", async () => {
  const [checker, entrypoint, packageJson] = await Promise.all([
    readFile(new URL("../../scripts/check-migration-compatibility.mjs", import.meta.url), "utf8"),
    readFile(new URL("../../scripts/migration-compatibility-entrypoint.ts", import.meta.url), "utf8"),
    readFile(new URL("../../package.json", import.meta.url), "utf8").then(JSON.parse),
  ]);
  assert.doesNotMatch(checker, /spawnSync|--input-type=module|input:\s*PRIOR_IMAGE|stdio:\s*\[\s*"pipe"/);
  for (const path of [
    "server.js",
    "workers/ingest-simpro.ts",
    "workers/queue-maintenance.ts",
    "workers/rebuild-rollups.ts",
    "scripts/migration-compatibility-entrypoint.ts",
  ]) assert.match(checker, new RegExp(path.replaceAll(".", "\\.")));
  assert.match(entrypoint, /MIGRATION_COMPATIBILITY_CLONE_ONLY/);
  assert.match(entrypoint, /MIGRATION_COMPATIBILITY_PLATFORM/);
  assert.match(entrypoint, /metrics_compat_\[a-f0-9\]\{32\}/);
  assert.match(entrypoint, /expectedSafetyError/);
  assert.match(entrypoint, /scope === "commissions" \? \[0, 1\] : \[0\]/);
  assert.match(entrypoint, /Number\.isSafeInteger\(failure\.jobId\)/);
  assert.match(entrypoint, /rebuilt\.length === 1/);
  assert.equal(packageJson.scripts["migration:compatibility:probe"], "tsx scripts/migration-compatibility-entrypoint.ts");
  assert.match(checker, /attemptedContainerNames\.add/);
  assert.match(checker, /childRegistry\.quiesceAll/);
  assert.match(checker, /cleanupNamedContainerUntilStable/);
  assert.doesNotMatch(checker, /\{ cause: error \}/);
});
