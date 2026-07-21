import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";

import {
  assertExactDatabaseSchemaManifest,
  collectDatabaseSchemaManifest,
  generateRepositoryDatabaseSchemaManifest,
} from "./lib/database-schema-manifest.mjs";
import { verifiedPostgresClientConfig } from "./postgres-tls.mjs";

const { Client } = pg;
const ROOT = resolve(import.meta.dirname, "..");
const CONFIRMATION = "RESTORE-PG-PROSTAR-METRICS-PROD";
const RESOURCE_GROUP = "prostar-payroll";
const SOURCE_SERVER_NAME = "pg-prostar-metrics-prod";
const DATABASE_NAME = "prostar_metrics";
const KEY_VAULT_NAME = "kv-prostar-metrics-prod";
const CONNECTION_SECRET_NAME = "azure-postgres-connection-string";
const CA_SECRET_NAME = "postgres-ssl-ca-cert-base64";
const TEMP_FIREWALL_RULE = "restore-drill-caller";
const POSTGRES_ARM_API_VERSION = "2023-12-01-preview";

const NONPUBLIC_IPV4_CIDRS = Object.freeze([
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]);

function parseOptions(args) {
  const allowedFlags = new Set(["--execute", "--use-ca-secret"]);
  const allowedValues = new Set(["--confirm", "--caller-ip", "--restore-time", "--evidence-dir"]);
  const flags = new Set();
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (allowedFlags.has(arg)) {
      if (flags.has(arg)) throw new Error(`Duplicate restore argument: ${arg}`);
      flags.add(arg);
      continue;
    }
    const [name, inlineValue] = arg.split("=", 2);
    if (!allowedValues.has(name)) throw new Error(`Unknown restore argument: ${arg}`);
    if (values.has(name)) throw new Error(`Duplicate restore argument: ${name}`);
    const value = inlineValue ?? args[++index];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    values.set(name, value);
  }
  return { flags, values };
}

function uniqueServerName(now = new Date()) {
  const timestamp = now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `pg-psm-drill-${timestamp}-${randomBytes(3).toString("hex")}`;
}

function ipv4Integer(value) {
  const parts = value.split(".");
  if (
    parts.length !== 4
    || parts.some((part) => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)
  ) return null;
  return parts.reduce((result, part) => ((result << 8) | Number(part)) >>> 0, 0);
}

function inCidr(address, network, prefix) {
  const addressValue = ipv4Integer(address);
  const networkValue = ipv4Integer(network);
  if (addressValue === null || networkValue === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (addressValue & mask) >>> 0 === (networkValue & mask) >>> 0;
}

export function isPublicIpv4(value) {
  if (typeof value !== "string" || ipv4Integer(value) === null) return false;
  return !NONPUBLIC_IPV4_CIDRS.some(([network, prefix]) => inCidr(value, network, prefix));
}

export function parseRestoreArgs(args, now = new Date()) {
  const { flags, values } = parseOptions(args);
  const execute = flags.has("--execute");
  if (execute && values.get("--confirm") !== CONFIRMATION) {
    throw new Error(`Execution requires --confirm=${CONFIRMATION}`);
  }
  if (!execute && values.has("--confirm")) throw new Error("--confirm is valid only with --execute");
  const callerIp = values.get("--caller-ip") ?? "";
  if (!isPublicIpv4(callerIp)) throw new Error("Restore planning requires one globally routable public IPv4 --caller-ip");
  const restoreTime = new Date(values.get("--restore-time") ?? new Date(now.getTime() - 10 * 60_000).toISOString());
  if (Number.isNaN(restoreTime.getTime()) || restoreTime > now || restoreTime < new Date(now.getTime() - 34 * 24 * 60 * 60_000)) {
    throw new Error("--restore-time must be within the last 34 days and not in the future");
  }
  return {
    execute,
    callerIp,
    restoreTime: restoreTime.toISOString(),
    temporaryServerName: uniqueServerName(now),
    useCaSecret: flags.has("--use-ca-secret"),
    evidenceDirectory: resolve(values.get("--evidence-dir") ?? resolve(ROOT, ".work", "infra-evidence")),
  };
}

export class AzureCliError extends Error {
  constructor(message, { status, stdout, stderr }) {
    super(message);
    this.name = "AzureCliError";
    this.status = status;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

function runAz(args, { sensitive = false, output = "json" } = {}) {
  const commandArgs = [...args];
  if (output && !commandArgs.includes("--output") && !commandArgs.includes("-o")) {
    commandArgs.push("--output", output);
  }
  commandArgs.push("--only-show-errors");
  const result = spawnSync("az", commandArgs, {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, AZURE_CORE_OUTPUT: "none" },
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new AzureCliError(
      sensitive ? "Sensitive Azure command failed" : (result.stderr || result.stdout || "Azure command failed").trim(),
      { status: result.status, stdout: result.stdout, stderr: result.stderr },
    );
  }
  if (output === "none") return null;
  const text = result.stdout.trim();
  if (output === "tsv") return text;
  return text ? JSON.parse(text) : null;
}

export function isExplicitCliResourceNotFound(error) {
  if (!(error instanceof AzureCliError)) return false;
  const detail = `${error.stderr ?? ""}\n${error.stdout ?? ""}`;
  return /\(ResourceNotFound\)|["']code["']\s*:\s*["']ResourceNotFound["']|\bCode:\s*ResourceNotFound\b/.test(detail);
}

function runAzOrResourceNotFound(args, options) {
  try {
    return { found: true, value: runAz(args, options) };
  } catch (error) {
    if (isExplicitCliResourceNotFound(error)) return { found: false, value: null };
    throw error;
  }
}

export async function assertArmResourceAbsent(resourceUrl, token, fetchImplementation = fetch) {
  let response;
  try {
    response = await fetchImplementation(resourceUrl, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
  } catch {
    throw new Error("ARM cleanup verification failed before an HTTP response was received");
  }
  if (response.status === 404) return true;
  if (response.ok) throw new Error("ARM still returns the temporary PostgreSQL server after deletion");
  throw new Error(`ARM cleanup verification failed with HTTP ${response.status}`);
}

function sourceContract(server) {
  return {
    location: server.location,
    version: server.version,
    availabilityZone: server.availabilityZone ?? null,
    sku: server.sku ?? null,
    storage: server.storage ?? null,
    backup: server.backup ?? null,
    highAvailability: server.highAvailability ?? null,
    network: server.network ?? null,
  };
}

function evidenceServer(server) {
  return {
    id: server.id,
    name: server.name,
    fullyQualifiedDomainName: server.fullyQualifiedDomainName,
    state: server.state,
    ...sourceContract(server),
  };
}

function assertPublicSource(server) {
  if (server?.network?.publicNetworkAccess !== "Enabled") {
    throw new Error("Restore drill requires the existing public-access contract and will not alter source networking");
  }
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

async function validateRestoredDatabase({ connectionString, caBase64, expectedManifest }) {
  const url = new URL(connectionString);
  url.pathname = `/${DATABASE_NAME}`;
  const tlsEnv = { ...process.env };
  if (caBase64) {
    const pem = Buffer.from(caBase64, "base64").toString("utf8").trim();
    if (!pem.includes("-----BEGIN CERTIFICATE-----")) throw new Error("The optional PostgreSQL CA secret is not valid base64 PEM");
    tlsEnv.AZURE_POSTGRES_CA_CERT = pem;
    delete tlsEnv.AZURE_POSTGRES_CA_CERT_PATH;
    delete tlsEnv.PGSSLROOTCERT;
  }
  const client = new Client(await verifiedPostgresClientConfig(url.toString(), { env: tlsEnv }));
  await client.connect();
  try {
    await client.query("begin isolation level repeatable read read only");
    await client.query("set local statement_timeout = '5min'");
    const tls = (await client.query(`
      select ssl, version, cipher, bits
        from pg_stat_ssl
       where pid = pg_backend_pid()
    `)).rows[0];
    if (tls?.ssl !== true) throw new Error("Restored PostgreSQL connection is not using TLS");

    const actualManifest = await collectDatabaseSchemaManifest((sql) => client.query(sql));
    const schemaContract = assertExactDatabaseSchemaManifest(actualManifest, expectedManifest);
    const tableCounts = [];
    for (const table of actualManifest.tables) {
      const result = await client.query(
        `select count(*)::text as count from ${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`,
      );
      tableCounts.push({ schema: table.schema, table: table.name, rowCount: result.rows[0].count });
    }
    await client.query("commit");
    return {
      databaseName: DATABASE_NAME,
      tls: {
        enabled: true,
        protocol: tls.version,
        cipher: tls.cipher,
        bits: tls.bits,
      },
      schemaManifest: schemaContract,
      migrationsCompatible: true,
      rowCounts: {
        purpose: "evidence-only",
        comparedToSourceBaseline: false,
        tables: tableCounts,
      },
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

export async function executeRestoreWorkflow({ operations }) {
  let result = null;
  let primaryError = null;
  const cleanupErrors = [];
  try {
    await operations.restore();
    const restoredServer = await operations.waitUntilReady();
    await operations.validateRestoredConfiguration(restoredServer);
    await operations.addTemporaryFirewall(restoredServer);
    result = await operations.validateDatabase(restoredServer);
  } catch (error) {
    primaryError = error;
  } finally {
    for (const cleanup of [
      operations.removeTemporaryFirewall,
      operations.deleteTemporaryServer,
      operations.verifyCleanup,
      operations.verifySourceUnchanged,
    ]) {
      try {
        await cleanup();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }
  if (primaryError && cleanupErrors.length > 0) {
    throw new AggregateError([primaryError, ...cleanupErrors], "Restore drill failed and cleanup verification was incomplete");
  }
  if (primaryError) throw primaryError;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Restore drill validation passed but cleanup verification failed");
  return result;
}

async function waitForReady(serverName, attempts = 120) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = runAzOrResourceNotFound([
      "postgres", "flexible-server", "show",
      "--resource-group", RESOURCE_GROUP,
      "--name", serverName,
    ]);
    if (result.found && result.value?.state === "Ready") return result.value;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 15_000));
  }
  throw new Error("Temporary PostgreSQL restore did not become Ready before timeout");
}

async function waitForCliDeletion(serverName, attempts = 80) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = runAzOrResourceNotFound([
      "postgres", "flexible-server", "show",
      "--resource-group", RESOURCE_GROUP,
      "--name", serverName,
    ]);
    if (!result.found) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 15_000));
  }
  throw new Error("Temporary PostgreSQL server still exists after delete timeout");
}

function readVaultSecret(secretName) {
  return runAz([
    "keyvault", "secret", "show",
    "--vault-name", KEY_VAULT_NAME,
    "--name", secretName,
    "--query", "value",
  ], { sensitive: true, output: "tsv" });
}

async function writeEvidence(directory, evidence) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const timestamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
  const path = resolve(directory, `postgres-restore-drill-${timestamp}.json`);
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  return path;
}

async function main() {
  const args = parseRestoreArgs(process.argv.slice(2));
  const expectedManifest = await generateRepositoryDatabaseSchemaManifest(ROOT);
  const source = runAz([
    "postgres", "flexible-server", "show",
    "--resource-group", RESOURCE_GROUP,
    "--name", SOURCE_SERVER_NAME,
  ]);
  assertPublicSource(source);
  const existingTemporary = runAzOrResourceNotFound([
    "postgres", "flexible-server", "show",
    "--resource-group", RESOURCE_GROUP,
    "--name", args.temporaryServerName,
  ]);
  if (existingTemporary.found) throw new Error("Refusing to reuse an existing temporary restore server name");

  runAz([
    "keyvault", "secret", "show",
    "--vault-name", KEY_VAULT_NAME,
    "--name", CONNECTION_SECRET_NAME,
    "--query", "{id:id,enabled:attributes.enabled}",
  ]);

  const evidence = {
    schemaVersion: 2,
    operation: "prostar-metrics-postgres-restore-drill",
    mode: args.execute ? "execute" : "dry-run",
    startedAt: new Date().toISOString(),
    resourceGroup: RESOURCE_GROUP,
    sourceServer: evidenceServer(source),
    restoreTime: args.restoreTime,
    temporaryServerName: args.temporaryServerName,
    callerFirewallRule: TEMP_FIREWALL_RULE,
    callerIpValidatedPublic: true,
    databaseName: DATABASE_NAME,
    expectedSchemaContract: {
      schemaCount: expectedManifest.schemas.length,
      tableCount: expectedManifest.tables.length,
      columnCount: expectedManifest.columns.length,
      constraintCount: expectedManifest.constraints.length,
      indexCount: expectedManifest.indexes.length,
      migrations: expectedManifest.migrations,
    },
    status: "planned",
    cleanup: {
      firewallRemovalAttempted: false,
      serverDeletionAttempted: false,
      cliResourceNotFoundVerified: false,
      armHttp404Verified: false,
      sourceUnchangedVerified: false,
    },
  };

  if (!args.execute) {
    evidence.completedAt = new Date().toISOString();
    const evidencePath = await writeEvidence(args.evidenceDirectory, evidence);
    console.log(`Dry run complete. Secret-free evidence: ${evidencePath}`);
    return;
  }

  const temporaryServerId = `${source.id.slice(0, source.id.lastIndexOf("/") + 1)}${args.temporaryServerName}`;
  const temporaryServerUrl = `https://management.azure.com${temporaryServerId}?api-version=${POSTGRES_ARM_API_VERSION}`;
  let restoredEvidence = null;
  try {
    const sourceConnectionString = readVaultSecret(CONNECTION_SECRET_NAME);
    const caBase64 = args.useCaSecret ? readVaultSecret(CA_SECRET_NAME) : null;
    const validation = await executeRestoreWorkflow({
      operations: {
        async restore() {
          runAz([
            "postgres", "flexible-server", "restore",
            "--resource-group", RESOURCE_GROUP,
            "--name", args.temporaryServerName,
            "--source-server", source.id,
            "--restore-time", args.restoreTime,
            "--yes",
          ], { output: "none" });
        },
        async waitUntilReady() {
          return waitForReady(args.temporaryServerName);
        },
        async validateRestoredConfiguration(restored) {
          restoredEvidence = evidenceServer(restored);
          if (restored.name !== args.temporaryServerName) throw new Error("Restore returned an unexpected temporary server");
          if (restored.network?.publicNetworkAccess !== source.network?.publicNetworkAccess) {
            throw new Error("Temporary restore network access differs from the source contract");
          }
          for (const key of ["location", "version"]) {
            if (restored[key] !== source[key]) throw new Error(`Temporary restore ${key} differs from source`);
          }
        },
        async addTemporaryFirewall() {
          runAz([
            "postgres", "flexible-server", "firewall-rule", "create",
            "--resource-group", RESOURCE_GROUP,
            "--server-name", args.temporaryServerName,
            "--name", TEMP_FIREWALL_RULE,
            "--start-ip-address", args.callerIp,
            "--end-ip-address", args.callerIp,
          ], { output: "none" });
        },
        async validateDatabase(restored) {
          const url = new URL(sourceConnectionString);
          url.hostname = restored.fullyQualifiedDomainName;
          return validateRestoredDatabase({ connectionString: url.toString(), caBase64, expectedManifest });
        },
        async removeTemporaryFirewall() {
          evidence.cleanup.firewallRemovalAttempted = true;
          const existingRule = runAzOrResourceNotFound([
            "postgres", "flexible-server", "firewall-rule", "show",
            "--resource-group", RESOURCE_GROUP,
            "--server-name", args.temporaryServerName,
            "--name", TEMP_FIREWALL_RULE,
          ]);
          if (existingRule.found) {
            runAz([
              "postgres", "flexible-server", "firewall-rule", "delete",
              "--resource-group", RESOURCE_GROUP,
              "--server-name", args.temporaryServerName,
              "--name", TEMP_FIREWALL_RULE,
              "--yes",
            ], { output: "none" });
          }
        },
        async deleteTemporaryServer() {
          evidence.cleanup.serverDeletionAttempted = true;
          const existing = runAzOrResourceNotFound([
            "postgres", "flexible-server", "show",
            "--resource-group", RESOURCE_GROUP,
            "--name", args.temporaryServerName,
          ]);
          if (existing.found) {
            runAz([
              "postgres", "flexible-server", "delete",
              "--resource-group", RESOURCE_GROUP,
              "--name", args.temporaryServerName,
              "--yes",
            ], { output: "none" });
          }
        },
        async verifyCleanup() {
          await waitForCliDeletion(args.temporaryServerName);
          evidence.cleanup.cliResourceNotFoundVerified = true;
          const cleanupArmToken = runAz([
            "account", "get-access-token",
            "--resource", "https://management.azure.com",
            "--query", "accessToken",
          ], { sensitive: true, output: "tsv" });
          await assertArmResourceAbsent(temporaryServerUrl, cleanupArmToken);
          evidence.cleanup.armHttp404Verified = true;
        },
        async verifySourceUnchanged() {
          const after = runAz([
            "postgres", "flexible-server", "show",
            "--resource-group", RESOURCE_GROUP,
            "--name", SOURCE_SERVER_NAME,
          ]);
          if (JSON.stringify(sourceContract(after)) !== JSON.stringify(sourceContract(source))) {
            throw new Error("Source PostgreSQL network or configuration changed during the restore drill");
          }
          evidence.cleanup.sourceUnchangedVerified = true;
        },
      },
    });
    evidence.status = "succeeded";
    evidence.restoredServer = restoredEvidence;
    evidence.validation = validation;
  } catch (error) {
    evidence.status = "failed";
    evidence.failure = error instanceof AggregateError
      ? "Restore drill failed and cleanup verification was incomplete"
      : "Restore drill failed; cleanup was attempted";
    throw error;
  } finally {
    if (restoredEvidence) evidence.restoredServer = restoredEvidence;
    evidence.completedAt = new Date().toISOString();
    const evidencePath = await writeEvidence(args.evidenceDirectory, evidence);
    console.log(`Secret-free evidence: ${evidencePath}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error("PostgreSQL restore drill failed; inspect the secret-free evidence report");
    process.exitCode = 1;
  });
}
