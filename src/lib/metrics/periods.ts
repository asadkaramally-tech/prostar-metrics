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

export function periodStartToMonthKey(periodStart: string | undefined): string | undefined {
  if (!periodStart || !/^\d{4}-\d{2}-01$/.test(periodStart)) {
    return undefined;
  }

  return periodStart.slice(0, 7);
}
