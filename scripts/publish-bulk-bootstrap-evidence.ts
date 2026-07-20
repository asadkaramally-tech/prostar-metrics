import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { BACKFILL_START_MONTH, businessCurrentMonth, type BackfillSourceFamily } from "@/lib/backfill/plan";
import { flattenBulkProjectPage } from "@/lib/simpro/bulk-project-export";
import {
  flattenBulkEmployees,
  flattenBulkMobileStatus,
  flattenBulkSchedules,
  flattenBulkTimesheets,
} from "@/lib/simpro/bulk-operational-export";
import {
  bulkEvidencePageSha256,
  bulkEvidenceRequestSha256,
  publishVerifiedBulkBootstrapEvidence,
  type BulkBootstrapEvidenceUnit,
} from "@/lib/store/bulk-bootstrap-evidence";
import { compareExactSourceIds } from "@/lib/store/exact-source-identities";
import { verifyBulkArtifact } from "@/lib/store/bulk-project-bootstrap";
import { verifyOperationalBulkArtifact } from "@/lib/store/bulk-operational-bootstrap";
import { buildPostgresSslConfig } from "@/lib/store/postgres";

type Bucket = { ids: Set<string>; value: number };
type FamilyBuckets = Map<string, Bucket>;

export const REQUIRED_BULK_EVIDENCE_FAMILIES: readonly BackfillSourceFamily[] = [
  "quotes",
  "quote_nested",
  "jobs",
  "job_nested",
  "employees",
  "timesheets",
  "jobs_from_timesheets",
  "schedules",
];
const OPTIONAL_FAMILIES: BackfillSourceFamily[] = ["mobile_status"];
export const BULK_EVIDENCE_FAMILIES: readonly BackfillSourceFamily[] = [
  ...REQUIRED_BULK_EVIDENCE_FAMILIES,
  ...OPTIONAL_FAMILIES,
];

async function main() {
  const projectDirectory = path.resolve(
    argumentValue("--project-input") ?? path.join(".work", "simpro-bulk-export-20260710"),
  );
  const operationalDirectory = path.resolve(
    argumentValue("--operational-input") ?? path.join(".work", "simpro-operational-export-20260710"),
  );
  const [project, operational] = await Promise.all([
    verifyBulkArtifact(projectDirectory),
    verifyOperationalBulkArtifact(operationalDirectory),
  ]);
  const families = resolveBulkEvidenceFamilies(process.argv.slice(2));
  const units = await buildEvidenceUnits(project, operational, families);
  const summary = {
    mode: process.argv.includes("--execute") ? "execute" : "verified-dry-run",
    projectManifestSha256: project.manifestSha256,
    projectFinancialCoverage: project.financialCoverage,
    operationalManifestSha256: operational.manifestSha256,
    compositeManifestSha256: units[0]?.manifestSha256,
    unitCount: units.length,
    requiredUnitCount: units.filter((unit) => REQUIRED_BULK_EVIDENCE_FAMILIES.includes(unit.sourceFamily)).length,
    optionalUnitCount: units.filter((unit) => OPTIONAL_FAMILIES.includes(unit.sourceFamily)).length,
    families: Object.fromEntries(families.map((family) => [family, units.filter((unit) => unit.sourceFamily === family).length])),
  };
  if (!process.argv.includes("--execute")) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const connectionString = process.env.AZURE_POSTGRES_CONNECTION_STRING;
  if (!connectionString) throw new Error("AZURE_POSTGRES_CONNECTION_STRING is required with --execute");
  const client = new pg.Client({ connectionString, ssl: buildPostgresSslConfig() });
  await client.connect();
  try {
    const result = await publishVerifiedBulkBootstrapEvidence(units, client);
    console.log(JSON.stringify({ ...summary, result }, null, 2));
  } finally {
    await client.end();
  }
}

export function resolveBulkEvidenceFamilies(argv: readonly string[]): BackfillSourceFamily[] {
  const requiredOnly = argv.includes("--required-only");
  const optionalOnly = argv.includes("--optional-only");
  if (requiredOnly && optionalOnly) {
    throw new Error("--required-only and --optional-only cannot be combined.");
  }
  if (requiredOnly) return [...REQUIRED_BULK_EVIDENCE_FAMILIES];
  if (optionalOnly) return [...OPTIONAL_FAMILIES];
  return [...REQUIRED_BULK_EVIDENCE_FAMILIES, ...OPTIONAL_FAMILIES];
}

export async function buildEvidenceUnits(
  project: Awaited<ReturnType<typeof verifyBulkArtifact>>,
  operational: Awaited<ReturnType<typeof verifyOperationalBulkArtifact>>,
  families: BackfillSourceFamily[],
) {
  const currentMonth = businessCurrentMonth();
  const months = monthStarts(BACKFILL_START_MONTH, currentMonth);
  const evidenceAsOf = new Date(Math.max(
    Date.parse(project.manifest.completedAt),
    Date.parse(operational.manifest.completedAt),
  )).toISOString();
  const compositeManifestSha256 = compositeBulkManifestSha256(
    project.manifestSha256,
    operational.manifestSha256,
  );
  const buckets = new Map<BackfillSourceFamily, FamilyBuckets>();
  for (const family of families) buckets.set(family, new Map());

  const jobSource = project.sources.jobs;
  const quoteSource = project.sources.quotes;
  const jobValues = new Map<string, number>();
  for (const payload of jobSource.rows) {
    const fact = flattenBulkProjectPage("job", [payload], project.manifest.completedAt).projects[0]!;
    jobValues.set(String(fact.projectId), fact.totalExTax);
  }
  for (const month of months) {
    const ids = (jobSource.activityPeriodIds[month] ?? []).map(String);
    put(buckets, "jobs", month, ids, sumValues(ids, jobValues));
    put(buckets, "job_nested", month, ids, ids.length);
  }
  const activeJobIds = new Set(jobSource.exactIds.map(String));

  const quoteValues = new Map<string, number>();
  for (const payload of quoteSource.rows) {
    const fact = flattenBulkProjectPage("quote", [payload], project.manifest.completedAt).projects[0]!;
    quoteValues.set(String(fact.projectId), fact.totalExTax);
  }
  for (const month of months) {
    const ids = month === currentMonth
      ? quoteSource.exactIds.map(String)
      : unionIds(quoteSource.activityPeriodIds[month] ?? [], quoteSource.secondaryPeriodIds[month] ?? []);
    put(buckets, "quotes", month, ids, sumValues(ids, quoteValues));
    put(buckets, "quote_nested", month, ids, ids.length);
  }

  const employeeSource = operational.sources.employees;
  const employeeIds: string[] = [];
  for (const payload of employeeSource.rows) {
    employeeIds.push(String(flattenBulkEmployees([payload], operational.manifest.completedAt)[0]!.employeeId));
  }
  for (const month of months) put(buckets, "employees", month, employeeIds, employeeIds.length);

  const timesheetSource = operational.sources.timesheets;
  for (const payload of timesheetSource.rows) {
    const fact = flattenBulkTimesheets([payload], operational.manifest.completedAt)[0]!;
    const month = sourceMonth(fact.workDate);
    if (!month || !months.includes(month)) continue;
    add(
      buckets,
      "timesheets",
      month,
      fact.timesheetIdentity,
      requiredEvidenceNumber(fact.totalHours, "timesheets", month, "totalHours"),
    );
    if (fact.referenceType === "job" && fact.referenceId !== null && activeJobIds.has(String(fact.referenceId))) {
      add(buckets, "jobs_from_timesheets", month, String(fact.referenceId), 0);
    }
  }

  const scheduleSource = operational.sources.schedules;
  for (const payload of scheduleSource.rows) {
    const fact = flattenBulkSchedules([payload], operational.manifest.completedAt).schedules[0]!;
    const month = sourceMonth(fact.scheduleDate);
    if (month && months.includes(month)) {
      add(
        buckets,
        "schedules",
        month,
        String(fact.scheduleId),
        requiredEvidenceNumber(fact.totalHours, "schedules", month, "totalHours"),
      );
    }
  }

  const mobileSource = operational.sources.mobile_status;
  if (families.includes("mobile_status")) {
    for (const payload of mobileSource.rows) {
      const fact = flattenBulkMobileStatus([payload], operational.manifest.completedAt)[0]!;
      const month = pacificMonth(fact.dateLogged);
      if (month && months.includes(month)) add(buckets, "mobile_status", month, String(fact.logId), 1);
    }
  }

  const artifactHashes: Record<BackfillSourceFamily, string> = {
    quotes: quoteSource.sha256,
    quote_nested: quoteSource.sha256,
    jobs: jobSource.sha256,
    job_nested: jobSource.sha256,
    employees: employeeSource.sha256,
    timesheets: timesheetSource.sha256,
    jobs_from_timesheets: sha(stableJson([timesheetSource.sha256, jobSource.sha256])),
    schedules: scheduleSource.sha256,
    mobile_status: mobileSource.sha256,
  };

  return families.flatMap((family) => months.map((month) => evidenceUnit({
    family,
    month,
    bucket: buckets.get(family)?.get(month) ?? emptyBucket(),
    artifactSha256: artifactHashes[family],
    manifestSha256: compositeManifestSha256,
    evidenceAsOf,
    currentMonth: month === currentMonth,
    asOfDate: operational.manifest.asOfDate,
  })));
}

function evidenceUnit(params: {
  family: BackfillSourceFamily;
  month: string;
  bucket: Bucket;
  artifactSha256: string;
  manifestSha256: string;
  evidenceAsOf: string;
  currentMonth: boolean;
  asOfDate: string;
}): BulkBootstrapEvidenceUnit {
  const ids = [...params.bucket.ids].sort(compareExactSourceIds);
  const periodEnd = inclusiveMonthEnd(params.month);
  const effectiveEnd = params.currentMonth ? params.asOfDate : periodEnd;
  const requestQuery = params.currentMonth && params.family === "quotes"
    ? { search: "all", display: "all", orderby: "ID", openQuoteDiscovery: true }
    : { StartDate: params.month, EndDate: effectiveEnd, display: "all", orderby: "ID" };
  const requestIdentity = `${params.family}:${params.month}:artifact-projection`;
  const pageIdentity = `${requestIdentity}:page:1`;
  const detailCoverageRequired = [
    "quotes", "quote_nested", "jobs", "job_nested", "employees", "jobs_from_timesheets", "schedules",
  ].includes(params.family);
  return {
    sourceFamily: params.family,
    periodStart: params.month,
    periodEnd,
    exactSourceIds: ids,
    listedSourceIds: ids,
    detailedSourceIds: detailCoverageRequired ? ids : [],
    normalizedSourceIds: ids,
    sourceValue: round(params.bucket.value),
    normalizedValue: round(params.bucket.value),
    pages: [{
      targetKey: targetKey(params.family, params.month, params.currentMonth),
      sourceMethod: sourceMethod(params.family),
      requestIdentity,
      requestSha256: bulkEvidenceRequestSha256(requestQuery),
      pageIdentity,
      pageSha256: bulkEvidencePageSha256(pageIdentity, ids),
      pageNumber: 1,
      pageSize: Math.max(250, ids.length),
      rowCount: ids.length,
      exactIds: ids,
      requestQuery,
      terminal: true,
      continuationPage: null,
      observedMinDate: ids.length > 0 ? params.month : null,
      observedMaxDate: ids.length > 0 ? effectiveEnd : null,
    }],
    artifactSha256: params.artifactSha256,
    manifestSha256: params.manifestSha256,
    evidenceAsOf: params.evidenceAsOf,
    currentMonth: params.currentMonth,
    detailCoverageRequired,
    openQuoteDiscovery: params.family === "quotes" && params.currentMonth
      ? {
          required: true,
          status: "complete",
          discoveryIdentity: "checksum-verified-current-quote-universe",
          exactUniverseCount: ids.length,
        }
      : undefined,
  };
}

function put(
  buckets: Map<BackfillSourceFamily, FamilyBuckets>,
  family: BackfillSourceFamily,
  month: string,
  ids: string[],
  value: number,
) {
  buckets.get(family)?.set(month, { ids: new Set(ids), value });
}

function add(
  buckets: Map<BackfillSourceFamily, FamilyBuckets>,
  family: BackfillSourceFamily,
  month: string,
  id: string,
  value: number,
) {
  const familyBuckets = buckets.get(family);
  if (!familyBuckets) return;
  const bucket = familyBuckets.get(month) ?? emptyBucket();
  const isNew = !bucket.ids.has(id);
  bucket.ids.add(id);
  if (family !== "jobs_from_timesheets" || isNew) bucket.value += family === "jobs_from_timesheets" ? 1 : value;
  familyBuckets.set(month, bucket);
}

function emptyBucket(): Bucket {
  return { ids: new Set(), value: 0 };
}

function sumValues(ids: string[], values: Map<string, number>) {
  return ids.reduce((sum, id) => {
    const value = values.get(id);
    if (value === undefined) {
      throw new Error(`Bulk bootstrap evidence cannot publish source ID ${id}: required Total.ExTax value is missing.`);
    }
    return sum + value;
  }, 0);
}

function unionIds(left: readonly number[], right: readonly number[]) {
  return [...new Set([...left, ...right].map(String))].sort(compareExactSourceIds);
}

function targetKey(family: BackfillSourceFamily, month: string, current: boolean) {
  if (family === "quotes" && current) return "quotes:current-full-universe";
  return `${family}:${month}:full-universe`;
}

function sourceMethod(family: BackfillSourceFamily) {
  const methods: Record<BackfillSourceFamily, string> = {
    quotes: "listQuotes",
    quote_nested: "listQuotes",
    jobs: "listJobs",
    job_nested: "listJobs",
    employees: "listEmployees",
    timesheets: "listEmployeeTimesheets",
    jobs_from_timesheets: "listEmployeeTimesheets",
    schedules: "listSchedules",
    mobile_status: "listMobileStatus",
  };
  return methods[family];
}

function monthStarts(start: string, through: string) {
  const values: string[] = [];
  for (let month = start; month <= through; month = addMonths(month, 1)) values.push(month);
  return values;
}

function sourceMonth(value: string | null) {
  return value && /^\d{4}-\d{2}/.test(value) ? `${value.slice(0, 7)}-01` : null;
}

function pacificMonth(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  return year && month ? `${year}-${month}-01` : null;
}

function inclusiveMonthEnd(month: string) {
  const date = new Date(`${addMonths(month, 1)}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function addMonths(value: string, count: number) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() + count);
  return date.toISOString().slice(0, 10);
}

function round(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

function requiredEvidenceNumber(
  value: unknown,
  family: BackfillSourceFamily,
  month: string,
  field: string,
) {
  const scope = `bulk evidence ${family}/${month}/${field}`;
  if (value === undefined) throw new Error(`${scope} is absent; a finite number is required.`);
  if (value === null) throw new Error(`${scope} is null; a finite number is required.`);
  if (typeof value === "boolean") throw new Error(`${scope} is boolean; a finite number is required.`);
  if (typeof value === "string" && !value.trim()) throw new Error(`${scope} is blank; a finite number is required.`);
  if (typeof value !== "number" && typeof value !== "string") {
    throw new Error(`${scope} has type ${typeof value}; a finite number is required.`);
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${scope} is nonnumeric or non-finite.`);
  return parsed;
}

function stableJson(value: unknown) {
  return JSON.stringify(value, (_key, nested) => {
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) return nested;
    return Object.fromEntries(Object.entries(nested).sort(([left], [right]) => left.localeCompare(right)));
  });
}

function sha(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function compositeBulkManifestSha256(projectManifestSha256: string, operationalManifestSha256: string) {
  return sha(stableJson({ projectManifestSha256, operationalManifestSha256 }));
}

function argumentValue(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
