import assert from "node:assert/strict";
import test from "node:test";
import {
  allocateJobCreditByHours,
  buildTechnicianPerformanceReadModel,
  calculateTechnicianCapacity,
  calculateTechnicianUtilization,
  isFieldTechnicianPosition,
  matchTechnicianVisits,
  resolveTechnicianAvailability,
  TECHNICIAN_ALLOCATION_TOLERANCE,
  type TechnicianJobInput,
  type TechnicianMobileEventInput,
  type TechnicianMonthlyTrend,
  type TechnicianRecordedTimeInput,
  type TechnicianScheduleVisitInput,
} from "../../src/lib/metrics/technicians";
import {
  mapCommissionSourceJobRows,
  mapEffectiveTechnicianRosterRows,
  mapHistoricalTechnicianRows,
  mapTechnicianCapacityRows,
  mapTechnicianJobRows,
  parseTechnicianAvailability,
  parseTechnicianMetricConfiguration,
} from "../../src/lib/store/technician-read-model-inputs";
import { normalizeEmployeeCapacity } from "../../src/lib/simpro/normalize";

test("allocation consolidates employee rows, excludes unmapped hours, and reconciles value and GP", () => {
  const result = allocateJobCreditByHours(1_200, [
    { employeeId: "1", hours: 1 },
    { employeeId: "1", hours: 2 },
    { employeeId: "2", hours: 3 },
    { employeeId: "9", hours: 6, mapped: false },
  ], 480);

  assert.equal(result.length, 2);
  assert.deepEqual(result.map((row) => row.employeeId), ["1", "2"]);
  assert.equal(result[0].hours, 3);
  assert.equal(result[0].share, 0.5);
  assert.equal(result[0].allocatedSellValue, 600);
  assert.equal(result[0].allocatedGrossProfit, 240);
  closeTo(result.reduce((sum, row) => sum + row.completedJobCredit, 0), 1);
  closeTo(result.reduce((sum, row) => sum + row.allocatedSellValue, 0), 1_200);
  closeTo(result.reduce((sum, row) => sum + (row.allocatedGrossProfit ?? 0), 0), 480);
});

test("allocation returns no technician credit without mapped positive hours", () => {
  assert.deepEqual(allocateJobCreditByHours(1_000, [
    { employeeId: "1", hours: 0 },
    { employeeId: "2", hours: 4, mapped: false },
  ]), []);
});

test("recorded-time classification retains non-job and unmapped-reference coverage", () => {
  const result = calculateTechnicianUtilization({
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    timesheets: [
      recorded("job", 6, { referenceId: "100", jobSupported: true }),
      recorded("Activity", 2),
      recorded("Quote", 1),
      recorded("job", 1, { referenceId: "bad", parseStatus: "unparsed_reference", jobSupported: false }),
      recorded("Activity", 2, { employeeId: "99", displayName: null, personMapped: false }),
      recorded("Activity", 0),
      recorded("job", 40, { workDate: "2026-05-31", referenceId: "100", jobSupported: true }),
    ],
  });

  const technician = result.technicians.get("1");
  assert.ok(technician);
  assert.equal(technician.displayName, "Alex Rivera");
  assert.equal(technician.productiveHours, 6);
  assert.equal(technician.nonJobHours, 4);
  assert.equal(technician.unmappedReferenceHours, 1);
  assert.equal(technician.totalRecordedHours, 10);
  assert.equal(result.coverage.totalRecordedHours, 12);
  assert.equal(result.coverage.productiveHours, 6);
  assert.equal(result.coverage.nonJobHours, 6);
  assert.equal(result.coverage.unmappedReferenceHours, 1);
  assert.equal(result.coverage.unmappedPersonHours, 2);
  assert.equal(result.coverage.invalidRecordedRows, 1);
});

test("default capacity is eight hours for each Monday-Friday workday", () => {
  const capacity = calculateTechnicianCapacity({
    profile: { employeeId: "1" },
    periodStart: "2026-06-01",
    periodEnd: "2026-06-07",
  });

  assert.equal(capacity.eligibleWorkdays, 5);
  assert.equal(capacity.grossCapacityHours, 40);
  assert.equal(capacity.adjustedCapacityHours, 40);
  assert.equal(capacity.availabilitySource, "default");
});

test("hire date is inclusive and archived people accrue zero capacity", () => {
  const hireGated = calculateTechnicianCapacity({
    profile: { employeeId: "1", dateOfHire: "2026-06-04" },
    periodStart: "2026-06-01",
    periodEnd: "2026-06-07",
  });
  assert.equal(hireGated.eligibleWorkdays, 2);
  assert.equal(hireGated.grossCapacityHours, 16);

  // Without a verified archive-date boundary the whole period is
  // archived-effective: history rows stay visible but never earn capacity.
  const archived = calculateTechnicianCapacity({
    profile: { employeeId: "1", dateOfHire: "2026-06-04", archived: true },
    periodStart: "2026-06-01",
    periodEnd: "2026-06-07",
  });
  assert.equal(archived.eligibleWorkdays, 0);
  assert.equal(archived.grossCapacityHours, 0);
  assert.equal(archived.adjustedCapacityHours, 0);
  assert.equal(archived.archived, true);
  assert.equal(archived.archiveEvidenceAt, null);

  // A verified archive boundary keeps pre-archive workdays only.
  const bounded = calculateTechnicianCapacity({
    profile: { employeeId: "1", archived: true, archiveEvidenceAt: "2026-06-04T00:00:00Z" },
    periodStart: "2026-06-01",
    periodEnd: "2026-06-07",
  });
  assert.equal(bounded.eligibleWorkdays, 3);
  assert.equal(bounded.grossCapacityHours, 24);
  assert.equal(bounded.archiveEvidenceAt, "2026-06-04T00:00:00Z");
});

test("July 2026 regression: pre-month allocation is disclosed, archived people get zero capacity, and non-roster allocation is never promoted", () => {
  const model = buildTechnicianPerformanceReadModel({
    periodStart: "2026-07-01",
    periodEnd: "2026-07-31",
    roster: [
      { employeeId: "134", displayName: "Roster Tech", position: "Service Technician ", isFieldTechnician: true },
      { employeeId: "253", displayName: "Archived Tech", position: "Service Technician", archived: true, hasInPeriodWork: true },
    ],
    capacityProfiles: [
      { employeeId: "134", displayName: "Roster Tech" },
      { employeeId: "253", displayName: "Archived Tech", archived: true },
    ],
    jobs: [job({
      jobId: "700",
      completedDate: "2026-07-10",
      sellValue: 2_000,
      grossProfit: 800,
      netProfit: 500,
      timesheets: [
        {
          employeeId: "134", displayName: "Roster Tech", mapped: true, hours: 6,
          inPeriodHours: 0,
          workDates: [{ timesheetId: "june-ts", workDate: "2026-06-24", hours: 6 }],
        },
        {
          employeeId: "999", displayName: "Office Helper", mapped: true, hours: 2,
          inPeriodHours: 2,
          workDates: [{ timesheetId: "july-ts", workDate: "2026-07-10", hours: 2 }],
        },
      ],
    })],
    recordedTimesheets: [
      recorded("job", 2, { employeeId: "999", displayName: "Office Helper", referenceId: "700", jobSupported: true, workDate: "2026-07-10" }),
    ],
  });

  assert.equal(model.schemaVersion, 1);
  assert.equal(model.rosterApplied, true);
  assert.deepEqual(model.technicians.map((technician) => technician.employeeId).sort(), ["134", "253"]);

  // The roster technician keeps completed-cohort economics but the July
  // contradiction is disclosed: zero in-month hours, all hours pre-month.
  const rosterTech = model.technicians.find((technician) => technician.employeeId === "134");
  assert.ok(rosterTech);
  assert.equal(rosterTech.allocatedSellValue, 1_500);
  assert.equal(rosterTech.allocatedGrossProfit, 600);
  assert.equal(rosterTech.allocatedNetProfit, 375);
  assert.equal(rosterTech.actualJobHours, 6);
  assert.equal(rosterTech.actualJobHoursInPeriod, 0);
  assert.equal(rosterTech.actualJobHoursOutsidePeriod, 6);
  assert.equal(rosterTech.allocationOutsideWorkMonth, true);
  assert.equal(rosterTech.totalRecordedHours, 0);
  assert.equal(rosterTech.utilizationPercent, null);

  // Archived roster people keep their history row but accrue zero capacity.
  const archivedTech = model.technicians.find((technician) => technician.employeeId === "253");
  assert.ok(archivedTech);
  assert.equal(archivedTech.archived, true);
  assert.equal(archivedTech.grossCapacityHours, 0);
  assert.equal(archivedTech.adjustedCapacityHours, 0);
  assert.equal(archivedTech.eligibleWorkdays, 0);

  // Non-roster allocation is reconciled and disclosed, never promoted.
  assert.equal(model.outsideRoster.length, 1);
  assert.deepEqual(model.outsideRoster[0], {
    employeeId: "999",
    displayName: "Office Helper",
    allocatedJobs: 1,
    completedJobCredit: 0.25,
    actualJobHours: 2,
    allocatedSellValue: 500,
    allocatedGrossProfit: 200,
    allocatedNetProfit: 125,
    totalRecordedHours: 2,
  });
  assert.equal(model.coverage.outsideRosterEmployees, 1);
  assert.equal(model.coverage.outsideRosterAllocatedSellValue, 500);
  assert.equal(model.coverage.outsideRosterActualJobHours, 2);
  assert.ok(model.allocations.every((allocation) => allocation.employeeId !== "999"));
  assert.ok(model.history.every((row) => row.employeeId !== "999"));

  // Allocation evidence preserves source timesheet identities and work dates.
  const allocation = model.allocations.find((row) => row.employeeId === "134");
  assert.ok(allocation);
  assert.equal(allocation.actualHoursInPeriod, 0);
  assert.equal(allocation.actualHoursOutsidePeriod, 6);
  assert.deepEqual(allocation.workDates, [{ timesheetId: "june-ts", workDate: "2026-06-24", hours: 6 }]);

  // Served economics stay complete across scorecard plus disclosure.
  closeTo(
    model.technicians.reduce((total, technician) => total + technician.allocatedSellValue, 0)
      + model.outsideRoster.reduce((total, entry) => total + entry.allocatedSellValue, 0),
    2_000,
  );
});

test("an explicit empty roster gates every identity out of the scorecard", () => {
  const model = buildTechnicianPerformanceReadModel({
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    roster: [],
    jobs: [job({ timesheets: [{ employeeId: "1", displayName: "Alex Rivera", mapped: true, hours: 4 }] })],
    recordedTimesheets: [recorded("Activity", 3)],
    scheduleVisits: [visit()],
  });

  assert.equal(model.rosterApplied, true);
  assert.deepEqual(model.technicians, []);
  assert.equal(model.outsideRoster.length, 1);
  assert.equal(model.outsideRoster[0].employeeId, "1");
  assert.equal(model.outsideRoster[0].allocatedSellValue, 1_000);
  assert.equal(model.outsideRoster[0].totalRecordedHours, 3);
  // Global coverage keeps the ungated context for disclosure.
  assert.equal(model.coverage.totalRecordedHours, 3);
});

test("without a roster the legacy ungated population is preserved and evidence gaps disclose as null", () => {
  const model = buildTechnicianPerformanceReadModel({
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    jobs: [job({ timesheets: [{ employeeId: "1", displayName: "Alex Rivera", mapped: true, hours: 4 }] })],
  });

  assert.equal(model.rosterApplied, false);
  assert.equal(model.technicians.length, 1);
  assert.deepEqual(model.outsideRoster, []);
  // No work-date evidence supplied: the split is unknown, never fabricated.
  assert.equal(model.technicians[0].actualJobHoursInPeriod, null);
  assert.equal(model.technicians[0].actualJobHoursOutsidePeriod, null);
  assert.equal(model.technicians[0].allocationOutsideWorkMonth, false);
  assert.equal(model.allocations[0].actualHoursInPeriod, null);
  assert.equal(model.allocations[0].workDates, null);
});

test("explicit availability overrides a day while blank availability falls back", () => {
  const explicit = calculateTechnicianCapacity({
    profile: {
      employeeId: "1",
      availability: {
        monday: { startTime: "07:00", endTime: "16:00" },
        tuesday: { startTime: "", endTime: "" },
        wednesday: { unavailable: true },
        saturday: { workHours: 4 },
      },
    },
    periodStart: "2026-06-01",
    periodEnd: "2026-06-07",
  });
  const blank = resolveTechnicianAvailability({ monday: { startTime: "", endTime: "" } });

  assert.equal(explicit.availabilitySource, "simpro");
  assert.equal(explicit.eligibleWorkdays, 5);
  assert.equal(explicit.grossCapacityHours, 36.5);
  assert.equal(blank.source, "default");
  assert.equal(blank.hours.monday, 8);
});

test("leave adjusts capacity, lunch is excluded once, and overtime uses working recorded hours", () => {
  const model = buildTechnicianPerformanceReadModel({
    periodStart: "2026-06-10",
    periodEnd: "2026-06-10",
    jobs: [],
    capacityProfiles: [{ employeeId: "1", displayName: "Alex Rivera" }],
    recordedTimesheets: [
      recorded("job", 3, { referenceId: "100", jobSupported: true }),
      recorded("Activity", 1, { referenceId: "45", activityId: "45" }),
      recorded("Activity", 0.5, { referenceId: "48", activityId: "48" }),
      recorded("Activity", 0.5, { referenceId: "99", activityId: "99" }),
      recorded("Activity", 2, { referenceId: "47", activityId: "47" }),
      recorded("Activity", 1, { referenceId: "2", activityId: "2" }),
      recorded("Activity", 1, { referenceId: "181", activityId: "181" }),
      recorded("Activity", 0.5, { referenceId: "9", activityId: "9" }),
    ],
  });
  const technician = model.technicians[0];

  assert.equal(technician.grossCapacityHours, 8);
  assert.equal(technician.adjustedCapacityHours, 4);
  assert.equal(technician.lunchHours, 0.5);
  assert.equal(technician.workingRecordedHours, 5);
  assert.equal(technician.unrecordedHours, 0);
  assert.equal(technician.overCapacityHours, 1);
  closeTo(technician.utilizationPercent ?? NaN, 3 / 9.5 * 100);
  assert.equal(technician.jobCapacityUsePercent, 75);
  assert.equal(technician.fieldDeploymentPercent, 112.5);
});

test("capacity leaves unrecorded time when working records are below the adjusted denominator", () => {
  const capacity = calculateTechnicianCapacity({
    profile: { employeeId: "1" },
    periodStart: "2026-06-01",
    periodEnd: "2026-06-01",
    jobHours: 2,
    supportHours: 1,
  });

  assert.equal(capacity.adjustedCapacityHours, 8);
  assert.equal(capacity.workingRecordedHours, 3);
  assert.equal(capacity.unrecordedHours, 5);
  assert.equal(capacity.overCapacityHours, 0);
  assert.equal(capacity.jobCapacityUsePercent, 25);
});

test("job allocations do not create capacity without period eligibility", () => {
  const model = buildTechnicianPerformanceReadModel({
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    jobs: [job({ timesheets: [{ employeeId: "1", displayName: "Allocation Only", hours: 2 }] })],
    capacityProfiles: [],
  });
  const technician = model.technicians[0];

  assert.equal(technician.actualJobHours, 2);
  assert.equal(technician.grossCapacityHours, 0);
  assert.equal(technician.adjustedCapacityHours, 0);
  assert.equal(technician.eligibleWorkdays, 0);
  assert.equal(technician.jobCapacityUsePercent, null);
});

test("labor efficiency separates quote and recurring individuals from multi-tech crews", () => {
  const model = buildTechnicianPerformanceReadModel({
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    jobs: [
      job({ jobId: "Q", jobSource: "Quote", quoteId: "10", quotedHours: 8, quoteLaborCovered: true, netProfit: 400, timesheets: [{ employeeId: "1", displayName: "Alex", hours: 4 }] }),
      job({ jobId: "R", jobSource: "Recurring", recurringJobId: "20", quotedHours: 6, quoteLaborCovered: true, netProfit: 300, timesheets: [{ employeeId: "2", displayName: "Blair", hours: 3 }] }),
      job({ jobId: "C", jobSource: "Quote", quoteId: "30", quotedHours: 10, quoteLaborCovered: true, netProfit: 500, timesheets: [
        { employeeId: "1", displayName: "Alex", hours: 2 },
        { employeeId: "2", displayName: "Blair", hours: 3 },
      ] }),
    ],
  });
  const alex = model.technicians.find((technician) => technician.employeeId === "1");
  const blair = model.technicians.find((technician) => technician.employeeId === "2");

  assert.ok(alex);
  assert.ok(blair);
  assert.deepEqual(alex.laborEfficiency.quoteGenerated, { quotedHours: 12, actualHours: 6, jobs: 2, efficiencyPercent: 200 });
  assert.deepEqual(blair.laborEfficiency.quoteGenerated, { quotedHours: 6, actualHours: 3, jobs: 1, efficiencyPercent: 200 });
  assert.deepEqual(blair.laborEfficiency.recurring, { quotedHours: 6, actualHours: 3, jobs: 1, efficiencyPercent: 200 });
  assert.equal(model.crewLaborEfficiency.length, 1);
  assert.deepEqual(model.crewLaborEfficiency[0].technicianIds, ["1", "2"]);
  assert.equal(model.crewLaborEfficiency[0].actualHours, 5);
  assert.equal(model.crewLaborEfficiency[0].efficiencyPercent, 200);
  assert.equal(model.allocations.find((allocation) => allocation.jobId === "C")?.laborEfficiencyScope, "crew");
  assert.deepEqual(
    model.allocations.filter((allocation) => allocation.jobId === "C").map((allocation) => allocation.allocatedQuotedHours),
    [4, 6],
  );
  assert.equal(model.coverage.individualLaborEfficiencyJobs, 2);
  assert.equal(model.coverage.crewLaborEfficiencyJobs, 1);
});

test("zero and non-job-only recorded denominators produce null and zero utilization", () => {
  const model = buildTechnicianPerformanceReadModel({
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    jobs: [],
    capacityProfiles: [
      { employeeId: "1", displayName: "No Records" },
      { employeeId: "2", displayName: "Support Only" },
    ],
    recordedTimesheets: [recorded("Activity", 4, { employeeId: "2", displayName: "Support Only" })],
  });

  const noRecords = model.technicians.find((technician) => technician.employeeId === "1");
  const supportOnly = model.technicians.find((technician) => technician.employeeId === "2");
  assert.ok(noRecords);
  assert.ok(supportOnly);
  assert.equal(noRecords.utilizationPercent, null);
  assert.equal(supportOnly.utilizationPercent, 0);
  assert.equal(supportOnly.productiveHours, 0);
  assert.equal(supportOnly.totalRecordedHours, 4);
});

test("multi-technician quote and recurring allocations reconcile quoted hours deterministically", () => {
  const model = buildTechnicianPerformanceReadModel({
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    jobs: [
      job({ jobId: "Q", quoteId: "10", quotedHours: 10, quoteLaborCovered: true, timesheets: [
        { employeeId: "3", hours: 3 }, { employeeId: "1", hours: 1 }, { employeeId: "2", hours: 2 },
      ] }),
      job({ jobId: "R", jobSource: "Recurring", recurringJobId: "20", quotedHours: 7, quoteLaborCovered: true, timesheets: [
        { employeeId: "2", hours: 3 }, { employeeId: "1", hours: 2 },
      ] }),
    ],
  });

  for (const [jobId, quotedHours] of [["Q", 10], ["R", 7]] as const) {
    const allocations = model.allocations.filter((allocation) => allocation.jobId === jobId);
    assert.deepEqual(allocations.map((allocation) => allocation.employeeId), jobId === "Q" ? ["1", "2", "3"] : ["1", "2"]);
    closeTo(
      allocations.reduce((total, allocation) => total + (allocation.allocatedQuotedHours ?? 0), 0),
      quotedHours,
      TECHNICIAN_ALLOCATION_TOLERANCE,
    );
    assert.ok(allocations.every((allocation) => allocation.laborEfficiencyScope === "crew"));
  }
  assert.equal(model.coverage.quoteGeneratedAllocatedQuotedHours, 10);
  assert.equal(model.coverage.quoteGeneratedActualHours, 6);
  assert.equal(model.coverage.recurringAllocatedQuotedHours, 7);
  assert.equal(model.coverage.recurringActualHours, 5);
  assert.equal(model.crewLaborEfficiency.length, 2);
});

test("completed-job allocations use all job timesheets while utilization keeps the work-date cohort separate", () => {
  const model = buildTechnicianPerformanceReadModel({
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    jobs: [job({ timesheets: [{ employeeId: "1", displayName: "Alex Rivera", mapped: true, hours: 8 }] })],
    recordedTimesheets: [recorded("Activity", 4)],
  });

  assert.equal(model.technicians[0].actualJobHours, 8);
  assert.equal(model.technicians[0].productiveHours, 0);
  assert.equal(model.technicians[0].totalRecordedHours, 4);
  assert.equal(model.technicians[0].utilizationPercent, 0);
});

test("labor efficiency includes only quote-sourced jobs with persisted source-quote labor", () => {
  const model = buildTechnicianPerformanceReadModel({
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    jobs: [
      job({ jobId: "1", quoteId: "Q1", quotedHours: 8, quoteLaborCovered: true, timesheets: [{ employeeId: "1", displayName: "Alex Rivera", hours: 4 }] }),
      job({ jobId: "2", quoteId: null, quotedHours: 100, quoteLaborCovered: true, timesheets: [{ employeeId: "1", displayName: "Alex Rivera", hours: 4 }] }),
      job({ jobId: "3", quoteId: "Q3", quotedHours: null, quoteLaborCovered: false, timesheets: [{ employeeId: "1", displayName: "Alex Rivera", hours: 2 }] }),
    ],
  });

  const technician = model.technicians[0];
  assert.equal(technician.actualJobHours, 10);
  assert.equal(technician.quotedHours, 8);
  assert.equal(technician.laborEfficiencyActualHours, 4);
  assert.equal(technician.laborEfficiencyPercent, 200);
  assert.equal(technician.laborEfficiencyJobs, 1);
  assert.equal(model.coverage.quoteSourcedJobs, 2);
  assert.equal(model.coverage.jobsWithQuotedLabor, 1);
  assert.equal(model.coverage.quoteSourcedJobsMissingLabor, 1);
  assert.equal(model.coverage.laborEfficiencyIncludedJobs, 1);
});

test("zero source-quote labor is uncovered and never enters efficiency", () => {
  const model = buildTechnicianPerformanceReadModel({
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    jobs: [job({
      jobId: "1",
      quoteId: "Q1",
      quotedHours: 0,
      quoteLaborCovered: true,
      timesheets: [{ employeeId: "1", displayName: "Alex Rivera", hours: 4 }],
    })],
  });

  assert.equal(model.coverage.jobsWithQuotedLabor, 0);
  assert.equal(model.coverage.quoteSourcedJobsMissingLabor, 1);
  assert.equal(model.coverage.laborEfficiencyIncludedJobs, 0);
  assert.equal(model.technicians[0].laborEfficiencyJobs, 0);
});

test("revenue/hour and GP/hour use their matching covered job-hour cohorts", () => {
  const model = buildTechnicianPerformanceReadModel({
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    jobs: [
      job({ jobId: "1", sellValue: 1_000, grossProfit: 400, timesheets: [{ employeeId: "1", displayName: "Alex Rivera", hours: 4 }] }),
      job({ jobId: "2", sellValue: 500, grossProfit: null, timesheets: [{ employeeId: "1", displayName: "Alex Rivera", hours: 1 }] }),
    ],
  });

  const technician = model.technicians[0];
  assert.equal(technician.displayName, "Alex Rivera");
  assert.equal(technician.allocatedSellValue, 1_500);
  assert.equal(technician.allocatedGrossProfit, 400);
  assert.equal(technician.revenuePerHour, 300);
  assert.equal(technician.grossProfitPerHour, 100);
  assert.equal(technician.coverage.grossProfitJobs, 1);
});

test("coverage exposes financial, utilization, labor, schedule, and mobile exclusions", () => {
  const model = buildTechnicianPerformanceReadModel({
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    jobs: [
      job({ jobId: "financial", sellValue: 1_000, grossProfit: 400, netProfit: 250, timesheets: [{ employeeId: "1", hours: 4 }] }),
      job({ jobId: "revenue-only", sellValue: 500, grossProfit: null, netProfit: null, timesheets: [{ employeeId: "1", hours: 2 }] }),
    ],
    recordedTimesheets: [
      recorded("job", 3, { referenceId: "financial", jobSupported: true }),
      recorded("Activity", 2),
      recorded("job", 1, { referenceId: "missing", jobSupported: false }),
      recorded("Activity", 2, { employeeId: "99", personMapped: false }),
      recorded("Activity", 0),
    ],
    scheduleVisits: [
      visit(),
      visit({ scheduleId: "cancelled", cancelled: true }),
      visit({ scheduleId: "invalid", plannedEndAt: "invalid" }),
    ],
    mobileEvents: [
      event("unmatched", "2026-06-10T16:05:00Z", "arrival", { employeeId: "2" }),
      event("unverified", "2026-06-10T16:05:00Z", "unverified"),
      event("invalid", "invalid", "arrival"),
    ],
  });

  assert.equal(model.coverage.revenueSupportedJobs, 2);
  assert.equal(model.coverage.revenueSupportedHours, 6);
  assert.equal(model.coverage.grossProfitSupportedJobs, 1);
  assert.equal(model.coverage.grossProfitSupportedHours, 4);
  assert.equal(model.coverage.netProfitSupportedJobs, 1);
  assert.equal(model.coverage.netProfitSupportedHours, 4);
  assert.equal(model.coverage.utilizationProductiveHours, 3);
  assert.equal(model.coverage.utilizationAllRecordedHours, 8);
  assert.equal(model.coverage.utilizationExcludedRows, 1);
  assert.equal(model.coverage.utilizationUnattributedHours, 2);
  assert.equal(model.coverage.scheduleExcludedBlocks, 2);
  assert.equal(model.coverage.uncoveredVisits, 1);
  assert.equal(model.coverage.completionUncoveredVisits, 1);
  assert.equal(model.coverage.unmatchedMobileEvents, 1);
  assert.equal(model.coverage.unverifiedMobileEvents, 1);
  assert.equal(model.coverage.invalidMobileEvents, 1);
});

test("gross profit never substitutes for missing technician net profit", () => {
  const model = buildTechnicianPerformanceReadModel({
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    jobs: [job({
      grossProfit: 400,
      netProfit: null,
      timesheets: [{ employeeId: "1", displayName: "Alex Rivera", hours: 4 }],
    })],
  });

  assert.equal(model.coverage.jobsWithGrossProfit, 1);
  assert.equal(model.coverage.jobsWithNetProfit, 0);
  assert.equal(model.technicians[0].coverage.grossProfitJobs, 1);
  assert.equal(model.technicians[0].coverage.netProfitJobs, 0);
  assert.equal(model.technicians[0].allocatedGrossProfit, 400);
  assert.equal(model.technicians[0].allocatedNetProfit, null);
  assert.equal(model.technicians[0].grossProfitPerHour, 100);
  assert.equal(model.technicians[0].netProfitPerHour, null);
  assert.equal(model.allocations[0].allocatedGrossProfit, 400);
  assert.equal(model.allocations[0].netProfit, null);
  assert.equal(model.allocations[0].allocatedNetProfit, null);
});

test("visit matching requires employee and job identity before time proximity", () => {
  const result = matchTechnicianVisits({
    visits: [visit()],
    events: [
      event("wrong-tech", "2026-06-10T16:01:00Z", "arrival", { employeeId: "2" }),
      event("wrong-job", "2026-06-10T16:02:00Z", "arrival", { jobId: "999" }),
      event("arrival", "2026-06-10T16:10:00Z", "arrival"),
      event("completion", "2026-06-10T18:15:00Z", "completion"),
    ],
  });

  assert.equal(result.visits[0].arrivalEventId, "arrival");
  assert.equal(result.visits[0].completionEventId, "completion");
  assert.equal(result.visits[0].onTime, true);
  assert.equal(result.visits[0].arrivalVarianceMinutes, 10);
  assert.equal(result.visits[0].durationVarianceMinutes, 5);
  assert.deepEqual(result.unmatchedEvents.map((item) => item.sourceLogId), ["wrong-tech", "wrong-job"]);
});

test("visits on the same employee and job never cross-match different work orders", () => {
  const result = matchTechnicianVisits({
    visits: [visit({ workOrderId: "701" })],
    events: [
      event("wrong-work-order", "2026-06-10T16:01:00Z", "arrival", { workOrderId: "702" }),
      event("right-work-order", "2026-06-10T16:05:00Z", "arrival", { workOrderId: "701" }),
    ],
  });

  assert.equal(result.visits[0].arrivalEventId, "right-work-order");
  assert.deepEqual(result.unmatchedEvents.map((item) => item.sourceLogId), ["wrong-work-order"]);
});

test("locked visit window includes exactly 12 hours before and 24 hours after", () => {
  const earlyBoundary = matchTechnicianVisits({ visits: [visit()], events: [event("early", "2026-06-10T04:00:00Z", "arrival")] });
  assert.equal(earlyBoundary.visits[0].arrivalEventId, "early");

  const lateBoundary = matchTechnicianVisits({ visits: [visit()], events: [event("late", "2026-06-11T16:00:00Z", "arrival")] });
  assert.equal(lateBoundary.visits[0].arrivalEventId, "late");

  const outside = matchTechnicianVisits({
    visits: [visit()],
    events: [
      event("too-early", "2026-06-10T03:59:59Z", "arrival"),
      event("too-late", "2026-06-11T16:00:01Z", "arrival"),
    ],
  });
  assert.equal(outside.visits[0].arrivalCovered, false);
  assert.equal(outside.visits[0].onTime, null);
  assert.equal(outside.unmatchedEvents.length, 2);
});

test("nearest schedule blocks and mobile events are matched one-to-one", () => {
  const result = matchTechnicianVisits({
    visits: [
      visit({ scheduleId: "S1", blockIndex: 0, plannedStartAt: "2026-06-10T16:00:00Z", plannedEndAt: "2026-06-10T17:00:00Z" }),
      visit({ scheduleId: "S1", blockIndex: 1, plannedStartAt: "2026-06-10T18:00:00Z", plannedEndAt: "2026-06-10T19:00:00Z" }),
    ],
    events: [
      event("arrival-1", "2026-06-10T16:10:00Z", "arrival"),
      event("completion-1", "2026-06-10T17:00:00Z", "completion"),
      event("arrival-2", "2026-06-10T17:50:00Z", "arrival"),
      event("completion-2", "2026-06-10T19:00:00Z", "completion"),
    ],
  });

  assert.deepEqual(result.visits.map((item) => item.arrivalEventId), ["arrival-1", "arrival-2"]);
  assert.deepEqual(result.visits.map((item) => item.completionEventId), ["completion-1", "completion-2"]);
  assert.equal(new Set(result.visits.map((item) => item.arrivalEventId)).size, 2);
  assert.equal(result.unmatchedEvents.length, 0);
});

test("a visit uses the earliest valid arrival after its preceding boundary", () => {
  const result = matchTechnicianVisits({
    visits: [visit()],
    events: [
      event("earliest", "2026-06-10T15:00:00Z", "arrival"),
      event("closer", "2026-06-10T15:55:00Z", "arrival"),
    ],
  });
  assert.equal(result.visits[0].arrivalEventId, "earliest");
  assert.deepEqual(result.unmatchedEvents.map((item) => item.sourceLogId), ["closer"]);
});

test("matching deduplicates source IDs and identical event timestamps", () => {
  const result = matchTechnicianVisits({
    visits: [visit()],
    events: [
      event("A", "2026-06-10T16:05:00Z", "arrival"),
      event("A", "2026-06-10T16:06:00Z", "arrival"),
      event("B", "2026-06-10T16:05:00Z", "arrival"),
    ],
  });

  assert.equal(result.duplicateEvents, 2);
  assert.equal(result.visits[0].arrivalEventId, "A");
  assert.equal(result.unmatchedEvents.length, 0);
});

test("cross-midnight visits retain UTC ordering and duration variance", () => {
  const result = matchTechnicianVisits({
    visits: [visit({ plannedStartAt: "2026-06-11T06:30:00Z", plannedEndAt: "2026-06-11T08:00:00Z" })],
    events: [
      event("arrival", "2026-06-11T06:35:00Z", "arrival"),
      event("completion", "2026-06-11T08:20:00Z", "completion"),
    ],
  });

  assert.equal(result.visits[0].arrivalVarianceMinutes, 5);
  assert.equal(result.visits[0].durationVarianceMinutes, 15);
});

test("missing arrivals are uncovered rather than late and do not enter the on-time denominator", () => {
  const model = buildTechnicianPerformanceReadModel({
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    jobs: [],
    scheduleVisits: [
      visit({ employeeId: "1", displayName: "Alex Rivera" }),
      visit({ scheduleId: "S2", employeeId: "2", displayName: "Morgan Lee", jobId: "200" }),
    ],
    mobileEvents: [event("arrival", "2026-06-10T16:10:00Z", "arrival")],
  });

  const alex = model.technicians.find((item) => item.employeeId === "1");
  const morgan = model.technicians.find((item) => item.employeeId === "2");
  assert.ok(alex);
  assert.ok(morgan);
  assert.equal(alex.onTimeRate, 100);
  assert.equal(morgan.onTimeRate, null);
  assert.equal(model.coverage.arrivalCoveredVisits, 1);
  assert.equal(model.coverage.uncoveredVisits, 1);
  assert.equal(model.visits.find((item) => item.employeeId === "2")?.onTime, null);
});

test("on-time threshold is inclusive and configurable", () => {
  const atThreshold = matchTechnicianVisits({
    visits: [visit()],
    events: [event("arrival", "2026-06-10T16:15:00Z", "arrival")],
    onTimeThresholdMinutes: 15,
  });
  assert.equal(atThreshold.visits[0].onTime, true);

  const overThreshold = matchTechnicianVisits({
    visits: [visit()],
    events: [event("arrival", "2026-06-10T16:15:01Z", "arrival")],
    onTimeThresholdMinutes: 15,
  });
  assert.equal(overThreshold.visits[0].onTime, false);
});

test("cancelled and invalid blocks are excluded from the scheduled-visit denominator", () => {
  const result = matchTechnicianVisits({
    visits: [
      visit({ cancelled: true }),
      visit({ scheduleId: "bad", plannedEndAt: "not-a-date" }),
      visit({ scheduleId: "good" }),
    ],
    events: [],
  });
  assert.equal(result.cancelledVisits, 1);
  assert.equal(result.invalidVisits, 1);
  assert.equal(result.scheduledVisits, 1);
  assert.equal(result.visits[0].onTime, null);
});

test("mobile event semantics remain disabled until a persisted map is explicitly verified", () => {
  const unverified = parseTechnicianMetricConfiguration({
    on_time_threshold_minutes: 20,
    config_json: { technician: { mobileStatus: { arrivalStatusIds: [1], completionStatusIds: [2] } } },
  });
  assert.equal(unverified.onTimeThresholdMinutes, 20);
  assert.equal(unverified.semanticsVerified, false);
  assert.equal(unverified.arrivalStatusIds.size, 0);

  const verified = parseTechnicianMetricConfiguration({
    on_time_threshold_minutes: 15,
    config_json: { technician: { mobileStatus: { verified: true, arrivalStatusIds: [1], completionStatusIds: [2] } } },
  });
  assert.equal(verified.semanticsVerified, true);
  assert.deepEqual([...verified.arrivalStatusIds], ["1"]);
  assert.deepEqual([...verified.completionStatusIds], ["2"]);

  const ambiguous = parseTechnicianMetricConfiguration({
    on_time_threshold_minutes: 15,
    config_json: { technician: { mobileStatus: { verified: true, arrivalStatusIds: [1], completionStatusIds: [1] } } },
  });
  assert.equal(ambiguous.semanticsVerified, false);
  assert.equal(ambiguous.arrivalStatusIds.size, 0);
});

test("canonical job rows preserve dim_people names and source-quote labor coverage", () => {
  const jobs = mapTechnicianJobRows([
    {
      job_id: "100",
      job_no: "J-100",
      job_name: "Replace heater",
      completed_date: "2026-06-15",
      sell_value: "1200.00",
      gross_profit: "480.00",
      net_profit: "420.00",
      job_source_type: "Quote",
      job_source_id: "50",
      labor_hours_estimate: "6.00",
      quote_id: "50",
      quoted_hours: "6.00",
      quote_labor_rows: "2",
      employee_id: "1",
      display_name: "Alex Rivera",
      person_mapped: true,
      hours: "3.00",
      in_period_hours: "1.00",
      work_dates: [
        { timesheetId: "ts-may", workDate: "2026-05-30", hours: 2 },
        { timesheetId: "ts-june", workDate: "2026-06-14", hours: 1 },
      ],
    },
    {
      job_id: "100",
      job_no: "J-100",
      job_name: "Replace heater",
      completed_date: "2026-06-15",
      sell_value: "1200.00",
      gross_profit: "480.00",
      net_profit: "420.00",
      job_source_type: "Quote",
      job_source_id: "50",
      labor_hours_estimate: "6.00",
      quote_id: "50",
      quoted_hours: "6.00",
      quote_labor_rows: "2",
      employee_id: "2",
      display_name: null,
      person_mapped: false,
      hours: "1.00",
    },
  ]);

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].quoteId, "50");
  assert.equal(jobs[0].jobSource, "Quote");
  assert.equal(jobs[0].netProfit, 420);
  assert.equal(jobs[0].quotedHours, 6);
  assert.equal(jobs[0].quoteLaborCovered, true);
  assert.deepEqual(jobs[0].timesheets, [
    {
      employeeId: "1",
      displayName: "Alex Rivera",
      mapped: true,
      hours: 3,
      inPeriodHours: 1,
      workDates: [
        { timesheetId: "ts-may", workDate: "2026-05-30", hours: 2 },
        { timesheetId: "ts-june", workDate: "2026-06-14", hours: 1 },
      ],
    },
    { employeeId: "2", displayName: null, mapped: false, hours: 1 },
  ]);
});

test("effective roster rows carry position, hire, archive, and in-month work evidence", () => {
  const members = mapEffectiveTechnicianRosterRows([
    {
      employee_id: "134",
      display_name: "Roster Tech",
      position: "Service Technician ",
      date_of_hire: "2022-11-21",
      archived: false,
      is_field_technician: true,
      has_in_period_work: true,
      availability_json: null,
    },
    {
      employee_id: "253",
      display_name: "Archived Tech",
      position: "Service Technician",
      date_of_hire: "2025-11-17",
      archived: true,
      is_field_technician: false,
      has_in_period_work: true,
      availability_json: null,
    },
  ]);

  assert.deepEqual(members, [
    {
      employeeId: "134",
      displayName: "Roster Tech",
      position: "Service Technician ",
      dateOfHire: "2022-11-21",
      archived: false,
      isFieldTechnician: true,
      hasInPeriodWork: true,
    },
    {
      employeeId: "253",
      displayName: "Archived Tech",
      position: "Service Technician",
      dateOfHire: "2025-11-17",
      archived: true,
      isFieldTechnician: false,
      hasInPeriodWork: true,
    },
  ]);
});

test("field-position matching trims and ignores case, and never guesses extra roles", () => {
  assert.equal(isFieldTechnicianPosition("Service Technician "), true);
  assert.equal(isFieldTechnicianPosition("service technician"), true);
  assert.equal(isFieldTechnicianPosition("Apprentice"), true);
  assert.equal(isFieldTechnicianPosition("Service Manager"), false);
  assert.equal(isFieldTechnicianPosition("Warehouse Associate"), false);
  assert.equal(isFieldTechnicianPosition(""), false);
  assert.equal(isFieldTechnicianPosition(null), false);
  assert.equal(isFieldTechnicianPosition(undefined), false);
});

test("canonical job rows preserve missing net profit when gross profit is present", () => {
  const jobs = mapTechnicianJobRows([{
    job_id: "101",
    job_no: "J-101",
    job_name: "Gross-only job",
    completed_date: "2026-06-16",
    sell_value: "1000.00",
    gross_profit: "300.00",
    net_profit: null,
    job_source_type: null,
    job_source_id: null,
    labor_hours_estimate: null,
    quote_id: null,
    quoted_hours: null,
    quote_labor_rows: "0",
    employee_id: "1",
    display_name: "Alex Rivera",
    person_mapped: true,
    hours: "2.00",
  }]);

  assert.equal(jobs[0].grossProfit, 300);
  assert.equal(jobs[0].netProfit, null);
});

test("capacity rows preserve migration-026 hire, archive, and availability evidence", () => {
  const rows = mapTechnicianCapacityRows([{
    employee_id: "1",
    display_name: "Alex Rivera",
    date_of_hire: "2026-06-04",
    archived: true,
    availability_json: {
      Monday: { StartTime: "07:00", EndTime: "16:00" },
      Tuesday: { StartTime: "", EndTime: "" },
    },
  }]);

  assert.equal(rows[0].dateOfHire, "2026-06-04");
  assert.equal(rows[0].archived, true);
  assert.equal(rows[0].archiveEvidenceAt, null);
  assert.deepEqual(rows[0].availability?.monday, {
    startTime: "07:00", endTime: "16:00", workHours: null, unavailable: false,
  });
  assert.equal(rows[0].availability?.tuesday?.startTime, null);
  assert.deepEqual(parseTechnicianAvailability(null), null);
  assert.equal(parseTechnicianAvailability(["Weekdays 08:00-16:30"])?.friday?.endTime, "16:30");
});

test("normalized explicit Simpro availability round-trips through the technician parser", () => {
  const normalized = normalizeEmployeeCapacity([
    "Monday 07:00-16:00",
    { Day: "Tuesday", StartTime: "08:00", EndTime: "15:30" },
    { Wednesday: { Start: "09:00", End: "14:00" } },
  ]);
  const parsed = parseTechnicianAvailability(normalized.schedule);

  assert.equal(normalized.capacitySource, "simpro_availability");
  assert.equal(parsed?.monday?.startTime, "07:00");
  assert.equal(parsed?.tuesday?.endTime, "15:30");
  assert.equal(parsed?.wednesday?.startTime, "09:00");
  assert.equal(resolveTechnicianAvailability(parsed).source, "simpro");

  const objectShape = normalizeEmployeeCapacity({
    Thursday: { StartTime: "06:30", EndTime: "12:30" },
    Friday: "Unavailable",
  });
  const parsedObject = parseTechnicianAvailability(objectShape.schedule);
  assert.equal(parsedObject?.thursday?.endTime, "12:30");
  assert.equal(parsedObject?.friday?.unavailable, true);
});

test("commission source rows retain actual stage, individual timesheets, and effective field classification", () => {
  const jobs = mapCommissionSourceJobRows([{
    job_id: "100",
    job_no: "J-100",
    job_name: "Replace heater",
    completed_date: "2026-06-15",
    stage_name: "Archived",
    sell_value: "1200.00",
    gross_profit: "480.00",
    quote_id: "50",
    source_snapshot_id: "900",
    source_hash: "job-upstream-hash",
    source_version: "job-v7",
    fetched_at: "2026-07-01T00:00:00Z",
    updated_from_source_at: "2026-07-01T00:00:01Z",
    timesheets: [
      {
        timesheetId: "ts-1", employeeId: "1", displayName: "Alex Rivera", mapped: true,
        hours: 3, workDate: "2026-06-14", referenceType: "Job", referenceId: "100", parseStatus: "parsed",
        fieldTechnician: true,
        fieldClassification: {
          verified: true, basis: "effective_commission_roster", rosterId: "7", rosterIncluded: false,
          effectiveStart: "2026-01-01", effectiveEnd: null,
        },
        person: {
          personId: "11", employeeId: "1", displayName: "Alex Rivera", roleType: "employee",
          position: "Service Technician", active: true, sourceModifiedAt: "2026-05-01T00:00:00Z",
          lastSeenAt: "2026-07-01T00:00:00Z",
        },
        source: { sourceSnapshotId: "901", upstreamSourceHash: "ts-1-hash", sourceVersion: null, fetchedAt: "2026-07-01T00:00:00Z", updatedFromSourceAt: "2026-07-01T00:00:01Z" },
      },
      {
        timesheetId: "ts-2", employeeId: "2", displayName: "Office User", mapped: true,
        hours: 1, workDate: "2026-06-14", referenceType: "Job", referenceId: "100", parseStatus: "parsed",
        fieldTechnician: false,
        fieldClassification: {
          verified: true, basis: "no_effective_commission_roster", rosterId: null, rosterIncluded: null,
          effectiveStart: null, effectiveEnd: null,
        },
        person: {
          personId: "12", employeeId: "2", displayName: "Office User", roleType: "employee",
          position: "Dispatcher", active: true, sourceModifiedAt: "2026-05-01T00:00:00Z",
          lastSeenAt: "2026-07-01T00:00:00Z",
        },
        source: { sourceSnapshotId: "902", upstreamSourceHash: "ts-2-hash", sourceVersion: null, fetchedAt: "2026-07-01T00:00:00Z", updatedFromSourceAt: "2026-07-01T00:00:01Z" },
      },
    ],
    quote_labor: [{
      quoteId: "50", sectionId: "1", costCenterId: "2", laborId: "3",
      laborTypeId: "4", laborTypeName: "HVAC", quantityHours: 6, sellExTax: 0, actualCost: 300,
      source: { sourceSnapshotId: "903", upstreamSourceHash: "labor-hash", sourceVersion: null, fetchedAt: "2026-07-01T00:00:00Z", updatedFromSourceAt: null },
    }],
  }]);

  assert.equal(jobs[0].stageName, "Archived");
  assert.equal(jobs[0].timesheets.length, 2);
  assert.equal(jobs[0].timesheets[0].fieldTechnician, true);
  assert.equal(jobs[0].timesheets[0].fieldClassification.rosterIncluded, false);
  assert.equal(jobs[0].timesheets[1].fieldTechnician, false);
  assert.equal(jobs[0].quotedHours, 6);
  assert.equal(jobs[0].quoteLabor[0].laborId, "3");
});

test("historical technician rows retain per-technician coverage numerators without copying global coverage", () => {
  const history = mapHistoricalTechnicianRows([{
    period_start: "2026-05-01",
    values_json: {
      periodEnd: "2026-05-31",
      coverage: { mobileStatusCoveredJobs: 80, totalJobs: 100 },
      technicians: [{
        employeeId: "1",
        displayName: "Alex Rivera",
        allocatedGrossProfit: 250,
        productiveHours: 30,
        totalRecordedHours: 40,
        quotedHours: 20,
        laborEfficiencyActualHours: 25,
        scheduledVisits: 10,
        arrivalCoveredVisits: 4,
        onTimeVisits: 3,
      }],
    },
  }]);

  assert.equal(history.length, 1);
  assert.equal(history[0].displayName, "Alex Rivera");
  assert.equal(history[0].arrivalCoveredVisits, 4);
  assert.equal(history[0].onTimeVisits, 3);
  assert.equal(history[0].allocatedGrossProfit, 250);
  assert.equal(history[0].allocatedNetProfit, null);
  assert.equal("mobileStatusCoveredJobs" in history[0], false);
});

test("read model history appends the current technician month after persisted prior months", () => {
  const prior = {
    periodStart: "2026-05-01",
    periodEnd: "2026-05-31",
    employeeId: "1",
    displayName: "Alex Rivera",
    completedJobCredit: 1,
    allocatedSellValue: 900,
    allocatedGrossProfit: 250,
    actualJobHours: 3,
    productiveHours: 20,
    totalRecordedHours: 30,
    quotedHours: 4,
    laborEfficiencyActualHours: 3,
    scheduledVisits: 2,
    arrivalCoveredVisits: 1,
    onTimeVisits: 1,
    reconciliation: {
      status: "matched",
      reason: "matched",
      checkedAt: "2026-06-01T00:00:00Z",
      sourceCount: 1,
      servedCount: 1,
      sourceValue: 900,
      servedValue: 900,
      sourceHours: 3,
      servedHours: 3,
      sourceManifestCount: 7,
      expectedSourceManifestCount: 7,
    },
  } satisfies TechnicianMonthlyTrend;
  const selected = {
    ...prior,
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    reconciliation: {
      ...prior.reconciliation,
      status: "mismatch",
      reason: "check_mismatch",
      checkedAt: "2026-07-01T00:00:00Z",
      sourceCount: 1,
      servedCount: 0.75,
    },
  } satisfies TechnicianMonthlyTrend;
  const model = buildTechnicianPerformanceReadModel({
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    jobs: [job({ timesheets: [{ employeeId: "1", displayName: "Alex Rivera", hours: 2 }] })],
    historicalTechnicians: [prior, selected],
  });

  assert.deepEqual(model.history.map((row) => row.periodStart), ["2026-05-01", "2026-06-01"]);
  assert.equal(model.history[1].displayName, "Alex Rivera");
  assert.deepEqual(model.history[1].reconciliation, selected.reconciliation);
});

function job(overrides: Partial<TechnicianJobInput> = {}): TechnicianJobInput {
  return {
    jobId: "100",
    jobNo: "J-100",
    completedDate: "2026-06-15",
    sellValue: 1_000,
    sellValueCovered: true,
    grossProfit: 300,
    quoteId: null,
    quotedHours: null,
    quoteLaborCovered: false,
    timesheets: [],
    ...overrides,
  };
}

function recorded(referenceType: string, hours: number, overrides: Partial<TechnicianRecordedTimeInput> = {}) {
  return { ...recordedBase(), referenceType, hours, ...overrides };
}

function recordedBase(): TechnicianRecordedTimeInput {
  return {
    timesheetId: "T",
    employeeId: "1",
    displayName: "Alex Rivera",
    personMapped: true,
    workDate: "2026-06-10",
    hours: 1,
    referenceType: "Activity",
    referenceId: null as string | null,
    parseStatus: "parsed",
    jobSupported: false,
  };
}

function visit(overrides: Partial<TechnicianScheduleVisitInput> = {}): TechnicianScheduleVisitInput {
  return {
    scheduleId: "S1",
    blockIndex: 0,
    employeeId: "1",
    displayName: "Alex Rivera",
    personMapped: true,
    jobId: "100",
    workOrderId: null,
    plannedStartAt: "2026-06-10T16:00:00Z",
    plannedEndAt: "2026-06-10T18:00:00Z",
    cancelled: false,
    ...overrides,
  };
}

function event(
  sourceLogId: string,
  occurredAt: string,
  kind: TechnicianMobileEventInput["kind"],
  overrides: Partial<TechnicianMobileEventInput> = {},
): TechnicianMobileEventInput {
  return {
    sourceLogId,
    employeeId: "1",
    displayName: "Alex Rivera",
    personMapped: true,
    jobId: "100",
    workOrderId: null,
    occurredAt,
    kind,
    ...overrides,
  };
}

function closeTo(actual: number, expected: number, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} should be within ${epsilon} of ${expected}`);
}
