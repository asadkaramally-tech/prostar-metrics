import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { PRODUCTION_JOB_NAMES } from "./lib/production-targets.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = path.join(ROOT, "docs", "inventory.generated.json");
const CHECK = process.argv.includes("--check");
const PUBLIC_APIS = new Set(["/api/health"]);

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(target));
    else files.push(target);
  }
  return files;
}

const relative = (file) => path.relative(ROOT, file).split(path.sep).join("/");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const quoted = (value) => [...value.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);
const unique = (values) => [...new Set(values)].sort();

function appRoute(file, suffix) {
  const route = relative(file).slice("src/app".length, -suffix.length);
  return route || "/";
}

function importedModules(source, pattern) {
  return unique([...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]).filter(pattern));
}

async function pageInventory(appFiles) {
  const pages = [];
  for (const file of appFiles.filter((candidate) => candidate.endsWith("/page.tsx"))) {
    const source = await readFile(file, "utf8");
    pages.push({ route: appRoute(file, "/page.tsx"), module: relative(file), components: importedModules(source, (value) => value.startsWith("@/components/")), stores: importedModules(source, (value) => value.startsWith("@/lib/store/")) });
  }
  return pages.sort((a, b) => a.route.localeCompare(b.route));
}

async function apiInventory(appFiles) {
  const routes = [];
  for (const file of appFiles.filter((candidate) => candidate.endsWith("/route.ts"))) {
    const source = await readFile(file, "utf8");
    const route = appRoute(file, "/route.ts");
    const methods = unique([...source.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/g)].map((match) => match[1]));
    const roles = unique([...source.matchAll(/assertRole\([^]*?\[([^\]]+)\]/g)].flatMap((match) => quoted(match[1])));
    const ownerSession = /parseClientPrincipalHeader/.test(source) && /isAllowedSessionOwner/.test(source);
    const auth = PUBLIC_APIS.has(route) ? "public" : roles.length ? "role-gated" : ownerSession ? "authenticated-owner" : /getCurrentUser|assertConfigured|require[A-Z]/.test(source) ? "authenticated-policy" : "unknown-review-required";
    routes.push({ route, module: relative(file), methods, auth, roles, stores: importedModules(source, (value) => value.startsWith("@/lib/store/")) });
  }
  return routes.sort((a, b) => a.route.localeCompare(b.route));
}

function objectArray(source, variableName) {
  const start = source.indexOf(`var ${variableName} = [`);
  if (start < 0) throw new Error(`Unable to find ${variableName} in metrics.bicep.`);
  const end = source.indexOf("\n]\n", start);
  if (end < 0) throw new Error(`Unable to find the end of ${variableName} in metrics.bicep.`);
  return source.slice(start, end + 2);
}

function productionJobs(metricsBicep) {
  const jobs = new Map();
  const scheduled = objectArray(metricsBicep, "scheduledSourceJobs");
  for (const match of scheduled.matchAll(/name:\s*'([^']+)'[^]*?cron:\s*'([^']+)'[^]*?args:\s*\[([^\]]+)\]/g)) jobs.set(match[1], { name: match[1], trigger: "schedule", cron: match[2], command: quoted(match[3]).join(" ") });
  const manual = objectArray(metricsBicep, "manualIngestionJobs");
  for (const match of manual.matchAll(/name:\s*'([^']+)'[^]*?entity:\s*'([^']+)'[^]*?budget:\s*'([^']+)'/g)) jobs.set(match[1], { name: match[1], trigger: "manual", cron: null, command: `npm run ingest:worker -- --entity ${match[2]} --request-budget ${match[3]}` });
  const parameter = (name) => metricsBicep.match(new RegExp(`param ${name} string = '([^']+)'`))?.[1];
  const ingestionCron = parameter("ingestionCronExpression");
  const reconciliationCron = parameter("reconciliationCronExpression");
  for (const [parameterName, entity] of [["ingestionJobName", "quotes"], ["jobsIngestionJobName", "jobs"]]) {
    const name = parameter(parameterName);
    jobs.set(name, { name, trigger: "schedule", cron: ingestionCron, command: `npm run ingest:worker -- --entity ${entity}` });
  }
  const reconciliation = parameter("reconciliationJobName");
  jobs.set(reconciliation, { name: reconciliation, trigger: "schedule", cron: reconciliationCron, command: "npm run reconcile:worker" });
  const rollup = parameter("rollupRebuildJobName");
  jobs.set(rollup, { name: rollup, trigger: "manual", cron: null, command: "npm run rollups:worker" });
  if (JSON.stringify([...jobs.keys()].sort()) !== JSON.stringify([...PRODUCTION_JOB_NAMES].sort())) throw new Error("Generated job inventory does not match the exact 24-job production target set.");
  return [...jobs.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function configurationInventory(sourceFiles, envExample, metricsBicep) {
  const local = unique([...envExample.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]));
  const runtime = unique([...metricsBicep.matchAll(/name:\s*'([A-Z][A-Z0-9_]*)'/g)].map((match) => match[1]));
  const referenced = [];
  for (const file of sourceFiles) {
    if (!/\.(?:mjs|js|ts|tsx)$/.test(file)) continue;
    const source = await readFile(file, "utf8");
    referenced.push(...[...source.matchAll(/process\.env(?:\.([A-Z][A-Z0-9_]*)|\[["']([A-Z][A-Z0-9_]*)["']\])/g)].map((match) => match[1] ?? match[2]));
  }
  return { localExample: local, deployedRuntime: runtime, sourceReferenced: unique(referenced) };
}

async function migrationInventory() {
  const directory = path.join(ROOT, "infra", "db", "migrations");
  const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  return Promise.all(files.map(async (name) => ({ name, sha256: sha256(await readFile(path.join(directory, name))) })));
}

async function buildInventory() {
  const appFiles = await walk(path.join(ROOT, "src", "app"));
  const sourceFiles = (await Promise.all(["src", "scripts", "workers", "infra"].map((name) => walk(path.join(ROOT, name))))).flat();
  const [metricsBicep, envExample] = await Promise.all([readFile(path.join(ROOT, "infra", "azure", "metrics.bicep"), "utf8"), readFile(path.join(ROOT, ".env.example"), "utf8")]);
  return {
    schemaVersion: 1,
    generatedFrom: { app: sha256(Buffer.concat(await Promise.all(appFiles.map((file) => readFile(file))))), metricsBicep: sha256(metricsBicep), envExample: sha256(envExample) },
    pages: await pageInventory(appFiles),
    apis: await apiInventory(appFiles),
    jobs: productionJobs(metricsBicep),
    configuration: await configurationInventory(sourceFiles, envExample, metricsBicep),
    migrations: await migrationInventory(),
  };
}

const content = `${JSON.stringify(await buildInventory(), null, 2)}\n`;
if (CHECK) {
  const current = await readFile(OUTPUT, "utf8").catch(() => "");
  if (current !== content) { console.error("docs/inventory.generated.json is stale; run npm run inventory:sync."); process.exitCode = 1; }
  else console.log("Generated project inventory is current.");
} else {
  await writeFile(OUTPUT, content);
  console.log("Wrote docs/inventory.generated.json.");
}
