import { randomUUID } from "node:crypto";

const destructivePatterns = [
  ["DROP schema/table/view/type", /\bdrop\s+(?:schema|table|view|materialized\s+view|type)\b/i],
  ["DROP COLUMN", /\balter\s+table\b[^;]*?\bdrop\s+column\b/i],
  ["TRUNCATE", /\btruncate\b/i],
  ["DELETE", /\bdelete\s+from\b/i],
  ["RENAME", /\balter\s+(?:table|type)\b[^;]*?\brename\b/i],
  ["incompatible ALTER COLUMN TYPE", /\balter\s+table\b[^;]*?\balter\s+column\b[^;]*?\btype\b/i],
];

const pinnedImagePattern = /^[a-z0-9.-]+\.azurecr\.io\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/;
const compatibilityDatabasePattern = /^metrics_compat_[a-f0-9]{32}$/;
const probeContainerNamePattern = /^metrics-compat-probe-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const signalExitCodes = Object.freeze({ SIGINT: 130, SIGTERM: 143 });
export const PRIOR_IMAGE_PLATFORM = "linux/amd64";
const priorImageEnvironmentNames = new Set([
  "AZURE_POSTGRES_CA_CERT", "AZURE_POSTGRES_CA_CERT_PATH", "HOME", "LANG", "LC_ALL", "PATH",
  "PGSSLROOTCERT", "TMPDIR",
]);

const expectedApplicationRoutes = Object.freeze([
  "/api/health",
  "/api/jobs",
  "/api/quotes",
  "/api/technicians",
  "/api/commissions",
]);

export function backwardCompatibilityViolations(filename, sql) {
  if (typeof filename !== "string" || !filename.endsWith(".sql")) return ["migration filename must end in .sql"];
  if (typeof sql !== "string" || !sql.trim()) return ["migration SQL must be non-empty"];
  const executableSql = stripSqlComments(sql);
  return destructivePatterns.flatMap(([label, pattern]) => (
    pattern.test(executableSql) ? [`${filename}: prior-image compatibility forbids ${label}`] : []
  ));
}

export function createCompatibilityDatabaseName() {
  return assertCompatibilityDatabaseName(`metrics_compat_${randomUUID().replaceAll("-", "")}`);
}

export function createProbeContainerName() {
  return assertProbeContainerName(`metrics-compat-probe-${randomUUID()}`);
}

export function assertProbeContainerName(containerName) {
  if (!probeContainerNamePattern.test(containerName ?? "")) {
    throw new Error("Prior-image probe container name is not an internally generated UUID name");
  }
  return containerName;
}

export async function runWithRegisteredProbeContainer({ containerName, register, run, cleanup }) {
  assertProbeContainerName(containerName);
  if (typeof register !== "function" || typeof run !== "function" || typeof cleanup !== "function") {
    throw new TypeError("Registered probe container lifecycle requires register, run, and cleanup operations");
  }
  register(containerName);
  let result;
  let operationError;
  try {
    result = await run(containerName);
  } catch (error) {
    operationError = error;
  }
  let cleanupError;
  try {
    await cleanup(containerName);
  } catch (error) {
    cleanupError = error;
  }
  if (operationError && cleanupError) {
    throw new AggregateError([operationError, cleanupError], "Probe command and named-container cleanup failed");
  }
  if (operationError) throw operationError;
  if (cleanupError) throw cleanupError;
  return result;
}

export function createActiveChildRegistry({
  gracePeriodMs = 1_000,
  closeTimeoutMs = 10_000,
  wait = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)),
} = {}) {
  const active = new Set();

  function track(child, label) {
    if (!child || typeof child.once !== "function" || typeof child.kill !== "function") {
      throw new TypeError("Active child tracking requires a killable EventEmitter child process");
    }
    let resolveClose;
    const record = {
      child,
      label,
      closed: false,
      terminationError: null,
      startupError: null,
      closePromise: new Promise((resolve) => { resolveClose = resolve; }),
    };
    active.add(record);
    child.once("close", (code, signal) => {
      record.closed = true;
      active.delete(record);
      resolveClose({ code, signal });
    });
    return record;
  }

  async function terminate(record, error = new Error(`${record?.label ?? "Child process"} was terminated`)) {
    if (!record || !active.has(record)) return record?.closePromise;
    record.terminationError ??= error;
    record.child.kill("SIGTERM");
    const closedDuringGrace = await Promise.race([
      record.closePromise.then(() => true),
      wait(gracePeriodMs).then(() => false),
    ]);
    if (!closedDuringGrace && !record.closed) record.child.kill("SIGKILL");
    return withCompatibilityTimeout(
      () => record.closePromise,
      closeTimeoutMs,
      `${record.label} child close`,
    );
  }

  async function quiesceAll(error = new Error("Compatibility cleanup interrupted active child processes")) {
    const failures = [];
    for (let round = 1; round <= 4; round += 1) {
      const records = [...active];
      if (records.length === 0) return { rounds: round - 1, verifiedQuiescent: true };
      const results = await Promise.allSettled(records.map((record) => terminate(record, error)));
      failures.push(...results.filter(({ status }) => status === "rejected").map(({ reason }) => reason));
    }
    if (active.size === 0 && failures.length === 0) return { rounds: 4, verifiedQuiescent: true };
    throw new AggregateError(failures, `Active child process quiescence failed; ${active.size} process(es) remain`);
  }

  return {
    activeCount: () => active.size,
    quiesceAll,
    terminate,
    track,
  };
}

export async function cleanupNamedContainerUntilStable({
  containerName,
  forceRemove,
  isPresent,
  maxAttempts = 8,
  requiredAbsentChecks = 3,
  retryDelay = (attempt) => new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 100)),
}) {
  assertProbeContainerName(containerName);
  if (!Number.isInteger(maxAttempts) || maxAttempts < requiredAbsentChecks || maxAttempts > 20) {
    throw new Error("Named-container cleanup attempts do not permit stable absence verification");
  }
  if (!Number.isInteger(requiredAbsentChecks) || requiredAbsentChecks < 2 || requiredAbsentChecks > 5) {
    throw new Error("Named-container cleanup requires two through five consecutive absence checks");
  }
  let consecutiveAbsent = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await forceRemove(containerName);
    const present = await isPresent(containerName);
    if (typeof present !== "boolean") throw new Error("Named-container presence check returned an invalid result");
    consecutiveAbsent = present ? 0 : consecutiveAbsent + 1;
    if (consecutiveAbsent >= requiredAbsentChecks) {
      return { attempts: attempt, consecutiveAbsent, verifiedAbsent: true };
    }
    if (attempt < maxAttempts) await retryDelay(attempt);
  }
  throw new Error(`Prior-image compatibility container lacks stable absence after ${maxAttempts} cleanup attempts`);
}

export function assertCompatibilityDatabaseName(databaseName) {
  if (!compatibilityDatabasePattern.test(databaseName ?? "")) {
    throw new Error("Temporary compatibility database name is not an internally generated full-UUID name");
  }
  return databaseName;
}

export async function withCompatibilityTimeout(operation, timeoutMs, label) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error(`${label} timeout must be a positive integer`);
  let timeout;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

export async function createCompatibilityDatabase({
  databaseName,
  operations,
  onPreCreateAbsenceProven = () => undefined,
  onOwnershipProven = () => undefined,
  operationTimeoutMs = 30_000,
}) {
  assertCompatibilityDatabaseName(databaseName);
  const before = await withCompatibilityTimeout(
    () => operations.listDatabases(),
    operationTimeoutMs,
    "Pre-create compatibility database enumeration",
  );
  assertDatabaseEnumeration(before, "Pre-create compatibility database enumeration");
  if (before.includes(databaseName)) {
    throw new Error("Cryptographically reserved compatibility database name already exists");
  }
  onPreCreateAbsenceProven();
  let creationError;
  try {
    // The concrete PostgreSQL operation owns its query and connection timeouts.
    // Awaiting it here prevents a timed-out Promise from creating the database
    // after reconciliation has already accepted absence.
    await operations.createDatabase(databaseName);
  } catch (error) {
    creationError = error;
  }
  const reconciliation = await reconcileCompatibilityDatabaseCreation({
    databaseName,
    operations,
    operationTimeoutMs,
  });
  if (reconciliation.owned) onOwnershipProven();
  if (creationError) throw creationError;
  if (!reconciliation.owned) {
    throw new Error("Compatibility CREATE DATABASE completed without an observable owned database");
  }
  return reconciliation;
}

export async function reconcileCompatibilityDatabaseCreation({
  databaseName,
  operations,
  maxAttempts = 4,
  operationTimeoutMs = 30_000,
  retryDelay = (attempt) => new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 250)),
}) {
  assertCompatibilityDatabaseName(databaseName);
  if (typeof operations?.reconcileCreate !== "function") {
    throw new TypeError("Migration compatibility operation is required: reconcileCreate");
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new Error("Compatibility create reconciliation attempts must be an integer from 1 through 10");
  }
  const failures = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const status = await withCompatibilityTimeout(
        () => operations.reconcileCreate(databaseName),
        operationTimeoutMs,
        "Reconcile ambiguous compatibility database creation",
      );
      if (!isExactObject(status, ["createOperationActive", "databaseExists"])
        || typeof status.createOperationActive !== "boolean"
        || typeof status.databaseExists !== "boolean") {
        throw new Error("Compatibility create reconciliation returned an invalid status");
      }
      if (!status.createOperationActive) {
        return {
          attempts: attempt,
          databaseName,
          owned: status.databaseExists,
          verifiedAbsent: !status.databaseExists,
        };
      }
      failures.push(new Error(`Compatibility CREATE DATABASE remains active after reconciliation attempt ${attempt}`));
    } catch (error) {
      failures.push(error);
    }
    if (attempt < maxAttempts) {
      try {
        await withCompatibilityTimeout(
          () => retryDelay(attempt),
          operationTimeoutMs,
          "Compatibility create reconciliation retry delay",
        );
      } catch (error) {
        failures.push(error);
        break;
      }
    }
  }
  throw new AggregateError(
    failures,
    `Compatibility CREATE DATABASE ownership could not be reconciled after ${maxAttempts} attempts`,
  );
}

export async function verifyOwnedCompatibilityDatabase({
  databaseName,
  operations,
  operationTimeoutMs = 30_000,
}) {
  assertCompatibilityDatabaseName(databaseName);
  const after = await withCompatibilityTimeout(
    () => operations.listDatabases(),
    operationTimeoutMs,
    "Post-create compatibility database ownership verification",
  );
  assertDatabaseEnumeration(after, "Post-create compatibility database ownership verification");
  if (!after.includes(databaseName)) {
    throw new Error("Created compatibility database is absent during ownership verification");
  }
  return { databaseName, owned: true };
}

export async function cleanupCompatibilityDatabase({
  databaseName,
  operations,
  maxAttempts = 4,
  operationTimeoutMs = 10_000,
  retryDelay = (attempt) => new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 250)),
}) {
  assertCompatibilityDatabaseName(databaseName);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new Error("Compatibility database cleanup attempts must be an integer from 1 through 10");
  }
  const failures = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    for (const [label, operation] of [
      ["Terminate compatibility database sessions", () => operations.terminateSessions(databaseName)],
      ["Force-drop compatibility database", () => operations.dropDatabase(databaseName)],
    ]) {
      try {
        await withCompatibilityTimeout(operation, operationTimeoutMs, label);
      } catch (error) {
        failures.push(error);
      }
    }

    try {
      const databases = await withCompatibilityTimeout(
        () => operations.listDatabases(),
        operationTimeoutMs,
        "Verify compatibility database absence",
      );
      assertDatabaseEnumeration(databases, "Compatibility database cleanup");
      if (!databases.includes(databaseName)) return { attempts: attempt, verifiedAbsent: true };
      failures.push(new Error(`Temporary compatibility database remains after cleanup attempt ${attempt}`));
    } catch (error) {
      failures.push(error);
    }

    if (attempt < maxAttempts) {
      try {
        await withCompatibilityTimeout(
          () => retryDelay(attempt),
          operationTimeoutMs,
          "Compatibility database cleanup retry delay",
        );
      } catch (error) {
        failures.push(error);
        break;
      }
    }
  }
  throw new AggregateError(
    failures,
    `Temporary compatibility database cleanup failed absence verification after ${maxAttempts} attempts`,
  );
}

export function createCompatibilityCleanupGuard({
  cleanup,
  isOwned,
  markOwned,
  reconcileOwnership,
  signalTarget = process,
  exit = process.exit.bind(process),
  signalCleanupDeadlineMs = 20_000,
}) {
  let armed = false;
  let signalCount = 0;
  let forcedExit = false;
  let cleanupPromise;
  let reconcileCleanupPromise;
  const handlers = new Map();

  function cleanupOnce() {
    if (!isOwned()) return Promise.resolve({ skipped: true, reason: "ownership-not-proven" });
    cleanupPromise ??= Promise.resolve().then(cleanup);
    return cleanupPromise;
  }

  function reconcileAndCleanup() {
    reconcileCleanupPromise ??= (async () => {
      if (!isOwned()) {
        const reconciliation = await reconcileOwnership();
        if (reconciliation?.owned === true) markOwned();
        else if (reconciliation?.verifiedAbsent === true) return reconciliation;
        else throw new Error("Compatibility database ownership was not safely reconciled");
      }
      return cleanupOnce();
    })();
    return reconcileCleanupPromise;
  }

  function arm() {
    if (armed) throw new Error("Compatibility database cleanup guard is already armed");
    armed = true;
    for (const [signal, exitCode] of Object.entries(signalExitCodes)) {
      const handler = () => {
        signalCount += 1;
        if (signalCount > 1) {
          forcedExit = true;
          exit(exitCode);
          return;
        }
        void withCompatibilityTimeout(
          reconcileAndCleanup,
          signalCleanupDeadlineMs,
          "Signal compatibility cleanup deadline",
        ).then(
          () => { if (!forcedExit) exit(exitCode); },
          () => { if (!forcedExit) exit(1); },
        );
      };
      handlers.set(signal, handler);
      signalTarget.on(signal, handler);
    }
  }

  function disarm() {
    for (const [signal, handler] of handlers) signalTarget.off(signal, handler);
    handlers.clear();
    armed = false;
  }

  return { arm, cleanup: reconcileAndCleanup, disarm };
}

export async function runWithOwnedCompatibilityDatabase({
  createDatabase,
  run,
  cleanup,
  reconcileOwnership = async () => ({ owned: false, verifiedAbsent: true }),
  signalTarget = process,
  exit = process.exit.bind(process),
  signalCleanupDeadlineMs = 60_000,
}) {
  let ownershipProven = false;
  let creation;
  let creationSettled = false;
  const markOwned = () => { ownershipProven = true; };
  const reconcileAfterCreationQuiesces = async () => {
    // The first pass terminates an active CREATE backend. The second pass is
    // authoritative only after the corresponding client operation has settled.
    if (!creationSettled) await reconcileOwnership();
    if (creation) {
      try {
        await creation;
      } catch {
        // The operation error is preserved by the main lifecycle below.
      }
    }
    return reconcileOwnership();
  };
  const guard = createCompatibilityCleanupGuard({
    cleanup,
    isOwned: () => ownershipProven,
    markOwned,
    reconcileOwnership: reconcileAfterCreationQuiesces,
    signalTarget,
    exit,
    signalCleanupDeadlineMs,
  });
  guard.arm();
  creation = Promise.resolve().then(() => createDatabase({ markOwned }));
  void creation.then(
    () => { creationSettled = true; },
    () => { creationSettled = true; },
  );

  let result;
  let operationError;
  try {
    await creation;
    if (!ownershipProven) throw new Error("Compatibility database creation did not prove ownership");
    result = await run();
  } catch (error) {
    operationError = error;
  }

  let cleanupError;
  try {
    await guard.cleanup();
  } catch (error) {
    cleanupError = error;
  } finally {
    guard.disarm();
  }
  if (operationError && cleanupError) {
    throw new AggregateError(
      [operationError, cleanupError],
      "Migration compatibility failed and owned temporary database cleanup was incomplete",
    );
  }
  if (cleanupError) throw cleanupError;
  if (operationError) throw operationError;
  return result;
}

export async function runExecutableMigrationCompatibility({
  previousImage,
  operations,
  signalTarget = process,
  exit = process.exit.bind(process),
  signalCleanupDeadlineMs = 60_000,
}) {
  assertPinnedImage(previousImage, "Executable migration compatibility requires the exact prior image digest");
  for (const name of [
    "listDatabases", "createDatabase", "materializeClone", "applyPendingMigrations",
    "reconcileCreate", "runPriorImageProbes", "terminateSessions", "dropDatabase",
  ]) {
    if (typeof operations?.[name] !== "function") {
      throw new TypeError(`Migration compatibility operation is required: ${name}`);
    }
  }
  const databaseName = createCompatibilityDatabaseName();
  let preCreateAbsenceProven = false;
  const reconcileOwnership = async () => {
    if (!preCreateAbsenceProven) return { owned: false, verifiedAbsent: true };
    return reconcileCompatibilityDatabaseCreation({ databaseName, operations });
  };
  return runWithOwnedCompatibilityDatabase({
    signalTarget,
    exit,
    signalCleanupDeadlineMs,
    reconcileOwnership,
    createDatabase: ({ markOwned }) => createCompatibilityDatabase({
      databaseName,
      operations,
      onPreCreateAbsenceProven: () => { preCreateAbsenceProven = true; },
      onOwnershipProven: markOwned,
    }),
    cleanup: async () => {
      let artifactCleanupError;
      try {
        await operations.cleanupArtifacts?.();
      } catch (error) {
        artifactCleanupError = error;
      }
      let databaseCleanupError;
      try {
        await cleanupCompatibilityDatabase({ databaseName, operations });
      } catch (error) {
        databaseCleanupError = error;
      }
      if (databaseCleanupError && artifactCleanupError) {
        throw new AggregateError([databaseCleanupError, artifactCleanupError], "Compatibility cleanup was incomplete");
      }
      if (databaseCleanupError) throw databaseCleanupError;
      if (artifactCleanupError) throw artifactCleanupError;
    },
    run: async () => {
      await verifyOwnedCompatibilityDatabase({ databaseName, operations });
      await operations.materializeClone(databaseName);
      const appliedMigrations = await operations.applyPendingMigrations(databaseName);
      if (!Array.isArray(appliedMigrations) || appliedMigrations.some((name) => typeof name !== "string")) {
        throw new Error("Compatibility clone did not report applied migrations");
      }
      const probes = validatePriorImageProbeResult(
        await operations.runPriorImageProbes(databaseName, previousImage),
        previousImage,
      );
      return { databaseName, previousImage, appliedMigrations, probes };
    },
  });
}

export function validatePriorImageProbeResult(result, previousImage) {
  const topLevelKeys = ["application", "mode", "platform", "previousImage", "probePeriods", "runtime", "schemaVersion"];
  if (!isExactObject(result, topLevelKeys)) {
    throw new Error("Prior-image probe result has an unsupported or incomplete evidence shape");
  }
  if (result.schemaVersion !== 1 || !["standard", "legacy"].includes(result.mode)) {
    throw new Error("Prior-image probe result has an unsupported compatibility mode");
  }
  if (result.previousImage !== previousImage) {
    throw new Error("Prior-image probe result is not bound to the deployed digest");
  }
  if (result.platform !== PRIOR_IMAGE_PLATFORM) {
    throw new Error("Prior-image probe result is not bound to linux/amd64");
  }
  if (!isExactObject(result.probePeriods, ["commissions", "jobs"])
    || !/^20\d{2}-(?:0[1-9]|1[0-2])-01$/.test(result.probePeriods.jobs)
    || !/^20\d{2}-(?:0[1-9]|1[0-2])-01$/.test(result.probePeriods.commissions)) {
    throw new Error("Prior-image probe result is not bound to exact requested periods");
  }
  if (!isExactObject(result.application, ["routes", "succeeded"]) || result.application.succeeded !== true) {
    throw new Error("Prior-image application server probe did not pass");
  }
  if (JSON.stringify(result.application.routes) !== JSON.stringify(expectedApplicationRoutes)) {
    throw new Error("Prior-image application server probe did not execute every required route");
  }
  const runtimeKeys = result.mode === "standard"
    ? ["commissionWorker", "dashboardStores", "databaseHealth", "ingestionLifecycle", "ingestionWorker", "rollupWorker"]
    : ["commissionWorker", "ingestionQueueDiagnostic", "ingestionWorker", "rollupWorker"];
  if (!isExactObject(result.runtime, runtimeKeys)) {
    throw new Error(`Prior-image ${result.mode} runtime evidence is incomplete or overclaims coverage`);
  }
  for (const name of runtimeKeys) {
    const rollup = ["rollupWorker", "commissionWorker"].includes(name);
    const expectedKeys = rollup
      ? ["metricFamily", "outcome", "periodStart", "succeeded"]
      : ["succeeded"];
    if (!isExactObject(result.runtime[name], expectedKeys) || result.runtime[name].succeeded !== true) {
      throw new Error(`Prior-image compatibility probe did not pass: ${name}`);
    }
    if (rollup) {
      const expectedScope = name === "commissionWorker" ? "commissions" : "jobs";
      if (result.runtime[name].metricFamily !== expectedScope
        || result.runtime[name].periodStart !== result.probePeriods[expectedScope]) {
        throw new Error(`Prior-image compatibility probe was not bound to the requested ${expectedScope} period`);
      }
      const allowedOutcomes = name === "commissionWorker"
        ? new Set(["rebuilt", "expected-source-evidence-safety-gate"])
        : new Set(["rebuilt"]);
      if (!allowedOutcomes.has(result.runtime[name].outcome)) {
        throw new Error(`Prior-image compatibility probe reported an unsupported ${name} outcome`);
      }
    }
  }
  return result;
}

export function priorImageProbeEnvironment(connectionString, source = process.env, previousImage) {
  if (typeof connectionString !== "string" || !connectionString) {
    throw new Error("Prior-image probe requires a temporary database connection string");
  }
  const databaseName = decodeURIComponent(new URL(connectionString).pathname.slice(1));
  assertCompatibilityDatabaseName(databaseName);
  const environment = {};
  for (const name of priorImageEnvironmentNames) {
    if (typeof source[name] === "string") environment[name] = source[name];
  }
  environment.AZURE_POSTGRES_CONNECTION_STRING = connectionString;
  environment.METRICS_ADMIN_EMAILS = "asad@prostarmechanical.com";
  environment.METRICS_AUTH_MODE = "easy-auth";
  environment.MIGRATION_COMPATIBILITY_CLONE_ONLY = "true";
  environment.NODE_ENV = "production";
  environment.POSTGRES_SSL_REJECT_UNAUTHORIZED = "true";
  environment.MIGRATION_COMPATIBILITY_PLATFORM = PRIOR_IMAGE_PLATFORM;
  if (previousImage !== undefined) {
    assertPinnedImage(previousImage, "Prior-image environment requires an exact deployed image digest");
    environment.MIGRATION_COMPATIBILITY_IMAGE_DIGEST = previousImage;
  }
  return environment;
}

export function priorImageProbeDockerArgs(previousImage, environment, {
  command = [],
  detached = false,
  publishPort = false,
  pull = "never",
  name,
} = {}) {
  assertPinnedImage(previousImage, "Prior-image probe requires the exact deployed image digest");
  if (!Array.isArray(command) || command.some((value) => typeof value !== "string")) {
    throw new Error("Prior-image command must be an argv array");
  }
  if (!new Set(["always", "never"]).has(pull)) throw new Error("Prior-image pull policy must be always or never");
  assertProbeContainerName(name);
  const forwarded = ["AZURE_POSTGRES_CONNECTION_STRING"];
  for (const environmentName of [
    "AZURE_POSTGRES_CA_CERT", "METRICS_ADMIN_EMAILS", "METRICS_AUTH_MODE",
    "MIGRATION_COMPATIBILITY_CLONE_ONLY", "MIGRATION_COMPATIBILITY_IMAGE_DIGEST",
    "MIGRATION_COMPATIBILITY_PLATFORM", "NODE_ENV", "POSTGRES_SSL_REJECT_UNAUTHORIZED",
  ]) {
    if (typeof environment?.[environmentName] === "string") forwarded.push(environmentName);
  }
  return [
    "run", "--rm", ...(detached ? ["--detach"] : []), `--pull=${pull}`, `--platform=${PRIOR_IMAGE_PLATFORM}`,
    "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "128",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
    "--name", name,
    ...(publishPort ? ["--publish", "127.0.0.1::3000"] : []),
    ...forwarded.flatMap((environmentName) => ["--env", environmentName]),
    previousImage,
    ...command,
  ];
}

export function parseStructuredCommandOutput(stdout, label) {
  const text = String(stdout ?? "").trim();
  if (!text) throw new Error(`${label} returned no structured output`);
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed;
  } catch {
    throw new Error(`${label} returned malformed structured output`);
  }
}

export function validateLegacyRollupProbeOutput(output, { scope, periodStart, exitCode }) {
  if (!isExactObject(output, ["workerId", "commissionCadence", "claimed", "rebuilt", "failures"]) ||
      typeof output.workerId !== "string" || !/^metrics-rollup-\d+$/.test(output.workerId) ||
      output.commissionCadence !== null || output.claimed !== true ||
      !Array.isArray(output.rebuilt) || !Array.isArray(output.failures)) {
    throw new Error(`Legacy exact-image ${scope} rollup worker returned an unsupported evidence envelope`);
  }

  const rebuilt = output.rebuilt[0];
  const rebuiltExactPeriod = output.rebuilt.length === 1
    && isExactObject(rebuilt, ["jobId", "keys", "metricFamily", "periodStart"])
    && isPositiveSafeIntegerId(rebuilt.jobId)
    && rebuilt.metricFamily === scope && rebuilt.periodStart === periodStart
    && Array.isArray(rebuilt.keys)
    && rebuilt.keys.every((key) => typeof key === "string" && key.length > 0)
    && new Set(rebuilt.keys).size === rebuilt.keys.length;
  if (exitCode === 0 && output.failures.length === 0 && rebuiltExactPeriod) {
    return { outcome: "rebuilt" };
  }

  const expectedSafetyErrors = new Set([
    `Commission source evidence is loading for ${periodStart}; refusing immutable-run and ready read-model publication.`,
    `Commission integrity verification failed for ${periodStart}; refusing immutable-run and ready read-model publication: source_complete is false`,
  ]);
  const failure = output.failures[0];
  if (scope === "commissions" && exitCode === 1 && output.rebuilt.length === 0 &&
      output.failures.length === 1 && isExactObject(failure, ["error", "jobId", "metricFamily", "periodStart"]) &&
      isPositiveSafeIntegerId(failure.jobId) &&
      failure.metricFamily === scope && failure.periodStart === periodStart &&
      expectedSafetyErrors.has(failure.error)) {
    return { outcome: "expected-source-evidence-safety-gate" };
  }

  throw new Error(`Legacy exact-image ${scope} rollup worker did not prove compatible clone execution`);
}

export function isStandardRollupEvidenceFallbackError(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /Run exact prior-image compatibility entrypoint failed with exit 1:[\s\S]*Actual (?:jobs|commissions) rollup worker did not rebuild or safely refuse its clone-only period/.test(message);
}

function isPositiveSafeIntegerId(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0;
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return false;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0;
}

export function createRedactedCompatibilityError(prefix, error, secrets = []) {
  const diagnostic = collectErrorDiagnostic(error);
  const redacted = redactCompatibilityDiagnostic(diagnostic, secrets);
  return new Error(`${prefix}: ${redacted || "compatibility operation failed"}`);
}

export function redactCompatibilityDiagnostic(value, secrets = []) {
  let redacted = String(value ?? "");
  const variants = new Set();
  for (const secret of secrets) {
    if (typeof secret !== "string" || !secret) continue;
    variants.add(secret);
    try {
      const parsed = new URL(secret);
      for (const identity of [
        parsed.username,
        decodeURIComponent(parsed.username),
        parsed.password,
        decodeURIComponent(parsed.password),
        parsed.hostname,
      ]) if (identity) variants.add(identity);
    } catch {
      // Non-URL secrets are still replaced exactly.
    }
  }
  for (const secret of [...variants].sort((left, right) => right.length - left.length)) {
    redacted = redacted.replaceAll(secret, "[REDACTED]");
  }
  return redacted
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[REDACTED_POSTGRES_URL]")
    .replace(/((?:password|pwd|token|secret))=([^\s,;]+)/gi, "$1=[REDACTED]")
    .trim()
    .slice(0, 3_000);
}

function collectErrorDiagnostic(error, seen = new Set(), depth = 0) {
  if (depth > 5) return "nested error depth exceeded";
  if (!error || typeof error !== "object") return String(error ?? "unknown error");
  if (seen.has(error)) return "circular error reference";
  seen.add(error);
  const parts = [error instanceof Error ? error.message : String(error)];
  if (error instanceof AggregateError) {
    for (const nested of error.errors) parts.push(collectErrorDiagnostic(nested, seen, depth + 1));
  }
  if ("cause" in error && error.cause !== undefined) {
    parts.push(collectErrorDiagnostic(error.cause, seen, depth + 1));
  }
  return parts.filter(Boolean).join(" | ");
}

function assertPinnedImage(previousImage, message) {
  if (!pinnedImagePattern.test(previousImage ?? "")) throw new Error(message);
}

function assertDatabaseEnumeration(value, label) {
  if (!Array.isArray(value) || value.some((name) => typeof name !== "string")) {
    throw new Error(`${label} did not return a valid pg_database enumeration`);
  }
}

function isExactObject(value, keys) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function stripSqlComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ");
}
