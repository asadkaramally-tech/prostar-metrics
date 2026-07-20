import assert from "node:assert/strict";
import test from "node:test";
import {
  flattenBulkEmployees,
  flattenBulkMobileStatus,
  flattenBulkSchedules,
  flattenBulkTimesheets,
} from "../../src/lib/simpro/bulk-operational-export";
import { sourceHash } from "../../src/lib/simpro/client";

const fetchedAt = "2026-07-10T18:30:00.000Z";

test("employees flatten to canonical person fields with provenance", () => {
  const employee = {
    ID: 258,
    Name: "Ismael Contreras",
    Position: "Service Technician",
    PrimaryContact: { Email: "ismael@example.com" },
    DateCreated: "2022-01-14T08:00:00-08:00",
    DateModified: "2026-07-09T17:17:16-07:00",
    Archived: false,
  };

  const rows = flattenBulkEmployees({ Employees: [employee] }, fetchedAt);

  assert.deepEqual(rows[0], {
    employeeId: 258,
    displayName: "Ismael Contreras",
    roleType: "employee",
    email: "ismael@example.com",
    position: "Service Technician",
    archived: false,
    active: true,
    sourceCreatedAt: "2022-01-14T16:00:00.000Z",
    sourceHash: sourceHash(employee),
    fetchedAt,
    sourceModifiedAt: employee.DateModified,
  });
});

test("timesheets preserve EmployeeID/UID identity and use locked Job href parsing", () => {
  const timesheet = {
    EmployeeID: 258,
    UID: "f7d221f0-67fb-4fde-b6b9",
    ScheduleType: "Job",
    Reference: "99999-60576",
    _href: "/api/v1.0/companies/0/jobs/17319/sections/90716/costCenters/60576",
    Date: "2026-07-09",
    StartTime: "13:30",
    EndTime: "17:15",
    TotalHrs: 3.75,
    ScheduleRate: { ID: 1, Name: "Normal Time" },
    Cost: 200,
    OverheadCost: 40,
    TotalCost: 240,
  };

  const rows = flattenBulkTimesheets([timesheet], fetchedAt);

  assert.deepEqual(rows[0], {
    timesheetIdentity: "258:f7d221f0-67fb-4fde-b6b9",
    timesheetId: "f7d221f0-67fb-4fde-b6b9",
    employeeId: 258,
    employeeName: null,
    referenceType: "job",
    referenceId: 17319,
    referenceRaw: "99999-60576",
    referenceHref: timesheet._href,
    workDate: "2026-07-09",
    startAt: "2026-07-09T20:30:00.000Z",
    endAt: "2026-07-10T00:15:00.000Z",
    totalHours: 3.75,
    scheduleRateId: 1,
    scheduleRateName: "Normal Time",
    cost: 200,
    overheadCost: 40,
    totalCost: 240,
    parseStatus: "parsed",
    sourceHash: sourceHash(timesheet),
    fetchedAt,
    sourceModifiedAt: null,
  });
});

test("schedules flatten canonical parents and every ordered schedule block", () => {
  const schedule = {
    ID: 172490,
    Type: "job",
    Reference: "17319-60576",
    Project: { ProjectID: 17319, SectionID: 90716, CostCenterID: 60576 },
    Staff: { ID: 258, Name: "Ismael Contreras", Type: "employee", TypeId: 258 },
    Date: "2026-07-09",
    TotalHours: 5.25,
    Notes: "Return visit",
    Blocks: [
      {
        Hrs: 3.75,
        StartTime: "13:30",
        ISO8601StartTime: "2026-07-09T13:30:00-07:00",
        EndTime: "17:15",
        ISO8601EndTime: "2026-07-09T17:15:00-07:00",
        ScheduleRate: { ID: 1, Name: "Normal Time" },
      },
      {
        Hrs: 1.5,
        StartTime: "18:00",
        ISO8601StartTime: "2026-07-09T18:00:00-07:00",
        EndTime: "19:30",
        ISO8601EndTime: "2026-07-09T19:30:00-07:00",
        ScheduleRate: { ID: 2, Name: "Overtime" },
      },
    ],
    DateModified: "2026-07-09T17:17:16-07:00",
  };

  const flattened = flattenBulkSchedules({ Schedules: [schedule] }, fetchedAt);

  assert.equal(flattened.schedules.length, 1);
  assert.deepEqual(
    {
      scheduleId: flattened.schedules[0]?.scheduleId,
      referenceType: flattened.schedules[0]?.referenceType,
      referenceId: flattened.schedules[0]?.referenceId,
      projectId: flattened.schedules[0]?.projectId,
      sectionId: flattened.schedules[0]?.sectionId,
      costCenterId: flattened.schedules[0]?.costCenterId,
      staffId: flattened.schedules[0]?.staffId,
      isoStartTime: flattened.schedules[0]?.isoStartTime,
      isoEndTime: flattened.schedules[0]?.isoEndTime,
      sourceHash: flattened.schedules[0]?.sourceHash,
    },
    {
      scheduleId: 172490,
      referenceType: "job",
      referenceId: 17319,
      projectId: 17319,
      sectionId: 90716,
      costCenterId: 60576,
      staffId: 258,
      isoStartTime: "2026-07-09T20:30:00.000Z",
      isoEndTime: "2026-07-10T00:15:00.000Z",
      sourceHash: sourceHash(schedule),
    },
  );
  assert.deepEqual(flattened.scheduleBlocks.map((block) => ({
    blockIndex: block.blockIndex,
    plannedHours: block.plannedHours,
    plannedStartAt: block.plannedStartAt,
    plannedEndAt: block.plannedEndAt,
    scheduleRateId: block.scheduleRateId,
    sourceHash: block.sourceHash,
    scheduleSourceHash: block.scheduleSourceHash,
  })), [
    {
      blockIndex: 0,
      plannedHours: 3.75,
      plannedStartAt: "2026-07-09T20:30:00.000Z",
      plannedEndAt: "2026-07-10T00:15:00.000Z",
      scheduleRateId: 1,
      sourceHash: sourceHash(schedule.Blocks[0]),
      scheduleSourceHash: sourceHash(schedule),
    },
    {
      blockIndex: 1,
      plannedHours: 1.5,
      plannedStartAt: "2026-07-10T01:00:00.000Z",
      plannedEndAt: "2026-07-10T02:30:00.000Z",
      scheduleRateId: 2,
      sourceHash: sourceHash(schedule.Blocks[1]),
      scheduleSourceHash: sourceHash(schedule),
    },
  ]);
});

test("mobile status keeps project identity when the work-order ID is empty", () => {
  const mobileLog = {
    ID: 191978,
    Staff: { ID: 205, Name: "Juan Serrato", Type: "employee", TypeId: 205 },
    WorkOrder: { ID: "", Type: "Job", ProjectID: 16745, CostCenterID: 59956, _href: "/workOrders/" },
    Status: { ID: 39, Name: "Install Complete", Color: "#ff99ad" },
    Latitude: 34.0882528,
    Longitude: -117.4028502,
    DateLogged: "2026-06-28T22:36:19-07:00",
  };

  const row = flattenBulkMobileStatus({ Logs: [mobileLog] }, fetchedAt)[0];

  assert.equal(row?.workOrderId, null);
  assert.equal(row?.projectId, 16745);
  assert.equal(row?.costCenterId, 59956);
  assert.equal(row?.staffId, 205);
  assert.equal(row?.statusName, "Install Complete");
  assert.equal(row?.dateLogged, "2026-06-29T05:36:19.000Z");
  assert.equal(row?.sourceHash, sourceHash(mobileLog));
});
