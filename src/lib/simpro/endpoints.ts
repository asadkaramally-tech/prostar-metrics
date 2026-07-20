import type { ZodType } from "zod";
import { SimproClient, type RequestBudget, type SimproPage } from "@/lib/simpro/client";
import {
  parseSimproResponse,
  parseSimproRows,
  simproCatalogDetailSchema,
  simproCatalogSummarySchema,
  simproCostCenterDetailSchema,
  simproCostCenterSummarySchema,
  simproEmployeeDetailSchema,
  simproEmployeeSummarySchema,
  simproJobLogSchema,
  simproJobSchema,
  simproLaborDetailSchema,
  simproLaborSummarySchema,
  simproMobileStatusLogSchema,
  simproOneOffDetailSchema,
  simproOneOffSummarySchema,
  simproPrebuildDetailSchema,
  simproPrebuildSummarySchema,
  simproQuoteLogSchema,
  simproQuoteSchema,
  simproScheduleDetailSchema,
  simproScheduleLogSchema,
  simproScheduleSummarySchema,
  simproSectionDetailSchema,
  simproSectionSummarySchema,
  simproServiceFeeDetailSchema,
  simproServiceFeeSummarySchema,
  simproStockSchema,
  simproSummarySchema,
  simproTimesheetSchema,
  simproWorkOrderDetailSchema,
  simproWorkOrderSummarySchema,
  type SimproCatalogDetail,
  type SimproCatalogSummary,
  type SimproCostCenterDetail,
  type SimproCostCenterSummary,
  type SimproEmployeeDetail,
  type SimproEmployeeSummary,
  type SimproJob,
  type SimproJobLog,
  type SimproLaborDetail,
  type SimproLaborSummary,
  type SimproMobileStatusLog,
  type SimproOneOffDetail,
  type SimproOneOffSummary,
  type SimproPrebuildDetail,
  type SimproPrebuildSummary,
  type SimproQuote,
  type SimproQuoteLog,
  type SimproScheduleDetail,
  type SimproScheduleLog,
  type SimproScheduleSummary,
  type SimproSectionDetail,
  type SimproSectionSummary,
  type SimproServiceFeeDetail,
  type SimproServiceFeeSummary,
  type SimproStock,
  type SimproSummary,
  type SimproTimesheet,
  type SimproWorkOrderDetail,
  type SimproWorkOrderSummary,
} from "@/lib/simpro/schemas";

export type EntityPageOptions = {
  page?: number;
  pageSize?: number;
  budget?: RequestBudget;
  query?: Record<string, unknown>;
};

export class SimproEndpoints {
  constructor(private readonly client: SimproClient) {}

  listQuotes(options: EntityPageOptions = {}): Promise<SimproPage<SimproSummary>> {
    return this.listPage("/quotes/", simproSummarySchema, options);
  }

  getQuote(quoteId: Id, budget?: RequestBudget): Promise<SimproQuote> {
    return this.getDetail(`/quotes/${encodeId(quoteId)}`, simproQuoteSchema, budget);
  }

  listQuoteSections(quoteId: Id, options: EntityPageOptions = {}): Promise<SimproPage<SimproSectionSummary>> {
    return this.listPage(`/quotes/${encodeId(quoteId)}/sections/`, simproSectionSummarySchema, options);
  }

  getQuoteSection(quoteId: Id, sectionId: Id, budget?: RequestBudget): Promise<SimproSectionDetail> {
    return this.getDetail(`/quotes/${encodeId(quoteId)}/sections/${encodeId(sectionId)}`, simproSectionDetailSchema, budget);
  }

  listQuoteCostCenters(quoteId: Id, sectionId: Id, options: EntityPageOptions = {}): Promise<SimproPage<SimproCostCenterSummary>> {
    return this.listPage(`${quoteCostCenterBase(quoteId, sectionId)}/`, simproCostCenterSummarySchema, options);
  }

  getQuoteCostCenter(quoteId: Id, sectionId: Id, costCenterId: Id, budget?: RequestBudget): Promise<SimproCostCenterDetail> {
    return this.getDetail(quoteCostCenterPath(quoteId, sectionId, costCenterId), simproCostCenterDetailSchema, budget);
  }

  listQuoteLabor(quoteId: Id, sectionId: Id, costCenterId: Id, options: EntityPageOptions = {}): Promise<SimproPage<SimproLaborSummary>> {
    return this.listPage(`${quoteCostCenterPath(quoteId, sectionId, costCenterId)}/labor/`, simproLaborSummarySchema, options);
  }

  getQuoteLabor(quoteId: Id, sectionId: Id, costCenterId: Id, laborId: Id, budget?: RequestBudget): Promise<SimproLaborDetail> {
    return this.getDetail(`${quoteCostCenterPath(quoteId, sectionId, costCenterId)}/labor/${encodeId(laborId)}`, simproLaborDetailSchema, budget);
  }

  listQuoteCatalogs(quoteId: Id, sectionId: Id, costCenterId: Id, options: EntityPageOptions = {}): Promise<SimproPage<SimproCatalogSummary>> {
    return this.listPage(`${quoteCostCenterPath(quoteId, sectionId, costCenterId)}/catalogs/`, simproCatalogSummarySchema, options);
  }

  getQuoteCatalog(quoteId: Id, sectionId: Id, costCenterId: Id, catalogId: Id, budget?: RequestBudget): Promise<SimproCatalogDetail> {
    return this.getDetail(`${quoteCostCenterPath(quoteId, sectionId, costCenterId)}/catalogs/${encodeId(catalogId)}`, simproCatalogDetailSchema, budget);
  }

  listQuoteServiceFees(quoteId: Id, sectionId: Id, costCenterId: Id, options: EntityPageOptions = {}): Promise<SimproPage<SimproServiceFeeSummary>> {
    return this.listPage(`${quoteCostCenterPath(quoteId, sectionId, costCenterId)}/serviceFees/`, simproServiceFeeSummarySchema, options);
  }

  getQuoteServiceFee(quoteId: Id, sectionId: Id, costCenterId: Id, serviceFeeId: Id, budget?: RequestBudget): Promise<SimproServiceFeeDetail> {
    return this.getDetail(`${quoteCostCenterPath(quoteId, sectionId, costCenterId)}/serviceFees/${encodeId(serviceFeeId)}`, simproServiceFeeDetailSchema, budget);
  }

  listQuoteOneOffs(quoteId: Id, sectionId: Id, costCenterId: Id, options: EntityPageOptions = {}): Promise<SimproPage<SimproOneOffSummary>> {
    return this.listPage(`${quoteCostCenterPath(quoteId, sectionId, costCenterId)}/oneOffs/`, simproOneOffSummarySchema, options);
  }

  getQuoteOneOff(quoteId: Id, sectionId: Id, costCenterId: Id, oneOffId: Id, budget?: RequestBudget): Promise<SimproOneOffDetail> {
    return this.getDetail(`${quoteCostCenterPath(quoteId, sectionId, costCenterId)}/oneOffs/${encodeId(oneOffId)}`, simproOneOffDetailSchema, budget);
  }

  listQuotePrebuilds(quoteId: Id, sectionId: Id, costCenterId: Id, options: EntityPageOptions = {}): Promise<SimproPage<SimproPrebuildSummary>> {
    return this.listPage(`${quoteCostCenterPath(quoteId, sectionId, costCenterId)}/prebuilds/`, simproPrebuildSummarySchema, options);
  }

  getQuotePrebuild(quoteId: Id, sectionId: Id, costCenterId: Id, prebuildId: Id, budget?: RequestBudget): Promise<SimproPrebuildDetail> {
    return this.getDetail(`${quoteCostCenterPath(quoteId, sectionId, costCenterId)}/prebuilds/${encodeId(prebuildId)}`, simproPrebuildDetailSchema, budget);
  }

  listQuoteSchedules(quoteId: Id, sectionId: Id, costCenterId: Id, options: EntityPageOptions = {}): Promise<SimproPage<SimproScheduleSummary>> {
    return this.listPage(`${quoteCostCenterPath(quoteId, sectionId, costCenterId)}/schedules/`, simproScheduleSummarySchema, options);
  }

  getQuoteSchedule(quoteId: Id, sectionId: Id, costCenterId: Id, scheduleId: Id, budget?: RequestBudget): Promise<SimproScheduleDetail> {
    return this.getDetail(`${quoteCostCenterPath(quoteId, sectionId, costCenterId)}/schedules/${encodeId(scheduleId)}`, simproScheduleDetailSchema, budget);
  }

  listQuoteWorkOrders(quoteId: Id, sectionId: Id, costCenterId: Id, options: EntityPageOptions = {}): Promise<SimproPage<SimproWorkOrderSummary>> {
    return this.listPage(`${quoteCostCenterPath(quoteId, sectionId, costCenterId)}/workOrders/`, simproWorkOrderSummarySchema, options);
  }

  getQuoteWorkOrder(quoteId: Id, sectionId: Id, costCenterId: Id, workOrderId: Id, budget?: RequestBudget): Promise<SimproWorkOrderDetail> {
    return this.getDetail(`${quoteCostCenterPath(quoteId, sectionId, costCenterId)}/workOrders/${encodeId(workOrderId)}`, simproWorkOrderDetailSchema, budget);
  }

  listJobs(options: EntityPageOptions = {}): Promise<SimproPage<SimproSummary>> {
    return this.listPage("/jobs/", simproSummarySchema, options);
  }

  getJob(jobId: Id, budget?: RequestBudget): Promise<SimproJob> {
    return this.getDetail(`/jobs/${encodeId(jobId)}`, simproJobSchema, budget);
  }

  listJobSections(jobId: Id, options: EntityPageOptions = {}): Promise<SimproPage<SimproSectionSummary>> {
    return this.listPage(`/jobs/${encodeId(jobId)}/sections/`, simproSectionSummarySchema, options);
  }

  getJobSection(jobId: Id, sectionId: Id, budget?: RequestBudget): Promise<SimproSectionDetail> {
    return this.getDetail(`/jobs/${encodeId(jobId)}/sections/${encodeId(sectionId)}`, simproSectionDetailSchema, budget);
  }

  listJobCostCenters(jobId: Id, sectionId: Id, options: EntityPageOptions = {}): Promise<SimproPage<SimproCostCenterSummary>> {
    return this.listPage(`${jobCostCenterBase(jobId, sectionId)}/`, simproCostCenterSummarySchema, options);
  }

  getJobCostCenter(jobId: Id, sectionId: Id, costCenterId: Id, budget?: RequestBudget): Promise<SimproCostCenterDetail> {
    return this.getDetail(jobCostCenterPath(jobId, sectionId, costCenterId), simproCostCenterDetailSchema, budget);
  }

  listJobLabor(jobId: Id, sectionId: Id, costCenterId: Id, options: EntityPageOptions = {}): Promise<SimproPage<SimproLaborSummary>> {
    return this.listPage(`${jobCostCenterPath(jobId, sectionId, costCenterId)}/labor/`, simproLaborSummarySchema, options);
  }

  getJobLabor(jobId: Id, sectionId: Id, costCenterId: Id, laborId: Id, budget?: RequestBudget): Promise<SimproLaborDetail> {
    return this.getDetail(`${jobCostCenterPath(jobId, sectionId, costCenterId)}/labor/${encodeId(laborId)}`, simproLaborDetailSchema, budget);
  }

  listJobCatalogs(jobId: Id, sectionId: Id, costCenterId: Id, options: EntityPageOptions = {}): Promise<SimproPage<SimproCatalogSummary>> {
    return this.listPage(`${jobCostCenterPath(jobId, sectionId, costCenterId)}/catalogs/`, simproCatalogSummarySchema, options);
  }

  getJobCatalog(jobId: Id, sectionId: Id, costCenterId: Id, catalogId: Id, budget?: RequestBudget): Promise<SimproCatalogDetail> {
    return this.getDetail(`${jobCostCenterPath(jobId, sectionId, costCenterId)}/catalogs/${encodeId(catalogId)}`, simproCatalogDetailSchema, budget);
  }

  listJobServiceFees(jobId: Id, sectionId: Id, costCenterId: Id, options: EntityPageOptions = {}): Promise<SimproPage<SimproServiceFeeSummary>> {
    return this.listPage(`${jobCostCenterPath(jobId, sectionId, costCenterId)}/serviceFees/`, simproServiceFeeSummarySchema, options);
  }

  getJobServiceFee(jobId: Id, sectionId: Id, costCenterId: Id, serviceFeeId: Id, budget?: RequestBudget): Promise<SimproServiceFeeDetail> {
    return this.getDetail(`${jobCostCenterPath(jobId, sectionId, costCenterId)}/serviceFees/${encodeId(serviceFeeId)}`, simproServiceFeeDetailSchema, budget);
  }

  listJobOneOffs(jobId: Id, sectionId: Id, costCenterId: Id, options: EntityPageOptions = {}): Promise<SimproPage<SimproOneOffSummary>> {
    return this.listPage(`${jobCostCenterPath(jobId, sectionId, costCenterId)}/oneOffs/`, simproOneOffSummarySchema, options);
  }

  getJobOneOff(jobId: Id, sectionId: Id, costCenterId: Id, oneOffId: Id, budget?: RequestBudget): Promise<SimproOneOffDetail> {
    return this.getDetail(`${jobCostCenterPath(jobId, sectionId, costCenterId)}/oneOffs/${encodeId(oneOffId)}`, simproOneOffDetailSchema, budget);
  }

  listJobPrebuilds(jobId: Id, sectionId: Id, costCenterId: Id, options: EntityPageOptions = {}): Promise<SimproPage<SimproPrebuildSummary>> {
    return this.listPage(`${jobCostCenterPath(jobId, sectionId, costCenterId)}/prebuilds/`, simproPrebuildSummarySchema, options);
  }

  getJobPrebuild(jobId: Id, sectionId: Id, costCenterId: Id, prebuildId: Id, budget?: RequestBudget): Promise<SimproPrebuildDetail> {
    return this.getDetail(`${jobCostCenterPath(jobId, sectionId, costCenterId)}/prebuilds/${encodeId(prebuildId)}`, simproPrebuildDetailSchema, budget);
  }

  listJobStock(jobId: Id, sectionId: Id, costCenterId: Id, budget?: RequestBudget): Promise<SimproStock[]> {
    return this.listUnpaged(`${jobCostCenterPath(jobId, sectionId, costCenterId)}/stock/`, simproStockSchema, budget);
  }

  getJobStock(jobId: Id, sectionId: Id, costCenterId: Id, stockId: Id, budget?: RequestBudget): Promise<SimproStock> {
    return this.getDetail(`${jobCostCenterPath(jobId, sectionId, costCenterId)}/stock/${encodeId(stockId)}`, simproStockSchema, budget);
  }

  listJobSchedules(jobId: Id, sectionId: Id, costCenterId: Id, options: EntityPageOptions = {}): Promise<SimproPage<SimproScheduleSummary>> {
    return this.listPage(`${jobCostCenterPath(jobId, sectionId, costCenterId)}/schedules/`, simproScheduleSummarySchema, options);
  }

  getJobSchedule(jobId: Id, sectionId: Id, costCenterId: Id, scheduleId: Id, budget?: RequestBudget): Promise<SimproScheduleDetail> {
    return this.getDetail(`${jobCostCenterPath(jobId, sectionId, costCenterId)}/schedules/${encodeId(scheduleId)}`, simproScheduleDetailSchema, budget);
  }

  listJobWorkOrders(jobId: Id, sectionId: Id, costCenterId: Id, options: EntityPageOptions = {}): Promise<SimproPage<SimproWorkOrderSummary>> {
    return this.listPage(`${jobCostCenterPath(jobId, sectionId, costCenterId)}/workOrders/`, simproWorkOrderSummarySchema, options);
  }

  getJobWorkOrder(jobId: Id, sectionId: Id, costCenterId: Id, workOrderId: Id, budget?: RequestBudget): Promise<SimproWorkOrderDetail> {
    return this.getDetail(`${jobCostCenterPath(jobId, sectionId, costCenterId)}/workOrders/${encodeId(workOrderId)}`, simproWorkOrderDetailSchema, budget);
  }

  listEmployees(options: EntityPageOptions = {}): Promise<SimproPage<SimproEmployeeSummary>> {
    return this.listPage("/employees/", simproEmployeeSummarySchema, options);
  }

  getEmployee(employeeId: Id, budget?: RequestBudget): Promise<SimproEmployeeDetail> {
    return this.getDetail(`/employees/${encodeId(employeeId)}`, simproEmployeeDetailSchema, budget);
  }

  async listEmployeeTimesheets(employeeId: Id, options: EntityPageOptions = {}): Promise<SimproPage<SimproTimesheet>> {
    const path = `/employees/${encodeId(employeeId)}/timesheets/`;
    const rows = await this.listUnpaged(path, simproTimesheetSchema, options.budget, options.query);
    return { rows, page: 1, pageSize: rows.length, hasMore: false, continuationToken: null };
  }

  listSchedules(options: EntityPageOptions = {}): Promise<SimproPage<SimproScheduleSummary>> {
    return this.listPage("/schedules/", simproScheduleSummarySchema, options);
  }

  getSchedule(scheduleId: Id, budget?: RequestBudget): Promise<SimproScheduleDetail> {
    return this.getDetail(`/schedules/${encodeId(scheduleId)}`, simproScheduleDetailSchema, budget);
  }

  listQuoteLogs(options: EntityPageOptions = {}): Promise<SimproPage<SimproQuoteLog>> {
    return this.listPage("/logs/quotes/", simproQuoteLogSchema, options);
  }

  getQuoteLog(logId: Id, budget?: RequestBudget): Promise<SimproQuoteLog> {
    return this.getDetail(`/logs/quotes/${encodeId(logId)}`, simproQuoteLogSchema, budget);
  }

  listJobLogs(options: EntityPageOptions = {}): Promise<SimproPage<SimproJobLog>> {
    return this.listPage("/logs/jobs/", simproJobLogSchema, options);
  }

  getJobLog(logId: Id, budget?: RequestBudget): Promise<SimproJobLog> {
    return this.getDetail(`/logs/jobs/${encodeId(logId)}`, simproJobLogSchema, budget);
  }

  listScheduleLogs(options: EntityPageOptions = {}): Promise<SimproPage<SimproScheduleLog>> {
    return this.listPage("/logs/schedules/", simproScheduleLogSchema, options);
  }

  getScheduleLog(logId: Id, budget?: RequestBudget): Promise<SimproScheduleLog> {
    return this.getDetail(`/logs/schedules/${encodeId(logId)}`, simproScheduleLogSchema, budget);
  }

  listMobileStatusLogs(options: EntityPageOptions = {}): Promise<SimproPage<SimproMobileStatusLog>> {
    return this.listPage("/logs/mobileStatus/", simproMobileStatusLogSchema, options);
  }

  getMobileStatusLog(logId: Id, budget?: RequestBudget): Promise<SimproMobileStatusLog> {
    return this.getDetail(`/logs/mobileStatus/${encodeId(logId)}`, simproMobileStatusLogSchema, budget);
  }

  private async listPage<T extends Record<string, unknown>>(path: string, schema: ZodType<T>, options: EntityPageOptions): Promise<SimproPage<T>> {
    const page = await this.client.getPage<Record<string, unknown>>(path, {
      pageSize: options.pageSize,
      startPage: options.page,
      requestBudget: options.budget,
      query: options.query,
    });
    return { ...page, rows: parseSimproRows(schema, page.rows, `GET ${path}`) };
  }

  private async getDetail<T>(path: string, schema: ZodType<T>, budget?: RequestBudget): Promise<T> {
    return parseSimproResponse(schema, await this.client.getJson<unknown>(path, undefined, budget), `GET ${path}`);
  }

  private async listUnpaged<T>(path: string, schema: ZodType<T>, budget?: RequestBudget, query?: Record<string, unknown>): Promise<T[]> {
    const value = await this.client.getJson<unknown>(path, query, budget);
    if (!Array.isArray(value)) {
      return [parseSimproResponse(schema, value, `GET ${path}`)];
    }
    return parseSimproRows(schema, value, `GET ${path}`);
  }
}

type Id = string | number;

function encodeId(value: Id): string {
  return encodeURIComponent(String(value));
}

function quoteCostCenterBase(quoteId: Id, sectionId: Id): string {
  return `/quotes/${encodeId(quoteId)}/sections/${encodeId(sectionId)}/costCenters`;
}

function quoteCostCenterPath(quoteId: Id, sectionId: Id, costCenterId: Id): string {
  return `${quoteCostCenterBase(quoteId, sectionId)}/${encodeId(costCenterId)}`;
}

function jobCostCenterBase(jobId: Id, sectionId: Id): string {
  return `/jobs/${encodeId(jobId)}/sections/${encodeId(sectionId)}/costCenters`;
}

function jobCostCenterPath(jobId: Id, sectionId: Id, costCenterId: Id): string {
  return `${jobCostCenterBase(jobId, sectionId)}/${encodeId(costCenterId)}`;
}
