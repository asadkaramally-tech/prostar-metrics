export const VISIT_MATCH_WINDOW_BEFORE_HOURS = 12;
export const VISIT_MATCH_WINDOW_AFTER_HOURS = 24;
export const DEFAULT_ON_TIME_THRESHOLD_MINUTES = 15;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export type TechnicianScheduleVisitInput = {
  scheduleId: string;
  blockIndex: number;
  employeeId: string;
  displayName?: string | null;
  personMapped?: boolean;
  jobId: string;
  workOrderId?: string | null;
  plannedStartAt: string;
  plannedEndAt: string;
  cancelled?: boolean;
};

export type TechnicianMobileEventKind = "arrival" | "completion" | "unverified";

export type TechnicianMobileEventInput = {
  sourceLogId: string;
  employeeId: string;
  displayName?: string | null;
  personMapped?: boolean;
  jobId: string;
  workOrderId?: string | null;
  occurredAt: string;
  kind: TechnicianMobileEventKind;
  statusId?: string | null;
  statusName?: string | null;
};

export type TechnicianVisitMatch = {
  visitId: string;
  scheduleId: string;
  blockIndex: number;
  employeeId: string;
  displayName: string;
  jobId: string;
  workOrderId: string | null;
  plannedStartAt: string;
  plannedEndAt: string;
  arrivalEventId: string | null;
  actualArrivalAt: string | null;
  completionEventId: string | null;
  actualCompletionAt: string | null;
  arrivalCovered: boolean;
  completionCovered: boolean;
  onTime: boolean | null;
  arrivalVarianceMinutes: number | null;
  durationVarianceMinutes: number | null;
  coverageReason: "covered" | "missing_verified_arrival" | "missing_verified_completion";
};

export type TechnicianVisitMatchingResult = {
  visits: TechnicianVisitMatch[];
  unmatchedEvents: TechnicianMobileEventInput[];
  scheduledVisits: number;
  arrivalCoveredVisits: number;
  completionCoveredVisits: number;
  onTimeVisits: number;
  cancelledVisits: number;
  invalidVisits: number;
  duplicateEvents: number;
  invalidEvents: number;
  unverifiedEvents: number;
};

type ParsedVisit = TechnicianScheduleVisitInput & {
  visitId: string;
  startMs: number;
  endMs: number;
};

type ParsedEvent = TechnicianMobileEventInput & {
  eventIndex: number;
  occurredMs: number;
};

export function matchTechnicianVisits(params: {
  visits: TechnicianScheduleVisitInput[];
  events: TechnicianMobileEventInput[];
  onTimeThresholdMinutes?: number;
}): TechnicianVisitMatchingResult {
  const threshold = validThreshold(params.onTimeThresholdMinutes);
  const cancelledVisits = params.visits.filter((visit) => visit.cancelled).length;
  const parsedVisits = params.visits
    .filter((visit) => !visit.cancelled)
    .map(parseVisit)
    .filter((visit): visit is ParsedVisit => visit !== null)
    .sort(compareVisits);
  const invalidVisits = params.visits.length - cancelledVisits - parsedVisits.length;
  const deduplicated = deduplicateEvents(params.events);
  const parsedEvents = deduplicated.events
    .map((event, eventIndex) => parseEvent(event, eventIndex))
    .filter((event): event is ParsedEvent => event !== null);
  const invalidEvents = deduplicated.events.length - parsedEvents.length;
  const verifiedEvents = parsedEvents.filter((event) => event.kind !== "unverified");
  const unverifiedEvents = parsedEvents.length - verifiedEvents.length;

  const arrivalByVisit = assignArrivals(parsedVisits, verifiedEvents.filter((event) => event.kind === "arrival"));
  const completionByVisit = assignCompletions(
    parsedVisits,
    verifiedEvents.filter((event) => event.kind === "completion"),
    arrivalByVisit,
  );

  const usedEventIndexes = new Set<number>();
  for (const event of arrivalByVisit.values()) usedEventIndexes.add(event.eventIndex);
  for (const event of completionByVisit.values()) usedEventIndexes.add(event.eventIndex);

  const visits = parsedVisits.map((visit): TechnicianVisitMatch => {
    const arrival = arrivalByVisit.get(visit.visitId) ?? null;
    const completion = completionByVisit.get(visit.visitId) ?? null;
    const arrivalVarianceMinutes = arrival ? (arrival.occurredMs - visit.startMs) / MINUTE_MS : null;
    const durationVarianceMinutes = arrival && completion
      ? ((completion.occurredMs - arrival.occurredMs) - (visit.endMs - visit.startMs)) / MINUTE_MS
      : null;

    return {
      visitId: visit.visitId,
      scheduleId: visit.scheduleId,
      blockIndex: visit.blockIndex,
      employeeId: visit.employeeId,
      displayName: displayName(visit.displayName, visit.employeeId),
      jobId: visit.jobId,
      workOrderId: visit.workOrderId ?? null,
      plannedStartAt: visit.plannedStartAt,
      plannedEndAt: visit.plannedEndAt,
      arrivalEventId: arrival?.sourceLogId ?? null,
      actualArrivalAt: arrival?.occurredAt ?? null,
      completionEventId: completion?.sourceLogId ?? null,
      actualCompletionAt: completion?.occurredAt ?? null,
      arrivalCovered: arrival !== null,
      completionCovered: completion !== null,
      onTime: arrivalVarianceMinutes === null ? null : arrivalVarianceMinutes <= threshold,
      arrivalVarianceMinutes,
      durationVarianceMinutes,
      coverageReason: !arrival
        ? "missing_verified_arrival"
        : !completion
          ? "missing_verified_completion"
          : "covered",
    };
  });

  return {
    visits,
    unmatchedEvents: parsedEvents
      .filter((event) => !usedEventIndexes.has(event.eventIndex))
      .map(stripParsedEvent),
    scheduledVisits: visits.length,
    arrivalCoveredVisits: visits.filter((visit) => visit.arrivalCovered).length,
    completionCoveredVisits: visits.filter((visit) => visit.completionCovered).length,
    onTimeVisits: visits.filter((visit) => visit.onTime === true).length,
    cancelledVisits,
    invalidVisits,
    duplicateEvents: deduplicated.duplicateCount,
    invalidEvents,
    unverifiedEvents,
  };
}

function assignArrivals(visits: ParsedVisit[], arrivals: ParsedEvent[]) {
  const precedingBoundaries = precedingVisitBoundaries(visits);
  const candidates: Array<{ visit: ParsedVisit; event: ParsedEvent; distance: number }> = [];

  for (const visit of visits) {
    const windowStart = visit.startMs - VISIT_MATCH_WINDOW_BEFORE_HOURS * HOUR_MS;
    const windowEnd = visit.startMs + VISIT_MATCH_WINDOW_AFTER_HOURS * HOUR_MS;
    const precedingBoundary = precedingBoundaries.get(visit.visitId) ?? windowStart;
    const lowerBound = Math.max(windowStart, precedingBoundary);

    for (const event of arrivals) {
      if (!sameVisitIdentity(visit, event)) continue;
      if (event.occurredMs < lowerBound || event.occurredMs > windowEnd) continue;
      candidates.push({ visit, event, distance: Math.abs(event.occurredMs - visit.startMs) });
    }
  }

  candidates.sort((left, right) =>
    left.event.occurredMs - right.event.occurredMs ||
    left.distance - right.distance ||
    compareVisits(left.visit, right.visit) ||
    left.event.sourceLogId.localeCompare(right.event.sourceLogId),
  );

  const byVisit = new Map<string, ParsedEvent>();
  const usedEvents = new Set<number>();
  for (const candidate of candidates) {
    if (byVisit.has(candidate.visit.visitId) || usedEvents.has(candidate.event.eventIndex)) continue;
    byVisit.set(candidate.visit.visitId, candidate.event);
    usedEvents.add(candidate.event.eventIndex);
  }
  return byVisit;
}

function assignCompletions(
  visits: ParsedVisit[],
  completions: ParsedEvent[],
  arrivalByVisit: Map<string, ParsedEvent>,
) {
  const byVisit = new Map<string, ParsedEvent>();
  const usedEvents = new Set<number>();
  const groupedVisits = groupVisitsByIdentity(visits);

  for (const group of groupedVisits.values()) {
    for (let index = 0; index < group.length; index += 1) {
      const visit = group[index];
      const arrival = arrivalByVisit.get(visit.visitId);
      if (!arrival) continue;

      const nextArrival = group
        .slice(index + 1)
        .map((nextVisit) => arrivalByVisit.get(nextVisit.visitId))
        .find((event): event is ParsedEvent => event !== undefined);
      const windowEnd = visit.startMs + VISIT_MATCH_WINDOW_AFTER_HOURS * HOUR_MS;
      const completion = completions
        .filter((event) =>
          !usedEvents.has(event.eventIndex) &&
          sameVisitIdentity(visit, event) &&
          event.occurredMs >= arrival.occurredMs &&
          event.occurredMs <= windowEnd &&
          (!nextArrival || event.occurredMs < nextArrival.occurredMs),
        )
        .sort((left, right) => left.occurredMs - right.occurredMs || left.sourceLogId.localeCompare(right.sourceLogId))[0];

      if (!completion) continue;
      byVisit.set(visit.visitId, completion);
      usedEvents.add(completion.eventIndex);
    }
  }

  return byVisit;
}

function precedingVisitBoundaries(visits: ParsedVisit[]) {
  const boundaries = new Map<string, number>();
  for (const group of groupVisitsByIdentity(visits).values()) {
    for (let index = 1; index < group.length; index += 1) {
      boundaries.set(group[index].visitId, group[index - 1].endMs);
    }
  }
  return boundaries;
}

function groupVisitsByIdentity(visits: ParsedVisit[]) {
  const grouped = new Map<string, ParsedVisit[]>();
  for (const visit of visits) {
    const key = `${visit.employeeId}:${visit.workOrderId ? `work-order:${visit.workOrderId}` : `job:${visit.jobId}`}`;
    const current = grouped.get(key) ?? [];
    current.push(visit);
    grouped.set(key, current);
  }
  for (const group of grouped.values()) group.sort(compareVisits);
  return grouped;
}

function sameVisitIdentity(visit: ParsedVisit, event: ParsedEvent) {
  if (visit.employeeId !== event.employeeId) return false;
  if (visit.workOrderId && event.workOrderId) return visit.workOrderId === event.workOrderId;
  return Boolean(visit.jobId) && visit.jobId === event.jobId;
}

function deduplicateEvents(events: TechnicianMobileEventInput[]) {
  const seenIds = new Set<string>();
  const seenTimestamps = new Set<string>();
  const deduplicated: TechnicianMobileEventInput[] = [];
  let duplicateCount = 0;

  for (const event of events) {
    const timestampKey = [
      event.employeeId,
      event.jobId,
      event.workOrderId ?? "",
      event.kind,
      event.occurredAt,
    ].join(":");
    if (seenIds.has(event.sourceLogId) || seenTimestamps.has(timestampKey)) {
      duplicateCount += 1;
      continue;
    }
    seenIds.add(event.sourceLogId);
    seenTimestamps.add(timestampKey);
    deduplicated.push(event);
  }

  return { events: deduplicated, duplicateCount };
}

function parseVisit(visit: TechnicianScheduleVisitInput): ParsedVisit | null {
  const startMs = Date.parse(visit.plannedStartAt);
  const endMs = Date.parse(visit.plannedEndAt);
  if (
    !visit.employeeId ||
    !visit.jobId ||
    visit.personMapped === false ||
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    endMs <= startMs
  ) {
    return null;
  }
  return { ...visit, visitId: `${visit.scheduleId}:${visit.blockIndex}`, startMs, endMs };
}

function parseEvent(event: TechnicianMobileEventInput, eventIndex: number): ParsedEvent | null {
  const occurredMs = Date.parse(event.occurredAt);
  if (
    !event.employeeId ||
    !event.jobId ||
    event.personMapped === false ||
    !Number.isFinite(occurredMs)
  ) {
    return null;
  }
  return { ...event, eventIndex, occurredMs };
}

function stripParsedEvent(event: ParsedEvent): TechnicianMobileEventInput {
  return {
    sourceLogId: event.sourceLogId,
    employeeId: event.employeeId,
    displayName: event.displayName,
    personMapped: event.personMapped,
    jobId: event.jobId,
    workOrderId: event.workOrderId,
    occurredAt: event.occurredAt,
    kind: event.kind,
    statusId: event.statusId,
    statusName: event.statusName,
  };
}

function validThreshold(value: number | undefined) {
  return Number.isFinite(value) && (value ?? -1) >= 0 ? Number(value) : DEFAULT_ON_TIME_THRESHOLD_MINUTES;
}

function compareVisits(left: ParsedVisit, right: ParsedVisit) {
  return left.startMs - right.startMs || left.visitId.localeCompare(right.visitId);
}

function displayName(value: string | null | undefined, employeeId: string) {
  return value?.trim() || `Employee ${employeeId}`;
}
