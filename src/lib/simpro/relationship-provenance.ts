export const QUOTE_DIRECT_LINK_FIELDS = [
  "LinkedJobID",
  "linkedJobId",
  "linked_job_id",
] as const;

export const JOB_CONVERTED_FROM_FIELDS = [
  "ConvertedFrom",
  "convertedFrom",
  "converted_from",
] as const;

const CONVERTED_FROM_TYPE_FIELDS = ["Type", "type"] as const;
const CONVERTED_FROM_ID_FIELDS = ["ID", "Id", "id"] as const;

export type ResolvedJobConvertedFrom = {
  type: string | null;
  id: number | null;
  convertedAt: string | null;
};

export function resolveQuoteDirectLinkedJobId(payload: unknown): number | null {
  const record = relationshipPayload(payload, "quote");
  return resolveAliasedScalarId(record, QUOTE_DIRECT_LINK_FIELDS, "Raw quote direct-link");
}

export function resolveJobConvertedFromQuoteId(payload: unknown): number | null {
  const convertedFrom = resolveJobConvertedFrom(payload);
  return convertedFrom.type === "Quote" ? convertedFrom.id : null;
}

export function resolveJobConvertedFrom(payload: unknown): ResolvedJobConvertedFrom {
  const record = relationshipPayload(payload, "job");
  const candidates = JOB_CONVERTED_FROM_FIELDS.flatMap((field) => {
    if (!Object.prototype.hasOwnProperty.call(record, field)) return [];
    const value = record[field];
    if (value === null || value === undefined) return [];
    if (!isRecord(value)) {
      throw new Error(`Raw job ${field} provenance is not an object.`);
    }
    return [{ field, value }];
  });

  if (candidates.length === 0) {
    return { type: null, id: null, convertedAt: null };
  }

  const resolvedTypes = new Set<string>();
  const resolvedIds = new Set<number>();
  let convertedAt: string | null = null;
  for (const candidate of candidates) {
    const type = resolveAliasedString(
      candidate.value,
      CONVERTED_FROM_TYPE_FIELDS,
      `Raw job ${candidate.field} type`,
    );
    const id = resolveAliasedScalarId(
      candidate.value,
      CONVERTED_FROM_ID_FIELDS,
      `Raw job ${candidate.field} ID`,
    );
    if (type !== null) resolvedTypes.add(type);
    if (id !== null) resolvedIds.add(id);
    convertedAt ??= timestampText(candidate.value.Date ?? candidate.value.date);
  }

  if (resolvedTypes.size > 1) {
    throw new Error("Raw job ConvertedFrom type aliases conflict.");
  }
  if (resolvedIds.size > 1) {
    throw new Error("Raw job ConvertedFrom ID aliases conflict.");
  }

  const type = resolvedTypes.values().next().value ?? null;
  const id = resolvedIds.values().next().value ?? null;
  if (type === "Quote" && id === null) {
    throw new Error("Raw job ConvertedFrom.Type is Quote but no valid ConvertedFrom ID is present.");
  }

  return { type, id, convertedAt };
}

function resolveAliasedScalarId(
  record: Record<string, unknown>,
  fields: readonly string[],
  context: string,
): number | null {
  const resolved = new Set<number>();
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) continue;
    const value = record[field];
    if (value === null || value === undefined) continue;
    resolved.add(relationshipScalarId(value, `${context} ${field}`));
  }
  if (resolved.size > 1) {
    throw new Error(`${context} scalar fields conflict.`);
  }
  return resolved.values().next().value ?? null;
}

function resolveAliasedString(
  record: Record<string, unknown>,
  fields: readonly string[],
  context: string,
): string | null {
  const resolved = new Set<string>();
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) continue;
    const value = record[field];
    if (value === null || value === undefined) continue;
    if (typeof value !== "string") {
      throw new Error(`${context} ${field} is not a string.`);
    }
    resolved.add(value);
  }
  if (resolved.size > 1) {
    throw new Error(`${context} aliases conflict.`);
  }
  return resolved.values().next().value ?? null;
}

function relationshipScalarId(value: unknown, context: string): number {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`${context} is not a numeric or string scalar ID.`);
  }
  const normalized = typeof value === "string" ? value.trim() : value;
  if (normalized === "") {
    throw new Error(`${context} is not a positive safe-integer scalar ID.`);
  }
  const id = Number(normalized);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`${context} is not a positive safe-integer scalar ID.`);
  }
  return id;
}

function relationshipPayload(payload: unknown, entity: "quote" | "job"): Record<string, unknown> {
  if (!isRecord(payload)) {
    throw new Error(`Authoritative raw ${entity} payload is not an object.`);
  }
  return payload;
}

function timestampText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
