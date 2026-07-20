import { sourceHash } from "@/lib/simpro/client";
import { pickId, pickName } from "@/lib/simpro/schemas";

export type BulkOperationalSourceFields = {
  sourceHash: string;
  fetchedAt: string;
  sourceModifiedAt: string | null;
};

export type BulkEmployeeRow = BulkOperationalSourceFields & {
  employeeId: number;
  displayName: string;
  roleType: "employee";
  email: string | null;
  position: string | null;
  archived: boolean;
  active: boolean;
  sourceCreatedAt: string | null;
};

export type BulkTimesheetParseStatus = "parsed" | "unparsed_reference";

export type BulkTimesheetRow = BulkOperationalSourceFields & {
  timesheetIdentity: string;
  timesheetId: string;
  employeeId: number;
  employeeName: string | null;
  referenceType: string | null;
  referenceId: number | null;
  referenceRaw: string | null;
  referenceHref: string | null;
  workDate: string | null;
  startAt: string | null;
  endAt: string | null;
  totalHours: number | null;
  scheduleRateId: number | null;
  scheduleRateName: string | null;
  cost: number | null;
  overheadCost: number | null;
  totalCost: number | null;
  parseStatus: BulkTimesheetParseStatus;
};

export type BulkScheduleRow = BulkOperationalSourceFields & {
  scheduleId: number;
  referenceType: string | null;
  referenceId: number | null;
  referenceRaw: string | null;
  referenceHref: string | null;
  projectId: number | null;
  sectionId: number | null;
  costCenterId: number | null;
  staffId: number | null;
  staffName: string | null;
  staffType: string | null;
  staffTypeId: number | null;
  scheduleDate: string | null;
  totalHours: number | null;
  startTime: string | null;
  endTime: string | null;
  isoStartTime: string | null;
  isoEndTime: string | null;
  scheduleRateId: number | null;
  scheduleRateName: string | null;
  notes: string | null;
};

export type BulkScheduleBlockRow = BulkOperationalSourceFields & {
  scheduleId: number;
  blockIndex: number;
  staffId: number | null;
  staffName: string | null;
  referenceType: string | null;
  referenceId: number | null;
  scheduleDate: string | null;
  plannedHours: number | null;
  startTime: string | null;
  endTime: string | null;
  plannedStartAt: string | null;
  plannedEndAt: string | null;
  scheduleRateId: number | null;
  scheduleRateName: string | null;
  scheduleSourceHash: string;
  scheduleSourceModifiedAt: string | null;
};

export type FlattenedBulkSchedulePage = {
  schedules: BulkScheduleRow[];
  scheduleBlocks: BulkScheduleBlockRow[];
};

export type BulkMobileStatusRow = BulkOperationalSourceFields & {
  logId: number;
  staffId: number | null;
  staffName: string | null;
  staffType: string | null;
  staffTypeId: number | null;
  workOrderId: number | null;
  workOrderType: string | null;
  workOrderHref: string | null;
  projectId: number | null;
  costCenterId: number | null;
  statusId: number | null;
  statusName: string | null;
  statusColor: string | null;
  latitude: number | null;
  longitude: number | null;
  dateLogged: string | null;
};

export function flattenBulkEmployees(payloads: unknown, fetchedAt: string): BulkEmployeeRow[] {
  return collectionRows(payloads, ["employees", "Employees"]).map((payload) => {
    const employeeId = requiredId(payload.ID, "employee ID");
    const archived = booleanValue(payload.Archived) ?? false;
    const primaryContact = recordValue(payload.PrimaryContact);

    return {
      ...sourceFields(payload, fetchedAt),
      employeeId,
      displayName: pickName(payload) ?? `Employee ${employeeId}`,
      roleType: "employee",
      email: textValue(primaryContact?.Email ?? payload.Email),
      position: textValue(payload.Position),
      archived,
      active: !archived,
      sourceCreatedAt: timestampValue(payload.DateCreated),
    };
  });
}

export function flattenBulkTimesheets(payloads: unknown, fetchedAt: string): BulkTimesheetRow[] {
  return collectionRows(payloads, ["timesheets", "Timesheets"]).map((payload) => {
    const employeeId = requiredId(payload.EmployeeID, "timesheet EmployeeID");
    const timesheetId = requiredText(payload.UID, "timesheet UID");
    const referenceRaw = textValue(payload.Reference);
    const referenceHref = textValue(payload._href);
    const reference = parseReference(payload.ScheduleType, referenceRaw, referenceHref);
    const workDate = dateValue(payload.Date);
    const startTime = timeValue(payload.StartTime);
    const endTime = timeValue(payload.EndTime);

    return {
      ...sourceFields(payload, fetchedAt),
      timesheetIdentity: `${employeeId}:${timesheetId}`,
      timesheetId,
      employeeId,
      employeeName: pickName(payload.Employee ?? payload.Staff),
      referenceType: reference.type,
      referenceId: reference.id,
      referenceRaw,
      referenceHref,
      workDate,
      startAt: pacificTimestamp(workDate, startTime),
      endAt: pacificTimestamp(workDate, endTime, isOvernight(startTime, endTime)),
      totalHours: numberValue(payload.TotalHrs ?? payload.TotalHours),
      scheduleRateId: idFromRef(payload.ScheduleRate),
      scheduleRateName: pickName(payload.ScheduleRate),
      cost: numberValue(payload.Cost),
      overheadCost: numberValue(payload.OverheadCost),
      totalCost: numberValue(payload.TotalCost),
      parseStatus: reference.id === null ? "unparsed_reference" : "parsed",
    };
  });
}

export function flattenBulkSchedules(payloads: unknown, fetchedAt: string): FlattenedBulkSchedulePage {
  const result: FlattenedBulkSchedulePage = { schedules: [], scheduleBlocks: [] };

  for (const payload of collectionRows(payloads, ["schedules", "Schedules"])) {
    flattenSchedule(payload, fetchedAt, result);
  }

  return result;
}

export function flattenBulkMobileStatus(payloads: unknown, fetchedAt: string): BulkMobileStatusRow[] {
  return collectionRows(payloads, ["logs", "Logs", "mobileStatus", "MobileStatus"]).map((payload) => {
    const staff = payload.Staff;
    const workOrder = recordValue(payload.WorkOrder);
    const status = payload.Status;

    return {
      ...sourceFields(payload, fetchedAt),
      logId: requiredId(payload.ID, "mobile status log ID"),
      staffId: idFromRef(staff),
      staffName: pickName(staff),
      staffType: textValue(recordValue(staff)?.Type),
      staffTypeId: idValue(recordValue(staff)?.TypeId),
      workOrderId: idValue(workOrder?.ID),
      workOrderType: textValue(workOrder?.Type),
      workOrderHref: textValue(workOrder?._href),
      projectId: idValue(workOrder?.ProjectID),
      costCenterId: idValue(workOrder?.CostCenterID),
      statusId: idFromRef(status),
      statusName: pickName(status) ?? textValue(recordValue(status)?.Name),
      statusColor: textValue(recordValue(status)?.Color),
      latitude: numberValue(payload.Latitude),
      longitude: numberValue(payload.Longitude),
      dateLogged: timestampValue(payload.DateLogged),
    };
  });
}

function flattenSchedule(
  payload: Record<string, unknown>,
  fetchedAt: string,
  result: FlattenedBulkSchedulePage,
): void {
  const scheduleId = requiredId(payload.ID, "schedule ID");
  const scheduleSource = sourceFields(payload, fetchedAt);
  const project = recordValue(payload.Project);
  const projectId = idValue(project?.ProjectID ?? payload.Project);
  const referenceRaw = textValue(payload.Reference);
  const referenceHref = textValue(payload._href);
  const parsedReference = parseReference(
    payload.Type,
    referenceRaw ?? (projectId === null ? null : String(projectId)),
    referenceHref,
  );
  const referenceType = normalizedReferenceType(payload.Type) ?? parsedReference.type;
  const referenceId = projectId ?? parsedReference.id;
  const scheduleDate = dateValue(payload.Date);
  const staff = payload.Staff;
  const blocks = arrayRecords(payload.Blocks);
  const firstBlock = blocks[0];
  const firstTiming = scheduleTiming(scheduleDate, firstBlock);
  const firstRate = firstBlock?.ScheduleRate;

  result.schedules.push({
    ...scheduleSource,
    scheduleId,
    referenceType,
    referenceId,
    referenceRaw,
    referenceHref,
    projectId,
    sectionId: idValue(project?.SectionID),
    costCenterId: idValue(project?.CostCenterID),
    staffId: idFromRef(staff),
    staffName: pickName(staff),
    staffType: textValue(recordValue(staff)?.Type),
    staffTypeId: idValue(recordValue(staff)?.TypeId),
    scheduleDate,
    totalHours: numberValue(payload.TotalHours),
    startTime: firstTiming.startTime ?? timeValue(payload.StartTime),
    endTime: firstTiming.endTime ?? timeValue(payload.EndTime),
    isoStartTime: firstTiming.startAt ?? pacificTimestamp(scheduleDate, timeValue(payload.StartTime)),
    isoEndTime: firstTiming.endAt ?? pacificTimestamp(
      scheduleDate,
      timeValue(payload.EndTime),
      isOvernight(timeValue(payload.StartTime), timeValue(payload.EndTime)),
    ),
    scheduleRateId: idFromRef(firstRate),
    scheduleRateName: pickName(firstRate),
    notes: textValue(payload.Notes),
  });

  blocks.forEach((block, blockIndex) => {
    const timing = scheduleTiming(scheduleDate, block);
    result.scheduleBlocks.push({
      ...sourceFields(block, fetchedAt),
      scheduleId,
      blockIndex,
      staffId: idFromRef(staff),
      staffName: pickName(staff),
      referenceType,
      referenceId,
      scheduleDate,
      plannedHours: numberValue(block.Hrs),
      startTime: timing.startTime,
      endTime: timing.endTime,
      plannedStartAt: timing.startAt,
      plannedEndAt: timing.endAt,
      scheduleRateId: idFromRef(block.ScheduleRate),
      scheduleRateName: pickName(block.ScheduleRate),
      scheduleSourceHash: scheduleSource.sourceHash,
      scheduleSourceModifiedAt: scheduleSource.sourceModifiedAt,
    });
  });
}

function scheduleTiming(scheduleDate: string | null, block: Record<string, unknown> | undefined) {
  const startTime = timeValue(block?.StartTime);
  const endTime = timeValue(block?.EndTime);
  return {
    startTime,
    endTime,
    startAt: timestampValue(block?.ISO8601StartTime) ?? pacificTimestamp(scheduleDate, startTime),
    endAt: timestampValue(block?.ISO8601EndTime)
      ?? pacificTimestamp(scheduleDate, endTime, isOvernight(startTime, endTime)),
  };
}

// This parser intentionally mirrors the locked fallback order in normalize.ts.
function parseReference(
  typeValue: unknown,
  reference: string | null,
  href?: string | null,
): { type: string | null; id: number | null } {
  const typeText = textValue(typeValue)?.toLowerCase() ?? "";
  const path = href ?? "";
  const jobFromPath = path.match(/\/jobs\/(\d+)/i)?.[1];
  const quoteFromPath = path.match(/\/quotes\/(\d+)/i)?.[1];
  const leadFromPath = path.match(/\/leads\/(\d+)/i)?.[1];

  if (jobFromPath) return { type: "job", id: idValue(jobFromPath) };
  if (quoteFromPath) return { type: "quote", id: idValue(quoteFromPath) };
  if (leadFromPath) return { type: "lead", id: idValue(leadFromPath) };

  const firstReferenceId = idValue(reference?.split("-")[0]);
  if (typeText.includes("job")) return { type: "job", id: firstReferenceId };
  if (typeText.includes("quote")) return { type: "quote", id: firstReferenceId };
  if (typeText.includes("lead")) return { type: "lead", id: firstReferenceId };
  if (typeText.includes("activity")) return { type: "activity", id: firstReferenceId };

  return { type: firstReferenceId === null ? null : "unknown", id: firstReferenceId };
}

function normalizedReferenceType(value: unknown): string | null {
  const type = textValue(value)?.toLowerCase() ?? "";
  for (const candidate of ["job", "quote", "lead", "activity"]) {
    if (type.includes(candidate)) return candidate;
  }
  return null;
}

function sourceFields(payload: Record<string, unknown>, fetchedAt: string): BulkOperationalSourceFields {
  return {
    sourceHash: sourceHash(payload),
    fetchedAt,
    sourceModifiedAt: textValue(payload.DateModified),
  };
}

function collectionRows(value: unknown, collectionKeys: string[]): Record<string, unknown>[] {
  if (Array.isArray(value)) return arrayRecords(value);
  const record = recordValue(value);
  if (!record) return [];

  for (const key of [...collectionKeys, "items", "Items", "data", "Data", "results", "Results"]) {
    if (Array.isArray(record[key])) return arrayRecords(record[key]);
  }
  return [record];
}

function pacificTimestamp(date: string | null, time: string | null, nextDay = false): string | null {
  if (!date || !time) return null;
  const dateParts = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const timeParts = parseTime(time);
  if (!dateParts || !timeParts) return null;

  const localDate = new Date(Date.UTC(Number(dateParts[1]), Number(dateParts[2]) - 1, Number(dateParts[3])));
  if (nextDay) localDate.setUTCDate(localDate.getUTCDate() + 1);
  const localEpoch = Date.UTC(
    localDate.getUTCFullYear(),
    localDate.getUTCMonth(),
    localDate.getUTCDate(),
    timeParts.hour,
    timeParts.minute,
    timeParts.second,
  );
  let instant = localEpoch;
  for (let pass = 0; pass < 3; pass += 1) {
    instant = localEpoch - pacificOffsetAt(instant);
  }

  return localPartsAt(instant) === localPartsKey(localDate, timeParts)
    ? new Date(instant).toISOString()
    : null;
}

const pacificFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function pacificOffsetAt(instant: number): number {
  const values = dateTimeParts(new Date(instant));
  const localAsUtc = Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute, values.second);
  return localAsUtc - Math.floor(instant / 1000) * 1000;
}

function localPartsAt(instant: number): string {
  const values = dateTimeParts(new Date(instant));
  return [values.year, values.month, values.day, values.hour, values.minute, values.second]
    .map((value, index) => String(value).padStart(index === 0 ? 4 : 2, "0"))
    .join("-");
}

function localPartsKey(date: Date, time: ParsedTime): string {
  return [
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    time.hour,
    time.minute,
    time.second,
  ].map((value, index) => String(value).padStart(index === 0 ? 4 : 2, "0")).join("-");
}

function dateTimeParts(date: Date) {
  const parts = pacificFormatter.formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

type ParsedTime = {
  hour: number;
  minute: number;
  second: number;
  secondsSinceMidnight: number;
};

function parseTime(value: string): ParsedTime | null {
  const match = value.match(/^(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3]);
  if (hour > 23 || minute > 59 || second > 59) return null;
  return { hour, minute, second, secondsSinceMidnight: hour * 3600 + minute * 60 + second };
}

function isOvernight(start: string | null, end: string | null): boolean {
  if (!start || !end) return false;
  const startParts = parseTime(start);
  const endParts = parseTime(end);
  return Boolean(startParts && endParts && endParts.secondsSinceMidnight < startParts.secondsSinceMidnight);
}

function timeValue(value: unknown): string | null {
  const text = textValue(value);
  const match = text?.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? 0);
  if (hour > 23 || minute > 59 || second > 59) return null;
  return [hour, minute, second].map((part) => String(part).padStart(2, "0")).join(":");
}

function dateValue(value: unknown): string | null {
  const match = textValue(value)?.match(/^\d{4}-\d{2}-\d{2}/);
  return match?.[0] ?? null;
}

function timestampValue(value: unknown): string | null {
  const text = textValue(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
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

function numberValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const number = Number(value.replace(/[$,]/g, ""));
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

function booleanValue(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  const text = textValue(value)?.toLowerCase();
  return text === "true" ? true : text === "false" ? false : null;
}

function requiredText(value: unknown, label: string): string {
  const text = textValue(value);
  if (!text) throw new Error(`Missing ${label}`);
  return text;
}

function textValue(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
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
