import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
  coerceRows,
  SimproClient,
  sourceHash,
  type RequestBudget,
} from "@/lib/simpro/client";

export const OPERATIONAL_EXPORT_START_DATE = "2023-01-01";
export const OPERATIONAL_EXPORT_TIMEZONE = "America/Los_Angeles";
export const OPERATIONAL_EXPORT_PAGE_SIZE = 250;
export const OPERATIONAL_EMPLOYEE_COLUMNS =
  "ID,Name,Position,PrimaryContact,DateCreated,DateModified,Archived";

const DEFAULT_REQUEST_BUDGET = 1000;
const EXPECTED_FILES = [
  "employees.jsonl",
  "timesheets.jsonl",
  "schedules.jsonl",
  "mobile_status.jsonl",
] as const;

type Identity = number | string;
type JsonRecord = Record<string, unknown>;
type ExportClient = Pick<SimproClient, "getJson" | "getPage">;

export type PageEvidence = {
  page: number;
  rowCount: number;
  exactIds: Identity[];
  firstId: Identity | null;
  lastId: Identity | null;
  responseHash: string;
  requestCount: number;
  terminal: boolean;
};

export type EmployeeTargetEvidence = {
  key: "active" | "archived";
  path: "/employees/";
  required: true;
  complete: true;
  pagination: "paged";
  pageSize: number;
  query: JsonRecord;
  requestCount: number;
  responseRowCount: number;
  exactIds: number[];
  pages: PageEvidence[];
};

export type TimesheetTargetEvidence = {
  key: string;
  employeeId: number;
  path: string;
  required: true;
  complete: true;
  pagination: "unpaged";
  query: JsonRecord;
  requestCount: number;
  rowCount: number;
  exactIds: string[];
  responseHash: string;
  empty: boolean;
};

export type EmployeesSourceManifest = ArtifactManifest & {
  family: "employees";
  exactIds: number[];
  responseRowCount: number;
  deduplicatedRowCount: number;
  duplicateIds: number[];
  targets: EmployeeTargetEvidence[];
};

export type TimesheetsSourceManifest = ArtifactManifest & {
  family: "timesheets";
  exactIds: string[];
  query: JsonRecord;
  targetCount: number;
  completedTargetCount: number;
  perMonthIds: Record<string, string[]>;
  perEmployeeCounts: Record<string, number>;
  targets: TimesheetTargetEvidence[];
};

export type PagedSourceManifest = ArtifactManifest & {
  family: "schedules" | "mobile_status";
  path: string;
  required: true;
  complete: true;
  pagination: "paged";
  pageSize: number;
  query: JsonRecord;
  exactIds: number[];
  pages: PageEvidence[];
};

export type OperationalSourceManifest =
  | EmployeesSourceManifest
  | TimesheetsSourceManifest
  | PagedSourceManifest;

export type OperationalBulkManifest = {
  version: 1;
  source: string;
  companyId: string;
  startDate: string;
  asOfDate: string;
  timezone: string;
  startedAt: string;
  completedAt: string;
  requestsUsed: number;
  sources: OperationalSourceManifest[];
};

type ArtifactManifest = {
  file: string;
  sha256: string;
  rowCount: number;
  requestCount: number;
};

export type OperationalBulkExportOptions = {
  outputDir: string;
  client: ExportClient;
  companyId?: string;
  now?: Date;
  requestBudgetLimit?: number;
  resumeExisting?: boolean;
  log?: (event: JsonRecord) => void;
};

type PagedSpec = {
  family: PagedSourceManifest["family"];
  file: (typeof EXPECTED_FILES)[number];
  path: string;
  query: JsonRecord;
};

export async function runOperationalBulkExport(
  options: OperationalBulkExportOptions,
): Promise<OperationalBulkManifest> {
  const outputDir = path.resolve(options.outputDir);
  const now = options.now ?? new Date();
  const asOfDate = pacificDate(now);
  const companyId = options.companyId ?? process.env.SIMPRO_COMPANY_ID ?? "0";
  const budgetLimit = positiveInteger(options.requestBudgetLimit ?? DEFAULT_REQUEST_BUDGET, "request budget");
  const log = options.log ?? ((event: JsonRecord) => console.log(JSON.stringify(event)));

  await mkdir(outputDir, { recursive: true });
  if (options.resumeExisting) {
    const existing = await loadCompletedExport(outputDir, asOfDate, companyId);
    if (existing) {
      log({ event: "operational-export-resumed", outputDir, requestCount: 0 });
      return existing;
    }
  }

  const startedAt = now.toISOString();
  const budget: RequestBudget = { limit: budgetLimit, used: 0 };
  const employees = await exportEmployees(options.client, budget, outputDir, log);
  const timesheets = await exportTimesheets(
    options.client,
    budget,
    outputDir,
    employees.exactIds,
    asOfDate,
    log,
  );
  const pagedSpecs: PagedSpec[] = [
    {
      family: "schedules",
      file: "schedules.jsonl",
      path: "/schedules/",
      query: { orderby: "ID", display: "all" },
    },
    {
      family: "mobile_status",
      file: "mobile_status.jsonl",
      path: "/logs/mobileStatus/",
      query: { orderby: "ID" },
    },
  ];
  const pagedSources: PagedSourceManifest[] = [];
  for (const spec of pagedSpecs) {
    pagedSources.push(await exportPagedSource(options.client, budget, outputDir, spec, log));
  }
  const manifest: OperationalBulkManifest = {
    version: 1,
    source: "Simpro operational GET endpoints with checksum and traversal evidence",
    companyId,
    startDate: OPERATIONAL_EXPORT_START_DATE,
    asOfDate,
    timezone: OPERATIONAL_EXPORT_TIMEZONE,
    startedAt,
    completedAt: new Date().toISOString(),
    requestsUsed: budget.used,
    sources: [employees, timesheets, ...pagedSources],
  };
  await writeManifest(outputDir, manifest);
  log({
    event: "operational-export-complete",
    outputDir,
    requestCount: budget.used,
    sources: manifest.sources.map((source) => ({ family: source.family, rowCount: source.rowCount })),
  });
  return manifest;
}

async function exportEmployees(
  client: ExportClient,
  budget: RequestBudget,
  outputDir: string,
  log: (event: JsonRecord) => void,
): Promise<EmployeesSourceManifest> {
  const seenIds = new Set<number>();
  const duplicateIds = new Set<number>();
  const exactIds: number[] = [];
  const targets: EmployeeTargetEvidence[] = [];
  let responseRowCount = 0;
  const requestStart = budget.used;
  const artifact = await streamJsonl(path.join(outputDir, "employees.jsonl"), async (write) => {
    for (const archived of [false, true]) {
      const key = archived ? "archived" : "active";
      const query = {
        Archived: archived,
        display: "all",
        columns: OPERATIONAL_EMPLOYEE_COLUMNS,
        orderby: "ID",
      };
      const pages: PageEvidence[] = [];
      const targetIds: number[] = [];
      const targetSeen = new Set<number>();
      const targetRequestStart = budget.used;
      let targetResponseRows = 0;
      let pageNumber = 1;
      let previousId = 0;

      while (true) {
        const pageRequestStart = budget.used;
        const page = await client.getPage<JsonRecord>("/employees/", {
          pageSize: OPERATIONAL_EXPORT_PAGE_SIZE,
          startPage: pageNumber,
          requestBudget: budget,
          query,
        });
        const pageIds: number[] = [];
        for (const row of page.rows) {
          const id = positiveId(row.ID, `${key} employee ID`);
          if (id < previousId) {
            throw new Error(`${key} employees are not ordered by ID: ${id} followed ${previousId}`);
          }
          previousId = id;
          pageIds.push(id);
          targetResponseRows += 1;
          responseRowCount += 1;
          if (!targetSeen.has(id)) {
            targetSeen.add(id);
            targetIds.push(id);
          }
          if (seenIds.has(id)) {
            duplicateIds.add(id);
            continue;
          }
          seenIds.add(id);
          exactIds.push(id);
          await write(row);
        }
        pages.push(pageEvidence(pageNumber, page.rows, pageIds, budget.used - pageRequestStart, !page.hasMore));
        log({ family: "employees", target: key, page: pageNumber, rows: page.rows.length });
        if (!page.hasMore) break;
        pageNumber += 1;
      }
      targets.push({
        key,
        path: "/employees/",
        required: true,
        complete: true,
        pagination: "paged",
        pageSize: OPERATIONAL_EXPORT_PAGE_SIZE,
        query,
        requestCount: budget.used - targetRequestStart,
        responseRowCount: targetResponseRows,
        exactIds: targetIds,
        pages,
      });
    }
  });

  return {
    family: "employees",
    ...artifact,
    rowCount: exactIds.length,
    exactIds,
    responseRowCount,
    deduplicatedRowCount: responseRowCount - exactIds.length,
    duplicateIds: [...duplicateIds].sort((a, b) => a - b),
    requestCount: budget.used - requestStart,
    targets,
  };
}

async function exportTimesheets(
  client: ExportClient,
  budget: RequestBudget,
  outputDir: string,
  employeeIds: number[],
  asOfDate: string,
  log: (event: JsonRecord) => void,
): Promise<TimesheetsSourceManifest> {
  const query = { StartDate: OPERATIONAL_EXPORT_START_DATE, EndDate: asOfDate };
  const exactIds: string[] = [];
  const seenIds = new Set<string>();
  const perMonthIds: Record<string, string[]> = {};
  const perEmployeeCounts: Record<string, number> = {};
  const targets: TimesheetTargetEvidence[] = [];
  const requestStart = budget.used;
  const artifact = await streamJsonl(path.join(outputDir, "timesheets.jsonl"), async (write) => {
    for (const employeeId of employeeIds) {
      const targetPath = `/employees/${encodeURIComponent(String(employeeId))}/timesheets/`;
      const targetRequestStart = budget.used;
      const response = await client.getJson<unknown>(targetPath, query, budget);
      const rows = coerceRows<JsonRecord>(response);
      const targetIds: string[] = [];

      for (const row of rows) {
        const uid = requiredUid(row.UID, employeeId);
        const identity = `${employeeId}:${uid}`;
        if (seenIds.has(identity)) {
          throw new Error(`Duplicate timesheet identity ${identity}`);
        }
        seenIds.add(identity);
        exactIds.push(identity);
        targetIds.push(identity);

        const date = requiredDate(row.Date, identity);
        if (date < OPERATIONAL_EXPORT_START_DATE || date > asOfDate) {
          throw new Error(`Timesheet ${identity} Date ${date} is outside the requested export window`);
        }
        const month = `${date.slice(0, 7)}-01`;
        (perMonthIds[month] ??= []).push(identity);
        await write({ ...row, EmployeeID: employeeId });
      }

      perEmployeeCounts[String(employeeId)] = rows.length;
      targets.push({
        key: `employee:${employeeId}`,
        employeeId,
        path: targetPath,
        required: true,
        complete: true,
        pagination: "unpaged",
        query: { ...query },
        requestCount: budget.used - targetRequestStart,
        rowCount: rows.length,
        exactIds: targetIds,
        responseHash: sourceHash(rows),
        empty: rows.length === 0,
      });
      log({ family: "timesheets", employeeId, rows: rows.length });
    }
  });

  return {
    family: "timesheets",
    ...artifact,
    rowCount: exactIds.length,
    exactIds,
    query,
    targetCount: employeeIds.length,
    completedTargetCount: targets.length,
    perMonthIds: sortRecord(perMonthIds),
    perEmployeeCounts: sortRecord(perEmployeeCounts),
    requestCount: budget.used - requestStart,
    targets,
  };
}

async function exportPagedSource(
  client: ExportClient,
  budget: RequestBudget,
  outputDir: string,
  spec: PagedSpec,
  log: (event: JsonRecord) => void,
): Promise<PagedSourceManifest> {
  const exactIds: number[] = [];
  const seenIds = new Set<number>();
  const pages: PageEvidence[] = [];
  const requestStart = budget.used;
  let pageNumber = 1;
  let previousId = 0;
  const artifact = await streamJsonl(path.join(outputDir, spec.file), async (write) => {
    while (true) {
      const pageRequestStart = budget.used;
      const page = await client.getPage<JsonRecord>(spec.path, {
        pageSize: OPERATIONAL_EXPORT_PAGE_SIZE,
        startPage: pageNumber,
        requestBudget: budget,
        query: spec.query,
      });
      const pageIds: number[] = [];
      for (const row of page.rows) {
        const id = positiveId(row.ID, `${spec.family} ID`);
        if (id <= previousId) {
          throw new Error(`${spec.family} is not strictly ordered by ID: ${id} followed ${previousId}`);
        }
        if (seenIds.has(id)) throw new Error(`Duplicate ${spec.family} ID ${id}`);
        previousId = id;
        seenIds.add(id);
        exactIds.push(id);
        pageIds.push(id);
        await write(row);
      }
      pages.push(pageEvidence(pageNumber, page.rows, pageIds, budget.used - pageRequestStart, !page.hasMore));
      log({ family: spec.family, page: pageNumber, rows: page.rows.length });
      if (!page.hasMore) break;
      pageNumber += 1;
    }
  });

  return {
    family: spec.family,
    ...artifact,
    rowCount: exactIds.length,
    exactIds,
    path: spec.path,
    required: true,
    complete: true,
    pagination: "paged",
    pageSize: OPERATIONAL_EXPORT_PAGE_SIZE,
    query: spec.query,
    requestCount: budget.used - requestStart,
    pages,
  };
}

function pageEvidence(
  page: number,
  rows: JsonRecord[],
  exactIds: Identity[],
  requestCount: number,
  terminal: boolean,
): PageEvidence {
  return {
    page,
    rowCount: rows.length,
    exactIds,
    firstId: exactIds[0] ?? null,
    lastId: exactIds.at(-1) ?? null,
    responseHash: sourceHash(rows),
    requestCount,
    terminal,
  };
}

async function streamJsonl(
  finalPath: string,
  produce: (write: (row: JsonRecord) => Promise<void>) => Promise<void>,
): Promise<Pick<ArtifactManifest, "file" | "sha256">> {
  const partialPath = `${finalPath}.partial`;
  const output = createWriteStream(partialPath, { encoding: "utf8", flags: "w" });
  const hash = createHash("sha256");

  try {
    await produce(async (row) => {
      const line = `${JSON.stringify(row)}\n`;
      hash.update(line);
      if (!output.write(line)) await once(output, "drain");
    });
    output.end();
    await finished(output);
    await rename(partialPath, finalPath);
  } catch (error) {
    output.destroy();
    await finished(output).catch(() => undefined);
    throw error;
  }

  return { file: path.basename(finalPath), sha256: hash.digest("hex") };
}

async function writeManifest(outputDir: string, manifest: OperationalBulkManifest): Promise<void> {
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const checksumText = `${sha256(manifestText)}  manifest.json\n`;
  const manifestPath = path.join(outputDir, "manifest.json");
  const checksumPath = path.join(outputDir, "manifest.sha256");
  const manifestPartial = `${manifestPath}.partial`;
  const checksumPartial = `${checksumPath}.partial`;

  await writeFile(manifestPartial, manifestText, "utf8");
  await writeFile(checksumPartial, checksumText, "utf8");
  await rename(checksumPartial, checksumPath);
  await rename(manifestPartial, manifestPath);
}

async function loadCompletedExport(
  outputDir: string,
  asOfDate: string,
  companyId: string,
): Promise<OperationalBulkManifest | null> {
  const manifestPath = path.join(outputDir, "manifest.json");
  const checksumPath = path.join(outputDir, "manifest.sha256");
  const hasManifest = await exists(manifestPath);
  const hasChecksum = await exists(checksumPath);
  if (!hasManifest && !hasChecksum) return null;
  if (!hasManifest || !hasChecksum) throw new Error("Existing operational export is incomplete");

  const [manifestText, checksumText] = await Promise.all([
    readFile(manifestPath, "utf8"),
    readFile(checksumPath, "utf8"),
  ]);
  const checksumMatch = /^([a-f0-9]{64})  manifest\.json\n?$/.exec(checksumText);
  if (!checksumMatch || checksumMatch[1] !== sha256(manifestText)) {
    throw new Error("Existing operational manifest checksum mismatch");
  }
  const value: unknown = JSON.parse(manifestText);
  if (!isOperationalManifest(value)) throw new Error("Existing operational manifest has an invalid contract");
  if (value.asOfDate !== asOfDate) {
    throw new Error(`Existing operational export as-of date ${value.asOfDate} does not match ${asOfDate}`);
  }
  if (value.companyId !== companyId) {
    throw new Error(`Existing operational export company ${value.companyId} does not match ${companyId}`);
  }

  for (const expectedFile of EXPECTED_FILES) {
    const source = value.sources.find((item) => item.file === expectedFile);
    if (!source) throw new Error(`Existing operational manifest is missing ${expectedFile}`);
    const artifactPath = path.join(outputDir, expectedFile);
    if (!await exists(artifactPath) || await hashFile(artifactPath) !== source.sha256) {
      throw new Error(`Existing operational artifact checksum mismatch: ${expectedFile}`);
    }
  }
  return value;
}

function isOperationalManifest(value: unknown): value is OperationalBulkManifest {
  if (!isRecord(value)) return false;
  if (
    value.version !== 1
    || value.startDate !== OPERATIONAL_EXPORT_START_DATE
    || value.timezone !== OPERATIONAL_EXPORT_TIMEZONE
    || !Array.isArray(value.sources)
  ) return false;
  return value.sources.every((source) => (
    isRecord(source)
    && typeof source.file === "string"
    && typeof source.sha256 === "string"
    && /^[a-f0-9]{64}$/.test(source.sha256)
  ));
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function pacificDate(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new Error("Cannot determine Pacific date from an invalid date");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: OPERATIONAL_EXPORT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
  const year = part("year");
  const month = part("month");
  const day = part("day");
  if (!year || !month || !day) throw new Error("Unable to determine current Pacific date");
  return `${year}-${month}-${day}`;
}

function requiredUid(value: unknown, employeeId: number): string {
  if ((typeof value !== "string" && typeof value !== "number") || !String(value).trim()) {
    throw new Error(`Timesheet for employee ${employeeId} is missing UID`);
  }
  return String(value);
}

function requiredDate(value: unknown, identity: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Timesheet ${identity} is missing a YYYY-MM-DD Date`);
  }
  return value;
}

function positiveId(value: unknown, label: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`${label} must be a positive safe integer`);
  return id;
}

function positiveInteger(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer`);
  return number;
}

function sortRecord<T>(value: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const outputDir = path.resolve(
    argumentValue("--output") ?? path.join(".work", "simpro-operational-bulk-export"),
  );
  const requestBudget = argumentValue("--request-budget");
  await runOperationalBulkExport({
    outputDir,
    client: new SimproClient(),
    companyId: process.env.SIMPRO_COMPANY_ID ?? "0",
    requestBudgetLimit: requestBudget === undefined
      ? DEFAULT_REQUEST_BUDGET
      : positiveInteger(requestBudget, "--request-budget"),
    resumeExisting: process.argv.includes("--resume-existing"),
  });
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entryPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
