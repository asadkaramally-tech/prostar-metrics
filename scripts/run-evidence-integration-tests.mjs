import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const testsRoot = resolve(root, "tests");
const candidates = await findTestFiles(testsRoot);
const integrationTests = [];

for (const path of candidates) {
  const source = await readFile(path, "utf8");
  if (/from\s+["']@electric-sql\/pglite["']/.test(source)) integrationTests.push(relative(root, path));
}

if (integrationTests.length === 0) throw new Error("No PGlite-backed integration tests were discovered");
console.log(`Discovered ${integrationTests.length} PGlite-backed integration test files.`);
const child = spawn(process.execPath, [
  "--import", "tsx",
  "--test",
  "--test-reporter=./scripts/evidence-node-test-reporter.mjs",
  ...integrationTests,
], {
  cwd: root,
  env: { ...process.env, PROSTAR_EVIDENCE_GATE_CATEGORY: "integration" },
  stdio: "inherit",
});
const exitCode = await new Promise((resolveExit, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (signal) reject(new Error(`Integration test runner exited from signal ${signal}`));
    else resolveExit(code ?? 1);
  });
});
process.exitCode = exitCode;

async function findTestFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await findTestFiles(path));
    else if (entry.isFile() && /\.test\.(?:ts|mjs)$/.test(entry.name)) files.push(path);
  }
  return files.sort();
}
