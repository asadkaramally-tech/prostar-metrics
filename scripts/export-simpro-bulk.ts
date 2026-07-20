import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { BULK_JOB_COLUMNS, BULK_QUOTE_COLUMNS } from "@/lib/simpro/bulk-project-export";
import { SimproClient, sourceHash, type RequestBudget } from "@/lib/simpro/client";

const PAGE_SIZE = 250;
const START_DATE = "2023-01-01";

type SourceSpec = {
  family: "jobs" | "quotes";
  path: "/jobs/" | "/quotes/";
  query: Record<string, unknown>;
};

type PageManifest = {
  page: number;
  rowCount: number;
  firstId: number | null;
  lastId: number | null;
  responseHash: string;
  terminal: boolean;
};

async function main() {
  const outputDir = path.resolve(argumentValue("--output") ?? path.join(".work", "simpro-bulk-export"));
  const resumeExisting = process.argv.includes("--resume-existing");
  await mkdir(outputDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const client = new SimproClient();
  const budget: RequestBudget = { limit: 1000, used: 0 };
  const specs: SourceSpec[] = [
    {
      family: "jobs",
      path: "/jobs/",
      query: { search: "all", CompletedDate: `ge(${START_DATE})`, columns: BULK_JOB_COLUMNS, display: "all", orderby: "ID" },
    },
    {
      family: "quotes",
      path: "/quotes/",
      query: { search: "all", columns: BULK_QUOTE_COLUMNS, display: "all", orderby: "ID" },
    },
  ];

  const sources = [];
  for (const spec of specs) {
    const existingPath = path.join(outputDir, `${spec.family}.jsonl`);
    if (resumeExisting && await exists(existingPath)) {
      sources.push(await manifestExistingSource(existingPath, spec));
    } else {
      sources.push(await exportSource(client, budget, outputDir, spec));
    }
  }

  const manifest = {
    version: 1,
    source: "Simpro list endpoints with explicit columns and display=all",
    companyId: process.env.SIMPRO_COMPANY_ID || "0",
    startDate: START_DATE,
    timezone: "America/Los_Angeles",
    startedAt,
    completedAt: new Date().toISOString(),
    requestsUsed: budget.used,
    sources,
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(path.join(outputDir, "manifest.json"), manifestText, "utf8");
  await writeFile(
    path.join(outputDir, "manifest.sha256"),
    `${createHash("sha256").update(manifestText).digest("hex")}  manifest.json\n`,
    "utf8",
  );
  console.log(JSON.stringify({ outputDir, requestsUsed: budget.used, sources: sources.map(summary) }, null, 2));
}

async function manifestExistingSource(filePath: string, spec: SourceSpec) {
  const artifactHash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) artifactHash.update(chunk);

  const pages: PageManifest[] = [];
  const ids: number[] = [];
  const activityPeriodIds: Record<string, number[]> = {};
  const secondaryPeriodIds: Record<string, number[]> = {};
  const nestedCounts = { sections: 0, costCenters: 0, labor: 0, items: 0 };
  let pageRows: Record<string, unknown>[] = [];
  let previousId = 0;
  const input = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });

  for await (const line of input) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as Record<string, unknown>;
    const id = positiveId(row.ID, `${spec.family} ID`);
    if (id <= previousId) throw new Error(`${spec.family} existing artifact is not strictly ordered at ${id}`);
    previousId = id;
    ids.push(id);
    pageRows.push(row);
    recordPeriods(spec.family, row, id, activityPeriodIds, secondaryPeriodIds);
    countNested(row, nestedCounts);
    if (pageRows.length === PAGE_SIZE) {
      pages.push(existingPageManifest(pages.length + 1, pageRows, false));
      pageRows = [];
    }
  }
  if (pageRows.length > 0) pages.push(existingPageManifest(pages.length + 1, pageRows, true));
  else if (pages.length > 0) pages[pages.length - 1].terminal = true;
  if (ids.length === 0) throw new Error(`${spec.family} existing artifact is empty`);
  console.log(JSON.stringify({ family: spec.family, resumed: true, rows: ids.length, pages: pages.length }));
  return {
    family: spec.family,
    file: path.basename(filePath),
    sha256: artifactHash.digest("hex"),
    rowCount: ids.length,
    exactIds: ids,
    activityPeriodIds,
    secondaryPeriodIds,
    nestedCounts,
    query: spec.query,
    pageSize: PAGE_SIZE,
    pages,
  };
}

function existingPageManifest(page: number, rows: Record<string, unknown>[], terminal: boolean): PageManifest {
  return {
    page,
    rowCount: rows.length,
    firstId: positiveId(rows[0]?.ID, "page first ID"),
    lastId: positiveId(rows.at(-1)?.ID, "page last ID"),
    responseHash: sourceHash(rows),
    terminal,
  };
}

async function exists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function exportSource(
  client: SimproClient,
  budget: RequestBudget,
  outputDir: string,
  spec: SourceSpec,
) {
  const finalPath = path.join(outputDir, `${spec.family}.jsonl`);
  const partialPath = `${finalPath}.partial`;
  const output = createWriteStream(partialPath, { encoding: "utf8" });
  const artifactHash = createHash("sha256");
  const pages: PageManifest[] = [];
  const ids: number[] = [];
  const activityPeriodIds: Record<string, number[]> = {};
  const secondaryPeriodIds: Record<string, number[]> = {};
  const nestedCounts = { sections: 0, costCenters: 0, labor: 0, items: 0 };
  let pageNumber = 1;
  let previousId = 0;

  try {
    while (true) {
      const page = await client.getPage<Record<string, unknown>>(spec.path, {
        pageSize: PAGE_SIZE,
        startPage: pageNumber,
        requestBudget: budget,
        query: spec.query,
      });
      const pageIds: number[] = [];
      for (const row of page.rows) {
        const id = positiveId(row.ID, `${spec.family} ID`);
        if (id <= previousId) {
          throw new Error(`${spec.family} export is not strictly ordered: ${id} followed ${previousId}`);
        }
        previousId = id;
        ids.push(id);
        pageIds.push(id);
        recordPeriods(spec.family, row, id, activityPeriodIds, secondaryPeriodIds);
        countNested(row, nestedCounts);
        const line = `${JSON.stringify(row)}\n`;
        artifactHash.update(line);
        if (!output.write(line)) await once(output, "drain");
      }
      pages.push({
        page: pageNumber,
        rowCount: page.rows.length,
        firstId: pageIds[0] ?? null,
        lastId: pageIds.at(-1) ?? null,
        responseHash: sourceHash(page.rows),
        terminal: !page.hasMore,
      });
      console.log(JSON.stringify({ family: spec.family, page: pageNumber, rows: page.rows.length, totalRows: ids.length }));
      if (!page.hasMore) break;
      pageNumber += 1;
    }
  } finally {
    output.end();
    await once(output, "finish");
  }

  await rename(partialPath, finalPath);
  return {
    family: spec.family,
    file: path.basename(finalPath),
    sha256: artifactHash.digest("hex"),
    rowCount: ids.length,
    exactIds: ids,
    activityPeriodIds,
    secondaryPeriodIds,
    nestedCounts,
    query: spec.query,
    pageSize: PAGE_SIZE,
    pages,
  };
}

function recordPeriods(
  family: SourceSpec["family"],
  row: Record<string, unknown>,
  id: number,
  activity: Record<string, number[]>,
  secondary: Record<string, number[]>,
) {
  if (family === "jobs") {
    addPeriodId(activity, row.CompletedDate, id);
    return;
  }
  addPeriodId(activity, row.DateApproved, id);
  addPeriodId(secondary, row.DateIssued, id);
}

function addPeriodId(target: Record<string, number[]>, value: unknown, id: number) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value)) return;
  const period = `${value.slice(0, 7)}-01`;
  (target[period] ??= []).push(id);
}

function countNested(row: Record<string, unknown>, counts: { sections: number; costCenters: number; labor: number; items: number }) {
  for (const section of records(row.Sections)) {
    counts.sections += 1;
    for (const costCenter of records(section.CostCenters)) {
      counts.costCenters += 1;
      const items = record(costCenter.Items) ?? costCenter;
      counts.labor += records(items.Labors).length;
      counts.items += ["Catalogs", "Prebuilds", "ServiceFees", "OneOffs", "Stock"]
        .reduce((sum, key) => sum + records(items[key]).length, 0);
    }
  }
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => record(item) !== null) : [];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function positiveId(value: unknown, label: string) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`${label} must be a positive integer`);
  return id;
}

function argumentValue(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function summary(source: Awaited<ReturnType<typeof exportSource>>) {
  return {
    family: source.family,
    rowCount: source.rowCount,
    pages: source.pages.length,
    sha256: source.sha256,
    nestedCounts: source.nestedCounts,
  };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
