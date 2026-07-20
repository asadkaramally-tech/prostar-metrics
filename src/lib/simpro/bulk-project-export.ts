import { isCompletedJobStage } from "@/lib/metrics/jobs";
import {
  classifyQuote,
  verifiedQuoteStageClassification,
  type QuoteOutcome,
} from "@/lib/metrics/quotes";
import { coerceRows, sourceHash } from "@/lib/simpro/client";
import {
  mapCostCenterFact,
  mapItemFact,
  mapLaborFact,
  type ProjectItemType,
  type ProjectType,
} from "@/lib/simpro/normalize-nested";
import {
  extractCostCenterRollups,
  extractJobConvertedFromAt,
  extractJobFinancialTotals,
  extractJobSourceQuoteId,
  extractJobStageName,
  extractQuoteLinkedJobId,
  extractQuoteStageNames,
} from "@/lib/simpro/normalize";
import { pickId, pickName } from "@/lib/simpro/schemas";
import { dominantQuoteBusinessCategory } from "@/lib/store/quote-category-rebuild";

export const BULK_JOB_COLUMNS = "ID,Type,Stage,Status,Customer,Site,Description,Notes,DateIssued,DueDate,CompletedDate,Salesperson,ProjectManager,Technicians,Total,Totals,Sections,ConvertedFrom,ConvertedFromQuote,RequestNo,OrderNo,ResponseTime,DateModified";
export const BULK_QUOTE_COLUMNS = "ID,Type,Stage,Status,Customer,Site,Description,Notes,DateIssued,DateApproved,DueDate,ValidityDays,Salesperson,Total,Totals,Sections,RequestNo,OrderNo,IsClosed,JobNo,LinkedJobID";

type ProjectIdentity = {
  projectType: ProjectType;
  projectId: number;
};

type SourceFields = {
  sourceHash: string;
  fetchedAt: string;
  sourceModifiedAt: string | null;
};

type ChildSourceFields = ProjectIdentity & SourceFields & {
  projectSourceHash: string;
  projectSourceModifiedAt: string | null;
};

export type BulkProjectRow = ProjectIdentity & SourceFields & {
  projectNo: string;
  quoteNo: string | null;
  jobNo: string | null;
  type: string | null;
  name: string | null;
  description: string | null;
  stageName: string | null;
  customerStageName: string | null;
  statusId: number | null;
  statusName: string | null;
  dateIssued: string | null;
  dateApproved: string | null;
  completedDate: string | null;
  isCompleted: boolean | null;
  isClosed: boolean | null;
  quoteOutcome: QuoteOutcome | null;
  quoteOutcomeReason: string | null;
  quoteWon: boolean | null;
  linkedJobId: number | null;
  conversionJobId: number | null;
  sourceQuoteId: number | null;
  convertedFromType: string | null;
  convertedFromAt: string | null;
  salespersonId: number | null;
  salespersonName: string | null;
  customerId: number | null;
  customerName: string | null;
  siteId: number | null;
  siteName: string | null;
  category: string;
  totalExTax: number;
  totalTax: number | null;
  totalIncTax: number | null;
  materialsCostEstimate: number | null;
  materialsCostActual: number | null;
  resourcesCostEstimate: number | null;
  resourcesCostActual: number | null;
  laborHoursEstimate: number | null;
  laborHoursActual: number | null;
  grossProfitEstimate: number | null;
  grossProfitActual: number | null;
  grossMarginEstimate: number | null;
  grossMarginActual: number | null;
};

export type BulkProjectPersonRole = "salesperson" | "project_manager" | "technician";

export type BulkProjectPersonRow = ChildSourceFields & {
  role: BulkProjectPersonRole;
  personId: number;
  personName: string | null;
  personType: string | null;
  personTypeId: number | null;
};

export type BulkProjectCostCenterRow = ChildSourceFields & {
  sectionId: number;
  sectionName: string | null;
  sectionDescription: string | null;
  sectionDisplayOrder: number | null;
  costCenterId: number;
  configuredCostCenterId: number | null;
  configuredCostCenterName: string | null;
  costCenterName: string | null;
  costCenterDisplayOrder: number | null;
  costCenterStage: string | null;
  category: string;
  laborHours: number | null;
  sellValue: number | null;
  costValue: number | null;
  materialCostValue: number | null;
  totalExTax: number | null;
  totalTax: number | null;
  totalIncTax: number | null;
};

export type BulkProjectLaborRow = ChildSourceFields & {
  sectionId: number;
  costCenterId: number;
  laborId: number;
  laborTypeId: number | null;
  laborTypeName: string | null;
  quantityHours: number | null;
  unitSellExTax: number | null;
  unitSellIncTax: number | null;
  sellExTax: number | null;
  sellIncTax: number | null;
  actualCost: number | null;
  discount: number | null;
};

export type BulkProjectItemRow = ChildSourceFields & {
  sectionId: number;
  costCenterId: number;
  itemType: ProjectItemType;
  itemId: string;
  sourceItemId: number | null;
  sourceItemName: string | null;
  sourceItemPartNo: string | null;
  description: string | null;
  quantity: number | null;
  billableStatus: string | null;
  unitSellExTax: number | null;
  unitSellIncTax: number | null;
  sellExTax: number | null;
  sellIncTax: number | null;
  estimatedCost: number | null;
  actualCost: number | null;
  discount: number | null;
};

export type FlattenedBulkProjectPage = {
  projects: BulkProjectRow[];
  people: BulkProjectPersonRow[];
  costCenters: BulkProjectCostCenterRow[];
  labor: BulkProjectLaborRow[];
  items: BulkProjectItemRow[];
};

export function flattenBulkProjectPage(
  projectType: ProjectType,
  payloads: unknown,
  fetchedAt: string,
): FlattenedBulkProjectPage {
  const result: FlattenedBulkProjectPage = {
    projects: [],
    people: [],
    costCenters: [],
    labor: [],
    items: [],
  };

  for (const payload of coerceRows<Record<string, unknown>>(payloads)) {
    flattenProject(projectType, payload, fetchedAt, result);
  }

  return result;
}

function flattenProject(
  projectType: ProjectType,
  payload: Record<string, unknown>,
  fetchedAt: string,
  result: FlattenedBulkProjectPage,
): void {
  const projectId = requiredId(payload.ID, `${projectType} ID`);
  const projectSourceHash = sourceHash(payload);
  const projectSourceModifiedAt = textValue(payload.DateModified);
  const total = recordValue(payload.Total);
  const totals = recordValue(payload.Totals);
  const salesperson = payload.Salesperson;
  const customer = payload.Customer;
  const site = payload.Site;
  const stage = projectType === "quote"
    ? extractQuoteStageNames(payload)
    : { stageName: extractJobStageName(payload), customerStageName: null };
  const completedDate = projectType === "job" ? dateValue(payload.CompletedDate) : null;
  const isClosed = projectType === "quote" ? booleanValue(payload.IsClosed) : null;
  const totalExTax = requireBulkProjectTotalExTax(payload, projectType, projectId);
  const conversionJobId = projectType === "quote" ? extractQuoteLinkedJobId(payload) : null;
  const quoteClassification = projectType === "quote"
    ? classifyQuote({
        quoteId: projectId,
        totalValue: totalExTax,
        statusName: pickName(payload.Status),
        linkedJobId: conversionJobId,
        stageName: stage.stageName,
        customerStageName: stage.customerStageName,
        isClosed,
        ...verifiedQuoteStageClassification(stage.customerStageName),
      })
    : null;
  const jobFinancials = projectType === "job"
    ? extractJobFinancialTotals(payload)
    : { grossProfitActual: null, grossMarginActual: null };
  const convertedFrom = recordValue(payload.ConvertedFrom);
  const sourceQuoteId = projectType === "job" ? extractJobSourceQuoteId(payload) : null;
  const rawJobNo = textValue(payload.JobNo);
  const rawQuoteNo = textValue(payload.QuoteNo);

  result.projects.push({
    projectType,
    projectId,
    projectNo: rawQuoteNo ?? (projectType === "job" ? String(projectId) : rawJobNo) ?? String(projectId),
    quoteNo: rawQuoteNo,
    jobNo: rawJobNo,
    type: textValue(payload.Type),
    name: textValue(payload.Name),
    description: textValue(payload.Description),
    stageName: stage.stageName,
    customerStageName: stage.customerStageName,
    statusId: idFromRef(payload.Status),
    statusName: pickName(payload.Status),
    dateIssued: dateValue(payload.DateIssued),
    dateApproved: projectType === "quote" ? dateValue(payload.DateApproved) : null,
    completedDate,
    isCompleted: projectType === "job" ? Boolean(completedDate && isCompletedJobStage(stage.stageName)) : null,
    isClosed,
    quoteOutcome: quoteClassification?.outcome ?? null,
    quoteOutcomeReason: quoteClassification?.reason ?? null,
    quoteWon: quoteClassification?.won ?? null,
    linkedJobId: projectType === "quote" ? idValue(payload.LinkedJobID) : null,
    conversionJobId,
    sourceQuoteId,
    convertedFromType: projectType === "job" ? textValue(convertedFrom?.Type) : null,
    convertedFromAt: projectType === "job" ? extractJobConvertedFromAt(payload) : null,
    salespersonId: idFromRef(salesperson),
    salespersonName: pickName(salesperson),
    customerId: idFromRef(customer),
    customerName: pickName(customer),
    siteId: idFromRef(site),
    siteName: pickName(site),
    category: projectCategory(payload),
    totalExTax,
    totalTax: numberValue(total?.Tax),
    totalIncTax: numberValue(total?.IncTax),
    materialsCostEstimate: numberAt(totals, ["MaterialsCost", "Estimate"]),
    materialsCostActual: numberAt(totals, ["MaterialsCost", "Actual"]),
    resourcesCostEstimate: numberAt(totals, ["ResourcesCost", "Total", "Estimate"]),
    resourcesCostActual: numberAt(totals, ["ResourcesCost", "Total", "Actual"]),
    laborHoursEstimate: numberAt(totals, ["ResourcesCost", "LaborHours", "Estimate"]),
    laborHoursActual: numberAt(totals, ["ResourcesCost", "LaborHours", "Actual"]),
    grossProfitEstimate: numberAt(totals, ["GrossProfitLoss", "Estimate"]),
    grossProfitActual: jobFinancials.grossProfitActual,
    grossMarginEstimate: numberAt(totals, ["GrossMargin", "Estimate"]),
    grossMarginActual: jobFinancials.grossMarginActual,
    sourceHash: projectSourceHash,
    fetchedAt,
    sourceModifiedAt: projectSourceModifiedAt,
  });

  appendPeople(
    { projectType, projectId, projectSourceHash, projectSourceModifiedAt, fetchedAt },
    payload,
    result.people,
  );
  appendNestedRows(
    { projectType, projectId, projectSourceHash, projectSourceModifiedAt, fetchedAt },
    payload,
    result,
  );
}

export type BulkProjectFinancialValidationEvidence = {
  projectType: ProjectType;
  sourceId: number;
  requiredField: "Total.ExTax";
  reason: "missing" | "non_numeric";
  incTaxPresent: boolean;
  incTaxSubstitutionAllowed: false;
};

export class BulkProjectFinancialValidationError extends Error {
  readonly evidence: BulkProjectFinancialValidationEvidence;

  constructor(evidence: BulkProjectFinancialValidationEvidence) {
    const incTaxDetail = evidence.incTaxPresent
      ? " Total.IncTax is present but is not a permitted substitute."
      : "";
    super(
      `Invalid ${evidence.projectType} ${evidence.sourceId} Total.ExTax: ${evidence.reason === "missing" ? "missing required explicit Simpro ExTax" : "required explicit Simpro ExTax is not numeric"}.${incTaxDetail}`,
    );
    this.name = "BulkProjectFinancialValidationError";
    this.evidence = evidence;
  }
}

export function requireBulkProjectTotalExTax(
  payload: Record<string, unknown>,
  projectType: ProjectType,
  knownProjectId?: number,
): number {
  const sourceId = knownProjectId ?? requiredId(payload.ID, `${projectType} ID`);
  const total = recordValue(payload.Total);
  const rawExTax = total?.ExTax;
  const totalExTax = numberValue(rawExTax);
  if (totalExTax !== null) return totalExTax;

  throw new BulkProjectFinancialValidationError({
    projectType,
    sourceId,
    requiredField: "Total.ExTax",
    reason: rawExTax === null || rawExTax === undefined || rawExTax === "" ? "missing" : "non_numeric",
    incTaxPresent: numberValue(total?.IncTax) !== null,
    incTaxSubstitutionAllowed: false,
  });
}

type ProjectContext = ProjectIdentity & {
  projectSourceHash: string;
  projectSourceModifiedAt: string | null;
  fetchedAt: string;
};

function appendPeople(
  context: ProjectContext,
  payload: Record<string, unknown>,
  rows: BulkProjectPersonRow[],
): void {
  const candidates: Array<{ role: BulkProjectPersonRole; value: unknown }> = [
    { role: "salesperson", value: payload.Salesperson },
    { role: "project_manager", value: payload.ProjectManager },
    { role: "technician", value: payload.Technician },
    ...arrayRecords(payload.Technicians).map((value) => ({ role: "technician" as const, value })),
  ];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const person = recordValue(candidate.value);
    const personId = idFromRef(person);
    if (!person || personId === null) continue;
    const identity = `${candidate.role}:${personId}`;
    if (seen.has(identity)) continue;
    seen.add(identity);

    rows.push({
      ...childSourceFields(context, person),
      role: candidate.role,
      personId,
      personName: pickName(person),
      personType: textValue(person.Type),
      personTypeId: idValue(person.TypeId),
    });
  }
}

function appendNestedRows(
  context: ProjectContext,
  payload: Record<string, unknown>,
  result: FlattenedBulkProjectPage,
): void {
  for (const section of arrayRecords(payload.Sections)) {
    const sectionId = requiredId(section.ID, `${context.projectType} section ID`);
    for (const costCenter of arrayRecords(section.CostCenters)) {
      const costCenterFact = mapCostCenterFact(sectionId, costCenter);
      const total = recordValue(costCenter.Total);
      result.costCenters.push({
        ...childSourceFields(context, costCenter),
        sectionId,
        sectionName: textValue(section.Name),
        sectionDescription: textValue(section.Description),
        sectionDisplayOrder: integerValue(section.DisplayOrder),
        costCenterId: costCenterFact.costCenterId,
        configuredCostCenterId: costCenterFact.configuredCostCenterId,
        configuredCostCenterName: pickName(costCenter.CostCenter),
        costCenterName: costCenterFact.name,
        costCenterDisplayOrder: integerValue(costCenter.DisplayOrder),
        costCenterStage: textValue(costCenter.Stage),
        category: costCenterFact.category,
        laborHours: costCenterFact.laborHours,
        sellValue: costCenterFact.sellValue,
        costValue: costCenterFact.costValue,
        materialCostValue: costCenterFact.materialCostValue,
        totalExTax: numberValue(total?.ExTax),
        totalTax: numberValue(total?.Tax),
        totalIncTax: numberValue(total?.IncTax),
      });

      const itemCollections = recordValue(costCenter.Items);
      for (const labor of arrayRecords(itemCollections?.Labors)) {
        const laborFact = mapLaborFact(sectionId, costCenterFact.costCenterId, labor);
        result.labor.push({
          ...childSourceFields(context, labor),
          ...laborFact,
          unitSellExTax: numberAt(labor, ["SellPrice", "ExTax"]),
          unitSellIncTax: numberAt(labor, ["SellPrice", "IncTax"]),
          sellIncTax: numberAt(labor, ["Total", "Amount", "IncTax"]),
          discount: numberValue(labor.Discount),
        });
      }

      for (const [key, itemType] of ITEM_COLLECTIONS) {
        for (const item of arrayRecords(itemCollections?.[key])) {
          appendItem(context, sectionId, costCenterFact.costCenterId, itemType, item, result.items);
        }
      }
    }
  }
}

const ITEM_COLLECTIONS: ReadonlyArray<readonly [string, ProjectItemType]> = [
  ["Catalogs", "catalog"],
  ["ServiceFees", "service_fee"],
  ["OneOffs", "one_off"],
  ["Prebuilds", "prebuild"],
  ["Stock", "stock"],
  ["Stocks", "stock"],
];

function appendItem(
  context: ProjectContext,
  sectionId: number,
  costCenterId: number,
  itemType: ProjectItemType,
  item: Record<string, unknown>,
  rows: BulkProjectItemRow[],
): void {
  const fact = mapItemFact(sectionId, costCenterId, itemType, item);
  const reference = itemReference(itemType, item);
  rows.push({
    ...childSourceFields(context, item),
    ...fact,
    sourceItemName: pickName(reference),
    sourceItemPartNo: textValue(recordValue(reference)?.PartNo),
    unitSellExTax: numberAt(item, ["SellPrice", "ExTax"]),
    unitSellIncTax: numberAt(item, ["SellPrice", "IncTax"]),
    sellIncTax: itemType === "stock"
      ? multiply(numberValue(recordValue(item.Quantity)?.Required), numberValue(recordValue(item.Catalog)?.SellPrice))
      : numberAt(item, ["Total", "Amount", "IncTax"]),
    discount: numberValue(item.Discount),
  });
}

function childSourceFields(
  context: ProjectContext,
  payload: Record<string, unknown>,
): ChildSourceFields {
  return {
    projectType: context.projectType,
    projectId: context.projectId,
    projectSourceHash: context.projectSourceHash,
    projectSourceModifiedAt: context.projectSourceModifiedAt,
    sourceHash: sourceHash(payload),
    fetchedAt: context.fetchedAt,
    sourceModifiedAt: textValue(payload.DateModified),
  };
}

function projectCategory(payload: Record<string, unknown>): string {
  return dominantQuoteBusinessCategory(extractCostCenterRollups(payload).map((costCenter) => ({
    category: costCenter.category as "HVAC" | "Water Heating" | "Unclassified",
    sellValue: costCenter.sellValue,
  })));
}

function itemReference(itemType: ProjectItemType, item: Record<string, unknown>): unknown {
  if (itemType === "catalog" || itemType === "stock") return item.Catalog;
  if (itemType === "service_fee") return item.ServiceFee;
  if (itemType === "prebuild") return item.Prebuild;
  return null;
}

function dateValue(value: unknown): string | null {
  const text = textValue(value);
  const match = text?.match(/^\d{4}-\d{2}-\d{2}/);
  return match?.[0] ?? null;
}

function booleanValue(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string" && /^(true|false)$/i.test(value.trim())) {
    return value.trim().toLowerCase() === "true";
  }
  return null;
}

function idFromRef(value: unknown): number | null {
  return idValue(pickId(value));
}

function requiredId(value: unknown, label: string): number {
  const id = idValue(value);
  if (id === null) throw new Error(`Missing ${label}`);
  return id;
}

function idValue(value: unknown): number | null {
  const number = numberValue(value);
  return number !== null && Number.isInteger(number) && number > 0 ? number : null;
}

function integerValue(value: unknown): number | null {
  const number = numberValue(value);
  return number !== null && Number.isInteger(number) ? number : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const number = Number(value.replace(/[$,]/g, ""));
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

function numberAt(value: unknown, path: string[]): number | null {
  let cursor: unknown = value;
  for (const key of path) {
    cursor = recordValue(cursor)?.[key];
  }
  return numberValue(cursor);
}

function multiply(left: number | null, right: number | null): number | null {
  return left !== null && right !== null ? Math.round(left * right * 100) / 100 : null;
}

function textValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  return text || null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function arrayRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(recordValue).filter((row): row is Record<string, unknown> => row !== null)
    : [];
}
