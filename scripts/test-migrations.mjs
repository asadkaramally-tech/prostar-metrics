import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { verifiedPostgresClientConfig } from "./postgres-tls.mjs";

const { Client } = pg;
const root = resolve(import.meta.dirname, "..");
const migrationDir = resolve(root, "infra/db/migrations");
const SIGNAL_EXIT_CODES = Object.freeze({ SIGINT: 130, SIGTERM: 143 });
const TEMPORARY_DATABASE_PATTERN = /^metrics_migration_test_[a-f0-9]{32}$/;
const CONNECTION_TIMEOUT_MS = 15_000;
const QUERY_TIMEOUT_MS = 120_000;
const ADMIN_OPERATION_TIMEOUT_MS = 60_000;
const CLEANUP_OPERATION_TIMEOUT_MS = 60_000;
const CLIENT_CLOSE_TIMEOUT_MS = 5_000;
const SIGNAL_CLEANUP_DEADLINE_MS = 20_000;

export function assertTemporaryDatabaseName(databaseName) {
  if (!TEMPORARY_DATABASE_PATTERN.test(databaseName ?? "")) {
    throw new Error("Temporary migration database name is not an internally generated full-UUID name");
  }
  return databaseName;
}

function createTemporaryDatabaseName() {
  return assertTemporaryDatabaseName(`metrics_migration_test_${randomUUID().replaceAll("-", "")}`);
}

function quoteIdentifier(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

export async function withOperationTimeout(operation, timeoutMs, label) {
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

async function withClient(connectionString, createClient, operation, {
  label = "PostgreSQL operation",
  operationTimeoutMs = QUERY_TIMEOUT_MS,
} = {}) {
  const connection = await withOperationTimeout(
    () => createClient(connectionString),
    operationTimeoutMs,
    `${label} client creation`,
  );
  try {
    await withOperationTimeout(() => connection.connect(), operationTimeoutMs, `${label} connection`);
    return await withOperationTimeout(() => operation(connection), operationTimeoutMs, label);
  } finally {
    await withOperationTimeout(() => connection.end(), CLIENT_CLOSE_TIMEOUT_MS, `${label} client close`).catch(() => undefined);
  }
}

export function createPostgresCleanupOperations({
  adminConnectionString,
  createClient = (url) => client(url, {
    connectionTimeoutMs: CLEANUP_OPERATION_TIMEOUT_MS,
    queryTimeoutMs: CLEANUP_OPERATION_TIMEOUT_MS,
  }),
  operationTimeoutMs = CLEANUP_OPERATION_TIMEOUT_MS,
}) {
  const run = (label, operation) => withClient(adminConnectionString, createClient, operation, {
    label,
    operationTimeoutMs,
  });
  return {
    async terminateSessions(databaseName) {
      assertTemporaryDatabaseName(databaseName);
      await run("Terminate temporary database sessions", (connection) => connection.query(
        "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
        [databaseName],
      ));
    },
    async dropDatabase(databaseName) {
      assertTemporaryDatabaseName(databaseName);
      await run("Drop temporary database", (connection) => connection.query(
        `drop database if exists ${quoteIdentifier(databaseName)} with (force)`,
      ));
    },
    async listDatabases() {
      const result = await run("Enumerate PostgreSQL databases", (connection) => (
        connection.query("select datname from pg_database")
      ));
      if (!Array.isArray(result?.rows) || result.rows.some(({ datname }) => typeof datname !== "string")) {
        throw new Error("PostgreSQL returned an invalid pg_database enumeration");
      }
      return result.rows.map(({ datname }) => datname);
    },
  };
}

export async function createTemporaryDatabase({
  databaseName,
  operations,
  operationTimeoutMs = ADMIN_OPERATION_TIMEOUT_MS,
}) {
  assertTemporaryDatabaseName(databaseName);
  const databasesBeforeCreate = await withOperationTimeout(
    () => operations.listDatabases(),
    operationTimeoutMs,
    "Pre-create pg_database enumeration",
  );
  if (!Array.isArray(databasesBeforeCreate) || databasesBeforeCreate.some((name) => typeof name !== "string")) {
    throw new Error("Pre-create check did not receive a valid pg_database enumeration");
  }
  if (databasesBeforeCreate.includes(databaseName)) {
    throw new Error("Cryptographically reserved temporary database name already exists");
  }
  await withOperationTimeout(
    () => operations.createDatabase(databaseName),
    operationTimeoutMs,
    "Create temporary migration database",
  );
}

export async function cleanupTemporaryDatabase({
  databaseName,
  operations,
  maxAttempts = 4,
  operationTimeoutMs = CLEANUP_OPERATION_TIMEOUT_MS,
  retryDelay = (attempt) => new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 250)),
}) {
  assertTemporaryDatabaseName(databaseName);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new Error("Temporary database cleanup attempts must be an integer from 1 through 10");
  }
  const failures = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await withOperationTimeout(
        () => operations.terminateSessions(databaseName),
        operationTimeoutMs,
        "Terminate temporary database sessions",
      );
    } catch (error) {
      failures.push(error);
    }
    try {
      await withOperationTimeout(
        () => operations.dropDatabase(databaseName),
        operationTimeoutMs,
        "Drop temporary database",
      );
    } catch (error) {
      failures.push(error);
    }

    try {
      const databases = await withOperationTimeout(
        () => operations.listDatabases(),
        operationTimeoutMs,
        "Verify temporary database absence",
      );
      if (!Array.isArray(databases) || databases.some((name) => typeof name !== "string")) {
        throw new Error("Cleanup did not receive a valid pg_database enumeration");
      }
      if (!databases.includes(databaseName)) {
        return { attempts: attempt, verifiedAbsent: true };
      }
      failures.push(new Error(`Temporary migration database remains after cleanup attempt ${attempt}`));
    } catch (error) {
      failures.push(error);
    }

    if (attempt < maxAttempts) {
      try {
        await withOperationTimeout(
          () => retryDelay(attempt),
          operationTimeoutMs,
          "Temporary database cleanup retry delay",
        );
      } catch (error) {
        failures.push(error);
        break;
      }
    }
  }
  throw new AggregateError(
    failures,
    `Temporary migration database cleanup failed absence verification after ${maxAttempts} attempts`,
  );
}

export function createTemporaryDatabaseCleanupGuard({
  cleanup,
  isOwned,
  signalTarget = process,
  exit = process.exit.bind(process),
  signalCleanupDeadlineMs = SIGNAL_CLEANUP_DEADLINE_MS,
}) {
  let armed = false;
  let signalCount = 0;
  let forcedExit = false;
  let cleanupPromise;
  const handlers = new Map();

  function cleanupOnce() {
    if (!isOwned()) return Promise.resolve({ skipped: true, reason: "ownership-not-proven" });
    cleanupPromise ??= Promise.resolve().then(cleanup);
    return cleanupPromise;
  }

  function arm() {
    if (armed) throw new Error("Temporary database cleanup guard is already armed");
    armed = true;
    for (const [signal, exitCode] of Object.entries(SIGNAL_EXIT_CODES)) {
      const handler = () => {
        signalCount += 1;
        if (signalCount > 1) {
          forcedExit = true;
          exit(exitCode);
          return;
        }
        if (!isOwned()) {
          exit(exitCode);
          return;
        }
        void withOperationTimeout(
          cleanupOnce,
          signalCleanupDeadlineMs,
          "Signal cleanup deadline",
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

  return { arm, cleanup: cleanupOnce, disarm };
}

export async function runWithTemporaryDatabaseCleanup({
  createDatabase,
  run,
  cleanup,
  signalTarget = process,
  exit = process.exit.bind(process),
  signalCleanupDeadlineMs = SIGNAL_CLEANUP_DEADLINE_MS,
}) {
  let ownershipProven = false;
  const guard = createTemporaryDatabaseCleanupGuard({
    cleanup,
    isOwned: () => ownershipProven,
    signalTarget,
    exit,
    signalCleanupDeadlineMs,
  });
  guard.arm();
  const creation = Promise.resolve().then(createDatabase).then((value) => {
    ownershipProven = true;
    return value;
  });

  let result;
  let operationError;
  try {
    await creation;
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
    throw new AggregateError([operationError, cleanupError], "Migration test failed and temporary database cleanup was incomplete");
  }
  if (cleanupError) throw cleanupError;
  if (operationError) throw operationError;
  return result;
}

export async function runMigrationTests(options = {}) {
  const allowedOptions = new Set(["connectionString", "exit", "signalTarget"]);
  const unknownOptions = Object.keys(options).filter((name) => !allowedOptions.has(name));
  if (unknownOptions.length > 0) {
    throw new Error(`Unsupported migration test option: ${unknownOptions.join(", ")}`);
  }
  const {
    connectionString = process.env.AZURE_POSTGRES_CONNECTION_STRING,
    signalTarget = process,
    exit = process.exit.bind(process),
  } = options;
  if (!connectionString) throw new Error("AZURE_POSTGRES_CONNECTION_STRING is required");
  const databaseName = createTemporaryDatabaseName();
  const files = (await readdir(migrationDir)).filter((file) => file.endsWith(".sql")).sort();
  const adminUrl = new URL(connectionString);
  adminUrl.pathname = "/postgres";
  const testUrl = new URL(connectionString);
  testUrl.pathname = `/${databaseName}`;
  const cleanupOperations = createPostgresCleanupOperations({ adminConnectionString: adminUrl.toString() });
  const creationOperations = {
    listDatabases: cleanupOperations.listDatabases,
    createDatabase: (name) => withClient(adminUrl.toString(), (url) => client(url, {
      connectionTimeoutMs: CONNECTION_TIMEOUT_MS,
      queryTimeoutMs: ADMIN_OPERATION_TIMEOUT_MS,
    }), (connection) => connection.query(`create database ${quoteIdentifier(name)}`), {
      label: "Create temporary migration database",
      operationTimeoutMs: ADMIN_OPERATION_TIMEOUT_MS,
    }),
  };

  await runWithTemporaryDatabaseCleanup({
    signalTarget,
    exit,
    createDatabase: () => createTemporaryDatabase({ databaseName, operations: creationOperations }),
    cleanup: () => cleanupTemporaryDatabase({ databaseName, operations: cleanupOperations }),
    run: async () => {
      const testClient = await client(testUrl.toString());
      try {
        await testClient.connect();
        await runMigrationAssertions({ testClient, testUrl, files, databaseName });
      } finally {
        await testClient.end().catch(() => undefined);
      }
    },
  });
}

async function runMigrationAssertions({ testClient, testUrl, files, databaseName }) {
  for (const file of files) {
    if (file === "010_quarantine_production_verification_artifacts.sql") {
      await seedProductionVerificationArtifacts(testClient);
    }
    const sql = await readFile(resolve(migrationDir, file), "utf8");
    await testClient.query(sql);
    // Retry at the same migration boundary. Historical migrations are never
    // replayed after newer constraints have become authoritative.
    if (file >= "004_metrics_canonical_contract.sql") await testClient.query(sql);
  }

  const result = await testClient.query(
    `select to_regclass('metrics.source_change_events') as change_events,
            to_regclass('metrics.metrics_quote_labor') as quote_labor,
            to_regclass('metrics.metrics_job_labor') as job_labor,
            to_regclass('metrics.invoice_snapshots') as invoices,
            to_regclass('metrics.commission_run_inputs') as run_inputs,
            to_regclass('metrics.simpro_rate_limit_buckets') as rate_limit_buckets,
            to_regclass('metrics.pipeline_telemetry') as pipeline_telemetry,
            to_regclass('metrics.simpro_profit_capacity_completeness') as profit_capacity_completeness,
            to_regclass('metrics.authoritative_reconciliation_checks') as authoritative_reconciliation_checks,
            to_regclass('metrics.authoritative_reconciliation_results') as authoritative_reconciliation_results,
            to_regclass('metrics.operational_telemetry_emissions') as operational_telemetry_emissions,
            to_regclass('metrics.source_freshness') as freshness_view,
            to_regclass('metrics.report_exports') as exports_view,
            to_regclass('metrics.audit_log') as audit_view`,
  );
  for (const [name, value] of Object.entries(result.rows[0] ?? {})) {
    if (!value) throw new Error(`Missing expected relation: ${name}`);
  }

  const quarantine = await testClient.query(`
    select
      (select status::text from metrics.ingestion_jobs where idempotency_key = 'quote_nested:1:wp02-migration-fixture') as fixture_status,
      (select next_attempt_at is not null from metrics.ingestion_jobs where idempotency_key = 'quote_nested:1:wp02-migration-fixture') as fixture_retry_timestamp,
      (select last_error is null from metrics.ingestion_jobs where idempotency_key = 'jobs:migration-succeeded-error') as succeeded_error_cleared,
      (select superseded_at is not null from metrics.dashboard_read_models where metric_family = 'jobs' and period_start = date '2022-01-01') as old_model_superseded,
      (select status::text from metrics.rollup_rebuild_queue where idempotency_key = 'jobs:month:2022-01-01:migration-fixture') as old_rollup_status,
      (select count(*)::int from metrics.audit_events where actor_email = 'metrics-migration@prostarmechanical.com') as audit_count
  `);
  const quarantineRow = quarantine.rows[0];
  if (quarantineRow?.fixture_status !== "cancelled") throw new Error("Verification fixture was not cancelled");
  if (quarantineRow?.fixture_retry_timestamp !== true) throw new Error("Cancelled fixture lost its required retry timestamp");
  if (quarantineRow?.succeeded_error_cleared !== true) throw new Error("Succeeded ingestion error was not cleared");
  if (quarantineRow?.old_model_superseded !== true) throw new Error("Out-of-scope read model was not superseded");
  if (quarantineRow?.old_rollup_status !== "cancelled") throw new Error("Out-of-scope rollup was not cancelled");
  if (Number(quarantineRow?.audit_count ?? 0) < 4) throw new Error("Artifact quarantine did not write complete audit evidence");

  await assertServingWindowEnforced(testClient);
  await assertProfitCapacityContract(testClient);
  await assertScheduleIdentityContract(testClient);
  await assertPlatformTrustContract(testClient);
  await runNestedTraversalConcurrencyTest(testUrl.toString());
  await runRateLimiterConcurrencyTest(testUrl.toString());

  await testClient.query(`
    insert into metrics.invoice_snapshots (invoice_type, invoice_id)
    values ('global', 999999999)
    on conflict do nothing;
    insert into metrics.invoice_job_links (invoice_type, invoice_id, job_id, cost_center_id, ex_tax)
    values ('global', 999999999, 888888888, null, 1.00)
    on conflict do nothing;
  `);
  console.log(`Applied ${files.length} migrations twice-safe to temporary database ${databaseName}.`);
}

async function client(url, {
  connectionTimeoutMs = CONNECTION_TIMEOUT_MS,
  queryTimeoutMs = QUERY_TIMEOUT_MS,
} = {}) {
  return new Client({
    ...await verifiedPostgresClientConfig(url),
    connectionTimeoutMillis: connectionTimeoutMs,
    query_timeout: queryTimeoutMs,
    statement_timeout: queryTimeoutMs,
  });
}

async function assertPlatformTrustContract(connection) {
  await connection.query("begin");
  try {
    await connection.query(`
      insert into metrics.reconciliation_checks (
        scope, period_start, period_end, status, generation,
        complete_traversal, source_manifest_generations
      ) values (
        'jobs', date '2026-06-01', date '2026-06-30', 'matched',
        null, true, '{}'::jsonb
      )
    `);
    throw new Error("Generationless complete reconciliation probe was accepted");
  } catch (error) {
    await connection.query("rollback");
    if (!String(error?.message ?? error).includes("reconciliation_complete_generation_proof_check")) {
      throw error;
    }
  }
}

async function runNestedTraversalConcurrencyTest(temporaryConnectionString) {
  const script = resolve(root, "scripts/test-nested-traversal-concurrency.ts");
  await new Promise((resolvePromise, reject) => {
    const subprocess = spawn(process.execPath, ["--import", "tsx", script], {
      cwd: root,
      env: {
        ...process.env,
        AZURE_POSTGRES_CONNECTION_STRING: temporaryConnectionString,
      },
      stdio: "inherit",
    });
    subprocess.once("error", reject);
    subprocess.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(
        signal
          ? `Nested traversal concurrency test exited from signal ${signal}`
          : `Nested traversal concurrency test exited with code ${code}`,
      ));
    });
  });
}

async function runRateLimiterConcurrencyTest(temporaryConnectionString) {
  const script = resolve(root, "scripts/test-rate-limiter-concurrency.ts");
  await new Promise((resolvePromise, reject) => {
    const subprocess = spawn(process.execPath, ["--import", "tsx", script], {
      cwd: root,
      env: {
        ...process.env,
        AZURE_POSTGRES_CONNECTION_STRING: temporaryConnectionString,
      },
      stdio: "inherit",
    });
    subprocess.once("error", reject);
    subprocess.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(
        signal
          ? `Rate limiter concurrency test exited from signal ${signal}`
          : `Rate limiter concurrency test exited with code ${code}`,
      ));
    });
  });
}

async function seedProductionVerificationArtifacts(connection) {
  await connection.query(`
    insert into metrics.ingestion_jobs (
      entity_type, status, idempotency_key, last_error
    ) values
      ('quote_nested', 'queued', 'quote_nested:1:wp02-migration-fixture', 'fixture error'),
      ('jobs', 'succeeded', 'jobs:migration-succeeded-error', 'stale retry error');

    insert into metrics.dashboard_read_models (
      metric_family, period_grain, period_start, dimensions_json,
      values_json, status, source_hash
    ) values (
      'jobs', 'month', date '2022-01-01', '{}'::jsonb,
      '{}'::jsonb, 'ready', 'migration-fixture'
    );

    insert into metrics.rollup_rebuild_queue (
      metric_family, period_grain, period_start, reason, idempotency_key
    ) values (
      'jobs', 'month', date '2022-01-01',
      'migration fixture', 'jobs:month:2022-01-01:migration-fixture'
    );
  `);
}

async function assertServingWindowEnforced(connection) {
  for (const statement of [
    `insert into metrics.rollup_rebuild_queue (
       metric_family, period_grain, period_start, reason, idempotency_key
     ) values ('jobs', 'month', date '2022-02-01', 'rejection probe', 'rejection-probe-rollup')`,
    `insert into metrics.dashboard_read_models (
       metric_family, period_grain, period_start, dimensions_json, values_json, status, source_hash
     ) values ('jobs', 'month', date '2022-02-01', '{}'::jsonb, '{}'::jsonb, 'ready', 'rejection-probe')`,
    `insert into metrics.commission_periods (
       period_start, period_end, status, revision, config, created_by
     ) values (date '2022-02-01', date '2022-02-28', 'draft', 1, '{}'::jsonb, 'migration-test')`,
  ]) {
    await connection.query("begin");
    try {
      await connection.query(statement);
      throw new Error("Serving-window trigger accepted an out-of-scope period");
    } catch (error) {
      await connection.query("rollback");
      if (!String(error?.message ?? error).includes("outside the approved canonical 2023-current Pacific")) throw error;
    }
  }

  for (const statement of [
    `insert into metrics.rollup_rebuild_queue (
       metric_family, period_grain, period_start, reason, idempotency_key
     ) values (
       'jobs', 'month',
       date_trunc('month', current_timestamp at time zone 'America/Los_Angeles')::date + 1,
       'noncanonical rejection probe', 'rejection-probe-noncanonical'
     )`,
    `insert into metrics.rollup_rebuild_queue (
       metric_family, period_grain, period_start, reason, idempotency_key
     ) values (
       'jobs', 'month',
       (date_trunc('month', current_timestamp at time zone 'America/Los_Angeles') + interval '1 month')::date,
       'future rejection probe', 'rejection-probe-future'
     )`,
  ]) {
    await connection.query("begin");
    try {
      await connection.query(statement);
      throw new Error("Serving-window trigger accepted an invalid period");
    } catch (error) {
      await connection.query("rollback");
      if (!String(error?.message ?? error).includes("outside the approved canonical 2023-current Pacific")) throw error;
    }
  }
}

async function assertProfitCapacityContract(connection) {
  const result = await connection.query(`
    select
      (select data_type = 'numeric' and numeric_scale is null
         from information_schema.columns
        where table_schema = 'metrics' and table_name = 'metrics_jobs' and column_name = 'net_profit_actual') as lossless_net_profit,
      (select is_nullable = 'YES' and column_default is null
         from information_schema.columns
        where table_schema = 'metrics' and table_name = 'metrics_jobs' and column_name = 'total') as nullable_total,
      (select data_type = 'jsonb'
         from information_schema.columns
        where table_schema = 'metrics' and table_name = 'dim_people' and column_name = 'availability_json') as availability_json,
      (select data_type = 'boolean'
         from information_schema.columns
        where table_schema = 'metrics' and table_name = 'metrics_job_cost_centers' and column_name = 'totals_authoritative') as authoritative_cost_centers
  `);
  if (!Object.values(result.rows[0] ?? {}).every(Boolean)) {
    throw new Error(`Migration 026 contract is incomplete: ${JSON.stringify(result.rows[0])}`);
  }
}

async function assertScheduleIdentityContract(connection) {
  await connection.query(`
    insert into metrics.metrics_schedule_blocks (
      schedule_id, block_index, staff_id, reference_type, reference_id,
      work_order_id, cancelled
    ) values
      (9223372036854775000, 0, 1, 'job', 2, 701, true),
      (9223372036854775000, 1, 1, 'job', 2, null, default)
  `);
  const result = await connection.query(`
    select block_index, work_order_id::text, cancelled
      from metrics.metrics_schedule_blocks
     where schedule_id = 9223372036854775000
     order by block_index
  `);
  if (result.rows[0]?.work_order_id !== "701" || result.rows[0]?.cancelled !== true) {
    throw new Error("Migration 030 did not persist schedule work-order/cancellation identity");
  }
  if (result.rows[1]?.work_order_id !== null || result.rows[1]?.cancelled !== false) {
    throw new Error("Migration 030 did not preserve honest legacy schedule defaults");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runMigrationTests().catch(() => {
    console.error("Migration test failed; temporary database cleanup was attempted and connection details were redacted.");
    process.exitCode = 1;
  });
}
