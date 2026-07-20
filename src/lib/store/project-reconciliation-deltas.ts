export type ReconciliationProjectRow = {
  id: string;
  periodStart: string | null;
  total: number;
  outcome?: string | null;
  fetchedAt?: string | null;
};

export function applyVerifiedProjectDeltas(
  target: Map<string, ReconciliationProjectRow[]>,
  deltas: ReconciliationProjectRow[],
) {
  const changedIds = new Set(deltas.map((row) => row.id));
  for (const [month, rows] of target) target.set(month, rows.filter((row) => !changedIds.has(row.id)));
  for (const row of deltas) {
    if (!row.periodStart) continue;
    target.set(row.periodStart, [...(target.get(row.periodStart) ?? []), row]);
  }
}
