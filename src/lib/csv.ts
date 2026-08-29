/** Escape a CSV cell and neutralize spreadsheet formulas in source text. */
export function csvCell(value: string | number): string {
  const text = String(value);
  const safe = typeof value === "string" && /^[\t\r ]*[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
