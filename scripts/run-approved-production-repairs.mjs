import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { withReconciledTemporaryFirewall } from "./deploy-prod.mjs";

const RESOURCE_GROUP = "prostar-payroll";
const SERVER = "pg-prostar-metrics-prod";
const VAULT = "kv-prostar-metrics-prod";
const RULE = `metrics-repair-${Date.now()}`;
const ACTOR = "asad@prostarmechanical.com";
const CONFIRMATION = "REPAIR-APPROVED-PRODUCTION-BLOCKERS";

const ingestionScopes = [
  { entity: "schedules", period: "2026-08-01", expected: 76 },
  { entity: "schedules", period: "2026-09-01", expected: 85 },
  { entity: "schedules", period: "2026-10-01", expected: 1 },
  { entity: "job_nested", period: "2026-09-01", expected: 11 },
  { entity: "job_nested", period: "2021-03-01", expected: 1 },
].map((scope) => ({
  ...scope,
  error: `Unable to queue technicians rollup for ${scope.period}.`,
}));

const backfillScopes = [
  { sourceFamily: "jobs", expected: 1, error: "Lost backfill lease while reconciling work unit 422." },
  { sourceFamily: "quotes", expected: 1, error: "Lost backfill lease while reconciling work unit 421." },
];

function az(args, { json = false } = {}) {
  const output = execFileSync("az", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return json ? JSON.parse(output) : output.trim();
}

function listRule() {
  const rules = az([
    "postgres", "flexible-server", "firewall-rule", "list",
    "--resource-group", RESOURCE_GROUP, "--server-name", SERVER, "--output", "json",
  ], { json: true });
  return rules.filter((rule) => rule.name === RULE);
}

function runRepair(entrypoint, args, connectionString) {
  const result = spawnSync("node_modules/.bin/tsx", [entrypoint, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, AZURE_POSTGRES_CONNECTION_STRING: connectionString },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5 * 60_000,
  });
  if (result.status !== 0) throw new Error(result.stderr?.trim() || `${entrypoint} exited ${result.status}`);
  return JSON.parse(result.stdout);
}

function ids(rows) {
  return rows.map((row) => row.id);
}

function assertExactPreview(scope, rows) {
  if (rows.length !== scope.expected) {
    throw new Error(`${scope.label} preview changed: expected ${scope.expected}, received ${rows.length}`);
  }
  if (rows.some((row) => row.last_error !== scope.error)) {
    throw new Error(`${scope.label} preview included a row outside the exact approved error.`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const execute = argv.includes("--execute");
  const confirmation = argv.find((arg) => arg.startsWith("--confirm="))?.slice("--confirm=".length);
  if (argv.some((arg) => arg !== "--execute" && !arg.startsWith("--confirm="))) {
    throw new Error(`Usage: node scripts/run-approved-production-repairs.mjs [--execute --confirm=${CONFIRMATION}]`);
  }
  if (execute && confirmation !== CONFIRMATION) throw new Error(`Execution requires --confirm=${CONFIRMATION}`);

  const response = await fetch("https://api.ipify.org");
  if (!response.ok) throw new Error(`Public IP lookup failed with HTTP ${response.status}`);
  const publicIp = (await response.text()).trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(publicIp)) throw new Error("Public IP lookup returned an invalid address");
  const connectionString = az([
    "keyvault", "secret", "show", "--vault-name", VAULT,
    "--name", "azure-postgres-connection-string", "--query", "value", "--output", "tsv",
  ]);
  if (!connectionString) throw new Error("Key Vault returned an empty database connection string");

  await withReconciledTemporaryFirewall({
    create: async () => az([
      "postgres", "flexible-server", "firewall-rule", "create",
      "--resource-group", RESOURCE_GROUP, "--server-name", SERVER, "--name", RULE,
      "--start-ip-address", publicIp, "--end-ip-address", publicIp, "--output", "none",
    ]),
    verifyPresent: async () => {
      const matches = listRule();
      if (matches.length !== 1 || matches[0].startIpAddress !== publicIp || matches[0].endIpAddress !== publicIp) {
        throw new Error("Temporary repair firewall rule is not bound to the exact caller IP");
      }
    },
    run: async () => {
      const previews = [];
      for (const rawScope of ingestionScopes) {
        const scope = { ...rawScope, label: `${rawScope.entity}:${rawScope.period}` };
        const args = ["--entity", scope.entity, "--error-contains", scope.error, "--limit", String(scope.expected)];
        const preview = runRepair("workers/repair-ingestion-queue.ts", args, connectionString).matches;
        assertExactPreview(scope, preview);
        previews.push({ scope: scope.label, ids: ids(preview) });
        if (execute) {
          const repaired = runRepair("workers/repair-ingestion-queue.ts", [
            ...args, "--execute", "--actor-email", ACTOR,
            "--reason", `Approved 2026-08-28 stabilization repair for ${scope.label}`,
          ], connectionString).repaired;
          if (JSON.stringify(ids(repaired)) !== JSON.stringify(ids(preview))) throw new Error(`${scope.label} execution IDs did not match preview IDs`);
        }
      }
      for (const rawScope of backfillScopes) {
        const scope = { ...rawScope, label: `${rawScope.sourceFamily}:2026-07-01` };
        const args = [
          "--source-family", scope.sourceFamily, "--month-start", "2026-07-01",
          "--error-contains", scope.error, "--limit", String(scope.expected),
        ];
        const preview = runRepair("workers/repair-backfill-ledger.ts", args, connectionString).matches;
        assertExactPreview(scope, preview);
        previews.push({ scope: scope.label, ids: ids(preview) });
        if (execute) {
          const repaired = runRepair("workers/repair-backfill-ledger.ts", [
            ...args, "--execute", "--actor-email", ACTOR,
            "--reason", `Approved 2026-08-28 stabilization repair for ${scope.label}`,
          ], connectionString).repaired;
          if (JSON.stringify(ids(repaired)) !== JSON.stringify(ids(preview))) throw new Error(`${scope.label} execution IDs did not match preview IDs`);
        }
      }
      console.log(JSON.stringify({ mode: execute ? "execute" : "dry-run", scopes: previews }, null, 2));
    },
    remove: async () => {
      if (listRule().length === 0) return;
      az([
        "postgres", "flexible-server", "firewall-rule", "delete",
        "--resource-group", RESOURCE_GROUP, "--server-name", SERVER, "--name", RULE,
        "--yes", "--output", "none",
      ]);
    },
    verifyAbsent: async () => {
      if (listRule().length !== 0) throw new Error("Temporary repair firewall rule remains after cleanup");
    },
    settle: () => new Promise((resolve) => setTimeout(resolve, 2_000)),
    requiredAbsenceChecks: 2,
    cleanupCycles: 3,
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  main().then(() => process.exit(0)).catch((error) => {
    console.error(`[production-repair] ${error.message}`);
    process.exit(1);
  });
}
