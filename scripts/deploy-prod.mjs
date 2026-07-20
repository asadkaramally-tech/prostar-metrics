import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  DEPLOYMENT_MANIFEST_PATH,
  DEPLOYMENT_PROVENANCE_SCHEMA_VERSION,
  PRODUCTION_ACR,
  PRODUCTION_CONTAINER_APP,
  PRODUCTION_REPOSITORY,
  PRODUCTION_RESOURCE_GROUP,
  azureChildEnvironment,
  canonicalTargetContract,
  collectLiveHttpVerification,
  targetContractWithoutImage,
  validateAcrBuildProvenance,
  validateArmDeploymentProvenance,
  validateDeploymentManifestDocument,
  withImmutableDockerBuildContext,
  writeDeploymentManifestAtomic,
} from "./lib/deployment-provenance.mjs";
import { PLAN_REVISION, PLAN_SHA256 } from "./lib/feature-status-sync.mjs";
import {
  assertExactProductionJobNames,
  PRODUCTION_JOB_NAMES,
  PRODUCTION_TARGETS,
} from "./lib/production-targets.mjs";

const ROOT = process.cwd();
const RESOURCE_GROUP = PRODUCTION_RESOURCE_GROUP;
const PRODUCTION_SUBSCRIPTION_ID = "d7a98155-9693-4c6b-ad27-39e945c0f751";
const CONTAINER_APP_NAME = PRODUCTION_CONTAINER_APP;
const POSTGRES_SERVER = "pg-prostar-metrics-prod";
const ACR_NAME = PRODUCTION_ACR;
const TEMP_FIREWALL_RULE = `metrics-deploy-${Date.now()}`;
const PRODUCTION_PARAMETERS_PATH = "infra/azure/main.parameters.prod.example.json";
const MONITORING_PARAMETERS_PATH = "infra/azure/monitoring.parameters.prod.example.json";
const MONITORING_NOTIFICATION_EVIDENCE_DIRECTORY = "docs/prostar-metrics/verification/monitoring";
const LONGEST_QUERY_COLLECTOR_PARAMETER = "metrics.collector_database_activity";
const LONGEST_QUERY_METRIC = "longest_query_time_sec";
const LONGEST_QUERY_METRIC_INTERVAL = "1m";
const LONGEST_QUERY_METRIC_LOOKBACK_MS = 30 * 60 * 1000;
const LONGEST_QUERY_METRIC_POLL_MS = 30 * 1000;
const LONGEST_QUERY_METRIC_TIMEOUT_MS = 10 * 60 * 1000;
const KEY_VAULT_SECRETS_USER_ROLE = "Key Vault Secrets User";
const EVIDENCE_SIGNING_KEY_NAMES = Object.freeze({
  gate: "prostar-release-gate-evidence",
  browser: "prostar-release-browser-evidence",
  reviewer: "prostar-release-reviewer-evidence",
});
const MAX_CONTAINER_APP_JOB_NAME_LENGTH = 32;
const AZURE_CONFIG_DIR = process.env.AZURE_CONFIG_DIR || path.join(path.dirname(ROOT), ".work", "azure");
const migrationEnvironmentNames = new Set([
  "MIGRATION_COMPATIBILITY_COMMAND_TIMEOUT_MS", "MIGRATION_COMPATIBILITY_QUERY_TIMEOUT_MS",
  "AZURE_POSTGRES_CA_CERT", "AZURE_POSTGRES_CA_CERT_PATH", "NODE_TLS_REJECT_UNAUTHORIZED",
  "PGSSLROOTCERT", "POSTGRES_SSL_REJECT_UNAUTHORIZED",
]);
const postgresClientBinCandidates = Object.freeze([
  "/Applications/Postgres.app/Contents/Versions/17/bin",
  "/opt/homebrew/opt/libpq/bin",
  "/usr/local/opt/libpq/bin",
]);

function log(message) {
  console.log(`[deploy-prod] ${message}`);
}

export function materializeSnapshotDependencies(snapshotPath, dependencyPath = path.join(ROOT, "node_modules")) {
  const target = path.join(snapshotPath, "node_modules");
  const source = fs.realpathSync(dependencyPath);
  if (!fs.statSync(source).isDirectory()) throw new Error("Deployment dependencies must be a directory");
  if (fs.existsSync(target)) throw new Error("Immutable deployment snapshot already contains node_modules");
  try {
    fs.cpSync(source, target, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      mode: fs.constants.COPYFILE_FICLONE,
    });
    if (fs.lstatSync(target).isSymbolicLink() || !fs.statSync(target).isDirectory()) {
      throw new Error("Deployment dependencies were not materialized inside the immutable snapshot");
    }
    assertContainedDependencySymlinks(target);
  } catch (error) {
    fs.rmSync(target, { recursive: true, force: true });
    throw error;
  }
}

function assertContainedDependencySymlinks(root) {
  const canonicalRoot = fs.realpathSync(root);
  const pending = [canonicalRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      if (!entry.isSymbolicLink()) continue;
      const resolved = fs.realpathSync(candidate);
      if (resolved !== canonicalRoot && !resolved.startsWith(`${canonicalRoot}${path.sep}`)) {
        throw new Error(`Deployment dependency symlink escapes the immutable snapshot: ${candidate}`);
      }
    }
  }
}

function az(args, options = {}) {
  const result = spawnSync("az", args, {
    cwd: ROOT,
    env: azureChildEnvironment(process.env, { AZURE_CONFIG_DIR }),
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });

  if (result.status !== 0) {
    const details = options.capture ? `\n${result.stderr || result.stdout}` : "";
    throw new Error(`az ${args.slice(0, 3).join(" ")} failed${details}`);
  }

  return options.capture ? result.stdout.trim() : "";
}

export function preflightChildEnvironment(source = process.env) {
  return azureChildEnvironment(source, { AZURE_CONFIG_DIR: source.AZURE_CONFIG_DIR || AZURE_CONFIG_DIR });
}

export function migrationChildEnvironment(connectionString, previousImage, source = process.env) {
  if (typeof connectionString !== "string" || !connectionString) throw new Error("Migration connection string is required");
  if (typeof previousImage !== "string" || !previousImage.includes("@sha256:")) {
    throw new Error("Prior production image must be pinned by digest for migration compatibility");
  }
  const environment = preflightChildEnvironment(source);
  for (const name of migrationEnvironmentNames) {
    if (typeof source[name] === "string") environment[name] = source[name];
  }
  const pathEntries = String(environment.PATH ?? "").split(path.delimiter).filter(Boolean);
  const hasPgDump = pathEntries.some((entry) => fs.existsSync(path.join(entry, "pg_dump")));
  if (!hasPgDump) {
    const clientBin = postgresClientBinCandidates.find((entry) => fs.existsSync(path.join(entry, "pg_dump")));
    if (clientBin) environment.PATH = [clientBin, ...pathEntries].join(path.delimiter);
  }
  environment.AZURE_POSTGRES_CONNECTION_STRING = connectionString;
  environment.PRIOR_PRODUCTION_IMAGE = previousImage;
  return environment;
}

function getMigrationConnectionString() {
  const connectionString = process.env.AZURE_POSTGRES_MIGRATION_CONNECTION_STRING;
  if (!connectionString) {
    throw new Error("AZURE_POSTGRES_MIGRATION_CONNECTION_STRING is required for privileged migration gates.");
  }
  delete process.env.AZURE_POSTGRES_MIGRATION_CONNECTION_STRING;
  return connectionString;
}

async function getPublicIp() {
  const response = await fetch("https://api.ipify.org");
  if (!response.ok) {
    throw new Error(`Unable to resolve public IP: HTTP ${response.status}`);
  }
  return (await response.text()).trim();
}

export async function withReconciledTemporaryFirewall({
  create,
  verifyPresent,
  remove,
  verifyAbsent,
  run,
  cleanupCycles = 12,
  requiredAbsenceChecks = 6,
  settle = () => new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000)),
}) {
  if (!Number.isInteger(cleanupCycles) || cleanupCycles < 1) {
    throw new Error("Temporary firewall cleanup cycles must be a positive integer");
  }
  if (!Number.isInteger(requiredAbsenceChecks)
    || requiredAbsenceChecks < 1
    || requiredAbsenceChecks > cleanupCycles) {
    throw new Error("Temporary firewall absence checks must fit within the cleanup window");
  }
  let primaryError;
  let result;
  try {
    await create();
    await verifyPresent();
    result = await run();
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors = [];
  let consecutiveAbsenceChecks = 0;
  for (let cycle = 0; cycle < cleanupCycles; cycle += 1) {
    try {
      const removed = await remove();
      if (removed === true) consecutiveAbsenceChecks = 0;
    } catch (error) {
      cleanupErrors.push(error);
      consecutiveAbsenceChecks = 0;
    }
    try {
      await verifyAbsent();
      consecutiveAbsenceChecks += 1;
    } catch (error) {
      cleanupErrors.push(error);
      consecutiveAbsenceChecks = 0;
    }
    if (consecutiveAbsenceChecks >= requiredAbsenceChecks) break;
    if (cycle < cleanupCycles - 1) await settle();
  }
  if (consecutiveAbsenceChecks < requiredAbsenceChecks) {
    let terminalAbsenceProven = false;
    for (let attempt = 0; attempt < cleanupCycles; attempt += 1) {
      try {
        await remove();
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await verifyAbsent();
        terminalAbsenceProven = true;
        break;
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (attempt < cleanupCycles - 1) await settle();
    }
    cleanupErrors.push(new Error(terminalAbsenceProven
      ? "Temporary migration firewall rule did not remain absent for the full stability window"
      : "Temporary migration firewall rule final absence could not be proven"));
  }

  if (primaryError && cleanupErrors.length > 0) {
    throw new AggregateError([primaryError, ...cleanupErrors], "Migration firewall operation and cleanup failed");
  }
  if (primaryError) throw primaryError;
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Migration firewall cleanup failed");
  }
  return result;
}

function listTemporaryMigrationFirewallRules() {
  const output = az([
    "postgres", "flexible-server", "firewall-rule", "list",
    "--resource-group", RESOURCE_GROUP,
    "--name", POSTGRES_SERVER,
    "--output", "json",
  ], { capture: true });
  const rules = JSON.parse(output);
  if (!Array.isArray(rules)) throw new Error("PostgreSQL firewall enumeration returned a malformed response");
  return rules.filter((rule) => rule?.name === TEMP_FIREWALL_RULE);
}

function verifyTemporaryMigrationFirewallPresent(publicIp) {
  const matches = listTemporaryMigrationFirewallRules();
  if (matches.length !== 1
    || matches[0].startIpAddress !== publicIp
    || matches[0].endIpAddress !== publicIp) {
    throw new Error("Temporary migration firewall rule was not created with the exact caller IP");
  }
}

async function removeTemporaryMigrationFirewallRule() {
  const matches = listTemporaryMigrationFirewallRules();
  if (matches.length > 1) throw new Error("Temporary migration firewall rule enumeration returned duplicates");
  if (matches.length === 0) return false;
  az([
    "postgres", "flexible-server", "firewall-rule", "delete",
    "--resource-group", RESOURCE_GROUP,
    "--name", POSTGRES_SERVER,
    "--rule-name", TEMP_FIREWALL_RULE,
    "--yes",
    "--output", "none",
  ]);
  return true;
}

function verifyTemporaryMigrationFirewallAbsent() {
  if (listTemporaryMigrationFirewallRules().length !== 0) {
    throw new Error("Temporary migration firewall rule remains after cleanup");
  }
}

function applyTrackedMigrations(connectionString, previousImage) {
  const result = spawnSync(process.execPath, ["scripts/apply-migrations.mjs"], {
    cwd: ROOT,
    env: migrationChildEnvironment(connectionString, previousImage),
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error("Tracked database migrations failed.");
}

function runPostgresPredeployGate(connectionString, previousImage) {
  const result = spawnSync("npm", ["run", "test:predeploy:postgres"], {
    cwd: ROOT,
    env: migrationChildEnvironment(connectionString, previousImage),
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error("PostgreSQL migration and two-session concurrency predeploy gate failed.");
  }
}

function runMigrationCompatibilityGate(connectionString, previousImage) {
  const result = spawnSync("npm", ["run", "migration:compatibility:check"], {
    cwd: ROOT,
    env: migrationChildEnvironment(connectionString, previousImage),
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error("Pending migration prior-image compatibility gate failed.");
}

function runPreflightCommand(command, args, label, snapshotRoot) {
  log(`preflight: ${label}`);
  const result = spawnSync(command, args, {
    cwd: snapshotRoot,
    env: preflightChildEnvironment(),
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error(`Deployment preflight failed: ${label}.`);
}

function runDeploymentPreflight(snapshotRoot) {
  for (const [command, args, label] of [
    ["npm", ["test"], "tests"],
    ["npm", ["run", "test:scripts"], "script tests"],
    ["npm", ["run", "test:infra"], "infrastructure tests"],
    ["npm", ["run", "lint"], "ESLint"],
    ["npm", ["exec", "--", "tsc", "--noEmit"], "TypeScript"],
    ["npm", ["run", "guard:no-mirror"], "no-mirror guard"],
    ["npm", ["run", "build"], "production build"],
  ]) runPreflightCommand(command, args, label, snapshotRoot);
}

export function parseDeployArgs(argv) {
  if (argv.length > 0) throw new Error(`Unknown deploy argument: ${argv.join(", ")}`);
  return Object.freeze({});
}

export function validateProductionParameterContract(document) {
  const parameters = document?.parameters ?? {};
  const value = (name) => parameters[name]?.value;
  if (value("containerAppName") !== CONTAINER_APP_NAME) {
    throw new Error(`${PRODUCTION_PARAMETERS_PATH} containerAppName must be exactly ${CONTAINER_APP_NAME}.`);
  }
  if (value("useKeyVaultSecretReferences") !== true) {
    throw new Error(`${PRODUCTION_PARAMETERS_PATH} must set useKeyVaultSecretReferences=true.`);
  }
  const requiredStrings = [
    "keyVaultName", "managedIdentityName", "azurePostgresConnectionStringSecretName",
    "simproBearerTokenSecretName", "microsoftProviderAuthenticationSecretName",
    "postgresSslCaCertBase64SecretName",
  ];
  for (const name of requiredStrings) {
    if (typeof value(name) !== "string" || !value(name).trim()) throw new Error(`${PRODUCTION_PARAMETERS_PATH} ${name} must be concrete.`);
  }
  if (typeof value("includePostgresSslCaCertSecret") !== "boolean") {
    throw new Error(`${PRODUCTION_PARAMETERS_PATH} includePostgresSslCaCertSecret must be boolean.`);
  }
  return {
    keyVaultName: value("keyVaultName"),
    managedIdentityName: value("managedIdentityName"),
    includePostgresSslCaCertSecret: value("includePostgresSslCaCertSecret"),
    secretNames: {
      database: value("azurePostgresConnectionStringSecretName"),
      simpro: value("simproBearerTokenSecretName"),
      auth: value("microsoftProviderAuthenticationSecretName"),
      ca: value("postgresSslCaCertBase64SecretName"),
    },
  };
}

function validateDeploymentInputs() {
  const bicep = fs.readFileSync(path.join(ROOT, "infra/azure/metrics.bicep"), "utf8");
  const jobNameMatches = bicep.matchAll(/name:\s*'([^']+)'/g);
  const invalidJobNames = Array.from(jobNameMatches)
    .map((match) => match[1])
    .filter((name) => name.startsWith("job-") && name.length > MAX_CONTAINER_APP_JOB_NAME_LENGTH);

  if (invalidJobNames.length > 0) {
    throw new Error(
      `Container App job names exceed ${MAX_CONTAINER_APP_JOB_NAME_LENGTH} chars: ${invalidJobNames.join(", ")}`,
    );
  }
  const jobs = managedJobNames();
  if (jobs.length !== PRODUCTION_JOB_NAMES.length) throw new Error("Production job target count drifted.");
  const bicepJobs = [...new Set([...bicep.matchAll(/'(job-[^']+)'/g)].map((match) => match[1]))].sort();
  assertExactProductionJobNames(bicepJobs, "metrics Bicep job allowlist");
  if (JSON.stringify(jobs) !== JSON.stringify(bicepJobs)) throw new Error("Monitoring and metrics Bicep job allowlists diverge.");
  return validateProductionParameterContract(JSON.parse(
    fs.readFileSync(path.join(ROOT, PRODUCTION_PARAMETERS_PATH), "utf8"),
  ));
}

export function validateMonitoringTargetParameters(document) {
  if (document?.parameters?.containerAppName?.value !== CONTAINER_APP_NAME) {
    throw new Error(`${MONITORING_PARAMETERS_PATH} containerAppName must be exactly ${CONTAINER_APP_NAME}.`);
  }
  return {
    appName: CONTAINER_APP_NAME,
    jobNames: assertExactProductionJobNames(
      document?.parameters?.containerAppsJobNames?.value,
      `${MONITORING_PARAMETERS_PATH} job allowlist`,
    ),
  };
}

function managedJobNames() {
  const document = JSON.parse(fs.readFileSync(path.join(ROOT, MONITORING_PARAMETERS_PATH), "utf8"));
  return validateMonitoringTargetParameters(document).jobNames;
}

export function validatePostgresServerTarget(server) {
  const id = String(server?.id ?? "").toLowerCase();
  const expectedSuffix = `/resourcegroups/${RESOURCE_GROUP.toLowerCase()}/providers/microsoft.dbforpostgresql/flexibleservers/${POSTGRES_SERVER.toLowerCase()}`;
  if (
    server?.name !== POSTGRES_SERVER
    || String(server?.resourceGroup ?? "").toLowerCase() !== RESOURCE_GROUP.toLowerCase()
    || !id.endsWith(expectedSuffix)
  ) {
    throw new Error(`Monitoring preflight target must be exactly ${RESOURCE_GROUP}/${POSTGRES_SERVER}.`);
  }
  return { id: server.id, name: server.name, resourceGroup: server.resourceGroup };
}

export function monitoringManagedResourceContract(postgresTargetId) {
  const targetId = String(postgresTargetId ?? "").toLowerCase();
  const postgresSuffix = `/providers/microsoft.dbforpostgresql/flexibleservers/${POSTGRES_SERVER.toLowerCase()}`;
  if (!targetId.endsWith(postgresSuffix)) {
    throw new Error(`Monitoring what-if target must be exactly ${RESOURCE_GROUP}/${POSTGRES_SERVER}.`);
  }
  const resourceGroupId = targetId.slice(0, -postgresSuffix.length);
  if (!/^\/subscriptions\/[^/]+\/resourcegroups\/prostar-payroll$/.test(resourceGroupId)) {
    throw new Error(`Monitoring what-if target must be exactly ${RESOURCE_GROUP}/${POSTGRES_SERVER}.`);
  }

  const resources = new Map();
  const add = (resourceId, resourceType) => {
    const normalizedId = resourceId.toLowerCase();
    if (resources.has(normalizedId)) throw new Error(`Duplicate monitoring resource contract: ${resourceId}`);
    resources.set(normalizedId, resourceType.toLowerCase());
  };
  const topLevel = (resourceType, name) => `${resourceGroupId}/providers/${resourceType}/${name}`;
  const diagnostic = (scope, name) => `${scope}/providers/microsoft.insights/diagnosticsettings/${name}`;
  const app = topLevel("microsoft.app/containerapps", CONTAINER_APP_NAME);
  const environment = topLevel("microsoft.app/managedenvironments", "cae-prostar-dispatch-prod");
  const storage = topLevel("microsoft.storage/storageaccounts", "stprostarmetricsexports");
  const blob = `${storage}/blobservices/default`;

  add(topLevel("microsoft.insights/components", "appi-prostar-metrics-prod"), "microsoft.insights/components");
  add(topLevel("microsoft.insights/actiongroups", "ag-prostar-metrics-owners"), "microsoft.insights/actiongroups");
  add(diagnostic(environment, "diag-prostar-metrics-environment"), "microsoft.insights/diagnosticsettings");
  add(diagnostic(app, "diag-prostar-metrics-web"), "microsoft.insights/diagnosticsettings");
  for (const jobName of PRODUCTION_JOB_NAMES) {
    const job = topLevel("microsoft.app/jobs", jobName);
    add(diagnostic(job, `diag-${jobName}`), "microsoft.insights/diagnosticsettings");
  }
  add(diagnostic(targetId, "diag-prostar-metrics-postgres"), "microsoft.insights/diagnosticsettings");
  add(diagnostic(storage, "diag-prostar-metrics-storage"), "microsoft.insights/diagnosticsettings");
  add(diagnostic(blob, "diag-prostar-metrics-blob"), "microsoft.insights/diagnosticsettings");

  for (const suffix of [
    "web-5xx-rate",
    "web-p95-latency",
    "operational-critical",
    "ingestion-three-consecutive-failures",
    "dead-letter-immediate",
    "operational-warning",
  ]) add(topLevel("microsoft.insights/scheduledqueryrules", `alert-prostar-metrics-${suffix}`), "microsoft.insights/scheduledqueryrules");

  for (const jobName of PRODUCTION_JOB_NAMES) {
    add(topLevel("microsoft.insights/metricalerts", `alert-${jobName}-failed`), "microsoft.insights/metricalerts");
  }
  for (const suffix of [
    "cpu-high",
    "memory-high",
    "storage-warning",
    "storage-critical",
    "connections-high",
    "connections-failed",
    "deadlocks",
    "longest-query",
    "not-alive",
    "backup-storage-capacity",
  ]) add(topLevel("microsoft.insights/metricalerts", `alert-prostar-metrics-postgres-${suffix}`), "microsoft.insights/metricalerts");
  add(topLevel("microsoft.insights/metricalerts", "alert-prostar-metrics-export-storage-failures"), "microsoft.insights/metricalerts");

  if (resources.size !== 72) throw new Error(`Monitoring resource contract must contain exactly 72 resources; received ${resources.size}.`);
  return Object.freeze(Array.from(resources, ([resourceId, resourceType]) => Object.freeze({ resourceId, resourceType })));
}

export function validateMonitoringWhatIf(result, postgresTargetId) {
  const changes = Array.isArray(result?.changes)
    ? result.changes
    : Array.isArray(result?.properties?.changes)
      ? result.properties.changes
      : null;
  if (!changes) throw new Error("Monitoring what-if returned no recognized changes array.");
  const contract = monitoringManagedResourceContract(postgresTargetId);
  const expected = new Map(contract.map((resource) => [resource.resourceId, resource.resourceType]));
  const postgresSuffix = `/providers/microsoft.dbforpostgresql/flexibleservers/${POSTGRES_SERVER.toLowerCase()}`;
  const resourceGroupId = String(postgresTargetId).toLowerCase().slice(0, -postgresSuffix.length);
  const seen = new Set();
  for (const change of changes) {
    const changeType = change?.changeType;
    const resourceId = typeof change?.resourceId === "string" ? change.resourceId.toLowerCase() : "";
    if (!resourceId.startsWith(`${resourceGroupId}/providers/`)) {
      throw new Error(`Monitoring what-if returned an invalid or out-of-scope resource ID: ${String(change?.resourceId)}`);
    }
    if (changeType === "Ignore") {
      if (expected.has(resourceId)) {
        throw new Error(`Monitoring what-if ignored a managed resource: ${change.resourceId}`);
      }
      continue;
    }
    if (["Delete", "Replace"].includes(changeType)) {
      throw new Error(`Monitoring what-if attempted a destructive ${changeType}: ${change.resourceId}`);
    }
    if (!["Create", "Modify", "Deploy", "NoChange"].includes(changeType)) {
      throw new Error(`Monitoring what-if returned unsupported change type ${String(changeType)} for ${change.resourceId}`);
    }
    const expectedType = expected.get(resourceId);
    if (!expectedType) {
      throw new Error(`Monitoring what-if contains unexpected ${changeType} resource: ${change.resourceId}`);
    }
    if (seen.has(resourceId)) throw new Error(`Monitoring what-if returned duplicate managed resource: ${change.resourceId}`);
    for (const candidateType of [change.resourceType, change.before?.type, change.after?.type]) {
      if (candidateType !== undefined && String(candidateType).toLowerCase() !== expectedType) {
        throw new Error(`Monitoring what-if resource type drifted for ${change.resourceId}: ${candidateType}`);
      }
    }
    for (const candidateId of [change.before?.id, change.after?.id]) {
      if (candidateId !== undefined && String(candidateId).toLowerCase() !== resourceId) {
        throw new Error(`Monitoring what-if resource identity drifted for ${change.resourceId}.`);
      }
    }
    seen.add(resourceId);
  }
  const missing = contract.filter((resource) => !seen.has(resource.resourceId));
  if (missing.length > 0) {
    throw new Error(`Monitoring what-if omitted ${missing.length} managed resource(s): ${missing.map((resource) => resource.resourceId).join(", ")}`);
  }
  return { changes: changes.length };
}

function reviewMonitoringWhatIfAndTarget() {
  const parameters = JSON.parse(fs.readFileSync(path.join(ROOT, MONITORING_PARAMETERS_PATH), "utf8")).parameters;
  if (parameters.postgresServerName?.value !== POSTGRES_SERVER) {
    throw new Error(`${MONITORING_PARAMETERS_PATH} must target exactly ${POSTGRES_SERVER}.`);
  }
  const server = validatePostgresServerTarget(JSON.parse(az([
    "postgres", "flexible-server", "show", "--resource-group", RESOURCE_GROUP,
    "--name", POSTGRES_SERVER, "--query", "{id:id,name:name,resourceGroup:resourceGroup}", "--output", "json",
  ], { capture: true })));
  log("running fail-closed monitoring Bicep what-if against the verified PostgreSQL target");
  const whatIf = JSON.parse(az([
    "deployment", "group", "what-if", "--resource-group", RESOURCE_GROUP,
    "--name", "prostar-metrics-monitoring-review", "--template-file", "infra/azure/monitoring.bicep",
    "--parameters", MONITORING_PARAMETERS_PATH, "--result-format", "ResourceIdOnly",
    "--no-pretty-print", "--output", "json",
  ], { capture: true }));
  validateMonitoringWhatIf(whatIf, server.id);
  return server;
}

export function validateLongestQueryCollector(parameter, expectedValue = null) {
  if (parameter?.name !== LONGEST_QUERY_COLLECTOR_PARAMETER || typeof parameter?.value !== "string" || !parameter.value) {
    throw new Error(`Azure did not return the concrete ${LONGEST_QUERY_COLLECTOR_PARAMETER} parameter.`);
  }
  if (expectedValue !== null && parameter.value.toLowerCase() !== expectedValue.toLowerCase()) {
    throw new Error(`${LONGEST_QUERY_COLLECTOR_PARAMETER} must read ${expectedValue}; received ${parameter.value}.`);
  }
  return { name: parameter.name, value: parameter.value, source: parameter.source ?? null };
}

export async function withLongestQueryCollectorEnabled({ operations, run }) {
  if (typeof run !== "function") throw new TypeError("collector-protected release callback is required");
  const preflight = await operations.preflight();
  const baseline = validateLongestQueryCollector(await operations.readParameter());
  let changed = false;
  try {
    if (baseline.value.toLowerCase() !== "on") {
      changed = true;
      await operations.setParameter("on");
    }
    validateLongestQueryCollector(await operations.readParameter(), "on");
    return await run({ preflight, baseline });
  } catch (releaseError) {
    if (!changed) throw releaseError;
    try {
      await operations.setParameter(baseline.value);
      validateLongestQueryCollector(await operations.readParameter(), baseline.value);
    } catch (restoreError) {
      throw new AggregateError(
        [releaseError, restoreError],
        `Release failed and ${LONGEST_QUERY_COLLECTOR_PARAMETER} rollback verification was incomplete.`,
      );
    }
    throw releaseError;
  }
}

class MetricSamplePendingError extends Error {
  constructor(message) {
    super(message);
    this.name = "MetricSamplePendingError";
  }
}

export function validateLongestQueryMetricResponse(response, { startTime, endTime }) {
  if (!Array.isArray(response?.value) || response.value.length !== 1) {
    throw new Error("Azure Monitor metric response must contain exactly one metric value.");
  }
  const metric = response.value[0];
  if (metric?.name?.value !== LONGEST_QUERY_METRIC) {
    throw new Error(`Azure Monitor returned a different metric: ${String(metric?.name?.value)}.`);
  }
  if (metric.errorCode !== "Success") {
    throw new Error(`Azure Monitor metric API did not report Success: ${String(metric.errorCode)}.`);
  }
  if (!Array.isArray(metric.timeseries)) {
    throw new Error("Azure Monitor longest-query metric timeseries must be an array.");
  }
  const startMs = Date.parse(startTime);
  const endMs = Date.parse(endTime);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
    throw new TypeError("Metric validation requires a bounded query interval.");
  }
  const bucketStartMs = Math.floor(startMs / 60_000) * 60_000;
  const samples = [];
  for (const [index, series] of metric.timeseries.entries()) {
    if (!series || !Array.isArray(series.metadatavalues) || !Array.isArray(series.data)) {
      throw new Error(`Azure Monitor longest-query timeseries ${index + 1} has a malformed schema.`);
    }
    for (const [pointIndex, point] of series.data.entries()) {
      const timestamp = Date.parse(point?.timeStamp);
      if (!Number.isFinite(timestamp)) {
        throw new Error(`Azure Monitor longest-query data point ${index + 1}.${pointIndex + 1} has a malformed schema.`);
      }
      // Azure omits the requested aggregate for an empty time bucket.
      if (!Object.hasOwn(point, "maximum") || point.maximum === null) continue;
      if (!Number.isFinite(point.maximum) || point.maximum < 0 || timestamp < bucketStartMs || timestamp > endMs) {
        throw new Error(`Azure Monitor longest-query data point ${index + 1}.${pointIndex + 1} is invalid or outside the query interval.`);
      }
      samples.push({ timestamp: point.timeStamp, maximum: point.maximum });
    }
  }
  if (samples.length === 0) {
    throw new MetricSamplePendingError("Azure Monitor longest-query metric has no available sample yet.");
  }
  samples.sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
  const latest = samples.at(-1);
  return {
    metricName: LONGEST_QUERY_METRIC,
    timeseriesCount: metric.timeseries.length,
    sampleCount: samples.length,
    latestSampleTimestamp: latest.timestamp,
    latestMaximumSeconds: latest.maximum,
  };
}

export async function verifyLongestQueryMetricAvailability({
  resourceGroup,
  serverName,
  resourceId,
  operations,
  now = () => new Date(),
  lookbackMs = LONGEST_QUERY_METRIC_LOOKBACK_MS,
  pollIntervalMs = LONGEST_QUERY_METRIC_POLL_MS,
  timeoutMs = LONGEST_QUERY_METRIC_TIMEOUT_MS,
}) {
  const startedAt = now();
  let attempts = 0;
  while (true) {
    const end = now();
    const start = new Date(end.getTime() - lookbackMs);
    const query = {
      metricName: LONGEST_QUERY_METRIC,
      aggregation: "Maximum",
      interval: LONGEST_QUERY_METRIC_INTERVAL,
      startTime: start.toISOString(),
      endTime: end.toISOString(),
    };
    const response = await operations.queryMetric(query);
    attempts += 1;
    try {
      const summary = validateLongestQueryMetricResponse(response, query);
      const completedAt = now().toISOString();
      const evidence = {
        schemaVersion: 1,
        operation: "azure-monitor-longest-query-metric-availability",
        request: {
          command: "az monitor metrics list",
          resourceGroup,
          serverName,
          resourceId,
          ...query,
          lookbackMinutes: lookbackMs / 60000,
          activationTimeoutSeconds: timeoutMs / 1000,
        },
        result: {
          azureApiSuccess: true,
          errorCode: "Success",
          ...summary,
          attempts,
          completedAt,
        },
      };
      const persisted = await operations.persistEvidence(evidence);
      return { evidence, persisted };
    } catch (error) {
      if (!(error instanceof MetricSamplePendingError)) throw error;
      if (now().getTime() - startedAt.getTime() >= timeoutMs) {
        throw new Error(`Azure Monitor ${LONGEST_QUERY_METRIC} had no sample within the bounded activation timeout.`);
      }
      await operations.sleep(pollIntervalMs);
    }
  }
}

function readLongestQueryCollector() {
  return JSON.parse(az([
    "postgres", "flexible-server", "parameter", "show", "--resource-group", RESOURCE_GROUP,
    "--server-name", POSTGRES_SERVER, "--name", LONGEST_QUERY_COLLECTOR_PARAMETER,
    "--query", "{name:name,value:value,source:source}", "--output", "json",
  ], { capture: true }));
}

function setLongestQueryCollector(value) {
  az([
    "postgres", "flexible-server", "parameter", "set", "--resource-group", RESOURCE_GROUP,
    "--server-name", POSTGRES_SERVER, "--name", LONGEST_QUERY_COLLECTOR_PARAMETER,
    "--value", value, "--output", "none",
  ]);
}

function configuredOwnerReceivers(actionGroup, expected) {
  if (actionGroup?.enabled !== true) throw new Error("Production owner action group is disabled or has an unexpected Azure CLI shape.");
  const receivers = [...(actionGroup?.emailReceivers ?? [])]
    .map((receiver) => ({
      name: receiver.name,
      emailAddress: String(receiver.emailAddress ?? "").toLowerCase(),
      status: receiver.status,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const identities = receivers.map(({ name, emailAddress }) => ({ name, emailAddress }));
  const wanted = [
    { name: "Asad", emailAddress: expected.asad.toLowerCase() },
    { name: "Laila", emailAddress: expected.laila.toLowerCase() },
  ];
  if (JSON.stringify(identities) !== JSON.stringify(wanted)) {
    throw new Error(`Production owner action-group receivers are not exactly Asad and Laila: ${JSON.stringify(identities)}`);
  }
  if (receivers.some((receiver) => !["Enabled", "Disabled"].includes(receiver.status))) {
    throw new Error(`Production owner action-group receiver status is not concrete: ${JSON.stringify(receivers)}`);
  }
  return receivers;
}

export function validateOwnerActionGroup(actionGroup, expected) {
  const receivers = configuredOwnerReceivers(actionGroup, expected);
  if (receivers.some((receiver) => receiver.status !== "Enabled")) {
    throw new Error(`Production owner action-group receivers are not exactly enabled Asad and Laila: ${JSON.stringify(receivers)}`);
  }
  return receivers;
}

export async function verifyOwnerActionGroupNotification({
  resourceGroup,
  actionGroupName,
  expected,
  operations,
  now = () => new Date(),
}) {
  let actionGroup = await operations.readActionGroup();
  const receivers = configuredOwnerReceivers(actionGroup, expected);
  for (const receiver of receivers.filter(({ status }) => status === "Disabled")) {
    await operations.enableReceiver(receiver.name);
  }
  actionGroup = await operations.readActionGroup();
  const enabledReceivers = validateOwnerActionGroup(actionGroup, expected);
  const requestedAt = now().toISOString();
  await operations.testNotification({
    alertType: "logalertv2",
    receivers: enabledReceivers.map(({ name, emailAddress }) => ({ name, emailAddress })),
  });
  const acceptedAt = now().toISOString();
  const evidence = {
    schemaVersion: 1,
    operation: "azure-monitor-action-group-test-notification",
    request: {
      command: "az monitor action-group test-notifications create",
      resourceGroup,
      actionGroupName,
      alertType: "logalertv2",
      receiverNames: enabledReceivers.map(({ name }) => name),
      noWait: true,
      requestedAt,
    },
    result: {
      azureRequestAccepted: true,
      acceptedAt,
      inboxDeliveryVerified: false,
      statement: "Azure accepted the synthetic notification request; recipient inbox delivery was not verified.",
    },
  };
  const persisted = await operations.persistEvidence(evidence);
  return { evidence, persisted };
}

function writeMonitoringEvidenceAtomic({ evidence, prefix, timestamp }) {
  const stamp = timestamp.replaceAll(/[^0-9]/g, "");
  const evidencePath = `${MONITORING_NOTIFICATION_EVIDENCE_DIRECTORY}/${prefix}-${stamp}.json`;
  const target = path.join(ROOT, evidencePath);
  const temporary = `${target}.partial-${process.pid}`;
  const bytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
    fs.linkSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return { path: evidencePath, sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function deployAndVerifyMonitoringReceivers(postgresTarget) {
  const parameters = JSON.parse(fs.readFileSync(path.join(ROOT, MONITORING_PARAMETERS_PATH), "utf8")).parameters;
  const actionGroupName = parameters.ownerActionGroupName?.value;
  const expected = { asad: parameters.asadOwnerEmail?.value, laila: parameters.lailaOwnerEmail?.value };
  if (!actionGroupName || !expected.asad || !expected.laila) throw new Error("Monitoring owner receiver parameters are incomplete.");
  log("deploying authoritative monitoring configuration and enabling owner receivers");
  az([
    "deployment", "group", "create", "--resource-group", RESOURCE_GROUP,
    "--name", "prostar-metrics-monitoring-release", "--template-file", "infra/azure/monitoring.bicep",
    "--parameters", MONITORING_PARAMETERS_PATH, "--output", "none",
  ]);
  const metricResult = await verifyLongestQueryMetricAvailability({
    resourceGroup: RESOURCE_GROUP,
    serverName: POSTGRES_SERVER,
    resourceId: postgresTarget.id,
    operations: {
      queryMetric: ({ metricName, aggregation, interval, startTime, endTime }) => JSON.parse(az([
        "monitor", "metrics", "list", "--resource", postgresTarget.id,
        "--metrics", metricName, "--aggregation", aggregation, "--interval", interval,
        "--start-time", startTime, "--end-time", endTime, "--output", "json",
      ], { capture: true })),
      sleep: (delayMs) => sleep(delayMs),
      persistEvidence: (evidence) => writeMonitoringEvidenceAtomic({
        evidence,
        prefix: "longest-query-metric",
        timestamp: evidence.result.completedAt,
      }),
    },
  });
  log(`verified live ${LONGEST_QUERY_METRIC} sample availability (${metricResult.persisted.path})`);
  const result = await verifyOwnerActionGroupNotification({
    resourceGroup: RESOURCE_GROUP,
    actionGroupName,
    expected,
    operations: {
      readActionGroup: () => JSON.parse(az([
        "monitor", "action-group", "show", "--resource-group", RESOURCE_GROUP,
        "--name", actionGroupName, "--output", "json",
      ], { capture: true })),
      enableReceiver: (receiverName) => {
        log(`enabling production owner action-group receiver ${receiverName}`);
        az([
          "monitor", "action-group", "enable-receiver", "--resource-group", RESOURCE_GROUP,
          "--action-group-name", actionGroupName, "--receiver-name", receiverName, "--output", "none",
        ]);
      },
      testNotification: ({ alertType, receivers }) => az([
        "monitor", "action-group", "test-notifications", "create",
        "--resource-group", RESOURCE_GROUP, "--action-group", actionGroupName,
        "--alert-type", alertType,
        ...receivers.flatMap(({ name, emailAddress }) => [
          "--add-action", "email", name, emailAddress, "usecommonalertschema",
        ]),
        "--no-wait",
        "--output", "none",
      ]),
      persistEvidence: (evidence) => writeMonitoringEvidenceAtomic({
        evidence,
        prefix: "action-group-test",
        timestamp: evidence.request.requestedAt,
      }),
    },
  });
  log(`verified enabled Asad and Laila receivers; Azure accepted the test request (${result.persisted.path})`);
  return { metric: metricResult, notification: result };
}

function versionlessSecretUrl(vaultName, secretName) {
  return `https://${vaultName}.vault.azure.net/secrets/${secretName}`;
}

function canonicalSecretReference(secret) {
  return {
    name: secret?.name ?? null,
    keyVaultUrl: secret?.keyVaultUrl ?? null,
    identity: typeof secret?.identity === "string" ? secret.identity.toLowerCase() : null,
    hasInlineValue: Object.hasOwn(secret ?? {}, "value"),
  };
}

export function validateKeyVaultReferenceSet(actualSecrets, expectedReferences, label) {
  if (!Array.isArray(actualSecrets)) throw new Error(`${label} secret configuration is not an array.`);
  const actual = actualSecrets.map(canonicalSecretReference).sort((left, right) => left.name.localeCompare(right.name));
  const expected = expectedReferences.map((reference) => ({
    ...reference,
    identity: reference.identity.toLowerCase(),
    hasInlineValue: false,
  })).sort((left, right) => left.name.localeCompare(right.name));
  if (actual.some((reference) => reference.hasInlineValue)) throw new Error(`${label} contains an inline secret value field.`);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} Key Vault reference contract drifted: ${JSON.stringify(actual)}`);
  }
  return actual;
}

function expectedKeyVaultReferences(contract, identityId, includeAuth) {
  const references = [
    { name: "azure-postgres-connection-string", keyVaultUrl: versionlessSecretUrl(contract.keyVaultName, contract.secretNames.database), identity: identityId },
    { name: "simpro-bearer-token", keyVaultUrl: versionlessSecretUrl(contract.keyVaultName, contract.secretNames.simpro), identity: identityId },
  ];
  if (contract.includePostgresSslCaCertSecret) {
    references.push({ name: "postgres-ssl-ca-cert-base64", keyVaultUrl: versionlessSecretUrl(contract.keyVaultName, contract.secretNames.ca), identity: identityId });
  }
  if (includeAuth) {
    references.push({ name: "microsoft-provider-authentication-secret", keyVaultUrl: versionlessSecretUrl(contract.keyVaultName, contract.secretNames.auth), identity: identityId });
  }
  return references;
}

function verifyProductionKeyVaultPreflight(contract) {
  log("verifying production Key Vault references and managed-identity RBAC");
  const identity = JSON.parse(az([
    "identity", "show", "--resource-group", RESOURCE_GROUP, "--name", contract.managedIdentityName,
    "--query", "{id:id,principalId:principalId}", "--output", "json",
  ], { capture: true }));
  const vault = JSON.parse(az([
    "keyvault", "show", "--resource-group", RESOURCE_GROUP, "--name", contract.keyVaultName,
    "--query", "{id:id,name:name}", "--output", "json",
  ], { capture: true }));
  if (!identity.id || !identity.principalId || !vault.id || vault.name !== contract.keyVaultName) {
    throw new Error("Production Key Vault or user-assigned identity metadata is incomplete.");
  }
  const assignments = JSON.parse(az([
    "role", "assignment", "list", "--assignee-object-id", identity.principalId,
    "--scope", vault.id, "--include-inherited", "--output", "json",
  ], { capture: true }));
  const role = assignments.filter((assignment) => (
    assignment.roleDefinitionName === KEY_VAULT_SECRETS_USER_ROLE
    && String(assignment.principalId).toLowerCase() === String(identity.principalId).toLowerCase()
    && String(assignment.scope).toLowerCase() === String(vault.id).toLowerCase()
  ));
  if (role.length !== 1) throw new Error(`Managed identity must have exactly one direct ${KEY_VAULT_SECRETS_USER_ROLE} assignment on ${contract.keyVaultName}.`);

  const app = JSON.parse(az([
    "containerapp", "show", "--resource-group", RESOURCE_GROUP, "--name", CONTAINER_APP_NAME, "--output", "json",
  ], { capture: true }));
  validateKeyVaultReferenceSet(
    app.properties?.configuration?.secrets,
    expectedKeyVaultReferences(contract, identity.id, true),
    CONTAINER_APP_NAME,
  );
  for (const name of managedJobNames()) {
    const job = JSON.parse(az([
      "containerapp", "job", "show", "--resource-group", RESOURCE_GROUP, "--name", name, "--output", "json",
    ], { capture: true }));
    validateKeyVaultReferenceSet(
      job.properties?.configuration?.secrets,
      expectedKeyVaultReferences(contract, identity.id, false),
      name,
    );
  }
  log(`verified versionless Key Vault references for ${CONTAINER_APP_NAME} and 24 jobs`);
}

export function validateEvidenceSigningKeyIds(keyIds, vaultName) {
  if (!keyIds || typeof keyIds !== "object" || Array.isArray(keyIds)) {
    throw new Error("Evidence signing key IDs must be an object");
  }
  const expectedKinds = Object.keys(EVIDENCE_SIGNING_KEY_NAMES).sort();
  if (JSON.stringify(Object.keys(keyIds).sort()) !== JSON.stringify(expectedKinds)) {
    throw new Error("Evidence signing key IDs must contain exactly gate, browser, and reviewer");
  }
  for (const [kind, keyName] of Object.entries(EVIDENCE_SIGNING_KEY_NAMES)) {
    const pattern = new RegExp(`^https://${vaultName}\\.vault\\.azure\\.net/keys/${keyName}/[a-f0-9]{32}$`);
    if (!pattern.test(keyIds[kind] ?? "")) {
      throw new Error(`${kind} evidence signing key must be the exact version-pinned production Key Vault key`);
    }
  }
  if (new Set(Object.values(keyIds)).size !== expectedKinds.length) {
    throw new Error("Evidence signing purposes must use three distinct version-pinned keys");
  }
  return Object.freeze({ ...keyIds });
}

function resolveEvidenceSigningKeyIds(vaultName) {
  const keyIds = Object.fromEntries(Object.entries(EVIDENCE_SIGNING_KEY_NAMES).map(([kind, keyName]) => {
    const document = JSON.parse(az([
      "keyvault", "key", "show", "--vault-name", vaultName, "--name", keyName,
      "--query", "{id:key.kid,enabled:attributes.enabled}", "--output", "json",
    ], { capture: true }));
    if (document?.enabled !== true || typeof document?.id !== "string") {
      throw new Error(`${kind} evidence signing key is absent or disabled`);
    }
    return [kind, document.id];
  }));
  return validateEvidenceSigningKeyIds(keyIds, vaultName);
}

function captureDeploymentState() {
  const web = JSON.parse(az(
    ["containerapp", "show", "--resource-group", RESOURCE_GROUP, "--name", CONTAINER_APP_NAME, "--output", "json"],
    { capture: true },
  ));
  const expectedJobNames = managedJobNames();
  const expectedJobSet = new Set(expectedJobNames);
  const listedJobs = JSON.parse(az(
    ["containerapp", "job", "list", "--resource-group", RESOURCE_GROUP, "--output", "json"],
    { capture: true },
  ));
  if (!Array.isArray(listedJobs)) throw new Error("Azure did not return a concrete Container App job list.");
  const jobsByName = new Map();
  for (const job of listedJobs) {
    if (!expectedJobSet.has(job?.name)) continue;
    if (jobsByName.has(job.name)) throw new Error(`Azure returned duplicate managed job ${job.name}.`);
    jobsByName.set(job.name, job);
  }
  const missingJobs = expectedJobNames.filter((name) => !jobsByName.has(name));
  if (missingJobs.length > 0) throw new Error(`Azure did not return managed job(s): ${missingJobs.join(", ")}`);
  const jobs = expectedJobNames.map((name) => canonicalTargetContract(jobsByName.get(name), "job"));
  const webContract = canonicalTargetContract(web, "app");
  const targets = [webContract, ...jobs].sort((left, right) => left.name.localeCompare(right.name));
  const revision = currentRevisionState(web);
  return {
    webImage: webContract.image,
    revisionMode: webContract.configuration.activeRevisionsMode,
    targets,
    revision,
  };
}

function assertRollbackCompatibleBaseline(state) {
  if (!state.webImage) throw new Error("Production baseline has no web image.");
  if (state.revisionMode !== "Single") {
    throw new Error(`Routine deployment requires Single revision mode; found ${state.revisionMode}.`);
  }
  const divergent = state.targets.filter((contract) => contract.image !== state.webImage).map(({ name }) => name);
  if (divergent.length > 0) {
    throw new Error(`Single-image rollback is unsafe because job images differ from the web image: ${divergent.join(", ")}`);
  }
}

function verifyDeploymentState(baseline, expectedImage) {
  const current = captureDeploymentState();
  if (current.webImage !== expectedImage) {
    throw new Error(`Production web image mismatch: expected ${expectedImage}, found ${current.webImage}`);
  }
  if (current.revisionMode !== "Single") {
    throw new Error(`Routine deployment changed revision mode to ${current.revisionMode}.`);
  }
  const baselineNames = baseline.targets.map(({ name }) => name);
  const currentNames = current.targets.map(({ name }) => name);
  if (JSON.stringify(currentNames) !== JSON.stringify(baselineNames)) {
    throw new Error("The Bicep-managed production job set changed during deployment.");
  }
  for (const [index, name] of baselineNames.entries()) {
    const before = baseline.targets[index];
    const after = current.targets[index];
    if (after.image !== expectedImage) {
      throw new Error(`${name} image mismatch: expected ${expectedImage}, found ${after.image}`);
    }
    if (JSON.stringify(targetContractWithoutImage(after)) !== JSON.stringify(targetContractWithoutImage(before))) {
      throw new Error(`${name} full target contract changed unexpectedly.`);
    }
  }
  if (current.revision.revisionMode !== "Single" || current.revision.trafficWeight !== 100) {
    throw new Error("Production revision mode or traffic contract changed unexpectedly.");
  }
  return current;
}

export async function waitForDeploymentState(baseline, expectedImage, {
  attempts = 60,
  delayMs = 5_000,
  verify = verifyDeploymentState,
  wait = sleep,
} = {}) {
  let lastFailure = "production targets have not converged";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return verify(baseline, expectedImage);
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    if (attempt < attempts) await wait(delayMs);
  }
  throw new Error(`production target convergence failed: ${lastFailure}`);
}

export function canonicalManagedResource(resource) {
  const type = String(resource?.type ?? "").toLowerCase();
  const kind = type.endsWith("/containerapps") ? "app" : type.endsWith("/jobs") ? "job" : null;
  if (!kind) throw new Error(`Unsupported managed resource type: ${String(resource?.type)}`);
  return canonicalTargetContract(resource, kind, { strict: true });
}

export function productionDeploymentTargetContract(subscriptionId = PRODUCTION_SUBSCRIPTION_ID) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(subscriptionId)) {
    throw new Error("Production what-if requires an exact Azure subscription UUID.");
  }
  return Object.freeze(PRODUCTION_TARGETS.map((target) => {
    const resourceType = target.kind === "app" ? "Microsoft.App/containerApps" : "Microsoft.App/jobs";
    const resourceId = [
      "", "subscriptions", subscriptionId, "resourceGroups", target.resourceGroup,
      "providers", resourceType, target.name,
    ].join("/").toLowerCase();
    return Object.freeze({ ...target, resourceId, resourceType });
  }));
}

export function productionDeploymentSupportContract(subscriptionId = PRODUCTION_SUBSCRIPTION_ID) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(subscriptionId)) {
    throw new Error("Production what-if requires an exact Azure subscription UUID.");
  }
  const base = `/subscriptions/${subscriptionId}/resourceGroups/${RESOURCE_GROUP}/providers`;
  const app = `${base}/Microsoft.App/containerApps/${CONTAINER_APP_NAME}`;
  const storage = `${base}/Microsoft.Storage/storageAccounts/stprostarmetricsexports`;
  return Object.freeze([
    `${app}/authConfigs/current`,
    storage,
    `${storage}/blobServices/default`,
    `${storage}/blobServices/default/containers/commission-exports`,
    `${storage}/blobServices/default/containers/commission-exports/providers/Microsoft.Authorization/roleAssignments/dc98a737-1d8b-5f04-8806-058aa78d6961`,
    `${storage}/managementPolicies/default`,
  ].map((resourceId) => resourceId.toLowerCase()));
}

function flattenedDeltaLeaves(deltas, parentPath = "") {
  const leaves = [];
  for (const delta of deltas) {
    const segment = String(delta?.path ?? "");
    const path = !parentPath
      ? segment
      : /^\d+$/.test(segment)
        ? `${parentPath}[${segment}]`
        : `${parentPath}.${segment}`;
    if (Array.isArray(delta?.children) && delta.children.length > 0) {
      leaves.push(...flattenedDeltaLeaves(delta.children, path));
    } else {
      leaves.push({ ...delta, path });
    }
  }
  return leaves;
}

function imageOnlyDeltaFailure(deltas, target, expectedImage) {
  const leaves = flattenedDeltaLeaves(deltas);
  const imageLeaves = leaves.filter((delta) => delta.path === "properties.template.containers[0].image");
  const runningStatusLeaves = leaves.filter((delta) => delta.path === "properties.runningStatus");
  if (imageLeaves.length !== 1
    || imageLeaves[0].propertyChangeType !== "Modify"
    || imageLeaves[0].after !== expectedImage
    || typeof imageLeaves[0].before !== "string"
    || !imageLeaves[0].before) {
    return "missing-or-invalid-image-delta";
  }
  if (target.kind === "job" && runningStatusLeaves.length !== 0) return "job-running-status-delta";
  if (target.kind === "app" && runningStatusLeaves.length > 1) return "duplicate-running-status-delta";
  if (runningStatusLeaves.length === 1) {
    const status = runningStatusLeaves[0];
    if (status.propertyChangeType !== "Delete" || status.before !== "Running" || status.after !== null) {
      return "invalid-running-status-delta";
    }
  }
  if (leaves.length !== imageLeaves.length + runningStatusLeaves.length) return "unsupported-delta";
  return null;
}

function canonicalManagedWhatIfResource(resource) {
  const normalized = structuredClone(resource);
  delete normalized.resourceGroup;
  if (normalized?.properties) delete normalized.properties.runningStatus;
  return canonicalManagedResource(normalized);
}

export function validateDeploymentWhatIf(result, params) {
  const changes = Array.isArray(result?.changes)
    ? result.changes
    : Array.isArray(result?.properties?.changes)
      ? result.properties.changes
      : null;
  if (!changes) throw new Error("Production what-if returned no recognized changes array.");
  const contract = productionDeploymentTargetContract(params.subscriptionId);
  const expected = new Map(contract.map((target) => [target.resourceId, target]));
  const supportContract = productionDeploymentSupportContract(params.subscriptionId);
  const support = new Set(supportContract);
  const observed = new Set();
  const observedSupport = new Set();
  const unexpected = [];
  for (const change of changes) {
    const resourceId = typeof change?.resourceId === "string" ? change.resourceId.toLowerCase() : "";
    const target = expected.get(resourceId);
    const deltas = change.delta ?? change.deltas;
    if (change?.changeType === "Ignore" && !target && !support.has(resourceId)) continue;
    if (!target) {
      if (support.has(resourceId)) {
        if (observedSupport.has(resourceId)) {
          unexpected.push(`${String(change?.changeType)}:${String(change?.resourceId)}:duplicate-support-resource`);
        } else {
          observedSupport.add(resourceId);
          if (change?.changeType !== "NoChange") {
            unexpected.push(`${String(change?.changeType)}:${String(change?.resourceId)}:support-resource-mutation`);
          }
        }
        continue;
      }
      if (change?.changeType === "NoChange") continue;
      unexpected.push(`${String(change?.changeType)}:${String(change?.resourceId)}:unrelated-or-malformed-resource`);
      continue;
    }
    if (observed.has(resourceId)) {
      unexpected.push(`${String(change?.changeType)}:${String(change?.resourceId)}:duplicate-target`);
      continue;
    }
    observed.add(resourceId);
    if (change.changeType !== "Modify") {
      unexpected.push(`${String(change.changeType)}:${change.resourceId}:expected-image-only-modify`);
      continue;
    }
    if (!Array.isArray(deltas) || deltas.length < 1 || !change.before || !change.after) {
      unexpected.push(`Modify:${resourceId}:missing-semantic-evidence`);
      continue;
    }
    const deltaFailure = imageOnlyDeltaFailure(deltas, target, params.expectedImage);
    if (deltaFailure) {
      unexpected.push(`Modify:${resourceId}:${deltaFailure}`);
      continue;
    }
    const expectedType = target.resourceType.toLowerCase();
    const beforeType = String(change.before?.type ?? "").toLowerCase();
    const afterType = String(change.after?.type ?? "").toLowerCase();
    const beforeId = String(change.before?.id ?? "").toLowerCase();
    const afterId = String(change.after?.id ?? "").toLowerCase();
    if (beforeType !== expectedType || afterType !== expectedType) {
      unexpected.push(`Modify:${resourceId}:resource-type-drift`);
      continue;
    }
    if (beforeId !== resourceId || afterId !== resourceId) {
      unexpected.push(`Modify:${resourceId}:resource-id-drift`);
      continue;
    }
    let beforeContract;
    let afterContract;
    try {
      beforeContract = canonicalManagedWhatIfResource(change.before);
      afterContract = canonicalManagedWhatIfResource(change.after);
    } catch (error) {
      unexpected.push(`Modify:${resourceId}:unsupported-or-missing-contract:${error.message}`);
      continue;
    }
    if (beforeContract.name !== target.name || afterContract.name !== target.name
      || beforeContract.kind !== target.kind || afterContract.kind !== target.kind
      || beforeContract.resourceId !== resourceId || afterContract.resourceId !== resourceId
      || beforeContract.resourceType.toLowerCase() !== expectedType || afterContract.resourceType.toLowerCase() !== expectedType) {
      unexpected.push(`Modify:${resourceId}:resource-name-drift`);
      continue;
    }
    if (JSON.stringify(targetContractWithoutImage(afterContract)) !== JSON.stringify(targetContractWithoutImage(beforeContract))) {
      unexpected.push(`Modify:${resourceId}:non-image-contract-drift`);
      continue;
    }
    if (afterContract.image !== params.expectedImage) {
      unexpected.push(`Modify:${resourceId}:unexpected-image`);
    }
  }
  for (const target of contract) {
    if (!observed.has(target.resourceId)) unexpected.push(`MissingModify:${target.resourceId}`);
  }
  for (const resourceId of supportContract) {
    if (!observedSupport.has(resourceId)) unexpected.push(`MissingNoChange:${resourceId}`);
  }
  if (unexpected.length > 0) {
    throw new Error(`Production what-if contains unexpected drift: ${unexpected.join("; ")}`);
  }
  return { managedResourceCount: observed.size, supportResourceCount: observedSupport.size };
}

function reviewDeploymentWhatIf(params) {
  log("running fail-closed production Bicep what-if");
  const raw = az([
    "deployment", "group", "what-if",
    "--resource-group", RESOURCE_GROUP,
    "--template-file", "infra/azure/metrics.bicep",
    "--parameters", PRODUCTION_PARAMETERS_PATH,
    "--parameters", `containerImage=${params.containerImage}`,
    "--result-format", "FullResourcePayloads",
    "--no-pretty-print",
    "--output", "json",
  ], { capture: true });
  const result = JSON.parse(raw);
  const validation = validateDeploymentWhatIf(result, {
    expectedImage: params.containerImage,
    subscriptionId: PRODUCTION_SUBSCRIPTION_ID,
  });
  log(`what-if approved ${validation.managedResourceCount} managed image changes and ${validation.supportResourceCount} unchanged support resources with no unrelated drift`);
}

function deployMetrics(params) {
  const deployment = az(
    [
      "deployment",
      "group",
      "create",
      "--resource-group",
      RESOURCE_GROUP,
      "--name",
      params.deploymentName,
      "--template-file",
      "infra/azure/metrics.bicep",
      "--parameters",
      PRODUCTION_PARAMETERS_PATH,
      "--parameters",
      `containerImage=${params.containerImage}`,
      "--output",
      "json",
    ],
    { capture: true },
  );
  return JSON.parse(deployment);
}

function currentRevisionState(appResource = null) {
  const app = appResource ?? JSON.parse(az(
    ["containerapp", "show", "--resource-group", RESOURCE_GROUP, "--name", CONTAINER_APP_NAME, "--output", "json"],
    { capture: true },
  ));
  const revisions = JSON.parse(az(
    ["containerapp", "revision", "list", "--resource-group", RESOURCE_GROUP, "--name", CONTAINER_APP_NAME, "--output", "json"],
    { capture: true },
  ));
  const latestRevisionName = app.properties?.latestRevisionName ?? null;
  const latestReadyRevisionName = app.properties?.latestReadyRevisionName ?? null;
  const latest = revisions.find((revision) => revision.name === latestRevisionName) ?? null;
  const trafficRevisions = revisions.filter((revision) => Number(revision.properties?.trafficWeight ?? 0) > 0);
  return {
    revisionMode: app.properties?.configuration?.activeRevisionsMode ?? null,
    latestRevisionName,
    latestReadyRevisionName,
    active: latest?.properties?.active === true,
    healthState: latest?.properties?.healthState ?? null,
    provisioningState: latest?.properties?.provisioningState ?? null,
    image: latest?.properties?.template?.containers?.[0]?.image ?? null,
    trafficWeight: Number(latest?.properties?.trafficWeight ?? 0),
    trafficRevisionNames: trafficRevisions.map((revision) => revision.name),
    createdAt: latest?.properties?.createdTime ?? latest?.createdTime ?? null,
  };
}

export function readyRevisionFailure(state, expectedImage) {
  if (state.revisionMode !== "Single") return `revision mode is ${state.revisionMode}`;
  if (!state.latestRevisionName || state.latestRevisionName !== state.latestReadyRevisionName) {
    return `latest revision ${state.latestRevisionName} is not latest ready ${state.latestReadyRevisionName}`;
  }
  if (!state.active) return "latest revision is not active";
  if (state.healthState !== "Healthy") return `latest revision health is ${state.healthState}`;
  if (state.provisioningState !== "Provisioned") return `latest revision provisioning is ${state.provisioningState}`;
  if (state.image !== expectedImage) return `latest revision image is ${state.image}`;
  if (state.trafficWeight !== 100) return `latest revision traffic is ${state.trafficWeight}`;
  if (state.trafficRevisionNames.length !== 1 || state.trafficRevisionNames[0] !== state.latestRevisionName) {
    return `traffic is assigned to ${state.trafficRevisionNames.join(", ") || "no revision"}`;
  }
  return null;
}

async function waitForHealthyDeployment(fqdn, expectedImage, attempts = 24) {
  let lastFailure = "candidate revision has not become ready";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const revisionFailure = readyRevisionFailure(currentRevisionState(), expectedImage);
      if (revisionFailure) throw new Error(revisionFailure);
      const response = await fetch(`https://${fqdn}/api/health`, {
        headers: { accept: "application/json" },
        redirect: "manual",
      });
      const payload = await response.json().catch(() => null);
      if (response.status === 200 && payload?.ok === true && payload?.database?.connected === true) {
        return payload;
      }
      lastFailure = `HTTP ${response.status}; ok=${String(payload?.ok)}; database.connected=${String(payload?.database?.connected)}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    if (attempt < attempts) await sleep(5000);
  }
  throw new Error(`production health smoke failed: ${lastFailure}`);
}

function readEasyAuthContract() {
  return JSON.parse(az(
    ["containerapp", "auth", "show", "--resource-group", RESOURCE_GROUP, "--name", CONTAINER_APP_NAME, "--output", "json"],
    { capture: true },
  ));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function finalizeCandidateDeployment({
  deploymentName,
  deploymentRunId,
  deploymentNonce,
  evidenceSigningKeyIds,
  previousImage,
  pinnedImage,
  acrBuild,
  buildSourceSha256,
  baseline,
  monitoringEvidence,
  operations,
}) {
  let fqdn = null;
  try {
    const candidateDeployment = await operations.deployCandidate();
    const arm = validateArmDeploymentProvenance(candidateDeployment, deploymentName, {
      deploymentRunId, deploymentNonce,
    });
    fqdn = operations.requireFqdn(arm.outputs);
    await operations.waitForHealthy(fqdn, pinnedImage);
    const verifiedState = await operations.verifyState(baseline, pinnedImage);
    const finalRevision = await operations.currentRevision();
    const revisionFailure = readyRevisionFailure(finalRevision, pinnedImage);
    if (revisionFailure) throw new Error(`post-verification revision provenance failed: ${revisionFailure}`);
    if (!Number.isFinite(Date.parse(finalRevision.createdAt))) {
      throw new Error("Candidate revision has no concrete Azure creation time");
    }
    const verifiedAcrBuild = await operations.verifyAcrBuild(acrBuild);
    const liveVerification = await operations.verifyLive(fqdn);
    const deploymentManifest = {
      schemaVersion: DEPLOYMENT_PROVENANCE_SCHEMA_VERSION,
      environment: "production",
      planRevision: PLAN_REVISION,
      planSha256: PLAN_SHA256,
      buildSourceSha256,
      resourceGroup: RESOURCE_GROUP,
      containerAppName: CONTAINER_APP_NAME,
      registry: ACR_NAME,
      repository: PRODUCTION_REPOSITORY,
      deploymentOperationId: arm.operationId,
      deploymentRunId,
      deploymentNonce,
      evidenceSigningKeyIds,
      acrBuild: verifiedAcrBuild,
      armDeployment: {
        deploymentName: arm.deploymentName,
        operationId: arm.operationId,
        correlationId: arm.correlationId,
        completedAt: arm.completedAt,
      },
      deployedRevision: finalRevision.latestRevisionName,
      latestReadyRevisionName: finalRevision.latestReadyRevisionName,
      revisionCreatedAt: new Date(finalRevision.createdAt).toISOString(),
      imageDigest: verifiedAcrBuild.digest,
      pinnedImage,
      productionUrl: `https://${fqdn}`,
      revisionMode: finalRevision.revisionMode,
      active: finalRevision.active,
      healthState: finalRevision.healthState,
      provisioningState: finalRevision.provisioningState,
      trafficWeight: finalRevision.trafficWeight,
      trafficRevisionNames: finalRevision.trafficRevisionNames,
      targets: verifiedState.targets,
      liveVerification,
      monitoringEvidence,
      deployedAt: operations.now().toISOString(),
    };
    await validateDeploymentManifestDocument(deploymentManifest, {
      expectedPlanRevision: PLAN_REVISION,
      expectedPlanSha256: PLAN_SHA256,
    });
    const writtenManifest = await operations.writeManifest(deploymentManifest);
    return { fqdn, deploymentManifest, writtenManifest };
  } catch (error) {
    if (previousImage && previousImage !== pinnedImage) {
      try {
        operations.logRollback(previousImage);
        const restored = await operations.restoreBaseline(previousImage);
        const restoredFqdn = operations.requireFqdn(restored.outputs);
        await operations.waitForHealthy(restoredFqdn, previousImage);
        await operations.verifyState(baseline, previousImage);
        await operations.verifyLive(restoredFqdn);
        const restoredRevision = await operations.currentRevision();
        const restoreFailure = readyRevisionFailure(restoredRevision, previousImage);
        if (restoreFailure) throw new Error(`rollback revision verification failed: ${restoreFailure}`);
      } catch (rollbackError) {
        console.error(`[deploy-prod] candidate failure detail: ${error instanceof Error ? error.message : String(error)}`);
        console.error(`[deploy-prod] rollback verification detail: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        throw new AggregateError([error, rollbackError], "Candidate deployment failed and exact rollback verification was incomplete");
      }
    }
    // Database migrations are expand-only and intentionally are never reversed here.
    throw error;
  }
}

export function createImmutableImageTag(sourceSha256, uuid = randomUUID()) {
  if (!/^[a-f0-9]{64}$/.test(sourceSha256)) throw new Error("Immutable image tag requires the canonical source SHA-256");
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(uuid)) {
    throw new Error("Immutable image tag requires a UUID");
  }
  return `deploy-${sourceSha256.slice(0, 16)}-${uuid.toLowerCase()}`;
}

export function validateAcrBuildBinding({ buildResult, liveRun, tagManifest, imageTag }) {
  const expected = validateAcrBuildProvenance(buildResult, {
    registry: ACR_NAME, repository: PRODUCTION_REPOSITORY, imageTag,
  });
  const live = validateAcrBuildProvenance(liveRun, {
    registry: ACR_NAME, repository: PRODUCTION_REPOSITORY, imageTag,
  });
  if (JSON.stringify(live) !== JSON.stringify(expected)) throw new Error("ACR build run changed between build and verification");
  if (tagManifest?.digest !== expected.digest) throw new Error("Immutable ACR tag drifted from its exact build output digest");
  if (Array.isArray(tagManifest?.tags) && !tagManifest.tags.includes(imageTag)) {
    throw new Error("ACR repository result does not bind the requested immutable tag");
  }
  return expected;
}

function readAndVerifyAcrBuild(buildResult, imageTag) {
  const liveRun = JSON.parse(az([
    "acr", "task", "show-run", "--registry", ACR_NAME,
    "--run-id", buildResult.runId ?? buildResult.id, "--output", "json",
  ], { capture: true }));
  if (!liveRun || Array.isArray(liveRun)) {
    throw new Error("ACR run lookup did not return one immutable build run");
  }
  const tagManifest = JSON.parse(az([
    "acr", "repository", "show", "--name", ACR_NAME,
    "--image", `${PRODUCTION_REPOSITORY}:${imageTag}`, "--output", "json",
  ], { capture: true }));
  return validateAcrBuildBinding({ buildResult, liveRun, tagManifest, imageTag });
}

function requireDeploymentFqdn(outputs) {
  const value = outputs?.containerAppFqdn?.value;
  if (!value) throw new Error("ARM deployment succeeded but did not return a Container App FQDN");
  return value;
}

async function verifyLiveProduction(fqdn) {
  return collectLiveHttpVerification({
    productionUrl: `https://${fqdn}`,
    auth: readEasyAuthContract(),
  });
}

async function executeProductionRelease(keyVaultContract, postgresTarget, buildSnapshot, releaseIdentity) {
  const monitoring = await deployAndVerifyMonitoringReceivers(postgresTarget);
  verifyProductionKeyVaultPreflight(keyVaultContract);
  const evidenceSigningKeyIds = resolveEvidenceSigningKeyIds(keyVaultContract.keyVaultName);
  const baseline = captureDeploymentState();
  assertRollbackCompatibleBaseline(baseline);
  const connectionString = getMigrationConnectionString();
  const previousImage = baseline.webImage;
  const imageTag = createImmutableImageTag(buildSnapshot.sha256, releaseIdentity.deploymentNonce);
  const taggedImage = `${PRODUCTION_REPOSITORY}:${imageTag}`;

  log("building and pushing metrics image in ACR");
  const buildResult = JSON.parse(az([
      "acr",
      "build",
      "--resource-group",
      RESOURCE_GROUP,
      "--registry",
      ACR_NAME,
      "--image",
      taggedImage,
      "--no-logs",
      "--output",
      "json",
      buildSnapshot.path,
    ], { capture: true }));
  const acrBuild = readAndVerifyAcrBuild(buildResult, imageTag);
  log(`canonical immutable Docker build context SHA-256 ${buildSnapshot.sha256} (${buildSnapshot.entries} entries)`);
  const pinnedImage = `${ACR_NAME}.azurecr.io/${PRODUCTION_REPOSITORY}@${acrBuild.digest}`;

  const deploymentInputs = {};
  reviewDeploymentWhatIf({ ...deploymentInputs, containerImage: pinnedImage });

  const publicIp = await getPublicIp();
  await withReconciledTemporaryFirewall({
    create: async () => {
    log("opening temporary migration firewall rule");
    az([
      "postgres",
      "flexible-server",
      "firewall-rule",
      "create",
      "--resource-group",
      RESOURCE_GROUP,
      "--name",
      POSTGRES_SERVER,
      "--rule-name",
      TEMP_FIREWALL_RULE,
      "--start-ip-address",
      publicIp,
      "--end-ip-address",
      publicIp,
      "--output",
      "none",
    ]);
    },
    verifyPresent: async () => verifyTemporaryMigrationFirewallPresent(publicIp),
    remove: async () => {
      log("removing temporary migration firewall rule");
      return removeTemporaryMigrationFirewallRule();
    },
    verifyAbsent: async () => verifyTemporaryMigrationFirewallAbsent(),
    run: async () => {
      log("checking pending migrations remain additive for the prior production image");
      runMigrationCompatibilityGate(connectionString, previousImage);
      log("running PostgreSQL migrations-twice and two-session concurrency gate");
      runPostgresPredeployGate(connectionString, previousImage);
      log("applying hash-tracked metrics migrations under the advisory lock");
      applyTrackedMigrations(connectionString, previousImage);
    },
  });

  const deploymentName = releaseIdentity.deploymentRunId;
  log(`deploying metrics Container App and scheduled jobs as ARM operation ${deploymentName}`);
  const finalized = await finalizeCandidateDeployment({
    deploymentName,
    deploymentRunId: releaseIdentity.deploymentRunId,
    deploymentNonce: releaseIdentity.deploymentNonce,
    evidenceSigningKeyIds,
    previousImage,
    pinnedImage,
    acrBuild,
    buildSourceSha256: buildSnapshot.sha256,
    baseline,
    monitoringEvidence: {
      longestQueryMetric: monitoring.metric.persisted,
      actionGroupNotification: monitoring.notification.persisted,
    },
    operations: {
      deployCandidate: () => deployMetrics({
        ...deploymentInputs,
        deploymentName,
        deploymentRunId: releaseIdentity.deploymentRunId,
        deploymentNonce: releaseIdentity.deploymentNonce,
        containerImage: pinnedImage,
      }),
      requireFqdn: requireDeploymentFqdn,
      waitForHealthy: async (fqdn, expectedImage) => {
        log("waiting for the database-aware production health gate");
        return waitForHealthyDeployment(fqdn, expectedImage);
      },
      verifyState: (expectedBaseline, expectedImage) => waitForDeploymentState(expectedBaseline, expectedImage),
      currentRevision: () => currentRevisionState(),
      verifyAcrBuild: () => readAndVerifyAcrBuild(buildResult, imageTag),
      verifyLive: (fqdn) => verifyLiveProduction(fqdn),
      writeManifest: (manifest) => writeDeploymentManifestAtomic({
        root: ROOT, manifest, manifestPath: DEPLOYMENT_MANIFEST_PATH,
      }),
      restoreBaseline: (image) => {
        const rollbackName = `prostar-metrics-rollback-${randomUUID()}`;
        const rollback = deployMetrics({ deploymentName: rollbackName, containerImage: image });
        return validateArmDeploymentProvenance(rollback, rollbackName);
      },
      logRollback: (image) => log(`post-deployment verification failed; restoring previous image, jobs, and traffic ${image}`),
      now: () => new Date(),
    },
  });
  const { fqdn, writtenManifest } = finalized;
  log(`wrote deployment provenance ${writtenManifest.path} (${writtenManifest.sha256})`);
  log(`deployed and health-verified https://${fqdn}`);
}

async function main() {
  parseDeployArgs(process.argv.slice(2));
  const keyVaultContract = validateDeploymentInputs();
  const deploymentNonce = randomUUID();
  const releaseIdentity = Object.freeze({
    deploymentRunId: `prostar-metrics-${deploymentNonce}`,
    deploymentNonce,
  });
  await withImmutableDockerBuildContext({
    root: ROOT,
    prepareSnapshot: ({ path: snapshotPath }) => {
      materializeSnapshotDependencies(snapshotPath);
    },
    build: async ({ path: snapshotPath, sha256, entries }) => {
      runDeploymentPreflight(snapshotPath);
      return withLongestQueryCollectorEnabled({
        operations: {
          preflight: () => reviewMonitoringWhatIfAndTarget(),
          readParameter: () => readLongestQueryCollector(),
          setParameter: (value) => setLongestQueryCollector(value),
        },
        run: ({ preflight }) => executeProductionRelease(keyVaultContract, preflight, {
          path: snapshotPath,
          sha256,
          entries,
        }, releaseIdentity),
      });
    },
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(`[deploy-prod] ${error.message}`);
    process.exit(1);
  });
}
