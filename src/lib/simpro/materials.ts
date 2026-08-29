import { isSimproNotFound, SimproClient, type RequestBudget } from "@/lib/simpro/client";
import type { SimproEndpoints } from "@/lib/simpro/endpoints";
import type { MaterialLineType } from "@/lib/metrics/materials";

/**
 * Live Simpro walk for the materials mirror (verified recipe, brief §4.5):
 * jobs completed in a window (CompletedDate=between(...); "DateCompleted" is
 * not a valid filter) → sections → costCenters → catalogs/oneOffs/prebuilds
 * with display=all. Service Fee lines are excluded by never fetching the
 * serviceFees collection; one-offs keep only Type === "Material".
 */

export type CompletedJobRef = {
  jobId: number;
  completedDate: string;
};

export type WalkedMaterialLine = {
  sectionId: number;
  costCenterId: number;
  lineType: MaterialLineType;
  lineId: number;
  catalogId: number | null;
  prebuildId: number | null;
  name: string | null;
  partNo: string | null;
  qty: number;
  extendedExTax: number;
  basePrice: number | null;
  oneOffType: string | null;
};

export type CatalogGroupLookup = {
  catalogId: number;
  name: string | null;
  partNo: string | null;
  groupName: string | null;
  parentGroupName: string | null;
};

const NESTED_PAGE_SIZE = 250;

export async function discoverCompletedJobs(
  client: SimproClient,
  params: { startDate: string; endDate: string; budget?: RequestBudget },
): Promise<CompletedJobRef[]> {
  const seen = new Map<number, string>();
  let page = 1;
  for (;;) {
    const result = await client.getPage<Record<string, unknown>>("/jobs/", {
      startPage: page,
      pageSize: NESTED_PAGE_SIZE,
      requestBudget: params.budget,
      query: {
        CompletedDate: `between(${params.startDate},${params.endDate})`,
        columns: "ID,CompletedDate",
      },
    });
    for (const row of result.rows) {
      const jobId = numericId(row.ID);
      const completedDate = dateValue(row.CompletedDate);
      if (jobId === null || completedDate === null) continue;
      if (completedDate < params.startDate || completedDate > params.endDate) continue;
      // Dedupe: Simpro pages can overlap; keep the first observation.
      if (!seen.has(jobId)) seen.set(jobId, completedDate);
    }
    if (!result.hasMore) break;
    page = result.continuationToken?.page ?? page + 1;
  }
  return [...seen.entries()]
    .map(([jobId, completedDate]) => ({ jobId, completedDate }))
    .sort((left, right) => left.jobId - right.jobId);
}

export async function fetchJobMaterialLines(
  endpoints: SimproEndpoints,
  jobId: number,
  budget?: RequestBudget,
): Promise<WalkedMaterialLine[]> {
  const lines: WalkedMaterialLine[] = [];
  const sections = await drainPages((page) => endpoints.listJobSections(jobId, { page, budget }));
  for (const section of sections) {
    const sectionId = requiredId(section.ID, `job ${jobId} section ID`);
    const costCenters = await drainPages((page) => endpoints.listJobCostCenters(jobId, sectionId, { page, budget }));
    for (const costCenter of costCenters) {
      const costCenterId = requiredId(costCenter.ID, `job ${jobId} cost center ID`);
      const listOptions = { pageSize: NESTED_PAGE_SIZE, budget, query: { display: "all" } };

      const catalogs = await drainPages((page) =>
        endpoints.listJobCatalogs(jobId, sectionId, costCenterId, { ...listOptions, page }));
      for (const row of catalogs) {
        lines.push({
          sectionId,
          costCenterId,
          lineType: "catalog",
          lineId: requiredId(row.ID, `job ${jobId} catalog line ID`),
          catalogId: numericId(recordValue(row.Catalog)?.ID),
          prebuildId: null,
          name: stringValue(recordValue(row.Catalog)?.Name),
          partNo: stringValue(recordValue(row.Catalog)?.PartNo),
          qty: row.Total.Qty,
          extendedExTax: row.Total.Amount.ExTax,
          basePrice: row.BasePrice,
          oneOffType: null,
        });
      }

      const oneOffs = await drainPages((page) =>
        endpoints.listJobOneOffs(jobId, sectionId, costCenterId, { ...listOptions, page }));
      for (const row of oneOffs) {
        if (row.Type !== "Material") continue;
        lines.push({
          sectionId,
          costCenterId,
          lineType: "one_off",
          lineId: requiredId(row.ID, `job ${jobId} one-off line ID`),
          catalogId: null,
          prebuildId: null,
          name: stringValue(row.Description),
          partNo: null,
          qty: row.Total.Qty,
          extendedExTax: row.Total.Amount.ExTax,
          basePrice: null,
          oneOffType: row.Type,
        });
      }

      const prebuilds = await drainPages((page) =>
        endpoints.listJobPrebuilds(jobId, sectionId, costCenterId, { ...listOptions, page }));
      for (const row of prebuilds) {
        lines.push({
          sectionId,
          costCenterId,
          lineType: "prebuild",
          lineId: requiredId(row.ID, `job ${jobId} prebuild line ID`),
          catalogId: null,
          prebuildId: numericId(recordValue(row.Prebuild)?.ID),
          name: stringValue(recordValue(row.Prebuild)?.Name),
          partNo: null,
          qty: row.Total.Qty,
          extendedExTax: row.Total.Amount.ExTax,
          basePrice: null,
          oneOffType: null,
        });
      }
    }
  }
  return lines;
}

/**
 * Company-level catalog item detail (GET /catalogs/{id}?display=all): the only
 * live source of the product group hierarchy. Category uses
 * Group.ParentGroup.Name with Group.Name as the fallback.
 */
export async function fetchCatalogGroup(
  client: SimproClient,
  catalogId: number,
  budget?: RequestBudget,
): Promise<CatalogGroupLookup> {
  let payload: Record<string, unknown>;
  try {
    payload = await client.getJson<Record<string, unknown>>(
      `/catalogs/${encodeURIComponent(String(catalogId))}`,
      { display: "all" },
      budget,
    );
  } catch (error) {
    if (isSimproNotFound(error)) {
      return { catalogId, name: null, partNo: null, groupName: null, parentGroupName: null };
    }
    throw error;
  }
  const group = recordValue(payload.Group);
  const parentGroup = recordValue(group?.ParentGroup);
  return {
    catalogId,
    name: stringValue(payload.Name),
    partNo: stringValue(payload.PartNo),
    groupName: stringValue(group?.Name),
    parentGroupName: stringValue(parentGroup?.Name),
  };
}

async function drainPages<T>(
  loadPage: (page: number) => Promise<{ rows: T[]; hasMore: boolean; continuationToken: { page: number } | null }>,
): Promise<T[]> {
  const rows: T[] = [];
  let page = 1;
  for (;;) {
    const result = await loadPage(page);
    rows.push(...result.rows);
    if (!result.hasMore) break;
    page = result.continuationToken?.page ?? page + 1;
  }
  return rows;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function numericId(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function requiredId(value: unknown, label: string): number {
  const id = numericId(value);
  if (id === null) throw new Error(`Missing ${label}.`);
  return id;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function dateValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.match(/^\d{4}-\d{2}-\d{2}/);
  return match?.[0] ?? null;
}
