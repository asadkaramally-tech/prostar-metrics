import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { promisify } from "node:util";
import { parseArgs, shouldEnqueueIngestionJob } from "../../workers/ingest-simpro";

const execFileAsync = promisify(execFile);

test("ingestion worker IDs are stable per execution and unique across worker processes", async () => {
  const moduleUrl = new URL("../../workers/ingest-simpro.ts", import.meta.url).href;
  const probe = [
    "--import",
    "tsx",
    "--input-type=module",
    "--eval",
    `import { workerId } from ${JSON.stringify(moduleUrl)};
     console.log(JSON.stringify({ pid: process.pid, first: workerId, second: workerId }));`,
  ];
  const [firstResult, secondResult] = await Promise.all([
    execFileAsync(process.execPath, probe, { encoding: "utf8" }),
    execFileAsync(process.execPath, probe, { encoding: "utf8" }),
  ]);
  const first = JSON.parse(firstResult.stdout) as { pid: number; first: string; second: string };
  const second = JSON.parse(secondResult.stdout) as { pid: number; first: string; second: string };

  assert.notEqual(first.pid, second.pid);
  assert.equal(first.first, first.second);
  assert.equal(second.first, second.second);
  assert.notEqual(first.first, second.first);
  assert.match(first.first, new RegExp(`^metrics-ingest-${first.pid}-[0-9a-f-]{36}$`));
  assert.match(second.first, new RegExp(`^metrics-ingest-${second.pid}-[0-9a-f-]{36}$`));
});

test("ingest CLI preserves defaults and accepts documented options through the raised drain bound", () => {
  assert.equal(parseArgs([], {}).drainLimit, 1);

  const args = parseArgs([
    "--dry-run",
    "--entity", "schedules",
    "--page", "2",
    "--request-budget", "250",
    "--from", "2026-06-01",
    "--to", "2026-06-30",
    "--entity-id", "42",
    "--local-hour", "23",
    "--idempotency-suffix", "targeted-live-read",
    "--drain-limit", "1000",
  ], {});

  assert.deepEqual(args, {
    dryRun: true,
    entity: "schedules",
    page: 2,
    requestBudget: 250,
    startDate: "2026-06-01",
    endDate: "2026-06-30",
    entityId: 42,
    lookbackDays: undefined,
    localHour: 23,
    idempotencySuffix: "targeted-live-read",
    drainLimit: 1000,
  });
});

test("nested entity filters can drain existing queue rows without enqueueing a new detail job", () => {
  const drainOnly = parseArgs(["--entity", "quote_nested", "--drain-limit", "5"], {});
  assert.equal(shouldEnqueueIngestionJob(drainOnly), false);

  const targetedRefresh = parseArgs(["--entity", "quote_nested", "--entity-id", "2704"], {});
  assert.equal(shouldEnqueueIngestionJob(targetedRefresh), true);
});

test("ingest CLI rejects unknown arguments and options with missing values", () => {
  assert.throws(() => parseArgs(["--unknown"], {}), /Unknown argument --unknown/);

  for (const option of [
    "--entity",
    "--page",
    "--request-budget",
    "--start-date",
    "--end-date",
    "--entity-id",
    "--lookback-days",
    "--local-hour",
    "--idempotency-suffix",
    "--drain-limit",
  ]) {
    assert.throws(() => parseArgs([option], {}), new RegExp(`${option} requires a value`));
    assert.throws(() => parseArgs([option, "--dry-run"], {}), new RegExp(`${option} requires a value`));
  }
});

test("ingest CLI fails closed on invalid values and drain limits outside 1 through 1000", () => {
  const invalidCases: Array<{ argv: string[]; message: RegExp }> = [
    { argv: ["--entity", "not-an-entity"], message: /supported ingestion entity/ },
    { argv: ["--page", "1.5"], message: /--page must be an integer/ },
    { argv: ["--request-budget", "251"], message: /1 through 250/ },
    { argv: ["--start-date", "2026-02-30"], message: /valid calendar date/ },
    { argv: ["--from", "2026-07-02", "--to", "2026-07-01"], message: /must not be after/ },
    { argv: ["--entity-id", "0"], message: /--entity-id must be an integer/ },
    { argv: ["--entity", "invoices"], message: /supported ingestion entity/ },
    { argv: ["--invoice-type", "global"], message: /Unknown argument --invoice-type/ },
    { argv: ["--lookback-days", "NaN"], message: /--lookback-days must be an integer/ },
    { argv: ["--local-hour", "24"], message: /0 through 23/ },
    { argv: ["--idempotency-suffix", "   "], message: /requires a value/ },
    { argv: ["--drain-limit", "0"], message: /1 through 1000/ },
    { argv: ["--drain-limit", "1001"], message: /1 through 1000/ },
    { argv: ["--drain-limit", "4.5"], message: /1 through 1000/ },
    { argv: ["--drain-limit", "1e3"], message: /1 through 1000/ },
  ];

  for (const { argv, message } of invalidCases) {
    assert.throws(() => parseArgs(argv, {}), message);
  }

  assert.equal(parseArgs([], { INGEST_DRAIN_LIMIT: "1000" }).drainLimit, 1000);
  assert.throws(() => parseArgs([], { INGEST_DRAIN_LIMIT: "1001" }), /1 through 1000/);
  assert.throws(() => parseArgs([], { INGEST_DRY_RUN: "yes" }), /must be true or false/);
});

test("raising the drain bound does not change per-run runtime or request circuit breakers", () => {
  const worker = readFileSync(new URL("../../workers/ingest-simpro.ts", import.meta.url), "utf8");
  assert.match(worker, /Date\.now\(\) - startedAt < 19 \* 60_000/);
  assert.match(worker, /totalRequests < 1000/);
  assert.match(worker, /1000 - totalRequests/);
});
