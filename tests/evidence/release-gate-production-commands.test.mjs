import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  RELEASE_GATE_ASSERTION_EVENT_PREFIX,
  UNDERLYING_GATE_COMMANDS,
} from "../../scripts/lib/release-gate-assertions.mjs";
import {
  EXPECTED_GATE_COMMANDS,
  GATE_CATEGORIES,
  STRUCTURED_GATE_RESULT_SCHEMA_VERSION,
} from "../../scripts/lib/release-evidence-trust.mjs";
import { runStructuredGateCommand } from "../../scripts/run-structured-gate-command.mjs";

const projectRoot = resolve(import.meta.dirname, "../..");

test("all five actual production commands emit result-derived structured assertions", async (t) => {
  const outputRoot = await mkdtemp(join(tmpdir(), "prostar-actual-gates-"));
  try {
    for (const [index, category] of GATE_CATEGORIES.entries()) {
      await t.test(category, async () => {
        const resultPath = join(outputRoot, `${category}.results.json`);
        const executionId = `123e4567-e89b-42d3-a456-4266141740${String(index).padStart(2, "0")}`;
        const execution = await runStructuredGateCommand({
          category,
          env: {
            ...process.env,
            RELEASE_PROJECT_ROOT: projectRoot,
            RELEASE_GATE_CATEGORY: category,
            RELEASE_GATE_EXECUTION_ID: executionId,
            RELEASE_GATE_RESULT_PATH: resultPath,
          },
        });
        assert.equal(execution.exitCode, 0);
        assert.equal(execution.signal, null);
        assert.equal(execution.stdout.includes(Buffer.from(RELEASE_GATE_ASSERTION_EVENT_PREFIX)), true);
        const document = JSON.parse(await readFile(resultPath, "utf8"));
        assert.equal(document.schemaVersion, STRUCTURED_GATE_RESULT_SCHEMA_VERSION);
        assert.deepEqual(document.runnerCommand, EXPECTED_GATE_COMMANDS[category]);
        assert.deepEqual(document.command, UNDERLYING_GATE_COMMANDS[category]);
        assert.equal(document.results.length > 0, true);
        assert.equal(document.summary.claims, document.results.length);
        assert.equal(document.summary.failed, 0);
        assert.equal(document.summary.skipped, 0);
        assert.equal(document.summary.cancelled, 0);
        assert.equal(document.summary.todo, 0);
        assert.equal(document.summary.total, document.summary.passed);
        const expectedRunner = category === "integration" ? "integration-test" : category === "build" ? "build-check" : "node-test";
        for (const result of document.results) {
          assert.match(result.id, new RegExp(`^OBS-${category.toUpperCase()}-[a-f0-9]{32}$`));
          assert.equal(result.outcome, "PASS");
          assert.equal(result.provenance.runner, expectedRunner);
          assert.equal(result.provenance.source.startsWith("/"), false);
          assert.equal(result.counts.total, result.counts.passed);
        }
      });
    }
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test("a zero-exit production-command stub emits no claims and cannot create a result", async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "prostar-zero-claim-"));
  const resultPath = join(outputRoot, "unit.results.json");
  try {
    await assert.rejects(runStructuredGateCommand({
      category: "unit",
      env: {
        ...process.env,
        RELEASE_PROJECT_ROOT: projectRoot,
        RELEASE_GATE_CATEGORY: "unit",
        RELEASE_GATE_EXECUTION_ID: "123e4567-e89b-42d3-a456-426614174099",
        RELEASE_GATE_RESULT_PATH: resultPath,
      },
      commandExecutor: async () => ({
        exitCode: 0,
        signal: null,
        stdout: Buffer.from("stub succeeded without executing assertions\n"),
        stderr: Buffer.alloc(0),
      }),
    }), /emitted zero concrete assertion claims/);
    await assert.rejects(access(resultPath));
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});
