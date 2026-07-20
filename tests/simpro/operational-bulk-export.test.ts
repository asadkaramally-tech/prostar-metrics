import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  OPERATIONAL_EMPLOYEE_COLUMNS,
  pacificDate,
  runOperationalBulkExport,
  type EmployeesSourceManifest,
  type TimesheetsSourceManifest,
} from "../../scripts/export-simpro-operational-bulk";
import { SimproClient, sourceHash } from "../../src/lib/simpro/client";
import { loadSimproConfig } from "../../src/lib/simpro/config";

type RecordedRequest = {
  method: string;
  path: string;
  query: Record<string, string>;
};

test("Pacific as-of date remains on the local business date at UTC midnight", () => {
  assert.equal(pacificDate(new Date("2026-07-10T01:00:00.000Z")), "2026-07-09");
  assert.equal(pacificDate(new Date("2026-11-02T07:30:00.000Z")), "2026-11-01");
});

test("operational export traverses GET-only sources and manifests exact streaming evidence", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "simpro-operational-export-"));
  const requests: RecordedRequest[] = [];
  const logs: Record<string, unknown>[] = [];
  const responses = (url: URL): unknown => {
    const suffix = url.pathname.replace("/api/v1.0/companies/7", "");
    if (suffix === "/employees/") {
      return url.searchParams.get("Archived") === "true"
        ? [employee(2, true, "duplicate archived"), employee(3, true, "Archived Tech")]
        : [employee(1, false, "Active Tech"), employee(2, false, "Office")];
    }
    if (suffix === "/employees/1/timesheets/") {
      return [
        timesheet("a", "2023-01-05"),
        timesheet("b", "2026-07-09"),
      ];
    }
    if (suffix === "/employees/2/timesheets/") return [];
    if (suffix === "/employees/3/timesheets/") return [timesheet("c", "2026-06-30")];
    if (suffix === "/schedules/") return [{ ID: 10, Date: "2026-07-09", TotalHours: 4 }];
    if (suffix === "/logs/mobileStatus/") return [{ ID: 20, DateLogged: "2026-07-09T12:00:00-07:00" }];
    throw new Error(`Unexpected request ${suffix}`);
  };
  const client = testClient(requests, responses);

  try {
    const manifest = await runOperationalBulkExport({
      outputDir: directory,
      client,
      companyId: "7",
      now: new Date("2026-07-10T01:00:00.000Z"),
      log: (event) => logs.push(event),
    });

    assert.equal(manifest.version, 1);
    assert.equal(manifest.startDate, "2023-01-01");
    assert.equal(manifest.asOfDate, "2026-07-09");
    assert.equal(manifest.timezone, "America/Los_Angeles");
    assert.equal(manifest.requestsUsed, 7);
    assert.equal(manifest.sources.length, 4);
    assert.ok(manifest.startedAt);
    assert.ok(manifest.completedAt);

    assert.equal(requests.length, 7);
    assert.ok(requests.every((request) => request.method === "GET"));
    const activeRequest = requests.find((request) => request.path.endsWith("/employees/") && request.query.Archived === "false");
    assert.deepEqual(activeRequest?.query, {
      Archived: "false",
      display: "all",
      columns: OPERATIONAL_EMPLOYEE_COLUMNS,
      orderby: "ID",
      page: "1",
      pageSize: "250",
    });
    const archivedRequest = requests.find((request) => request.path.endsWith("/employees/") && request.query.Archived === "true");
    assert.ok(archivedRequest);
    const timesheetRequests = requests.filter((request) => request.path.includes("/timesheets/"));
    assert.equal(timesheetRequests.length, 3);
    for (const request of timesheetRequests) {
      assert.deepEqual(request.query, { StartDate: "2023-01-01", EndDate: "2026-07-09" });
    }
    assert.deepEqual(
      requests.find((request) => request.path.endsWith("/schedules/"))?.query,
      { orderby: "ID", display: "all", page: "1", pageSize: "250" },
    );
    assert.deepEqual(
      requests.find((request) => request.path.endsWith("/logs/mobileStatus/"))?.query,
      { orderby: "ID", page: "1", pageSize: "250" },
    );
    assert.ok(requests.every((request) => !/invoice/i.test(request.path)));

    const employeeSource = source<EmployeesSourceManifest>(manifest.sources, "employees");
    assert.deepEqual(employeeSource.exactIds, [1, 2, 3]);
    assert.equal(employeeSource.rowCount, 3);
    assert.equal(employeeSource.responseRowCount, 4);
    assert.equal(employeeSource.deduplicatedRowCount, 1);
    assert.deepEqual(employeeSource.duplicateIds, [2]);
    assert.deepEqual(employeeSource.targets.map((target) => target.key), ["active", "archived"]);
    assert.ok(employeeSource.targets.every((target) => target.complete && target.pages.at(-1)?.terminal));

    const timesheetSource = source<TimesheetsSourceManifest>(manifest.sources, "timesheets");
    assert.deepEqual(timesheetSource.exactIds, ["1:a", "1:b", "3:c"]);
    assert.deepEqual(timesheetSource.perMonthIds, {
      "2023-01-01": ["1:a"],
      "2026-06-01": ["3:c"],
      "2026-07-01": ["1:b"],
    });
    assert.deepEqual(timesheetSource.perEmployeeCounts, { "1": 2, "2": 0, "3": 1 });
    assert.equal(timesheetSource.targetCount, 3);
    assert.equal(timesheetSource.completedTargetCount, 3);
    const emptyTarget = timesheetSource.targets.find((target) => target.employeeId === 2);
    assert.deepEqual(
      emptyTarget && {
        required: emptyTarget.required,
        complete: emptyTarget.complete,
        empty: emptyTarget.empty,
        rowCount: emptyTarget.rowCount,
        exactIds: emptyTarget.exactIds,
        responseHash: emptyTarget.responseHash,
      },
      {
        required: true,
        complete: true,
        empty: true,
        rowCount: 0,
        exactIds: [],
        responseHash: sourceHash([]),
      },
    );

    const timesheetRows = await jsonl(path.join(directory, "timesheets.jsonl"));
    assert.deepEqual(timesheetRows.map((row) => [row.EmployeeID, row.UID]), [[1, "a"], [1, "b"], [3, "c"]]);

    const manifestText = await readFile(path.join(directory, "manifest.json"), "utf8");
    const manifestChecksum = await readFile(path.join(directory, "manifest.sha256"), "utf8");
    assert.equal(manifestChecksum, `${sha256(manifestText)}  manifest.json\n`);
    for (const item of manifest.sources) {
      assert.equal(item.sha256, sha256(await readFile(path.join(directory, item.file), "utf8")));
    }
    assert.ok((await readdir(directory)).every((file) => !file.endsWith(".partial")));
    assert.doesNotMatch(JSON.stringify(logs), /test-secret-token/);

    const resumed = await runOperationalBulkExport({
      outputDir: directory,
      client: testClient([], () => { throw new Error("resume made an HTTP request"); }),
      companyId: "7",
      now: new Date("2026-07-10T01:00:00.000Z"),
      resumeExisting: true,
      log: () => {},
    });
    assert.deepEqual(resumed, manifest);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed exact-identity validation leaves the timesheet artifact partial", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "simpro-operational-partial-"));
  const responses = (url: URL): unknown => {
    const suffix = url.pathname.replace("/api/v1.0/companies/7", "");
    if (suffix === "/employees/") {
      return url.searchParams.get("Archived") === "true" ? [] : [employee(1, false, "Active Tech")];
    }
    if (suffix === "/employees/1/timesheets/") {
      return [timesheet("duplicate", "2026-07-08"), timesheet("duplicate", "2026-07-09")];
    }
    throw new Error(`Unexpected request ${suffix}`);
  };

  try {
    await assert.rejects(
      runOperationalBulkExport({
        outputDir: directory,
        client: testClient([], responses),
        companyId: "7",
        now: new Date("2026-07-10T01:00:00.000Z"),
        log: () => {},
      }),
      /Duplicate timesheet identity 1:duplicate/,
    );
    const files = await readdir(directory);
    assert.ok(files.includes("employees.jsonl"));
    assert.ok(files.includes("timesheets.jsonl.partial"));
    assert.ok(!files.includes("timesheets.jsonl"));
    assert.ok(!files.includes("manifest.json"));
    assert.ok(!files.includes("manifest.sha256"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function testClient(requests: RecordedRequest[], responseFor: (url: URL) => unknown): SimproClient {
  return new SimproClient(
    loadSimproConfig({
      SIMPRO_BASE_URL: "https://example.invalid/api/v1.0",
      SIMPRO_COMPANY_ID: "7",
      SIMPRO_BEARER_TOKEN: "test-secret-token",
    }),
    {
      localLimiter: { wait: async () => {} },
      distributedLimiter: { wait: async () => {} },
      sleepImpl: async () => {},
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        requests.push({
          method: String(init?.method ?? "GET"),
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
        });
        return new Response(JSON.stringify(responseFor(url)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  );
}

function employee(id: number, archived: boolean, name: string) {
  return {
    ID: id,
    Name: name,
    Position: archived ? "Archived" : "Technician",
    PrimaryContact: { Email: `${id}@example.com` },
    DateCreated: "2023-01-01T00:00:00Z",
    DateModified: "2026-07-09T00:00:00Z",
    Archived: archived,
  };
}

function timesheet(uid: string, date: string) {
  return { UID: uid, Date: date, StartTime: "08:00", EndTime: "09:00", TotalHrs: 1 };
}

function source<T>(sources: Array<{ family: string }>, family: string): T {
  const value = sources.find((item) => item.family === family);
  assert.ok(value, `Missing ${family} source`);
  return value as T;
}

async function jsonl(filePath: string): Promise<Record<string, unknown>[]> {
  return (await readFile(filePath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
