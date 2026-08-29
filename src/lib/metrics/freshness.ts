export type FreshnessState = "current" | "partial" | "building" | "stale" | "suspect" | "failed" | "missing";

export type FreshnessStatus = {
  pageKey: string;
  state: FreshnessState;
  label: string;
  detail: string;
  dataThrough: string | null;
  lastSuccessfulRunAt: string | null;
  lastFailedRunAt: string | null;
};

export type FreshnessInput = {
  pageKey: string;
  dataThrough?: Date | string | null;
  lastSuccessfulRunAt?: Date | string | null;
  lastFailedRunAt?: Date | string | null;
  maxAgeHours: number;
  explicitState?: FreshnessState | null;
  coverageDetail?: string | null;
  now?: Date;
};

export function buildFreshnessStatus(input: FreshnessInput): FreshnessStatus {
  const now = input.now ?? new Date();
  const dataThrough = toDate(input.dataThrough);
  const lastSuccessfulRunAt = toDate(input.lastSuccessfulRunAt);
  const lastFailedRunAt = toDate(input.lastFailedRunAt);

  if (input.explicitState === "failed") {
    return status(input, "failed", "Latest ingestion failed", dataThrough, lastSuccessfulRunAt, lastFailedRunAt,
      dataThrough ? `Showing last successful data through ${formatDate(dataThrough)}.` : "No successful source window is available.");
  }

  if (input.explicitState === "suspect") {
    return status(input, "suspect", "Data reconciliation is suspect", dataThrough, lastSuccessfulRunAt, lastFailedRunAt,
      input.coverageDetail ?? "Count or money drift requires repair.");
  }

  if (input.explicitState === "building") {
    return status(input, "building", "Data is building", dataThrough, lastSuccessfulRunAt, lastFailedRunAt,
      input.coverageDetail ?? "Required source windows or rollups are still incomplete.");
  }

  if (input.explicitState === "stale") {
    return status(input, "stale", "Data is stale", dataThrough, lastSuccessfulRunAt, lastFailedRunAt,
      input.coverageDetail ?? (dataThrough ? `Data-through is ${formatDate(dataThrough)}.` : "Required source evidence is stale."));
  }

  if (!dataThrough || !lastSuccessfulRunAt) {
    return {
      pageKey: input.pageKey,
      state: "missing",
      label: "No app-owned data yet",
      detail: "Ingestion has not completed for this dashboard.",
      dataThrough: null,
      lastSuccessfulRunAt: toIso(lastSuccessfulRunAt),
      lastFailedRunAt: toIso(lastFailedRunAt),
    };
  }

  if (lastFailedRunAt && lastFailedRunAt > lastSuccessfulRunAt) {
    return {
      pageKey: input.pageKey,
      state: "failed",
      label: "Latest ingestion failed",
      detail: `Showing last successful data through ${formatDate(dataThrough)}.`,
      dataThrough: dataThrough.toISOString(),
      lastSuccessfulRunAt: lastSuccessfulRunAt.toISOString(),
      lastFailedRunAt: lastFailedRunAt.toISOString(),
    };
  }

  const ageHours = (now.getTime() - dataThrough.getTime()) / 36e5;
  if (ageHours > input.maxAgeHours) {
    return {
      pageKey: input.pageKey,
      state: "stale",
      label: "Data is stale",
      detail: `Data-through is ${formatDate(dataThrough)}.`,
      dataThrough: dataThrough.toISOString(),
      lastSuccessfulRunAt: lastSuccessfulRunAt.toISOString(),
      lastFailedRunAt: toIso(lastFailedRunAt),
    };
  }

  if (input.explicitState === "partial") {
    return status(input, "partial", "Partial source coverage", dataThrough, lastSuccessfulRunAt, lastFailedRunAt,
      input.coverageDetail ?? `Supported data through ${formatDate(dataThrough)}; one or more secondary sources are incomplete.`);
  }

  return {
    pageKey: input.pageKey,
    state: "current",
    label: "Data current",
    detail: `Data-through ${formatDate(dataThrough)}.`,
    dataThrough: dataThrough.toISOString(),
    lastSuccessfulRunAt: lastSuccessfulRunAt.toISOString(),
    lastFailedRunAt: toIso(lastFailedRunAt),
  };
}

function status(
  input: FreshnessInput,
  state: FreshnessState,
  label: string,
  dataThrough: Date | null,
  lastSuccessfulRunAt: Date | null,
  lastFailedRunAt: Date | null,
  detail: string,
): FreshnessStatus {
  return {
    pageKey: input.pageKey,
    state,
    label,
    detail,
    dataThrough: toIso(dataThrough),
    lastSuccessfulRunAt: toIso(lastSuccessfulRunAt),
    lastFailedRunAt: toIso(lastFailedRunAt),
  };
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function formatDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}
