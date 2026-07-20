import assert from "node:assert/strict";
import test from "node:test";
import {
  BULK_JOB_COLUMNS,
  BULK_QUOTE_COLUMNS,
  BulkProjectFinancialValidationError,
  flattenBulkProjectPage,
} from "../../src/lib/simpro/bulk-project-export";
import { sourceHash } from "../../src/lib/simpro/client";

const fetchedAt = "2026-07-10T18:30:00.000Z";

test("bulk export column strings retain the exact parent fields required by display=all exports", () => {
  assert.equal(
    BULK_JOB_COLUMNS,
    "ID,Type,Stage,Status,Customer,Site,Description,Notes,DateIssued,DueDate,CompletedDate,Salesperson,ProjectManager,Technicians,Total,Totals,Sections,ConvertedFrom,ConvertedFromQuote,RequestNo,OrderNo,ResponseTime,DateModified",
  );
  assert.equal(
    BULK_QUOTE_COLUMNS,
    "ID,Type,Stage,Status,Customer,Site,Description,Notes,DateIssued,DateApproved,DueDate,ValidityDays,Salesperson,Total,Totals,Sections,RequestNo,OrderNo,IsClosed,JobNo,LinkedJobID",
  );
});

test("bulk project flattening preserves an explicit real-zero Total.ExTax", () => {
  const flattened = flattenBulkProjectPage("quote", [{
    ID: 2400,
    Total: { ExTax: 0, IncTax: 110, Tax: 10 },
    Sections: [],
  }], fetchedAt);

  assert.equal(flattened.projects[0]?.totalExTax, 0);
});

test("bulk project flattening rejects missing, nonnumeric, and IncTax-only root totals", () => {
  const cases = [
    { id: 2401, total: undefined, reason: "missing", incTaxPresent: false },
    { id: 2402, total: { ExTax: "not-money", IncTax: 125 }, reason: "non_numeric", incTaxPresent: true },
    { id: 2403, total: { IncTax: 125 }, reason: "missing", incTaxPresent: true },
  ] as const;

  for (const row of cases) {
    assert.throws(
      () => flattenBulkProjectPage("quote", [{ ID: row.id, Total: row.total, Sections: [] }], fetchedAt),
      (error: unknown) => {
        assert.ok(error instanceof BulkProjectFinancialValidationError);
        assert.deepEqual(error.evidence, {
          projectType: "quote",
          sourceId: row.id,
          requiredField: "Total.ExTax",
          reason: row.reason,
          incTaxPresent: row.incTaxPresent,
          incTaxSubstitutionAllowed: false,
        });
        return true;
      },
    );
  }
});

test("job pages flatten Complete and Archived projects with exact embedded identities", () => {
  const completeJob = {
    ID: 16604,
    Type: "Service",
    Name: "Boiler repairs",
    Description: "Replace failed boiler components",
    Stage: "Complete",
    Status: { ID: 15, Name: "Job : Completed" },
    CompletedDate: "2026-04-29",
    DateIssued: "2026-04-10",
    DateModified: "2026-05-01T09:41:05-07:00",
    ConvertedFrom: { ID: 2283, Type: "Quote", Date: "2026-04-09T14:20:00-07:00" },
    ConvertedFromQuote: { ID: 2283, Name: "Boiler repairs" },
    Customer: { ID: 177, Name: "Amli Residential" },
    Site: { ID: 874, Name: "Amli Old Pasadena" },
    Salesperson: { ID: 13, Name: "Nelida Banuelos", Type: "employee", TypeId: 13 },
    Technician: { ID: 101, Name: "Technician One", Type: "employee", TypeId: 101 },
    Technicians: [
      { ID: 101, Name: "Technician One", Type: "employee", TypeId: 101 },
      { ID: 102, Name: "Technician Two", Type: "employee", TypeId: 102 },
    ],
    Total: { ExTax: 968.86, Tax: 12.05, IncTax: 980.91 },
    Totals: {
      MaterialsCost: { Actual: 58.86, Estimate: 58.86 },
      ResourcesCost: {
        Total: { Actual: 165.61, Estimate: 489 },
        LaborHours: { Actual: 1, Estimate: 3 },
      },
      GrossProfitLoss: { Actual: 744.39, Estimate: 421 },
      GrossMargin: { Actual: 76.83, Estimate: 43.45 },
    },
    Sections: [
      {
        ID: 90716,
        Name: "Boiler room",
        Description: "Primary repair scope",
        DisplayOrder: 1,
        CostCenters: [
          {
            ID: 60576,
            Name: "Water Heating Service",
            CostCenter: { ID: 6, Name: "Water Heating Service" },
            DisplayOrder: 1,
            Total: { ExTax: 968.86, Tax: 12.05, IncTax: 980.91 },
            Items: {
              Labors: [
                {
                  ID: 76101,
                  LaborType: { ID: 12, Name: "Technician Normal Time" },
                  Discount: 0,
                  SellPrice: { ExTax: 163, IncTax: 163 },
                  Total: { Qty: 3, Amount: { ExTax: 489, IncTax: 489 } },
                },
              ],
              Catalogs: [
                {
                  ID: 81231,
                  Catalog: { ID: 23800, PartNo: "013974F", Name: "Plumbing assembly kit" },
                  BillableStatus: "Billable",
                  BasePrice: 58.86,
                  Discount: 0,
                  SellPrice: { ExTax: 180, IncTax: 198.9 },
                  Total: { Qty: 1, Amount: { ExTax: 180, IncTax: 198.9 } },
                },
              ],
              Prebuilds: [],
              ServiceFees: [
                {
                  ID: 81232,
                  ServiceFee: { ID: 1, Name: "Trip Charge - Zone 1" },
                  BillableStatus: "Billable",
                  Discount: 0,
                  SellPrice: { ExTax: 59, IncTax: 59 },
                  Total: { Qty: 1, Amount: { ExTax: 59, IncTax: 59 } },
                },
              ],
              OneOffs: [
                {
                  ID: 81233,
                  Type: "Material",
                  Description: "Pressure gauge",
                  BillableStatus: "Billable",
                  EstimatedCost: 18,
                  ActualCost: 20,
                  Discount: 0,
                  SellPrice: { ExTax: 72, IncTax: 79.02 },
                  Total: { Qty: 2, Amount: { ExTax: 144, IncTax: 158.04 } },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  const archivedJob = {
    ID: 16068,
    Name: "Archived maintenance job",
    Description: "Completed maintenance",
    Stage: "Archived",
    Status: { ID: 15, Name: "Job : Completed" },
    CompletedDate: "2026-03-31",
    Total: { ExTax: 59, Tax: 0, IncTax: 59 },
    Totals: {},
    DateModified: "2026-04-22T09:41:05-07:00",
    Sections: [],
  };
  const dateOnlyJob = {
    ID: 17001,
    Name: "Still in progress",
    Description: "Completion date was entered early",
    Stage: "Pending",
    Status: { ID: 99, Name: "Job : In Progress" },
    CompletedDate: "2026-06-30",
    Total: { ExTax: 100, Tax: 10, IncTax: 110 },
    Totals: {},
    DateModified: "2026-07-01T08:00:00-07:00",
    Sections: [],
  };

  const flattened = flattenBulkProjectPage("job", { Jobs: [completeJob, archivedJob, dateOnlyJob] }, fetchedAt);

  assert.deepEqual(flattened.projects.map((row) => [row.projectId, row.stageName, row.isCompleted]), [
    [16604, "Complete", true],
    [16068, "Archived", true],
    [17001, "Pending", false],
  ]);
  const project = flattened.projects[0];
  assert.equal(project.sourceQuoteId, 2283);
  assert.equal(project.convertedFromAt, "2026-04-09T21:20:00.000Z");
  assert.equal(project.category, "Water Heating");
  assert.equal(project.totalExTax, 968.86);
  assert.equal(project.grossProfitActual, 744.39);
  assert.equal(project.laborHoursActual, 1);
  assert.equal(project.sourceModifiedAt, completeJob.DateModified);
  assert.equal(project.sourceHash, sourceHash(completeJob));

  assert.deepEqual(flattened.people.map((row) => [row.role, row.personId]), [
    ["salesperson", 13],
    ["technician", 101],
    ["technician", 102],
  ]);
  const costCenter = flattened.costCenters[0];
  assert.deepEqual(
    costCenter && {
      projectType: costCenter.projectType,
      projectId: costCenter.projectId,
      sectionId: costCenter.sectionId,
      costCenterId: costCenter.costCenterId,
      configuredCostCenterId: costCenter.configuredCostCenterId,
      category: costCenter.category,
      totalExTax: costCenter.totalExTax,
      fetchedAt: costCenter.fetchedAt,
    },
    {
      projectType: "job",
      projectId: 16604,
      sectionId: 90716,
      costCenterId: 60576,
      configuredCostCenterId: 6,
      category: "Water Heating",
      totalExTax: 968.86,
      fetchedAt,
    },
  );
  assert.equal(flattened.labor[0]?.laborId, 76101);
  assert.equal(flattened.labor[0]?.quantityHours, 3);
  assert.deepEqual(flattened.items.map((row) => [row.itemType, row.itemId, row.sourceItemId]), [
    ["catalog", "81231", 23800],
    ["service_fee", "81232", 1],
    ["one_off", "81233", null],
  ]);
  assert.equal(flattened.items[0]?.sellExTax, 180);
  assert.equal(flattened.items[0]?.estimatedCost, 58.86);
  assert.equal(flattened.items[2]?.estimatedCost, 36);
  assert.equal(flattened.items[2]?.actualCost, 40);

  for (const row of [...flattened.people, ...flattened.costCenters, ...flattened.labor, ...flattened.items]) {
    assert.equal(row.projectType, "job");
    assert.equal(row.projectId, 16604);
    assert.equal(row.projectSourceHash, sourceHash(completeJob));
    assert.match(row.sourceHash, /^[a-f0-9]{64}$/);
    assert.equal(row.fetchedAt, fetchedAt);
    assert.equal(row.projectSourceModifiedAt, completeJob.DateModified);
  }
  assert.equal(flattened.costCenters[0]?.sourceHash, sourceHash(completeJob.Sections[0].CostCenters[0]));
  assert.equal(flattened.labor[0]?.sourceHash, sourceHash(completeJob.Sections[0].CostCenters[0].Items.Labors[0]));
});

test("quote pages classify every non-accepted record the same regardless of terminal stage", () => {
  const terminalQuote = quotePayload({
    ID: 2401,
    CustomerStage: "Follow Up",
    IsClosed: true,
    JobNo: "NOT-CONVERTED",
    Salesperson: { ID: 13, Name: "Nelida Banuelos", Type: "employee", TypeId: 13 },
  });
  const nonterminalQuote = quotePayload({
    ID: 2402,
    CustomerStage: "Follow Up",
    IsClosed: false,
    JobNo: null,
    Sections: [],
  });
  const linkedQuote = quotePayload({
    ID: 2403,
    CustomerStage: null,
    IsClosed: false,
    LinkedJobID: 16444,
    JobNo: 3754,
    Sections: [],
  });
  const acceptedOnlineQuote = quotePayload({
    ID: 2404,
    Status: { ID: 10, Name: "  qUoTe AcCePtEd OnLiNe  " },
    JobNo: "16444",
    Sections: [],
  });

  const flattened = flattenBulkProjectPage(
    "quote",
    [terminalQuote, nonterminalQuote, linkedQuote, acceptedOnlineQuote],
    fetchedAt,
  );

  assert.deepEqual(flattened.projects.map((row) => [row.projectId, row.quoteOutcome, row.quoteOutcomeReason]), [
    [2401, "lost", "no_acceptance_evidence"],
    [2402, "lost", "no_acceptance_evidence"],
    [2403, "won", "converted_job"],
    [2404, "won", "accepted_online"],
  ]);
  assert.equal(flattened.projects[0]?.dateApproved, "2026-06-12");
  assert.equal(flattened.projects[0]?.isClosed, true);
  assert.equal(flattened.projects[0]?.jobNo, "NOT-CONVERTED");
  assert.equal(flattened.projects[0]?.salespersonId, 13);
  assert.equal(flattened.projects[1]?.dateApproved, "2026-06-12");
  assert.equal(flattened.projects[1]?.quoteWon, false);
  assert.equal(flattened.projects[2]?.linkedJobId, 16444);
  assert.equal(flattened.projects[2]?.conversionJobId, 16444);
  assert.equal(flattened.projects[2]?.jobNo, "3754");

  assert.equal(flattened.costCenters[0]?.sectionId, 55435);
  assert.equal(flattened.costCenters[0]?.costCenterId, 30408);
  assert.equal(flattened.costCenters[0]?.category, "Water Heating");
  assert.equal(flattened.labor[0]?.laborId, 56701);
  assert.deepEqual(flattened.items.map((row) => [row.itemType, row.itemId]), [
    ["catalog", "52823"],
    ["one_off", "43744"],
  ]);
  assert.equal(flattened.items[0]?.sourceItemPartNo, "013974F");
  assert.equal(flattened.items[0]?.sourceHash, sourceHash(terminalQuote.Sections[0].CostCenters[0].Items.Catalogs[0]));
  assert.equal(flattened.items[0]?.projectSourceHash, sourceHash(terminalQuote));
  assert.equal(flattened.items[0]?.projectId, 2401);
  assert.equal(flattened.items[0]?.projectType, "quote");
});

test("bulk quote normalization does not classify quote-level free text without a configured cost-center ID", () => {
  const flattened = flattenBulkProjectPage("quote", [quotePayload({
    ID: 2499,
    Category: "HVAC Service",
    PrimaryCostCenter: { Name: "HVAC Service" },
    Sections: [],
  })], fetchedAt);

  assert.equal(flattened.projects[0]?.category, "Unclassified");
});

test("bulk quote parent category counts Unclassified and matches canonical tie-breaking", () => {
  const dominantUnclassified = flattenBulkProjectPage("quote", [quotePayload({
    Sections: [categorySection([
      categoryCostCenter(401, 7, 100),
      categoryCostCenter(402, 999, 1_000),
      categoryCostCenter(403, null, 50),
    ])],
  })], fetchedAt);
  assert.equal(dominantUnclassified.projects[0]?.category, "Unclassified");
  assert.deepEqual(
    dominantUnclassified.costCenters.map((row) => row.category),
    ["HVAC", "Unclassified", "Unclassified"],
  );

  const tied = flattenBulkProjectPage("quote", [quotePayload({
    Sections: [categorySection([
      categoryCostCenter(411, 6, 100),
      categoryCostCenter(412, 7, 100),
      categoryCostCenter(413, 9, 100),
    ])],
  })], fetchedAt);
  assert.equal(tied.projects[0]?.category, "HVAC");
});

function categorySection(costCenters: Record<string, unknown>[]) {
  return { ID: 400, Name: "Category probe", CostCenters: costCenters };
}

function categoryCostCenter(id: number, configuredId: number | null, sellValue: number) {
  return {
    ID: id,
    CostCenter: configuredId === null ? null : { ID: configuredId, Name: `Configured ${configuredId}` },
    Name: `Cost center ${id}`,
    Total: { ExTax: sellValue },
    Items: { Labors: [], Catalogs: [], Prebuilds: [], ServiceFees: [], OneOffs: [] },
  };
}

function quotePayload(overrides: Record<string, unknown>) {
  return {
    ID: 2401,
    Type: "Project",
    Name: "Return line repair",
    Description: "Repair return line and replace pressure gauge",
    Stage: "Approved",
    CustomerStage: "Follow Up",
    Status: { ID: 9, Name: "Quote : Sent" },
    DateIssued: "2026-06-01",
    DateApproved: "2026-06-12",
    IsClosed: true,
    LinkedJobID: null,
    JobNo: null,
    Salesperson: null,
    Customer: { ID: 81, Name: "Aqua HOA" },
    Site: { ID: 903, Name: "Aqua 488" },
    Total: { ExTax: 3401.77, Tax: 106.45, IncTax: 3508.22 },
    Totals: {
      MaterialsCost: { Estimate: 519.89 },
      ResourcesCost: { Total: { Estimate: 978 }, LaborHours: { Estimate: 6 } },
      GrossProfitLoss: { Estimate: 1903.88 },
      GrossMargin: { Estimate: 55.97 },
    },
    DateModified: "2026-06-13T10:05:00-07:00",
    Sections: [
      {
        ID: 55435,
        Name: "Return line",
        Description: "Repair scope",
        DisplayOrder: 1,
        CostCenters: [
          {
            ID: 30408,
            CostCenter: { ID: 6, Name: "Water Heating Service" },
            Name: "Return Line Repair",
            DisplayOrder: 1,
            Total: { ExTax: 3401.77, Tax: 106.45, IncTax: 3508.22 },
            Totals: {
              MaterialsCost: { Estimate: 519.89 },
              ResourcesCost: { Total: { Estimate: 978 }, LaborHours: { Estimate: 6 } },
            },
            Items: {
              Labors: [
                {
                  ID: 56701,
                  LaborType: { ID: 12, Name: "Technician Normal Time" },
                  LaborRate: 163,
                  Discount: 0,
                  SellPrice: { ExTax: 350, IncTax: 350 },
                  Total: { Qty: 6, Amount: { ExTax: 2100, IncTax: 2100 } },
                },
              ],
              Catalogs: [
                {
                  ID: 52823,
                  Catalog: { ID: 23800, PartNo: "013974F", Name: "Plumbing assembly kit" },
                  BillableStatus: "Billable",
                  BasePrice: 519.89,
                  Discount: 0,
                  SellPrice: { ExTax: 1129.77, IncTax: 1236.22 },
                  Total: { Qty: 1, Amount: { ExTax: 1129.77, IncTax: 1236.22 } },
                },
              ],
              Prebuilds: [],
              ServiceFees: [],
              OneOffs: [
                {
                  ID: 43744,
                  Type: "Material",
                  Description: "Pressure gauge",
                  BillableStatus: "Billable",
                  EstimatedCost: 18,
                  ActualCost: 0,
                  Discount: 0,
                  SellPrice: { ExTax: 86, IncTax: 94.03 },
                  Total: { Qty: 2, Amount: { ExTax: 172, IncTax: 188.06 } },
                },
              ],
            },
          },
        ],
      },
    ],
    ...overrides,
  };
}
