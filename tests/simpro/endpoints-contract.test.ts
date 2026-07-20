import assert from "node:assert/strict";
import test from "node:test";
import { SimproEndpoints } from "../../src/lib/simpro/endpoints";
import { SimproSchemaError } from "../../src/lib/simpro/schemas";
import type { SimproClient, SimproPage } from "../../src/lib/simpro/client";

class StubClient {
  calls: Array<{ kind: string; path: string; query?: Record<string, unknown> }> = [];
  pageRows: Record<string, unknown>[] = [];
  detail: unknown = {};

  async getPage<T extends Record<string, unknown>>(
    path: string,
    options: { query?: Record<string, unknown> } = {},
  ): Promise<SimproPage<T>> {
    this.calls.push({ kind: "page", path, query: options.query });
    return {
      rows: this.pageRows as T[],
      page: 1,
      pageSize: 250,
      hasMore: false,
      continuationToken: null,
    };
  }

  async getJson<T>(path: string, query?: Record<string, unknown>): Promise<T> {
    this.calls.push({ kind: "detail", path, query });
    return this.detail as T;
  }
}

function endpoints(stub: StubClient) {
  return new SimproEndpoints(stub as unknown as SimproClient);
}

test("change-log wrappers use documented paged paths and runtime parsing", async () => {
  const stub = new StubClient();
  stub.pageRows = [{ ID: 9, QuoteID: 42, Message: "Updated", DateLogged: "2026-07-09T10:00:00-07:00" }];

  const result = await endpoints(stub).listQuoteLogs({ page: 2, pageSize: 100 });

  assert.equal(result.rows[0]?.QuoteID, 42);
  assert.equal(stub.calls[0]?.kind, "page");
  assert.equal(stub.calls[0]?.path, "/logs/quotes/");
});

test("nested quote and job wrappers build the documented paths", async () => {
  const stub = new StubClient();
  stub.pageRows = [];
  const api = endpoints(stub);

  await api.listQuoteLabor(11, 12, 13);
  await api.listJobWorkOrders(21, 22, 23);

  assert.equal(stub.calls[0]?.path, "/quotes/11/sections/12/costCenters/13/labor/");
  assert.equal(stub.calls[1]?.path, "/jobs/21/sections/22/costCenters/23/workOrders/");
});

test("job stock uses the documented unpaged collection", async () => {
  const stub = new StubClient();
  stub.detail = [];

  assert.deepEqual(await endpoints(stub).listJobStock(21, 22, 23), []);
  assert.equal(stub.calls[0]?.kind, "detail");
  assert.equal(stub.calls[0]?.path, "/jobs/21/sections/22/costCenters/23/stock/");
});

test("job nested item wrappers accept tenant Claimed null values", async () => {
  const stub = new StubClient();
  stub.pageRows = [{
    ID: 85138,
    LaborType: { ID: 12, Name: "Technician Normal Time" },
    Discount: 0,
    SellPrice: {},
    Total: { Qty: 3, Amount: { ExTax: 705, IncTax: 705 } },
    Claimed: null,
  }];

  const page = await endpoints(stub).listJobLabor(17319, 90716, 60576);
  assert.equal(page.rows[0]?.Claimed, null);
});

test("job cost centers accept tenant empty PercentComplete values as unavailable", async () => {
  const stub = new StubClient();
  stub.pageRows = [{
    ID: 60575,
    CostCenter: { ID: 6, Name: "Water Heating Service" },
    Name: "Service",
    DisplayOrder: 1,
    Total: { ExTax: 100, IncTax: 110 },
    JobID: 17318,
    PercentComplete: "",
  }];

  const page = await endpoints(stub).listJobCostCenters(17318, 90715);
  assert.equal(page.rows[0]?.PercentComplete, undefined);
});

test("mobile status logs accept tenant empty work-order IDs while preserving job identity", async () => {
  const client = new StubClient();
  client.pageRows = [{
      ID: 191978,
      Staff: { ID: 205, Name: "Juan Serrato" },
      WorkOrder: { ID: "", Type: "Job", ProjectID: 16745, CostCenterID: 59956, _href: "/workOrders/" },
      Status: { ID: 39, Name: "Install Complete", Color: "#ff99ad" },
      Latitude: 34.0882528,
      Longitude: -117.4028502,
      DateLogged: "2026-06-28T22:36:19-07:00",
    }];
  const endpoints = new SimproEndpoints(client as unknown as SimproClient);
  const page = await endpoints.listMobileStatusLogs();
  assert.equal(page.rows[0].WorkOrder?.ID, null);
  assert.equal(page.rows[0].WorkOrder?.ProjectID, 16745);
});

test("schedule detail accepts tenant Project identity objects", async () => {
  const stub = new StubClient();
  stub.detail = {
    ID: 172490,
    Type: "job",
    Reference: "17319-60576",
    Project: { ProjectID: 17319, SectionID: 90716, CostCenterID: 60576 },
    Staff: { ID: 258, Name: "Ismael Contreras", Type: "employee", TypeId: 258 },
    Date: "2026-07-09",
    TotalHours: 3.75,
    Blocks: [{
      Hrs: 3.75,
      StartTime: "13:30",
      ISO8601StartTime: "2026-07-09T13:30:00-07:00",
      EndTime: "17:15",
      ISO8601EndTime: "2026-07-09T17:15:00-07:00",
      ScheduleRate: { ID: 1, Name: "Normal Time" },
    }],
    DateModified: "2026-07-09T17:17:16-07:00",
  };
  const row = await endpoints(stub).getSchedule(172490);
  assert.deepEqual(row.Project, { ProjectID: 17319, SectionID: 90716, CostCenterID: 60576 });
});

test("detail wrappers reject invalid Swagger shapes with endpoint context", async () => {
  const stub = new StubClient();
  stub.detail = { ID: 99, Stage: { Name: "Approved" } };

  await assert.rejects(
    endpoints(stub).getQuote(99),
    (error: unknown) =>
      error instanceof SimproSchemaError &&
      error.context === "GET /quotes/99" &&
      error.message.includes("Stage"),
  );
});

test("quote detail accepts tenant numeric JobNo while keeping it descriptive", async () => {
  const stub = new StubClient();
  stub.detail = {
    ID: 2688,
    Name: "Accepted quote",
    Description: "Scope",
    Salesperson: null,
    DateIssued: "2026-07-09",
    DateApproved: "",
    IsClosed: false,
    Stage: "InProgress",
    CustomerStage: "Pending",
    JobNo: 17319,
    LinkedJobID: null,
    Total: { ExTax: 968.86, Tax: 12.05, IncTax: 980.91 },
    Totals: {},
    Status: { ID: 138, Name: "Accepted Online" },
    DateModified: "2026-07-09T12:52:43-07:00",
  };

  const quote = await endpoints(stub).getQuote(2688);
  assert.equal(quote.JobNo, "17319");
});

test("quote stock is not exposed because Swagger has no quote stock route", () => {
  assert.equal("listQuoteStock" in SimproEndpoints.prototype, false);
});

test("every required paged collection wrapper uses its documented path", async () => {
  const stub = new StubClient();
  stub.pageRows = [];
  const api = endpoints(stub);
  const cases: Array<{ path: string; run: () => Promise<unknown> }> = [
    { path: "/quotes/11/sections/", run: () => api.listQuoteSections(11) },
    { path: "/quotes/11/sections/12/costCenters/", run: () => api.listQuoteCostCenters(11, 12) },
    { path: "/quotes/11/sections/12/costCenters/13/labor/", run: () => api.listQuoteLabor(11, 12, 13) },
    { path: "/quotes/11/sections/12/costCenters/13/catalogs/", run: () => api.listQuoteCatalogs(11, 12, 13) },
    { path: "/quotes/11/sections/12/costCenters/13/serviceFees/", run: () => api.listQuoteServiceFees(11, 12, 13) },
    { path: "/quotes/11/sections/12/costCenters/13/oneOffs/", run: () => api.listQuoteOneOffs(11, 12, 13) },
    { path: "/quotes/11/sections/12/costCenters/13/prebuilds/", run: () => api.listQuotePrebuilds(11, 12, 13) },
    { path: "/quotes/11/sections/12/costCenters/13/schedules/", run: () => api.listQuoteSchedules(11, 12, 13) },
    { path: "/quotes/11/sections/12/costCenters/13/workOrders/", run: () => api.listQuoteWorkOrders(11, 12, 13) },
    { path: "/jobs/21/sections/", run: () => api.listJobSections(21) },
    { path: "/jobs/21/sections/22/costCenters/", run: () => api.listJobCostCenters(21, 22) },
    { path: "/jobs/21/sections/22/costCenters/23/labor/", run: () => api.listJobLabor(21, 22, 23) },
    { path: "/jobs/21/sections/22/costCenters/23/catalogs/", run: () => api.listJobCatalogs(21, 22, 23) },
    { path: "/jobs/21/sections/22/costCenters/23/serviceFees/", run: () => api.listJobServiceFees(21, 22, 23) },
    { path: "/jobs/21/sections/22/costCenters/23/oneOffs/", run: () => api.listJobOneOffs(21, 22, 23) },
    { path: "/jobs/21/sections/22/costCenters/23/prebuilds/", run: () => api.listJobPrebuilds(21, 22, 23) },
    { path: "/jobs/21/sections/22/costCenters/23/schedules/", run: () => api.listJobSchedules(21, 22, 23) },
    { path: "/jobs/21/sections/22/costCenters/23/workOrders/", run: () => api.listJobWorkOrders(21, 22, 23) },
    { path: "/employees/", run: () => api.listEmployees() },
    { path: "/schedules/", run: () => api.listSchedules() },
    { path: "/logs/quotes/", run: () => api.listQuoteLogs() },
    { path: "/logs/jobs/", run: () => api.listJobLogs() },
    { path: "/logs/schedules/", run: () => api.listScheduleLogs() },
    { path: "/logs/mobileStatus/", run: () => api.listMobileStatusLogs() },
  ];

  for (const item of cases) {
    const index = stub.calls.length;
    await item.run();
    assert.equal(stub.calls[index]?.path, item.path);
  }
});

test("every required detail wrapper uses its documented path before schema parsing", async () => {
  const stub = new StubClient();
  stub.detail = {};
  const api = endpoints(stub);
  const cases: Array<{ path: string; run: () => Promise<unknown> }> = [
    { path: "/quotes/11/sections/12", run: () => api.getQuoteSection(11, 12) },
    { path: "/quotes/11/sections/12/costCenters/13", run: () => api.getQuoteCostCenter(11, 12, 13) },
    { path: "/quotes/11/sections/12/costCenters/13/labor/14", run: () => api.getQuoteLabor(11, 12, 13, 14) },
    { path: "/quotes/11/sections/12/costCenters/13/catalogs/14", run: () => api.getQuoteCatalog(11, 12, 13, 14) },
    { path: "/quotes/11/sections/12/costCenters/13/serviceFees/14", run: () => api.getQuoteServiceFee(11, 12, 13, 14) },
    { path: "/quotes/11/sections/12/costCenters/13/oneOffs/14", run: () => api.getQuoteOneOff(11, 12, 13, 14) },
    { path: "/quotes/11/sections/12/costCenters/13/prebuilds/14", run: () => api.getQuotePrebuild(11, 12, 13, 14) },
    { path: "/quotes/11/sections/12/costCenters/13/schedules/14", run: () => api.getQuoteSchedule(11, 12, 13, 14) },
    { path: "/quotes/11/sections/12/costCenters/13/workOrders/14", run: () => api.getQuoteWorkOrder(11, 12, 13, 14) },
    { path: "/jobs/21/sections/22", run: () => api.getJobSection(21, 22) },
    { path: "/jobs/21/sections/22/costCenters/23", run: () => api.getJobCostCenter(21, 22, 23) },
    { path: "/jobs/21/sections/22/costCenters/23/labor/24", run: () => api.getJobLabor(21, 22, 23, 24) },
    { path: "/jobs/21/sections/22/costCenters/23/catalogs/24", run: () => api.getJobCatalog(21, 22, 23, 24) },
    { path: "/jobs/21/sections/22/costCenters/23/serviceFees/24", run: () => api.getJobServiceFee(21, 22, 23, 24) },
    { path: "/jobs/21/sections/22/costCenters/23/oneOffs/24", run: () => api.getJobOneOff(21, 22, 23, 24) },
    { path: "/jobs/21/sections/22/costCenters/23/prebuilds/24", run: () => api.getJobPrebuild(21, 22, 23, 24) },
    { path: "/jobs/21/sections/22/costCenters/23/stock/24", run: () => api.getJobStock(21, 22, 23, 24) },
    { path: "/jobs/21/sections/22/costCenters/23/schedules/24", run: () => api.getJobSchedule(21, 22, 23, 24) },
    { path: "/jobs/21/sections/22/costCenters/23/workOrders/24", run: () => api.getJobWorkOrder(21, 22, 23, 24) },
    { path: "/employees/24", run: () => api.getEmployee(24) },
    { path: "/schedules/24", run: () => api.getSchedule(24) },
    { path: "/logs/quotes/24", run: () => api.getQuoteLog(24) },
    { path: "/logs/jobs/24", run: () => api.getJobLog(24) },
    { path: "/logs/schedules/24", run: () => api.getScheduleLog(24) },
    { path: "/logs/mobileStatus/24", run: () => api.getMobileStatusLog(24) },
  ];

  for (const item of cases) {
    const index = stub.calls.length;
    await assert.rejects(item.run(), SimproSchemaError);
    assert.equal(stub.calls[index]?.path, item.path);
  }
});
