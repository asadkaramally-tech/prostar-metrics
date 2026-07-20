import { spawn } from "node:child_process";
import { basename, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";

import {
  extractReleaseGateAssertionEvents,
  summarizeReleaseGateAssertions,
  UNDERLYING_GATE_COMMANDS,
} from "./lib/release-gate-assertions.mjs";
import {
  EXPECTED_GATE_COMMANDS,
  jsonBytes,
  STRUCTURED_GATE_RESULT_SCHEMA_VERSION,
} from "./lib/release-evidence-trust.mjs";

const producer = Object.freeze({ name: "prostar-structured-gate-producer", version: "3.0.0" });

export async function runStructuredGateCommand({
  category,
  env = process.env,
  commandExecutor = executeCommand,
  now = () => new Date(),
}) {
  validateProducerEnvironment(category, env);
  const underlyingCommand = UNDERLYING_GATE_COMMANDS[category];
  const startedAt = now().toISOString();
  const execution = await commandExecutor({
    argv: [...underlyingCommand],
    cwd: env.RELEASE_PROJECT_ROOT,
    env: childEnvironment(env),
  });
  const completedAt = now().toISOString();
  const suiteExecution = {
    command: underlyingCommand,
    exitCode: execution.exitCode,
    signal: execution.signal,
    stdout: execution.stdout,
    stderr: execution.stderr,
  };
  if (execution.exitCode !== 0 || execution.signal !== null) {
    throw new Error(`${category} production gate command failed (${String(execution.exitCode ?? execution.signal)})`);
  }
  const results = extractReleaseGateAssertionEvents({ category, suiteExecution });
  const nonPassing = results.filter(({ outcome }) => outcome !== "PASS");
  if (nonPassing.length > 0) {
    throw new Error(`${category} production gate emitted non-PASS assertions`);
  }
  const document = {
    schemaVersion: STRUCTURED_GATE_RESULT_SCHEMA_VERSION,
    producer,
    category,
    executionId: env.RELEASE_GATE_EXECUTION_ID,
    runnerCommand: EXPECTED_GATE_COMMANDS[category],
    command: underlyingCommand,
    startedAt,
    completedAt,
    summary: summarizeReleaseGateAssertions(results),
    results,
  };
  await writeFile(env.RELEASE_GATE_RESULT_PATH, jsonBytes(document), { flag: "wx", mode: 0o400 });
  return {
    ...execution,
    stdout: Buffer.from(execution.stdout ?? Buffer.alloc(0)),
    stderr: Buffer.from(execution.stderr ?? Buffer.alloc(0)),
    resultPath: env.RELEASE_GATE_RESULT_PATH,
    results,
  };
}

function validateProducerEnvironment(category, env) {
  if (!UNDERLYING_GATE_COMMANDS[category]) throw new Error(`unknown gate category ${String(category)}`);
  if (env.RELEASE_GATE_CATEGORY !== category) throw new Error("gate producer category does not match the runner environment");
  if (!/^[0-9a-f-]{36}$/i.test(env.RELEASE_GATE_EXECUTION_ID ?? "")) throw new Error("gate producer execution ID is invalid");
  if (!isAbsolute(env.RELEASE_PROJECT_ROOT ?? "")) throw new Error("gate producer project root must be absolute");
  if (
    !isAbsolute(env.RELEASE_GATE_RESULT_PATH ?? "")
    || basename(env.RELEASE_GATE_RESULT_PATH) !== `${category}.results.json`
  ) throw new Error("gate producer result path is not the runner-owned category artifact");
}

function childEnvironment(env) {
  const result = { ...env };
  delete result.RELEASE_GATE_RESULT_PATH;
  delete result.RELEASE_GATE_EXECUTION_ID;
  delete result.RELEASE_GATE_CATEGORY;
  delete result.NODE_TEST_CONTEXT;
  return result;
}

async function executeCommand({ argv, cwd, env }) {
  const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const status = await new Promise((resolveStatus, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => resolveStatus({ exitCode, signal }));
  });
  return { ...status, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
}

function parseArguments(argv) {
  if (argv.length !== 2 || argv[0] !== "--category" || !UNDERLYING_GATE_COMMANDS[argv[1]]) {
    throw new Error("usage: node scripts/run-structured-gate-command.mjs --category <category>");
  }
  return argv[1];
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  runStructuredGateCommand({ category: parseArguments(process.argv.slice(2)) }).then((result) => {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.exitCode ?? 1;
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
