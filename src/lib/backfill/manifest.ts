import { createHash } from "node:crypto";
import { businessCurrentMonth, monthEndInclusive, type BackfillSourceFamily } from "@/lib/backfill/plan";
import type { SimproEndpoints } from "@/lib/simpro/endpoints";
import { pickId } from "@/lib/simpro/schemas";
import type { BackfillWorkUnit } from "@/lib/store/backfill-ledger";

export const AUTHORITATIVE_BACKFILL_CONTRACT_VERSION = 1;

export type BackfillFilterTarget = {
  key: string;
  purpose: "month_window" | "identity_snapshot" | "derived_dependency" | "open_quote_discovery";
  query: Record<string, unknown>;
  boundaryField: string | null;
};

export type BackfillFilterContract = {
  version: number;
  sourceFamily: BackfillSourceFamily;
  monthStart: string;
  monthEndExclusive: string;
  effectiveEndInclusive: string;
  pacificBoundaryDate: string;
  provisional: boolean;
  identityContract: string;
  requiredTargetKeys: string[];
  targets: BackfillFilterTarget[];
  openQuoteDiscoveryRequired: boolean;
};

export type BackfillTraversalPageEvidence = {
  ordinal: number;
  targetKey: string;
  sourceMethod: string;
  pageNumber: number;
  pageSize: number;
  rowCount: number;
  exactIds: string[];
  query: Record<string, unknown>;
  terminal: boolean;
  continuationPage: number | null;
  observedMinDate: string | null;
  observedMaxDate: string | null;
  responseHash: string;
  synthetic: boolean;
};

export type BackfillTraversalExclusion = {
  targetKey: string;
  entityId?: string;
  reason: string;
  detail?: Record<string, unknown>;
};

export type BackfillTraversalSliceEvidence = {
  version: number;
  generation: number;
  asOfWatermark: string;
  filterContract: BackfillFilterContract;
  observedBoundary: Record<string, unknown>;
  pages: BackfillTraversalPageEvidence[];
  sourceIds: string[];
  listedSourceIds: string[];
  detailedSourceIds: string[];
  completedTargetKeys: string[];
  exclusions: BackfillTraversalExclusion[];
  continuation: Record<string, unknown> | null;
  ingestionComplete: boolean;
  valid: boolean;
  violations: string[];
  detailCoverageRequired: boolean;
  emptyProof: Record<string, unknown> | null;
  openQuoteDiscovery: Record<string, unknown>;
};

type ActiveTarget = BackfillFilterTarget & { pageStart: number; detailStart: number };

type ObservedDetail = {
  targetKey: string;
  method: string;
  id: string;
  payload: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
};

type InternalPage = BackfillTraversalPageEvidence & {
  sourceIds: string[];
  rows: Record<string, unknown>[];
  validated: boolean;
};

export class AuthoritativeTraversalRecorder {
  readonly contract: BackfillFilterContract;
  readonly endpoints: SimproEndpoints;
  readonly asOfWatermark: string;

  private readonly pages: InternalPage[] = [];
  private readonly details: ObservedDetail[] = [];
  private readonly sourceIds = new Set<string>();
  private readonly listedSourceIds = new Set<string>();
  private readonly detailedSourceIds = new Set<string>();
  private readonly terminalDetailExclusions = new Set<string>();
  private readonly completedTargetKeys = new Set<string>();
  private readonly exclusions: BackfillTraversalExclusion[] = [];
  private readonly violations: string[] = [];
  private activeTarget: ActiveTarget | null = null;

  constructor(
    private readonly workUnit: BackfillWorkUnit,
    endpoints: SimproEndpoints,
    asOf = workUnit.manifest_as_of_watermark ? new Date(workUnit.manifest_as_of_watermark) : new Date(),
  ) {
    this.asOfWatermark = asOf.toISOString();
    this.contract = authoritativeFilterContract(workUnit, asOf);
    this.endpoints = this.observeEndpoints(endpoints);
    if (this.contract.provisional) {
      this.exclusions.push({
        targetKey: "current-month-boundary",
        reason: "future_pacific_month_boundary",
        detail: {
          includedThrough: this.contract.effectiveEndInclusive,
          monthEndInclusive: monthEndInclusive(workUnit.month_end_exclusive),
        },
      });
    }
  }

  beginTarget(target: BackfillFilterTarget) {
    this.activeTarget = {
      ...target,
      pageStart: this.pages.length,
      detailStart: this.details.length,
    };
  }

  completeInvocation(sourceContinuation: Record<string, unknown> | null) {
    const target = this.requireActiveTarget();
    const targetPages = this.pages.slice(target.pageStart);
    const targetDetails = this.details.slice(target.detailStart);

    for (const page of targetPages) {
      if (page.validated) continue;
      page.validated = true;
      this.validatePageContract(page, target, targetDetails, sourceContinuation);
    }
    this.activeTarget = null;
  }

  completeTarget(targetKey: string, sourceIds: string[] = []) {
    this.completedTargetKeys.add(targetKey);
    for (const id of sourceIds) this.sourceIds.add(id);
  }

  addSourceIds(sourceIds: string[]) {
    for (const id of sourceIds) this.sourceIds.add(id);
  }

  recordDerivedCompletion(target: BackfillFilterTarget, sourceIds = [...this.sourceIds]) {
    const exactIds = [...new Set(sourceIds)].sort(idSort);
    for (const id of exactIds) {
      this.sourceIds.add(id);
      this.listedSourceIds.add(id);
      this.detailedSourceIds.add(id);
    }
    this.pages.push({
      ordinal: this.pages.length + 1,
      targetKey: target.key,
      sourceMethod: "derivedDependencyTraversal",
      pageNumber: 1,
      pageSize: exactIds.length,
      rowCount: exactIds.length,
      exactIds,
      query: target.query,
      terminal: true,
      continuationPage: null,
      observedMinDate: null,
      observedMaxDate: null,
      responseHash: hashValue({ target: target.key, exactIds }),
      synthetic: true,
      sourceIds: exactIds,
      rows: [],
      validated: true,
    });
    this.completedTargetKeys.add(target.key);
  }

  hasViolations() {
    return this.violations.length > 0;
  }

  finish(params: {
    continuation: Record<string, unknown> | null;
    ingestionComplete: boolean;
  }): BackfillTraversalSliceEvidence {
    if (this.activeTarget) {
      this.completeInvocation(params.continuation);
    }
    if (
      params.ingestionComplete
      && this.pages.length === 0
      && this.details.length === 0
      && this.workUnit.execution_mode !== "coverage_only"
    ) {
      this.violations.push("Traversal claimed completion without an observed or derived terminal page.");
    }

    const missingDetailIds = [...this.listedSourceIds].filter(
      (id) => !this.detailedSourceIds.has(id) && !this.terminalDetailExclusions.has(id),
    );
    if (params.ingestionComplete && requiresDetailCoverage(this.workUnit.source_family) && missingDetailIds.length > 0) {
      this.violations.push(
        `Traversal ended with ${missingDetailIds.length} listed source ID(s) lacking required detail coverage: ${missingDetailIds.slice(0, 10).join(", ")}.`,
      );
    }

    const openRequired = this.contract.openQuoteDiscoveryRequired;
    const openComplete = this.completedTargetKeys.has("quotes:open-discovery");
    if (params.ingestionComplete && openRequired && !openComplete) {
      this.violations.push("Current-month quote traversal ended without authoritative open-quote discovery.");
    }

    const sourceIds = [...this.sourceIds].sort(idSort);
    const completedTargetKeys = [...this.completedTargetKeys].sort();
    const terminalTargets = new Set(this.pages.filter((page) => page.terminal).map((page) => page.targetKey));
    const emptyProof = params.ingestionComplete && sourceIds.length === 0
      ? {
          authoritative: this.violations.length === 0,
          terminalTargetKeys: completedTargetKeys.filter((key) => terminalTargets.has(key)),
          asOfWatermark: this.asOfWatermark,
          filterContractVersion: this.contract.version,
        }
      : null;

    return {
      version: AUTHORITATIVE_BACKFILL_CONTRACT_VERSION,
      generation: this.workUnit.manifest_generation ?? 1,
      asOfWatermark: this.asOfWatermark,
      filterContract: this.contract,
      observedBoundary: {
        pacificBoundaryDate: this.contract.pacificBoundaryDate,
        effectiveEndInclusive: this.contract.effectiveEndInclusive,
        monthEndExclusive: this.workUnit.month_end_exclusive,
        provisional: this.contract.provisional,
      },
      pages: this.pages.map(publicPageEvidence),
      sourceIds,
      listedSourceIds: [...this.listedSourceIds].sort(idSort),
      detailedSourceIds: [...this.detailedSourceIds].sort(idSort),
      completedTargetKeys,
      exclusions: this.exclusions,
      continuation: params.continuation,
      ingestionComplete: params.ingestionComplete,
      valid: this.violations.length === 0,
      violations: [...this.violations],
      detailCoverageRequired: requiresDetailCoverage(this.workUnit.source_family),
      emptyProof,
      openQuoteDiscovery: {
        required: openRequired,
        targetKey: openRequired ? "quotes:open-discovery" : null,
        status: openRequired ? (openComplete ? "complete" : "pending") : "not_required",
        asOfWatermark: this.asOfWatermark,
      },
    };
  }

  private observeEndpoints(endpoints: SimproEndpoints): SimproEndpoints {
    return new Proxy(endpoints, {
      get: (target, property) => {
        const value = Reflect.get(target, property, target);
        if (typeof property !== "string" || typeof value !== "function") return value;
        const method = value as (...args: unknown[]) => Promise<unknown>;
        if (property.startsWith("list")) {
          return async (...args: unknown[]) => {
            const result = await method.apply(target, args);
            this.recordListResult(property, args, result);
            return result;
          };
        }
        if (property.startsWith("get")) {
          return async (...args: unknown[]) => {
            try {
              const result = await method.apply(target, args);
              this.recordDetailResult(property, args, result, null);
              return result;
            } catch (error) {
              this.recordDetailResult(property, args, null, errorRecord(error));
              throw error;
            }
          };
        }
        return method.bind(target);
      },
    });
  }

  private recordListResult(method: string, args: unknown[], value: unknown) {
    const target = this.requireActiveTarget();
    const page = pageValue(value, args);
    const sourceIds = page.rows
      .map((row) => sourceIdentity(this.workUnit.source_family, method, args, row))
      .filter((id): id is string => Boolean(id));
    const pageIds = page.rows
      .map((row) => pageIdentity(method, args, row))
      .filter((id): id is string => Boolean(id));
    const boundaryDates = page.rows
      .map((row) => boundaryDate(row, target.boundaryField))
      .filter((date): date is string => Boolean(date))
      .sort();

    if (page.rows.length !== pageIds.length) {
      this.violations.push(`${target.key} ${method} returned row(s) without a stable source identity.`);
    }
    if (isAuthoritativeSourceList(this.workUnit.source_family, method)) {
      for (const id of sourceIds) {
        this.sourceIds.add(id);
        this.listedSourceIds.add(id);
      }
    }

    this.pages.push({
      ordinal: this.pages.length + 1,
      targetKey: target.key,
      sourceMethod: method,
      pageNumber: page.pageNumber,
      pageSize: page.pageSize,
      rowCount: page.rows.length,
      exactIds: pageIds.sort(idSort),
      query: page.query,
      terminal: page.continuationPage === null,
      continuationPage: page.continuationPage,
      observedMinDate: boundaryDates[0] ?? null,
      observedMaxDate: boundaryDates.at(-1) ?? null,
      responseHash: hashValue(page.rows),
      synthetic: false,
      sourceIds,
      rows: page.rows,
      validated: false,
    });
  }

  private recordDetailResult(method: string, args: unknown[], value: unknown, error: Record<string, unknown> | null) {
    const target = this.requireActiveTarget();
    const id = detailIdentity(this.workUnit.source_family, method, args);
    if (!id) return;
    const payload = recordValue(value);
    this.details.push({ targetKey: target.key, method, id, payload, error });

    if (isSourceDetailMethod(this.workUnit.source_family, method)) {
      if (payload) {
        this.detailedSourceIds.add(id);
        if (this.workUnit.source_family === "jobs_from_timesheets") {
          this.sourceIds.add(id);
          this.listedSourceIds.add(id);
        }
      } else if (Number(error?.status) === 404) {
        // Simpro can retain a stale ID in a collection after its detail resource
        // is deleted. The detail 404 is terminal authority for this traversal;
        // keep the listed ID as evidence but exclude it from the source universe.
        this.sourceIds.delete(id);
        this.terminalDetailExclusions.add(id);
        this.exclusions.push({
          targetKey: target.key,
          entityId: id,
          reason: "source_detail_not_found_after_list_discovery",
          detail: error ?? {},
        });
      } else {
        this.exclusions.push({
          targetKey: target.key,
          entityId: id,
          reason: "detail_request_failed_after_list_discovery",
          detail: error ?? {},
        });
      }
    }
  }

  private validatePageContract(
    page: InternalPage,
    target: BackfillFilterTarget,
    details: ObservedDetail[],
    sourceContinuation: Record<string, unknown> | null,
  ) {
    if (!isAuthoritativeSourceList(this.workUnit.source_family, page.sourceMethod)) return;

    const forwardedPage = positiveInteger(sourceContinuation?.page);
    if (page.continuationPage !== null && sourceContinuation === null) {
      this.violations.push(
        `${target.key} ${page.sourceMethod} page ${page.pageNumber} exposed continuation page ${page.continuationPage}, but the ingestion result dropped its continuation token.`,
      );
    } else if (forwardedPage !== null && forwardedPage !== page.continuationPage) {
      this.violations.push(
        `${target.key} ${page.sourceMethod} page ${page.pageNumber} exposed continuation page ${page.continuationPage ?? "terminal"}, but the ingestion result forwarded page ${forwardedPage}.`,
      );
    }

    if (stableJson(page.query) !== stableJson(target.query)) {
      this.violations.push(
        `${target.key} sent ${stableJson(page.query)} instead of the declared filter ${stableJson(target.query)}.`,
      );
    }

    const detailById = new Map(
      details
        .filter((detail) => detail.targetKey === target.key && detail.payload)
        .map((detail) => [detail.id, detail.payload!] as const),
    );
    const requiresDetails = listRequiresDetail(page.sourceMethod);
    if (requiresDetails) {
      const missing = page.sourceIds.filter(
        (id) => !detailById.has(id) && !this.terminalDetailExclusions.has(id),
      );
      if (missing.length > 0) {
        this.violations.push(
          `${target.key} ${page.sourceMethod} page ${page.pageNumber} ended with ${missing.length} listed ID(s) lacking detail; final-page traversal was interrupted.`,
        );
      }
    }

    if (!target.boundaryField) return;
    const observedDates: string[] = [];
    for (let index = 0; index < page.sourceIds.length; index += 1) {
      const id = page.sourceIds[index];
      const payload = detailById.get(id) ?? page.rows[index];
      const observedDate = boundaryDate(payload, target.boundaryField);
      if (observedDate) observedDates.push(observedDate);
      if (!observedDate || !dateMatchesQuery(observedDate, target.query, target.boundaryField)) {
        this.violations.push(
          `${target.key} returned ${id} with ${target.boundaryField}=${observedDate ?? "missing"}; the source filter was ignored or the boundary moved during traversal.`,
        );
      }
    }
    observedDates.sort();
    page.observedMinDate = observedDates[0] ?? page.observedMinDate;
    page.observedMaxDate = observedDates.at(-1) ?? page.observedMaxDate;
  }

  private requireActiveTarget() {
    if (!this.activeTarget) throw new Error("Backfill endpoint request occurred without an active filter target.");
    return this.activeTarget;
  }
}

export function authoritativeFilterContract(workUnit: BackfillWorkUnit, asOf = new Date()): BackfillFilterContract {
  const pacificBoundaryDate = pacificDate(asOf);
  const currentMonth = businessCurrentMonth(asOf);
  const provisional = workUnit.month_start === currentMonth;
  const effectiveEndInclusive = provisional
    ? minDate(monthEndInclusive(workUnit.month_end_exclusive), pacificBoundaryDate)
    : monthEndInclusive(workUnit.month_end_exclusive);
  const monthQuery = { StartDate: workUnit.month_start, EndDate: effectiveEndInclusive, orderby: "ID" };
  let targets: BackfillFilterTarget[];

  switch (workUnit.source_family) {
    case "quotes":
      targets = ["DateApproved", "DateIssued"].flatMap((field) =>
        dateRange(workUnit.month_start, effectiveEndInclusive).map((day) => ({
          key: `quotes:${field}:${day}`,
          purpose: "month_window" as const,
          query: { [field]: day, orderby: "ID" },
          boundaryField: field,
        })),
      );
      if (provisional) {
        targets.push({
          key: "quotes:open-discovery",
          purpose: "open_quote_discovery",
          query: { orderby: "ID" },
          boundaryField: null,
        });
      }
      break;
    case "jobs":
      targets = dateRange(workUnit.month_start, effectiveEndInclusive).map((day) => ({
        key: `jobs:CompletedDate:${day}`,
        purpose: "month_window",
        query: { CompletedDate: day, orderby: "ID" },
        boundaryField: "CompletedDate",
      }));
      break;
    case "timesheets":
      targets = [{ key: "timesheets:employees", purpose: "month_window", query: monthQuery, boundaryField: "Date" }];
      break;
    case "schedules":
      targets = [{ key: "schedules:month", purpose: "month_window", query: monthQuery, boundaryField: "Date" }];
      break;
    case "employees":
      targets = [{
        key: "employees:identity-snapshot",
        purpose: "identity_snapshot",
        query: { orderby: "ID" },
        boundaryField: null,
      }];
      break;
    case "quote_nested":
    case "job_nested":
    case "jobs_from_timesheets":
      targets = [{
        key: `${workUnit.source_family}:dependency-set`,
        purpose: "derived_dependency",
        query: {
          StartDate: workUnit.month_start,
          EndDate: effectiveEndInclusive,
          authority: "completed dependency manifest",
        },
        boundaryField: null,
      }];
      break;
    case "mobile_status":
      targets = [];
      break;
    default:
      return assertNever(workUnit.source_family);
  }

  return {
    version: AUTHORITATIVE_BACKFILL_CONTRACT_VERSION,
    sourceFamily: workUnit.source_family,
    monthStart: workUnit.month_start,
    monthEndExclusive: workUnit.month_end_exclusive,
    effectiveEndInclusive,
    pacificBoundaryDate,
    provisional,
    identityContract: identityContract(workUnit.source_family),
    requiredTargetKeys: targets.map((target) => target.key),
    targets,
    openQuoteDiscoveryRequired: workUnit.source_family === "quotes" && provisional,
  };
}

function pageValue(value: unknown, args: unknown[]) {
  const record = recordValue(value);
  const rows = Array.isArray(value)
    ? value.filter(isRecord)
    : Array.isArray(record?.rows)
      ? record.rows.filter(isRecord)
      : [];
  const options = [...args].reverse().map(recordValue).find((item) => item && ("query" in item || "page" in item));
  const query = recordValue(options?.query) ?? {};
  const pageNumber = positiveInteger(record?.page ?? options?.page) ?? 1;
  const pageSize = nonNegativeInteger(record?.pageSize) ?? rows.length;
  const continuation = recordValue(record?.continuationToken);
  return {
    rows,
    query,
    pageNumber,
    pageSize,
    continuationPage: positiveInteger(continuation?.page),
  };
}

function publicPageEvidence(page: InternalPage): BackfillTraversalPageEvidence {
  return {
    ordinal: page.ordinal,
    targetKey: page.targetKey,
    sourceMethod: page.sourceMethod,
    pageNumber: page.pageNumber,
    pageSize: page.pageSize,
    rowCount: page.rowCount,
    exactIds: page.exactIds,
    query: page.query,
    terminal: page.terminal,
    continuationPage: page.continuationPage,
    observedMinDate: page.observedMinDate,
    observedMaxDate: page.observedMaxDate,
    responseHash: page.responseHash,
    synthetic: page.synthetic,
  };
}

function sourceIdentity(
  sourceFamily: BackfillSourceFamily,
  method: string,
  args: unknown[],
  row: Record<string, unknown>,
) {
  const id = pickId(row) ?? stringValue(row.UID);
  if (!id) return null;
  if (sourceFamily === "timesheets" && method === "listEmployeeTimesheets") {
    const employeeId = positiveInteger(args[0]);
    return employeeId ? `${employeeId}:${id}` : null;
  }
  if (["quotes", "jobs", "employees", "schedules"].includes(sourceFamily)) return String(id);
  return null;
}

function pageIdentity(method: string, args: unknown[], row: Record<string, unknown>) {
  const id = pickId(row) ?? stringValue(row.UID);
  if (!id) return null;
  const parent = args
    .slice(0, -1)
    .map((value) => stringValue(value))
    .filter((value): value is string => Boolean(value))
    .join(":");
  return parent ? `${method}:${parent}:${id}` : `${method}:${id}`;
}

function detailIdentity(sourceFamily: BackfillSourceFamily, method: string, args: unknown[]) {
  const id = positiveInteger(args[0]);
  if (!id) return null;
  if (sourceFamily === "quotes" && method === "getQuote") return String(id);
  if ((sourceFamily === "jobs" || sourceFamily === "jobs_from_timesheets") && method === "getJob") return String(id);
  if (sourceFamily === "employees" && method === "getEmployee") return String(id);
  if (sourceFamily === "schedules" && method === "getSchedule") return String(id);
  return null;
}

function isAuthoritativeSourceList(sourceFamily: BackfillSourceFamily, method: string) {
  if (sourceFamily === "quotes") return method === "listQuotes";
  if (sourceFamily === "jobs") return method === "listJobs";
  if (sourceFamily === "employees") return method === "listEmployees";
  if (sourceFamily === "timesheets") return method === "listEmployeeTimesheets";
  if (sourceFamily === "schedules") return method === "listSchedules";
  return false;
}

function isSourceDetailMethod(sourceFamily: BackfillSourceFamily, method: string) {
  if (sourceFamily === "quotes") return method === "getQuote";
  if (sourceFamily === "jobs" || sourceFamily === "jobs_from_timesheets") return method === "getJob";
  if (sourceFamily === "employees") return method === "getEmployee";
  if (sourceFamily === "schedules") return method === "getSchedule";
  return false;
}

function listRequiresDetail(method: string) {
  return ["listQuotes", "listJobs", "listEmployees", "listSchedules"].includes(method);
}

function requiresDetailCoverage(sourceFamily: BackfillSourceFamily) {
  return ["quotes", "jobs", "employees", "jobs_from_timesheets", "schedules"].includes(sourceFamily);
}

function boundaryDate(payload: Record<string, unknown> | null | undefined, field: string | null) {
  if (!payload || !field) return null;
  const candidates = field === "Date"
    ? [payload.Date, payload.StartDate, payload.Start, payload.startDate]
    : [payload[field], payload[field[0].toLowerCase() + field.slice(1)]];
  for (const candidate of candidates) {
    const value = stringValue(candidate);
    if (value && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  }
  return null;
}

function dateMatchesQuery(date: string, query: Record<string, unknown>, field: string) {
  const exact = stringValue(query[field]);
  if (exact) return date === exact.slice(0, 10);
  const start = stringValue(query.StartDate);
  const end = stringValue(query.EndDate);
  return Boolean(start && end && date >= start.slice(0, 10) && date <= end.slice(0, 10));
}

function identityContract(sourceFamily: BackfillSourceFamily) {
  switch (sourceFamily) {
    case "timesheets": return "EmployeeID:UID";
    case "quote_nested": return "authoritative quote parent ID plus method/parent/child page identities";
    case "job_nested": return "authoritative job parent ID plus method/parent/child page identities";
    default: return "Simpro ID";
  }
}

function dateRange(start: string, endInclusive: string) {
  const dates: string[] = [];
  const end = new Date(`${endInclusive}T00:00:00.000Z`);
  for (let date = new Date(`${start}T00:00:00.000Z`); date <= end; date = new Date(date.getTime() + 86_400_000)) {
    dates.push(date.toISOString().slice(0, 10));
  }
  return dates;
}

function pacificDate(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function minDate(left: string, right: string) {
  return left < right ? left : right;
}

function hashValue(value: unknown) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function errorRecord(error: unknown) {
  if (error instanceof Error) {
    const details = recordValue((error as Error & { details?: unknown }).details);
    return { name: error.name, message: error.message, ...(details ?? {}) };
  }
  return { message: String(error) };
}

function positiveInteger(value: unknown) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function nonNegativeInteger(value: unknown) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function stringValue(value: unknown) {
  return value === null || value === undefined || value === "" ? null : String(value);
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function idSort(left: string, right: string) {
  return left.localeCompare(right, "en", { numeric: true });
}

function assertNever(value: never): never {
  throw new Error(`Unhandled authoritative backfill source: ${value}`);
}
