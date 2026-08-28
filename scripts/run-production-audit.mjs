import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { withReconciledTemporaryFirewall } from "./deploy-prod.mjs";

const RESOURCE_GROUP = "prostar-payroll";
const SERVER = "pg-prostar-metrics-prod";
const VAULT = "kv-prostar-metrics-prod";
const APP = "aca-prostar-metrics-prod";
const RULE = `metrics-audit-${Date.now()}`;
const AUTH_NAMES = new Set([
  "METRICS_AUTH_MODE",
  "METRICS_ADMIN_EMAILS",
  "METRICS_FINANCE_EMAILS",
  "METRICS_OPERATOR_EMAILS",
  "METRICS_VIEWER_EMAILS",
]);

function az(args, { json = false } = {}) {
  const output = execFileSync("az", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return json ? JSON.parse(output) : output.trim();
}

function listRule() {
  const rules = az([
    "postgres", "flexible-server", "firewall-rule", "list",
    "--resource-group", RESOURCE_GROUP,
    "--server-name", SERVER,
    "--output", "json",
  ], { json: true });
  return rules.filter((rule) => rule.name === RULE);
}

async function main() {
  const blockersOnly = process.argv.slice(2).includes("--blockers");
  if (process.argv.slice(2).some((arg) => arg !== "--blockers")) {
    throw new Error("Usage: node scripts/run-production-audit.mjs [--blockers]");
  }
  const response = await fetch("https://api.ipify.org");
  if (!response.ok) throw new Error(`Public IP lookup failed with HTTP ${response.status}`);
  const publicIp = (await response.text()).trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(publicIp)) throw new Error("Public IP lookup returned an invalid address");

  const connectionString = az([
    "keyvault", "secret", "show", "--vault-name", VAULT,
    "--name", "azure-postgres-connection-string", "--query", "value", "--output", "tsv",
  ]);
  if (!connectionString) throw new Error("Key Vault returned an empty database connection string");

  const app = az([
    "containerapp", "show", "--resource-group", RESOURCE_GROUP,
    "--name", APP, "--output", "json",
  ], { json: true });
  const authorizationEnvironment = Object.fromEntries(
    (app.properties?.template?.containers?.[0]?.env ?? [])
      .filter((entry) => AUTH_NAMES.has(entry.name) && typeof entry.value === "string")
      .map((entry) => [entry.name, entry.value]),
  );
  if (authorizationEnvironment.METRICS_AUTH_MODE !== "easy-auth") {
    throw new Error("Production authorization environment is not the expected easy-auth contract");
  }

  await withReconciledTemporaryFirewall({
    create: async () => az([
      "postgres", "flexible-server", "firewall-rule", "create",
      "--resource-group", RESOURCE_GROUP,
      "--server-name", SERVER,
      "--name", RULE,
      "--start-ip-address", publicIp,
      "--end-ip-address", publicIp,
      "--output", "none",
    ]),
    verifyPresent: async () => {
      const matches = listRule();
      if (matches.length !== 1 || matches[0].startIpAddress !== publicIp || matches[0].endIpAddress !== publicIp) {
        throw new Error("Temporary audit firewall rule is not bound to the exact caller IP");
      }
    },
    run: async () => {
      const childArgs = blockersOnly
        ? ["scripts/report-production-blockers.mjs"]
        : ["scripts/audit-production-state.mjs", "--strict", "--summary"];
      const result = spawnSync(process.execPath, childArgs, {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ...authorizationEnvironment,
          AZURE_POSTGRES_CONNECTION_STRING: connectionString,
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15 * 60_000,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.status !== 0) throw new Error(result.stderr?.trim() || `Strict production audit exited ${result.status}`);
    },
    remove: async () => {
      if (listRule().length === 0) return;
      az([
        "postgres", "flexible-server", "firewall-rule", "delete",
        "--resource-group", RESOURCE_GROUP,
        "--server-name", SERVER,
        "--name", RULE,
        "--yes", "--output", "none",
      ]);
    },
    verifyAbsent: async () => {
      if (listRule().length !== 0) throw new Error("Temporary audit firewall rule remains after cleanup");
    },
    settle: () => new Promise((resolve) => setTimeout(resolve, 2_000)),
    requiredAbsenceChecks: 2,
    cleanupCycles: 3,
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(`[production-audit] ${error.message}`);
      process.exit(1);
    });
}
