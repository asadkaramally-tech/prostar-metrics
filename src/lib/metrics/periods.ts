export const DASHBOARD_HISTORY_START = "2023-01-01";

export function monthParamToPeriodStart(month: string | null | undefined): string | undefined {
  if (!month) {
    return undefined;
  }

  const trimmed = month.trim();
  if (!/^\d{4}-\d{2}$/.test(trimmed)) {
    return undefined;
  }

  const [year, monthNumber] = trimmed.split("-").map(Number);
  if (!Number.isInteger(year) || !Number.isInteger(monthNumber) || monthNumber < 1 || monthNumber > 12) {
    return undefined;
  }

  return `${String(year).padStart(4, "0")}-${String(monthNumber).padStart(2, "0")}-01`;
}

/** Resolve a dashboard month into the supported Jan 2023–current Pacific range. */
export function boundedDashboardPeriodStart(
  month: string | null | undefined,
  now = new Date(),
): string | null {
  const current = pacificCurrentPeriodStart(now);
  if (month == null || month === "") return current;
  const requested = monthParamToPeriodStart(month);
  if (!requested || requested < DASHBOARD_HISTORY_START || requested > current) return null;
  return requested;
}

export function periodStartToMonthKey(periodStart: string | undefined): string | undefined {
  if (!periodStart || !/^\d{4}-\d{2}-01$/.test(periodStart)) {
    return undefined;
  }

  return periodStart.slice(0, 7);
}

function pacificCurrentPeriodStart(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (!year || !month) throw new Error("Unable to determine the current dashboard month.");
  return `${year}-${month}-01`;
}
