import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import type { TechnicianMonthlyTrend } from "../../src/lib/metrics/technicians";
import {
  technicianPerformanceInputsFromCorpus,
  type TechnicianPerformanceCorpus,
} from "../../src/lib/store/technician-read-model-inputs";

const source = readFileSync(path.join(process.cwd(), "src/lib/store/technician-read-model-inputs.ts"), "utf8");

test("historical drains preload each source family and monthly config selection once per process", () => {
  assert.match(source, /let technicianPerformanceCorpus: Promise<TechnicianPerformanceCorpus> \| null = null/);
  assert.match(source, /from generate_series\([\s\S]*interval '1 month'/);
  const loader = source.slice(
    source.indexOf("async function getTechnicianPerformanceCorpus"),
    source.indexOf("export async function getTechnicianJobs"),
  );
  for (const input of [
    "getTechnicianJobs",
    "getTechnicianRecordedTimesheets",
    "getTechnicianScheduleVisits",
    "getTechnicianMobileRows",
    "getTechnicianMetricConfigurations",
    "getEffectiveTechnicianRosterRows",
  ]) {
    assert.equal(loader.match(new RegExp(`${input}\\(`, "g"))?.length, 1, `${input} is loaded once into the process corpus`);
  }
  assert.doesNotMatch(loader, /getHistoricalTechnicians\(/, "served history stays live because each publication changes it");
});

test("process corpus slicing preserves monthly job, roster, schedule, mobile, config, and history semantics", () => {
  const corpus: TechnicianPerformanceCorpus = {
    rangeStart: "2023-01-01",
    rangeEnd: "2026-07-31",
    jobs: [{
      jobId: "10",
      completedDate: "2026-06-15",
      sellValue: 100,
      timesheets: [{
        employeeId: "1",
        hours: 5,
        inPeriodHours: 5,
        workDates: [
          { timesheetId: "may", workDate: "2026-05-31", hours: 2 },
          { timesheetId: "june", workDate: "2026-06-01", hours: 3 },
        ],
      }],
    }, {
      jobId: "11",
      completedDate: "2026-07-01",
      sellValue: 200,
      timesheets: [],
    }],
    recordedTimesheets: [
      recorded("june-positive", "1", "2026-06-01", 3),
      recorded("june-zero", "2", "2026-06-01", 0),
      recorded("july-positive", "2", "2026-07-01", 4),
    ],
    scheduleVisits: [
      visit("before", "2026-06-01T06:59:59.000Z"),
      visit("first", "2026-06-01T07:00:00.000Z"),
      visit("last", "2026-07-01T06:59:59.000Z"),
      visit("after", "2026-07-01T07:00:00.000Z"),
    ],
    mobileRows: [
      mobile("before-buffer", "2026-05-31T18:59:59.000Z"),
      mobile("buffer-start", "2026-05-31T19:00:00.000Z"),
      mobile("buffer-end", "2026-07-02T06:59:59.000Z"),
      mobile("after-buffer", "2026-07-02T07:00:00.000Z"),
    ],
    configurations: new Map([["2026-06-01", {
      onTimeThresholdMinutes: 9,
      semanticsVerified: true,
      arrivalStatusIds: new Set(["7"]),
      completionStatusIds: new Set(["8"]),
    }]]),
    historicalTechnicians: [history("2026-05-01"), history("2026-07-01")],
    rosterRows: [roster("1"), roster("2")],
  };

  const inputs = technicianPerformanceInputsFromCorpus(corpus, "2026-06-01", "2026-06-30");

  assert.deepEqual(inputs.jobs.map((job) => job.jobId), ["10"]);
  assert.equal(inputs.jobs[0]?.timesheets[0]?.hours, 5, "completed-cohort allocation still uses all job hours");
  assert.equal(inputs.jobs[0]?.timesheets[0]?.inPeriodHours, 3, "work-month disclosure is recomputed for June");
  assert.deepEqual(inputs.recordedTimesheets.map((row) => row.timesheetId), ["june-positive", "june-zero"]);
  assert.deepEqual(inputs.roster.map((row) => row.employeeId), ["1"], "membership requires a positive row in this month");
  assert.deepEqual(inputs.scheduleVisits.map((row) => row.scheduleId), ["first", "last"]);
  assert.deepEqual(inputs.mobileEvents.map((row) => row.sourceLogId), ["buffer-start", "buffer-end"]);
  assert.ok(inputs.mobileEvents.every((row) => row.kind === "arrival"));
  assert.equal(inputs.onTimeThresholdMinutes, 9);
  assert.deepEqual(inputs.historicalTechnicians.map((row) => row.periodStart), ["2026-05-01"]);
});

function recorded(timesheetId: string, employeeId: string, workDate: string, hours: number) {
  return { timesheetId, employeeId, workDate, hours };
}

function visit(scheduleId: string, plannedStartAt: string) {
  return {
    scheduleId,
    blockIndex: 0,
    employeeId: "1",
    displayName: "Alex",
    personMapped: true,
    jobId: "10",
    workOrderId: "100",
    plannedStartAt,
    plannedEndAt: plannedStartAt,
    cancelled: false,
  };
}

function mobile(source_log_id: string, occurred_at: string) {
  return {
    source_log_id,
    employee_id: "1",
    display_name: "Alex",
    job_id: "10",
    work_order_id: "100",
    occurred_at,
    status_id: "7",
    status_name: "Arrived",
  };
}

function roster(employee_id: string) {
  return {
    employee_id,
    display_name: `Tech ${employee_id}`,
    date_of_hire: "2020-01-01",
    position: "Service Technician",
    archived: false,
    availability_json: null,
    is_field_technician: true,
    has_in_period_work: true,
  };
}

function history(periodStart: string): TechnicianMonthlyTrend {
  return {
    periodStart,
    periodEnd: `${periodStart.slice(0, 7)}-28`,
    employeeId: "1",
    displayName: "Alex",
    completedJobCredit: 0,
    allocatedSellValue: 0,
    allocatedGrossProfit: 0,
    allocatedNetProfit: 0,
    actualJobHours: 0,
    jobHours: 0,
    travelHours: 0,
    pickupPartsHours: 0,
    supportHours: 0,
    grossCapacityHours: 0,
    adjustedCapacityHours: 0,
    workingRecordedHours: 0,
    unrecordedHours: 0,
    overCapacityHours: 0,
    productiveHours: 0,
    totalRecordedHours: 0,
    quotedHours: 0,
    laborEfficiencyActualHours: 0,
    scheduledVisits: 0,
    arrivalCoveredVisits: 0,
    onTimeVisits: 0,
    reconciliation: {
      status: "missing",
      reason: "check_missing",
      checkedAt: null,
      sourceCount: null,
      servedCount: null,
      sourceValue: null,
      servedValue: null,
      sourceHours: null,
      servedHours: null,
      sourceManifestCount: 0,
      expectedSourceManifestCount: 0,
    },
  };
}
