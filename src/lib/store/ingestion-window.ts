export function inclusivePacificDateWindow(days: number, now = new Date()) {
  const length = Math.max(1, Math.trunc(days));
  const endDate = pacificDate(now);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  const start = new Date(end.getTime() - (length - 1) * 86_400_000);
  return { startDate: start.toISOString().slice(0, 10), endDate };
}

export function pacificDate(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) throw new Error("Unable to resolve Pacific business date");
  return `${year}-${month}-${day}`;
}
