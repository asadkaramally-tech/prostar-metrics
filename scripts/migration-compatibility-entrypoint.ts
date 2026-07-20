import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

import { getCommissionDashboardReadModel } from "@/lib/store/commissions-read-model";
import { getDashboardReadModel } from "@/lib/store/dashboard-read-models";
import {
  claimNextIngestionJob,
  completeIngestionJob,
  enqueueIngestionJob,
  startIngestionRun,
} from "@/lib/store/ingestion-jobs";
import { getJobDashboardReadModel } from "@/lib/store/job-dashboard-read-model";
import { closePostgresPool, getDatabaseHealthStatus, queryPostgres } from "@/lib/store/postgres";
import { getQuoteMetricsReadModel, loadQuoteDashboardRows } from "@/lib/store/quote-dashboard-read-model";

const imagePattern = /^[a-z0-9.-]+\.azurecr\.io\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/;
const databasePattern = /^metrics_compat_[a-f0-9]{32}$/;
const tsxCli = "node_modules/tsx/dist/cli.mjs";

async function main() {
  assertCloneOnlyRuntime();
  const periods = await selectProbePeriods();
  const databaseHealth = await probeDatabaseHealth();
  const dashboardStores = await probeDashboardStores(periods);
  const ingestionLifecycle = await probeIngestionLifecycle();
  const ingestionWorker = await probeIngestionWorker();
  const rollupWorker = await probeRollupWorker("jobs", periods.jobs);
  const commissionWorker = await probeRollupWorker("commissions", periods.commissions);

  process.stdout.write(JSON.stringify({
    schemaVersion: 1,
    mode: "standard",
    platform: "linux/amd64",
    runtime: {
      databaseHealth,
      dashboardStores,
      ingestionLifecycle,
      ingestionWorker,
      rollupWorker,
      commissionWorker,
    },
  }));
}

function assertCloneOnlyRuntime() {
  if (process.env.MIGRATION_COMPATIBILITY_CLONE_ONLY !== "true") {
    throw new Error("Compatibility entrypoint refuses to run outside clone-only mode");
  }
  const connectionString = process.env.AZURE_POSTGRES_CONNECTION_STRING;
  if (!connectionString) throw new Error("Compatibility entrypoint requires a PostgreSQL clone connection");
  const databaseName = decodeURIComponent(new URL(connectionString).pathname.slice(1));
  if (!databasePattern.test(databaseName)) {
    throw new Error("Compatibility entrypoint refuses a non-compatibility database");
  }
  if (!imagePattern.test(process.env.MIGRATION_COMPATIBILITY_IMAGE_DIGEST ?? "")) {
    throw new Error("Compatibility entrypoint requires its exact digest identity");
  }
  if (process.env.MIGRATION_COMPATIBILITY_PLATFORM !== "linux/amd64") {
    throw new Error("Compatibility entrypoint requires linux/amd64 platform binding");
  }
}

async function selectProbePeriods() {
  const result = await queryPostgres<{ jobs: string; commissions: string }>(`
    select coalesce(
             (select to_char(max(completed_date), 'YYYY-MM') from metrics.metrics_jobs
               where lower(stage) in ('complete', 'archived') and source_deleted_at is null),
             to_char(current_date, 'YYYY-MM')
           ) as jobs,
           coalesce(
             (select to_char(max(period_start), 'YYYY-MM') from metrics.commission_periods),
             (select to_char(max(completed_date), 'YYYY-MM') from metrics.metrics_jobs
               where lower(stage) in ('complete', 'archived') and source_deleted_at is null),
             to_char(current_date, 'YYYY-MM')
           ) as commissions
  `);
  const periods = result.rows[0];
  if (!periods || !/^20\d{2}-\d{2}$/.test(periods.jobs) || !/^20\d{2}-\d{2}$/.test(periods.commissions)) {
    throw new Error("Actual application stores did not provide valid probe periods");
  }
  return periods;
}

async function probeDatabaseHealth() {
  const health = await getDatabaseHealthStatus();
  if (!health.connected) throw new Error("Actual application database health contract failed");
  return { succeeded: true } as const;
}

async function probeDashboardStores(periods: { jobs: string; commissions: string }) {
  const [jobModel, quoteRows, quoteModel, technicianModel, commissionModel] = await Promise.all([
    getJobDashboardReadModel({ selectedMonth: periods.jobs }),
    loadQuoteDashboardRows(),
    getQuoteMetricsReadModel({ selectedMonth: periods.jobs }),
    getDashboardReadModel("technicians", { periodStart: `${periods.jobs}-01` }),
    getCommissionDashboardReadModel({
      year: Number(periods.commissions.slice(0, 4)),
      month: Number(periods.commissions.slice(5, 7)),
      summaryYear: Number(periods.commissions.slice(0, 4)),
    }),
  ]);
  if (jobModel.loadError) throw new Error("Actual job dashboard store returned a load error");
  if (!Array.isArray(quoteRows) || quoteModel.quotesLoaded !== quoteRows.length) {
    throw new Error("Actual quote dashboard store did not reconcile its loaded rows");
  }
  if (technicianModel.warnings.some((warning) => warning.includes("Unable to read app-owned rollups"))) {
    throw new Error("Actual technician dashboard store returned a database read error");
  }
  if (commissionModel.worksheet.servingCode === "READ_MODEL_UNAVAILABLE") {
    throw new Error("Actual commission dashboard store returned a database read error");
  }
  return { succeeded: true } as const;
}

async function probeIngestionLifecycle() {
  const marker = randomUUID().replaceAll("-", "");
  const workerId = `migration-compatibility-${marker}`;
  const idempotencyKey = `migration-compatibility:${marker}`;
  await enqueueIngestionJob({
    entity: "jobs",
    idempotencyKey,
    requestBudget: 1,
    params: { compatibilityProbe: true },
  });
  const job = await claimNextIngestionJob(workerId, "jobs", marker);
  if (!job || job.idempotency_key !== idempotencyKey) {
    throw new Error("Actual ingestion store did not claim its isolated compatibility job");
  }
  const runId = await startIngestionRun(job, workerId);
  await completeIngestionJob({
    job,
    workerId,
    runId,
    requestCount: 0,
    snapshotCount: 0,
    normalizedCount: 0,
    continuationToken: null,
    candidateRefreshes: [],
    affectedPeriods: [],
  });
  const state = await queryPostgres<{ job_status: string; run_status: string }>(
    `select j.status::text as job_status, r.status::text as run_status
       from metrics.ingestion_jobs j
       join metrics.ingestion_runs r on r.id = $2 and r.job_id = j.id
      where j.id = $1`,
    [job.id, runId],
  );
  if (state.rows[0]?.job_status !== "succeeded" || state.rows[0]?.run_status !== "succeeded") {
    throw new Error("Actual ingestion store lifecycle did not complete on the clone");
  }
  return { succeeded: true } as const;
}

async function probeIngestionWorker() {
  const { output } = await runActualWorker(
    "workers/ingest-simpro.ts",
    ["--dry-run", "--entity", "jobs"],
    [0],
  );
  if (output.mode !== "dry-run" || output.entity !== "jobs") {
    throw new Error("Actual ingestion worker did not honor its no-Simpro dry-run contract");
  }
  return { succeeded: true } as const;
}

async function probeRollupWorker(scope: "jobs" | "commissions", month: string) {
  await queryPostgres(
    `update metrics.rollup_rebuild_queue
        set status = 'cancelled', locked_by = null, locked_until = null,
            finished_at = now(), error_message = 'superseded inside disposable migration compatibility clone'
      where metric_family = $1 and status in ('queued', 'running')`,
    [scope],
  );
  const { output, exitCode } = await runActualWorker("workers/rebuild-rollups.ts", [
    "--scope", scope,
    "--period-start", `${month}-01`,
    "--reason", "migration compatibility clone probe",
    "--limit", "1",
  ], scope === "commissions" ? [0, 1] : [0]);
  if (!isExactObject(output, ["workerId", "commissionCadence", "claimed", "rebuilt", "failures"])
    || typeof output.workerId !== "string" || !/^metrics-rollup-\d+$/.test(output.workerId)
    || output.commissionCadence !== null || output.claimed !== true
    || !Array.isArray(output.rebuilt) || !Array.isArray(output.failures)) {
    throw new Error(`Actual ${scope} rollup worker returned an unsupported evidence envelope`);
  }
  const rebuilt = output.rebuilt;
  const expectedPeriodStart = `${month}-01`;
  const rebuiltRow = rebuilt[0];
  if (exitCode === 0 && output.failures.length === 0 && rebuilt.length === 1
    && isExactObject(rebuiltRow, ["jobId", "keys", "metricFamily", "periodStart"])
    && Number.isSafeInteger(rebuiltRow.jobId) && Number(rebuiltRow.jobId) > 0
    && rebuiltRow.metricFamily === scope && rebuiltRow.periodStart === expectedPeriodStart
    && Array.isArray(rebuiltRow.keys)
    && rebuiltRow.keys.every((key) => typeof key === "string" && key.length > 0)
    && new Set(rebuiltRow.keys).size === rebuiltRow.keys.length) {
    return { succeeded: true } as const;
  }

  const expectedSafetyErrors = new Set([
    `Commission source evidence is loading for ${expectedPeriodStart}; refusing immutable-run and ready read-model publication.`,
    `Commission integrity verification failed for ${expectedPeriodStart}; refusing immutable-run and ready read-model publication: source_complete is false`,
  ]);
  const failure = output.failures[0];
  if (scope === "commissions" && exitCode === 1 && rebuilt.length === 0 && output.failures.length === 1
    && isExactObject(failure, ["error", "jobId", "metricFamily", "periodStart"])
    && Number.isSafeInteger(failure.jobId) && Number(failure.jobId) > 0
    && failure.metricFamily === scope && failure.periodStart === expectedPeriodStart
    && typeof failure.error === "string" && expectedSafetyErrors.has(failure.error)) {
    return { succeeded: true } as const;
  }

  throw new Error(`Actual ${scope} rollup worker did not rebuild or safely refuse its clone-only period`);
}

async function runActualWorker(worker: string, args: string[], allowedExitCodes: number[]) {
  const environment: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV ?? "production" };
  for (const name of [
    "AZURE_POSTGRES_CA_CERT", "AZURE_POSTGRES_CONNECTION_STRING", "HOME", "LANG", "LC_ALL", "NODE_ENV",
    "PATH", "POSTGRES_SSL_REJECT_UNAUTHORIZED", "TMPDIR",
  ]) {
    if (typeof process.env[name] === "string") environment[name] = process.env[name];
  }
  environment.POSTGRES_POOL_IDLE_TIMEOUT_MS = "1000";
  const result = await spawnBounded(
    process.execPath,
    [tsxCli, worker, ...args],
    environment,
    180_000,
    allowedExitCodes,
  );
  try {
    const parsed: unknown = JSON.parse(result.stdout.trim());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return { output: parsed as Record<string, unknown>, exitCode: result.exitCode };
  } catch {
    throw new Error(`Actual worker ${worker} returned malformed structured output`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isExactObject(value: unknown, expectedKeys: string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expectedKeys].sort());
}

function spawnBounded(
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
  allowedExitCodes: number[],
) {
  return new Promise<{ stdout: string; exitCode: number }>((resolve, reject) => {
    const child = spawn(command, args, { env: environment, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let completedExitCode = -1;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve({ stdout, exitCode: completedExitCode });
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`Actual worker ${args[1] ?? "command"} timed out`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 4 * 1024 * 1024) {
        child.kill("SIGKILL");
        finish(new Error("Actual worker output exceeded the compatibility evidence limit"));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 1024 * 1024) stderr = stderr.slice(-1024 * 1024);
    });
    child.on("error", (error) => finish(new Error(`Actual worker runtime is unavailable: ${error.message}`)));
    child.on("close", (code) => {
      completedExitCode = code ?? -1;
      if (!allowedExitCodes.includes(completedExitCode)) {
        finish(new Error(`Actual worker failed with exit ${code}: ${redact(stderr)}`));
      }
      else finish();
    });
  });
}

function redact(value: string) {
  const connectionString = process.env.AZURE_POSTGRES_CONNECTION_STRING ?? "";
  let parsed: URL | null = null;
  try {
    parsed = connectionString ? new URL(connectionString) : null;
  } catch {
    parsed = null;
  }
  let redacted = value;
  for (const secret of [
    connectionString,
    parsed?.password,
    parsed?.password ? decodeURIComponent(parsed.password) : "",
    parsed?.username,
    parsed?.username ? decodeURIComponent(parsed.username) : "",
    parsed?.hostname,
  ]) if (secret) redacted = redacted.replaceAll(secret, "[REDACTED]");
  return redacted
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[REDACTED_POSTGRES_URL]")
    .trim()
    .slice(0, 2_000);
}

main()
  .catch((error) => {
    console.error(redact(error instanceof Error ? error.message : "Compatibility entrypoint failed"));
    process.exitCode = 1;
  })
  .finally(() => closePostgresPool().catch(() => undefined));
