import { z } from "zod";

const idSchema = z.union([z.number().int(), z.string().min(1)]);
const optionalNullableIdSchema = z.preprocess(
  (value) => value === "" ? null : value,
  idSchema.nullable().optional(),
);
const moneySchema = z.union([z.number(), z.string()]).pipe(z.coerce.number());
const nullableDateSchema = z.string().nullable().optional();
const unknownObjectSchema = z.record(z.string(), z.unknown());

export const simproNamedRefSchema = z.object({
  ID: idSchema.optional(),
  Name: z.string().optional(),
  _href: z.string().optional(),
}).passthrough();

export const simproStaffRefSchema = z.object({
  ID: idSchema,
  Name: z.string(),
  Type: z.string().optional(),
  TypeId: idSchema.optional(),
}).passthrough();

export const simproMoneyTotalSchema = z.object({
  ExTax: moneySchema,
  Tax: moneySchema.optional(),
  IncTax: moneySchema,
}).passthrough();

export const simproAmountSchema = z.object({
  ExTax: moneySchema,
  IncTax: moneySchema,
}).passthrough();

export const simproQuantityTotalSchema = z.object({
  Qty: moneySchema,
  Amount: simproAmountSchema,
}).passthrough();

export const simproSummarySchema = z.object({
  ID: idSchema,
  Name: z.string().optional(),
  Description: z.string().optional(),
  Total: simproMoneyTotalSchema.optional(),
  _href: z.string().optional(),
}).passthrough();

export const simproQuoteSchema = z.object({
  ID: idSchema,
  QuoteNo: z.string().optional(),
  Name: z.string(),
  Description: z.string(),
  Salesperson: simproStaffRefSchema.nullable().optional(),
  DateIssued: z.string(),
  DateApproved: nullableDateSchema,
  IsClosed: z.boolean(),
  Stage: z.string(),
  CustomerStage: z.string().nullable().optional(),
  JobNo: z.union([z.string(), z.number()]).transform(String).nullable().optional(),
  LinkedJobID: idSchema.nullable().optional(),
  Total: simproMoneyTotalSchema,
  Totals: unknownObjectSchema,
  Status: simproNamedRefSchema,
  DateModified: z.string(),
}).passthrough();

export const simproJobSchema = z.object({
  ID: idSchema,
  JobNo: z.string().optional(),
  Name: z.string(),
  Description: z.string(),
  Stage: z.string(),
  Status: simproNamedRefSchema,
  CompletedDate: nullableDateSchema,
  ConvertedFromQuote: simproSummarySchema.nullable().optional(),
  ConvertedFrom: z.object({
    ID: idSchema.optional(),
    Type: z.string().optional(),
    Date: z.string().optional(),
  }).passthrough().nullable().optional(),
  Customer: simproSummarySchema,
  Site: simproSummarySchema,
  Total: simproMoneyTotalSchema,
  Totals: unknownObjectSchema,
  DateModified: z.string(),
}).passthrough();

export const simproSectionSummarySchema = z.object({
  ID: idSchema,
  Name: z.string(),
  Description: z.string(),
  DisplayOrder: z.number().int(),
}).passthrough();

export const simproSectionDetailSchema = simproSectionSummarySchema.extend({
  IsVariation: z.boolean(),
  DateModified: z.string(),
}).passthrough();

const optionalPercentCompleteSchema = z.preprocess(
  (value) => value === "" || value === null ? undefined : value,
  z.number().optional(),
);

export const simproCostCenterSummarySchema = z.object({
  ID: idSchema,
  CostCenter: simproNamedRefSchema,
  Name: z.string(),
  DisplayOrder: z.number().int(),
  Total: simproMoneyTotalSchema,
  JobID: idSchema.optional(),
  PercentComplete: optionalPercentCompleteSchema,
}).passthrough();

export const simproCostCenterDetailSchema = simproCostCenterSummarySchema.extend({
  Stage: z.string().nullable().optional(),
  StartDate: nullableDateSchema,
  EndDate: nullableDateSchema,
  Totals: unknownObjectSchema,
  DateModified: z.string(),
  PercentComplete: optionalPercentCompleteSchema,
}).passthrough();

export const simproLaborSummarySchema = z.object({
  ID: idSchema,
  LaborType: simproNamedRefSchema,
  Discount: moneySchema,
  SellPrice: unknownObjectSchema,
  Total: simproQuantityTotalSchema,
  Claimed: unknownObjectSchema.nullable().optional(),
}).passthrough();

export const simproLaborDetailSchema = simproLaborSummarySchema.extend({
  LaborRate: moneySchema,
  LaborMarkup: moneySchema,
  ProjectedTime: moneySchema.optional(),
  DateModified: z.string(),
}).passthrough();

const billableItemBase = z.object({
  ID: idSchema,
  BillableStatus: z.string(),
  Discount: moneySchema,
  SellPrice: unknownObjectSchema,
  Total: simproQuantityTotalSchema,
  Claimed: unknownObjectSchema.nullable().optional(),
}).passthrough();

export const simproCatalogSummarySchema = billableItemBase.extend({
  Catalog: simproNamedRefSchema,
  BasePrice: moneySchema,
  Markup: moneySchema,
}).passthrough();

export const simproCatalogDetailSchema = simproCatalogSummarySchema.extend({
  EstimatedTime: moneySchema,
  LaborCost: moneySchema,
  Totals: unknownObjectSchema,
  DateModified: z.string(),
}).passthrough();

export const simproServiceFeeSummarySchema = billableItemBase.extend({
  ServiceFee: simproNamedRefSchema,
}).passthrough();

export const simproServiceFeeDetailSchema = simproServiceFeeSummarySchema.extend({
  BasePrice: moneySchema,
  Markup: moneySchema,
  LaborCost: moneySchema,
  Totals: unknownObjectSchema,
  DateModified: z.string(),
}).passthrough();

export const simproOneOffSummarySchema = billableItemBase.extend({
  Type: z.string(),
  Description: z.string(),
}).passthrough();

export const simproOneOffDetailSchema = simproOneOffSummarySchema.extend({
  EstimatedCost: moneySchema,
  ActualCost: moneySchema,
  EstimatedTime: moneySchema,
  LaborCost: moneySchema,
  DateModified: z.string(),
}).passthrough();

export const simproPrebuildSummarySchema = billableItemBase.extend({
  Prebuild: simproNamedRefSchema,
}).passthrough();

export const simproPrebuildDetailSchema = simproPrebuildSummarySchema.extend({
  EstimatedTime: moneySchema,
  LaborCost: moneySchema,
  Totals: unknownObjectSchema,
  DateModified: z.string(),
}).passthrough();

export const simproStockSchema = z.object({
  Catalog: simproNamedRefSchema.extend({
    PartNo: z.string(),
    BasePrice: moneySchema,
    SellPrice: moneySchema,
  }).passthrough(),
  Quantity: z.object({
    Required: moneySchema,
    Assigned: moneySchema,
  }).passthrough(),
  AssignedBreakdown: z.array(unknownObjectSchema),
}).passthrough();

export const simproScheduleBlockSchema = z.object({
  Hrs: moneySchema,
  StartTime: z.string(),
  ISO8601StartTime: z.string(),
  EndTime: z.string(),
  ISO8601EndTime: z.string(),
  ScheduleRate: simproNamedRefSchema,
}).passthrough();

export const simproScheduleSummarySchema = z.object({
  ID: idSchema,
  Type: z.string().optional(),
  Reference: z.string().optional(),
  TotalHours: moneySchema,
  Staff: simproStaffRefSchema,
  Date: z.string(),
  Blocks: z.array(simproScheduleBlockSchema).optional(),
  Project: z.union([
    z.string(),
    z.object({
      ProjectID: idSchema,
      SectionID: idSchema.optional(),
      CostCenterID: idSchema.optional(),
    }).passthrough(),
  ]).nullable().optional(),
}).passthrough();

export const simproScheduleDetailSchema = simproScheduleSummarySchema.extend({
  Notes: z.string().nullable().optional(),
  Blocks: z.array(simproScheduleBlockSchema),
  _href: z.string().optional(),
  DateModified: z.string(),
}).passthrough();

export const simproWorkOrderSummarySchema = z.object({
  ID: idSchema,
  Staff: simproStaffRefSchema,
  WorkOrderDate: z.string(),
}).passthrough();

export const simproWorkOrderDetailSchema = simproWorkOrderSummarySchema.extend({
  Approved: z.boolean(),
  Materials: z.array(unknownObjectSchema),
  Blocks: z.array(simproScheduleBlockSchema),
  ScheduledHrs: moneySchema,
  ISO8601ScheduledStartTime: z.string(),
  ISO8601ScheduledEndTime: z.string(),
  DateModified: z.string(),
}).passthrough();

export const simproEmployeeSummarySchema = z.object({
  ID: idSchema,
  Name: z.string(),
}).passthrough();

export const simproEmployeeDetailSchema = simproEmployeeSummarySchema.extend({
  Position: z.string(),
  PrimaryContact: z.object({
    Email: z.string(),
  }).passthrough(),
  DateCreated: z.string(),
  DateModified: z.string(),
  Archived: z.boolean(),
}).passthrough();

export const simproTimesheetSchema = z.object({
  UID: z.string(),
  ScheduleType: z.enum(["Activity", "Job", "Lead", "Quote"]),
  Reference: z.string(),
  _href: z.string(),
  Date: z.string(),
  StartTime: z.string(),
  EndTime: z.string(),
  TotalHrs: moneySchema,
  ScheduleRate: simproNamedRefSchema,
  Cost: moneySchema,
  OverheadCost: moneySchema,
  TotalCost: moneySchema,
}).passthrough();

const changeLogBase = z.object({
  ID: idSchema,
  Message: z.string(),
  Staff: simproStaffRefSchema.partial().nullable().optional(),
  DateLogged: z.string(),
}).passthrough();

export const simproQuoteLogSchema = changeLogBase.extend({ QuoteID: idSchema.nullable().optional() }).passthrough();
export const simproJobLogSchema = changeLogBase.extend({ JobID: idSchema.nullable().optional() }).passthrough();
export const simproScheduleLogSchema = changeLogBase.extend({
  ScheduleID: idSchema.nullable().optional(),
  ScheduleEmployee: simproStaffRefSchema.partial().nullable().optional(),
  Type: z.string().optional(),
}).passthrough();
export const simproMobileStatusLogSchema = z.object({
  ID: idSchema,
  Staff: simproStaffRefSchema.partial(),
  WorkOrder: z.object({
    ID: optionalNullableIdSchema,
    Type: z.string().nullable().optional(),
    ProjectID: idSchema.nullable().optional(),
    CostCenterID: idSchema.nullable().optional(),
    _href: z.string().nullable().optional(),
  }).passthrough().nullable().optional(),
  Status: z.object({
    ID: idSchema,
    Name: z.union([z.string(), z.number()]).transform(String),
    Color: z.string(),
  }).passthrough(),
  Latitude: moneySchema.nullable().optional(),
  Longitude: moneySchema.nullable().optional(),
  DateLogged: z.string(),
}).passthrough();

export type SimproSummary = z.infer<typeof simproSummarySchema>;
export type SimproQuote = z.infer<typeof simproQuoteSchema>;
export type SimproJob = z.infer<typeof simproJobSchema>;
export type SimproSectionSummary = z.infer<typeof simproSectionSummarySchema>;
export type SimproSectionDetail = z.infer<typeof simproSectionDetailSchema>;
export type SimproCostCenterSummary = z.infer<typeof simproCostCenterSummarySchema>;
export type SimproCostCenterDetail = z.infer<typeof simproCostCenterDetailSchema>;
export type SimproLaborSummary = z.infer<typeof simproLaborSummarySchema>;
export type SimproLaborDetail = z.infer<typeof simproLaborDetailSchema>;
export type SimproCatalogSummary = z.infer<typeof simproCatalogSummarySchema>;
export type SimproCatalogDetail = z.infer<typeof simproCatalogDetailSchema>;
export type SimproServiceFeeSummary = z.infer<typeof simproServiceFeeSummarySchema>;
export type SimproServiceFeeDetail = z.infer<typeof simproServiceFeeDetailSchema>;
export type SimproOneOffSummary = z.infer<typeof simproOneOffSummarySchema>;
export type SimproOneOffDetail = z.infer<typeof simproOneOffDetailSchema>;
export type SimproPrebuildSummary = z.infer<typeof simproPrebuildSummarySchema>;
export type SimproPrebuildDetail = z.infer<typeof simproPrebuildDetailSchema>;
export type SimproStock = z.infer<typeof simproStockSchema>;
export type SimproScheduleSummary = z.infer<typeof simproScheduleSummarySchema>;
export type SimproScheduleDetail = z.infer<typeof simproScheduleDetailSchema>;
export type SimproWorkOrderSummary = z.infer<typeof simproWorkOrderSummarySchema>;
export type SimproWorkOrderDetail = z.infer<typeof simproWorkOrderDetailSchema>;
export type SimproEmployeeSummary = z.infer<typeof simproEmployeeSummarySchema>;
export type SimproEmployeeDetail = z.infer<typeof simproEmployeeDetailSchema>;
export type SimproTimesheet = z.infer<typeof simproTimesheetSchema>;
export type SimproQuoteLog = z.infer<typeof simproQuoteLogSchema>;
export type SimproJobLog = z.infer<typeof simproJobLogSchema>;
export type SimproScheduleLog = z.infer<typeof simproScheduleLogSchema>;
export type SimproMobileStatusLog = z.infer<typeof simproMobileStatusLogSchema>;
export type SimproNamedRef = z.infer<typeof simproNamedRefSchema>;

export class SimproSchemaError extends Error {
  constructor(readonly context: string, readonly issues: z.core.$ZodIssue[]) {
    super(`Simpro response failed schema validation for ${context}: ${issues.map((issue) => issue.path.join(".") || "root").join(", ")}`);
    this.name = "SimproSchemaError";
  }
}

export function parseSimproResponse<T>(schema: z.ZodType<T>, value: unknown, context: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new SimproSchemaError(context, parsed.error.issues);
  }
  return parsed.data;
}

export function parseSimproRows<T>(schema: z.ZodType<T>, rows: unknown[], context: string): T[] {
  return rows.map((row, index) => parseSimproResponse(schema, row, `${context}[${index}]`));
}

export function pickId(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = record.ID ?? record.Id ?? record.id;
  return id === undefined || id === null || id === "" ? null : String(id);
}

export function pickName(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const name = record.Name ?? record.name ?? record.DisplayName ?? record.displayName;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}
