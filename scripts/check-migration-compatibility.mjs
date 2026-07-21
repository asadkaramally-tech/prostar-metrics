import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import pg from "pg";

import {
  assertCompatibilityDatabaseName,
  backwardCompatibilityViolations,
  classifyStrictlyAdditiveMigration,
  cleanupNamedContainerUntilStable,
  createActiveChildRegistry,
  createProbeContainerName,
  createRedactedCompatibilityError,
  parseStructuredCommandOutput,
  PRIOR_IMAGE_PLATFORM,
  redactCompatibilityDiagnostic,
  isStandardRollupEvidenceFallbackError,
  parseMigrationCompatibilityMode,
  priorImageProbeDockerArgs,
  priorImageProbeEnvironment,
  runWithRegisteredProbeContainer,
  runExecutableMigrationCompatibility,
  validateLegacyRollupProbeOutput,
  withCompatibilityTimeout,
} from "./lib/migration-compatibility.mjs";
import { verifiedPostgresClientConfig } from "./postgres-tls.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const migrationDirectory = resolve(ROOT, "infra/db/migrations");
const connectionString = process.env.AZURE_POSTGRES_CONNECTION_STRING;
const previousImage = process.env.PRIOR_PRODUCTION_IMAGE;
const compatibilityMode = parseMigrationCompatibilityMode(
  process.argv.slice(2),
  process.env.MIGRATION_COMPATIBILITY_MODE ?? "static",
);
const reportPendingMigrationCount = process.env.MIGRATION_COMPATIBILITY_REPORT === "1";
const commandTimeoutMs = boundedTimeoutFromEnv("MIGRATION_COMPATIBILITY_COMMAND_TIMEOUT_MS", 180_000, {
  min: 30_000,
  max: 30 * 60_000,
});
const queryTimeoutMs = boundedTimeoutFromEnv("MIGRATION_COMPATIBILITY_QUERY_TIMEOUT_MS", 120_000, {
  min: 30_000,
  max: 30 * 60_000,
});
const attemptedContainerNames = new Set();
const containerCleanupPromises = new Map();
const childRegistry = createActiveChildRegistry();

if (!connectionString) throw new Error("AZURE_POSTGRES_CONNECTION_STRING is required");
if (!previousImage) throw new Error("PRIOR_PRODUCTION_IMAGE is required");

let sourceUrl;
let sourceDatabase;
try {
  sourceUrl = new URL(connectionString);
  sourceDatabase = decodeURIComponent(sourceUrl.pathname.slice(1));
  if (!sourceDatabase) throw new Error("Migration connection string must identify the live baseline database");
} catch (error) {
  throw createRedactedCompatibilityError(
    "Migration connection string validation failed; details were redacted",
    error,
    [connectionString],
  );
}
let dumpDirectory;
let dumpPath;

try {
  const files = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
  const applied = await loadAppliedMigrationBaseline();
  const pending = files.filter((file) => !applied.has(file));
  const pendingSql = [];
  const violations = [];
  for (const filename of pending) {
    const sql = await readFile(resolve(migrationDirectory, filename), "utf8");
    violations.push(...backwardCompatibilityViolations(filename, sql));
    pendingSql.push({ filename, sql, sha256: createHash("sha256").update(sql).digest("hex") });
  }
  if (violations.length) {
    throw new Error(`Pending migrations are not additive/backward-compatible:\n- ${violations.join("\n- ")}`);
  }

  const classifications = pendingSql.map(({ filename, sql }) => classifyStrictlyAdditiveMigration(filename, sql));
  const strictlyAdditive = classifications.filter(({ additive }) => additive).length;
  if (pending.length === 0) {
    console.log(
      `No pending migrations against the live baseline; prior-image compatibility for ${previousImage} is vacuously satisfied.`,
    );
  } else if (compatibilityMode === "clone") {
    await assertRequiredTool("pg_dump", ["--version"], /pg_dump \(PostgreSQL\) 17\./);
    await assertRequiredTool("pg_restore", ["--version"], /pg_restore \(PostgreSQL\) 17\./);
    await assertRequiredTool("docker", ["version", "--format", "{{.Client.Version}}"], /\d+\.\d+/);
    dumpDirectory = await mkdtemp(resolve(tmpdir(), "metrics-compatibility-"));
    dumpPath = resolve(dumpDirectory, "baseline.dump");
    const adminUrl = databaseUrl("postgres");
    const databaseOperations = createDatabaseOperations(adminUrl);
    const result = await runExecutableMigrationCompatibility({
      previousImage,
      operations: {
        ...databaseOperations,
        materializeClone,
        applyPendingMigrations: (databaseName) => applyPendingMigrations(databaseName, pendingSql),
        runPriorImageProbes,
        cleanupArtifacts,
      },
    });
    console.log(`Accepted ${result.appliedMigrations.length} pending migration(s) after actual prior-image application and worker probes for ${previousImage}.`);
  } else {
    console.log(
      `Accepted ${pending.length} pending migration(s) after static prior-image compatibility classification (${strictlyAdditive} strictly additive, ${pending.length - strictlyAdditive} non-additive and covered by the targeted migration gate); full-data clone probing is manual only.`,
    );
  }
  if (reportPendingMigrationCount) {
    console.log(`MIGRATION_COMPATIBILITY_REPORT ${JSON.stringify({ pendingMigrationCount: pending.length })}`);
  }
} catch (error) {
  let artifactCleanupError;
  try {
    await cleanupArtifacts();
  } catch (cleanupError) {
    artifactCleanupError = cleanupError;
  }
  const combined = artifactCleanupError
    ? new AggregateError([error, artifactCleanupError], "Compatibility operation and artifact cleanup failed")
    : error;
  throw createRedactedCompatibilityError(
    "Prior-image migration compatibility failed; details were redacted",
    combined,
    [connectionString, decodeURIComponent(sourceUrl.password || "")],
  );
}

async function loadAppliedMigrationBaseline() {
  return withClient(sourceUrl, "Read live applied-migration baseline", async (client) => {
    const table = await client.query("select to_regclass('metrics.schema_migrations')::text as name");
    if (!table.rows[0]?.name) {
      throw new Error("Cannot establish the live applied-migration baseline; refusing candidate deployment");
    }
    const result = await client.query("select filename from metrics.schema_migrations");
    if (result.rows.some(({ filename }) => typeof filename !== "string")) {
      throw new Error("Live migration baseline returned malformed filenames");
    }
    return new Set(result.rows.map(({ filename }) => filename));
  });
}

function createDatabaseOperations(adminUrl) {
  const runAdmin = (label, operation) => withClient(adminUrl, label, operation, 30_000);
  return {
    async listDatabases() {
      const result = await runAdmin("Enumerate PostgreSQL databases", (client) => (
        client.query("select datname from pg_database")
      ));
      if (!Array.isArray(result.rows) || result.rows.some(({ datname }) => typeof datname !== "string")) {
        throw new Error("PostgreSQL returned an invalid pg_database enumeration");
      }
      return result.rows.map(({ datname }) => datname);
    },
    async createDatabase(databaseName) {
      assertCompatibilityDatabaseName(databaseName);
      await withClient(
        adminUrl,
        "Create compatibility database",
        (client) => client.query(`create database ${quoteIdentifier(databaseName)}`),
        30_000,
        createOperationApplicationName(databaseName),
      );
    },
    async reconcileCreate(databaseName) {
      assertCompatibilityDatabaseName(databaseName);
      const applicationName = createOperationApplicationName(databaseName);
      await runAdmin("Terminate ambiguous compatibility CREATE DATABASE backend", (client) => client.query(
        `select pg_terminate_backend(pid)
           from pg_stat_activity
          where application_name = $1
            and pid <> pg_backend_pid()`,
        [applicationName],
      ));
      const result = await runAdmin("Re-enumerate ambiguous compatibility CREATE DATABASE", (client) => client.query(
        `select exists(select 1 from pg_database where datname = $1) as database_exists,
                exists(select 1 from pg_stat_activity where application_name = $2 and pid <> pg_backend_pid()) as create_operation_active`,
        [databaseName, applicationName],
      ));
      return {
        databaseExists: result.rows[0]?.database_exists === true,
        createOperationActive: result.rows[0]?.create_operation_active === true,
      };
    },
    async terminateSessions(databaseName) {
      assertCompatibilityDatabaseName(databaseName);
      await runAdmin("Terminate compatibility database sessions", (client) => client.query(
        "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
        [databaseName],
      ));
    },
    async dropDatabase(databaseName) {
      assertCompatibilityDatabaseName(databaseName);
      await runAdmin("Force-drop compatibility database", (client) => (
        client.query(`drop database if exists ${quoteIdentifier(databaseName)} with (force)`)
      ));
    },
  };
}

async function materializeClone(databaseName) {
  assertCompatibilityDatabaseName(databaseName);
  if (!dumpPath) throw new Error("Compatibility clone dump path was not initialized");
  await runPostgresTool("pg_dump", [
    "--format=custom", "--no-owner", "--no-acl", "--file", dumpPath, "--dbname", sourceDatabase,
  ], sourceDatabase);
  await runPostgresTool("pg_restore", [
    "--exit-on-error", "--no-owner", "--no-acl", "--dbname", databaseName, dumpPath,
  ], databaseName);
}

async function applyPendingMigrations(databaseName, pendingSql) {
  return withClient(databaseUrl(databaseName), "Apply pending migrations to compatibility clone", async (client) => {
    for (const migration of pendingSql) {
      await client.query("begin");
      try {
        await client.query(migration.sql);
        await client.query(
          "insert into metrics.schema_migrations (filename, sha256) values ($1, $2)",
          [migration.filename, migration.sha256],
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      }
    }
    return pendingSql.map(({ filename }) => filename);
  });
}

async function runPriorImageProbes(databaseName, exactPreviousImage) {
  assertCompatibilityDatabaseName(databaseName);
  const temporaryConnectionString = databaseUrl(databaseName).toString();
  const environment = priorImageProbeEnvironment(temporaryConnectionString, process.env, exactPreviousImage);
  const periods = await selectProbePeriods(databaseName);
  const entrypointCheck = await runDockerCommand(
    exactPreviousImage,
    environment,
    ["test", "-f", "scripts/migration-compatibility-entrypoint.ts"],
    "Inspect exact prior-image compatibility entrypoint",
    {
      pull: "always",
      allowedExitCodes: [0, 1],
    },
  );
  const platformResult = await runCommand(
    "docker",
    ["image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", exactPreviousImage],
    { env: environment, label: "Verify exact prior-image platform" },
  );
  const platform = platformResult.stdout.trim();
  if (platform !== PRIOR_IMAGE_PLATFORM) {
    throw new Error(`Exact prior image resolved to unsupported platform ${platform || "unknown"}`);
  }
  let mode = entrypointCheck.code === 0 ? "standard" : "legacy";
  const application = await runApplicationServerProbe(exactPreviousImage, environment, periods);
  let runtime;
  if (mode === "standard") {
    try {
      runtime = await runStandardRuntimeProbe(exactPreviousImage, environment, databaseName, periods);
    } catch (error) {
      if (!isStandardRollupEvidenceFallbackError(error)) throw error;
      mode = "legacy";
      runtime = await runLegacyRuntimeProbe(exactPreviousImage, environment, databaseName, periods);
    }
  } else {
    runtime = await runLegacyRuntimeProbe(exactPreviousImage, environment, databaseName, periods);
  }
  return {
    schemaVersion: 1,
    mode,
    platform,
    previousImage: exactPreviousImage,
    probePeriods: {
      jobs: `${periods.jobs}-01`,
      commissions: `${periods.commissions}-01`,
    },
    application,
    runtime,
  };
}

async function runApplicationServerProbe(exactPreviousImage, environment, periods) {
  return withRegisteredProbeContainer(environment, async (containerName) => {
    const started = await runCommand(
      "docker",
      priorImageProbeDockerArgs(exactPreviousImage, environment, {
        command: ["node", "server.js"],
        detached: true,
        name: containerName,
        publishPort: true,
      }),
      { env: environment, label: "Start exact prior-image application server" },
    );
    if (!/^[a-f0-9]{12,64}$/.test(started.stdout.trim())) {
      throw new Error("Docker returned an invalid prior-image application container identity");
    }
    const portResult = await runCommand("docker", ["port", containerName, "3000/tcp"], {
      env: environment,
      label: "Resolve prior-image application probe port",
    });
    const match = portResult.stdout.trim().match(/127\.0\.0\.1:(\d+)$/);
    if (!match) throw new Error("Docker did not publish the prior-image application on loopback");
    const origin = `http://127.0.0.1:${match[1]}`;
    await waitForApplication(origin, containerName, environment);
    const principal = Buffer.from(JSON.stringify({
      userDetails: "asad@prostarmechanical.com",
      claims: [{ typ: "preferred_username", val: "asad@prostarmechanical.com" }],
    })).toString("base64");
    const headers = { "x-ms-client-principal": principal };
    const health = await fetchJson(`${origin}/api/health`);
    if (health.status !== 200 || health.body?.ok !== true || health.body?.database?.connected !== true) {
      throw new Error("Exact prior-image database-aware health route failed");
    }
    const jobs = await fetchJson(`${origin}/api/jobs?month=${periods.jobs}`, headers);
    if (jobs.status !== 200 || jobs.body?.loadError) throw new Error("Exact prior-image jobs API/store route failed");
    const quotes = await fetchJson(`${origin}/api/quotes?month=${periods.jobs}`, headers);
    if (quotes.status !== 200 || !Number.isFinite(quotes.body?.quotesLoaded)) {
      throw new Error("Exact prior-image quotes API/store route failed");
    }
    const technicians = await fetchJson(`${origin}/api/technicians?month=${periods.jobs}`, headers);
    if (technicians.status !== 200 || technicians.body?.scope !== "technicians") {
      throw new Error("Exact prior-image technicians API/store route failed");
    }
    const [commissionYear, commissionMonth] = periods.commissions.split("-");
    const commissions = await fetchJson(
      `${origin}/api/commissions?year=${commissionYear}&month=${commissionMonth}&summaryYear=${commissionYear}`,
      headers,
    );
    if (commissions.status !== 200 || !commissions.body?.worksheet
      || commissions.body.worksheet.servingCode === "READ_MODEL_UNAVAILABLE") {
      throw new Error("Exact prior-image commissions API/store route failed");
    }
    return {
      succeeded: true,
      routes: ["/api/health", "/api/jobs", "/api/quotes", "/api/technicians", "/api/commissions"],
    };
  });
}

async function runStandardRuntimeProbe(exactPreviousImage, environment, databaseName, periods) {
  const result = await runDockerCommand(exactPreviousImage, environment, [
    "node", "node_modules/tsx/dist/cli.mjs", "scripts/migration-compatibility-entrypoint.ts",
  ], "Run exact prior-image compatibility entrypoint");
  const output = parseStructuredCommandOutput(result.stdout, "Exact prior-image compatibility entrypoint");
  if (output.schemaVersion !== 1 || output.mode !== "standard" || output.platform !== PRIOR_IMAGE_PLATFORM
    || JSON.stringify(Object.keys(output).sort()) !== JSON.stringify(["mode", "platform", "runtime", "schemaVersion"])) {
    throw new Error("Exact prior-image compatibility entrypoint returned an unsupported evidence envelope");
  }
  const exactJobs = await runLegacyRollupWorker(
    exactPreviousImage, environment, databaseName, "jobs", periods.jobs,
  );
  const exactCommissions = await runLegacyRollupWorker(
    exactPreviousImage, environment, databaseName, "commissions", periods.commissions,
  );
  return {
    ...output.runtime,
    rollupWorker: {
      succeeded: true,
      outcome: exactJobs.outcome,
      metricFamily: "jobs",
      periodStart: `${periods.jobs}-01`,
    },
    commissionWorker: {
      succeeded: true,
      outcome: exactCommissions.outcome,
      metricFamily: "commissions",
      periodStart: `${periods.commissions}-01`,
    },
  };
}

async function runLegacyRuntimeProbe(exactPreviousImage, environment, databaseName, periods) {
  const ingestion = parseStructuredCommandOutput((await runDockerCommand(
    exactPreviousImage,
    environment,
    ["node", "node_modules/tsx/dist/cli.mjs", "workers/ingest-simpro.ts", "--dry-run", "--entity", "jobs"],
    "Run legacy exact-image ingestion worker dry-run",
  )).stdout, "Legacy ingestion worker");
  if (ingestion.mode !== "dry-run" || ingestion.entity !== "jobs") {
    throw new Error("Legacy exact-image ingestion worker did not prove its no-Simpro dry-run path");
  }

  const queueDiagnostic = parseStructuredCommandOutput((await runDockerCommand(
    exactPreviousImage,
    environment,
    ["node", "node_modules/tsx/dist/cli.mjs", "workers/queue-maintenance.ts", "--dry-run"],
    "Run legacy exact-image ingestion queue diagnostic",
  )).stdout, "Legacy ingestion queue diagnostic");
  if (queueDiagnostic.dryRun !== true || !Array.isArray(queueDiagnostic.cancelledQueuedJobs)) {
    throw new Error("Legacy exact-image ingestion queue diagnostic did not read the clone");
  }

  const rollup = await runLegacyRollupWorker(exactPreviousImage, environment, databaseName, "jobs", periods.jobs);
  const commissions = await runLegacyRollupWorker(
    exactPreviousImage,
    environment,
    databaseName,
    "commissions",
    periods.commissions,
  );
  if (!rollup || !commissions) throw new Error("Legacy exact-image rollup probes did not complete");
  return {
    ingestionWorker: { succeeded: true },
    ingestionQueueDiagnostic: { succeeded: true },
    rollupWorker: {
      succeeded: true,
      outcome: rollup.outcome,
      metricFamily: "jobs",
      periodStart: `${periods.jobs}-01`,
    },
    commissionWorker: {
      succeeded: true,
      outcome: commissions.outcome,
      metricFamily: "commissions",
      periodStart: `${periods.commissions}-01`,
    },
  };
}

async function runLegacyRollupWorker(exactPreviousImage, environment, databaseName, scope, month) {
  await withClient(databaseUrl(databaseName), `Prepare isolated legacy ${scope} rollup`, (client) => client.query(
    `update metrics.rollup_rebuild_queue
        set status = 'cancelled', locked_by = null, locked_until = null,
            finished_at = now(), error_message = 'superseded inside disposable migration compatibility clone'
      where metric_family = $1 and status in ('queued', 'running')`,
    [scope],
  ));
  const result = await runDockerCommand(
    exactPreviousImage,
    environment,
    [
      "node", "node_modules/tsx/dist/cli.mjs", "workers/rebuild-rollups.ts",
      "--scope", scope, "--period-start", `${month}-01`,
      "--reason", "legacy migration compatibility clone probe", "--limit", "1",
    ],
    `Run legacy exact-image ${scope} rollup worker`,
    { allowedExitCodes: scope === "commissions" ? [0, 1] : [0] },
  );
  const output = parseStructuredCommandOutput(result.stdout, `Legacy ${scope} rollup worker`);
  return validateLegacyRollupProbeOutput(output, {
    scope,
    periodStart: `${month}-01`,
    exitCode: result.code,
  });
}

async function runDockerCommand(exactPreviousImage, environment, command, label, options = {}) {
  return withRegisteredProbeContainer(environment, (containerName) => runCommand(
    "docker",
    priorImageProbeDockerArgs(exactPreviousImage, environment, {
      command,
      name: containerName,
      pull: options.pull,
    }),
    { env: environment, label, allowedExitCodes: options.allowedExitCodes ?? [0] },
  ));
}

async function selectProbePeriods(databaseName) {
  return withClient(databaseUrl(databaseName), "Select actual prior-image probe periods", async (client) => {
    const result = await client.query(`
      select coalesce(
               (select to_char(max(completed_date), 'YYYY-MM') from metrics.metrics_jobs
                 where lower(stage) in ('complete', 'archived') and source_deleted_at is null),
               to_char(current_date, 'YYYY-MM')
             ) as jobs,
             coalesce(
               (select to_char(max(period_start), 'YYYY-MM') from metrics.commission_periods),
               to_char(current_date, 'YYYY-MM')
             ) as commissions
    `);
    const periods = result.rows[0];
    if (!periods || !/^20\d{2}-\d{2}$/.test(periods.jobs) || !/^20\d{2}-\d{2}$/.test(periods.commissions)) {
      throw new Error("Compatibility clone did not provide valid application probe periods");
    }
    return periods;
  });
}

async function waitForApplication(origin, containerId, environment) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(3_000) });
      if (response.status === 200) return;
    } catch {
      // The exact prior-image server is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  const logs = await runCommand("docker", ["logs", "--tail", "80", containerId], {
    env: environment,
    label: "Read failed prior-image application logs",
    allowedExitCodes: [0, 1],
  });
  throw new Error(`Exact prior-image application server did not become healthy: ${redactDiagnostic(logs.stderr || logs.stdout)}`);
}

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`Prior-image application returned non-JSON HTTP ${response.status}`);
  }
  return { status: response.status, body };
}

async function withRegisteredProbeContainer(environment, operation) {
  const containerName = createProbeContainerName();
  return runWithRegisteredProbeContainer({
    containerName,
    register: (name) => attemptedContainerNames.add(name),
    run: operation,
    cleanup: (name) => cleanupProbeContainer(name, environment),
  });
}

function cleanupProbeContainer(containerName, environment) {
  let cleanup = containerCleanupPromises.get(containerName);
  if (cleanup) return cleanup;
  cleanup = (async () => {
    await childRegistry.quiesceAll(new Error("Compatibility container cleanup interrupted an active child process"));
    const result = await cleanupNamedContainerUntilStable({
      containerName,
      forceRemove: async (name) => {
        await runCommand("docker", ["rm", "--force", name], {
          env: environment,
          label: "Force-remove prior-image compatibility container",
          allowedExitCodes: [0, 1],
          timeoutMs: 30_000,
        });
      },
      isPresent: async (name) => {
        const remaining = await runCommand(
          "docker",
          ["container", "ls", "--all", "--quiet", "--filter", `name=^/${name}$`],
          { env: environment, label: "Verify prior-image compatibility container absence", timeoutMs: 30_000 },
        );
        return Boolean(remaining.stdout.trim());
      },
    });
    attemptedContainerNames.delete(containerName);
    return result;
  })().finally(() => containerCleanupPromises.delete(containerName));
  containerCleanupPromises.set(containerName, cleanup);
  return cleanup;
}

async function cleanupArtifacts() {
  const environment = hostToolEnvironment();
  const failures = [];
  try {
    await childRegistry.quiesceAll(new Error("Compatibility signal/failure cleanup interrupted an active child process"));
  } catch (error) {
    failures.push(error);
  }
  for (const containerName of [...attemptedContainerNames]) {
    try {
      await cleanupProbeContainer(containerName, environment);
    } catch (error) {
      failures.push(error);
    }
  }
  if (dumpDirectory) {
    try {
      await rm(dumpDirectory, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, "Compatibility artifact cleanup failed");
}

async function runPostgresTool(command, args, databaseName) {
  await runCommand(command, args, {
    env: postgresToolEnvironment(databaseName),
    label: `${command} compatibility clone materialization`,
    timeoutMs: 15 * 60_000,
    maxOutputBytes: 4 * 1024 * 1024,
  });
}

async function assertRequiredTool(command, args, expected) {
  const result = await runCommand(command, args, {
    env: hostToolEnvironment(),
    label: `Check required ${command} runtime`,
    timeoutMs: 15_000,
  });
  if (!expected.test(`${result.stdout}\n${result.stderr}`)) {
    throw new Error(`Required runtime ${command} is present but has an unsupported version`);
  }
}

function runCommand(command, args, {
  env,
  label,
  timeoutMs = commandTimeoutMs,
  maxOutputBytes = 8 * 1024 * 1024,
  allowedExitCodes = [0],
}) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    const childRecord = childRegistry.track(child, label);
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) rejectCommand(error);
      else resolveCommand(result);
    };
    const requestTermination = (error) => {
      if (childRecord.terminationError) return;
      void childRegistry.terminate(childRecord, error).catch((closeError) => {
        finish(new AggregateError([error, closeError], `${label} termination did not quiesce its child process`));
      });
    };
    const timeout = setTimeout(() => requestTermination(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    const append = (target, chunk) => {
      const next = target + chunk;
      if (next.length > maxOutputBytes) {
        requestTermination(new Error(`${label} exceeded its bounded output limit`));
      }
      return next;
    };
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.on("error", (error) => {
      const detail = error?.code === "ENOENT"
        ? `Required runtime ${command} is unavailable on PATH`
        : `${label} could not start: ${error.message}`;
      childRecord.startupError = new Error(detail);
    });
    void childRecord.closePromise.then(({ code, signal }) => {
      if (childRecord.terminationError) {
        finish(childRecord.terminationError);
        return;
      }
      if (childRecord.startupError) {
        finish(childRecord.startupError);
        return;
      }
      if (!allowedExitCodes.includes(code)) {
        const suffix = signal ? `signal ${signal}` : `exit ${code}`;
        finish(new Error(`${label} failed with ${suffix}: ${redactDiagnostic(`${stdout}\n${stderr}`)}`));
        return;
      }
      finish(undefined, { code, stdout, stderr });
    });
  });
}

async function withClient(
  url,
  label,
  operation,
  operationTimeoutMs = queryTimeoutMs,
  applicationName = "prostar-migration-compatibility",
) {
  const client = await createClient(url, operationTimeoutMs, applicationName);
  try {
    await withCompatibilityTimeout(() => client.connect(), operationTimeoutMs, `${label} connection`);
    return await withCompatibilityTimeout(() => operation(client), operationTimeoutMs, label);
  } finally {
    await withCompatibilityTimeout(() => client.end(), 5_000, `${label} client close`).catch(() => undefined);
  }
}

async function createClient(url, timeoutMs, applicationName) {
  const config = await verifiedPostgresClientConfig(url.toString());
  return new pg.Client({
    ...config,
    connectionTimeoutMillis: Math.min(timeoutMs, 15_000),
    query_timeout: timeoutMs,
    statement_timeout: timeoutMs,
    application_name: applicationName,
  });
}

function postgresToolEnvironment(databaseName) {
  const environment = hostToolEnvironment();
  environment.PGHOST = sourceUrl.hostname;
  environment.PGPORT = sourceUrl.port || "5432";
  environment.PGUSER = decodeURIComponent(sourceUrl.username);
  environment.PGPASSWORD = decodeURIComponent(sourceUrl.password);
  environment.PGDATABASE = databaseName;
  environment.PGSSLMODE = "verify-full";
  environment.PGSSLROOTCERT ||= "system";
  return environment;
}

function hostToolEnvironment() {
  const environment = {};
  for (const name of ["DOCKER_CONFIG", "HOME", "LANG", "LC_ALL", "PATH", "PGSSLROOTCERT", "TMPDIR"]) {
    if (typeof process.env[name] === "string") environment[name] = process.env[name];
  }
  return environment;
}

function databaseUrl(databaseName) {
  const url = new URL(sourceUrl);
  url.pathname = `/${databaseName}`;
  return url;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function createOperationApplicationName(databaseName) {
  assertCompatibilityDatabaseName(databaseName);
  return `prostar-compat-create-${databaseName.slice(-24)}`;
}

function redactDiagnostic(value) {
  const password = decodeURIComponent(sourceUrl.password || "");
  const username = decodeURIComponent(sourceUrl.username || "");
  return redactCompatibilityDiagnostic(value, [
    connectionString,
    password,
    username,
    sourceUrl.hostname,
  ]);
}

function boundedTimeoutFromEnv(name, fallback, { min, max }) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer millisecond timeout`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max} milliseconds`);
  }
  return value;
}
