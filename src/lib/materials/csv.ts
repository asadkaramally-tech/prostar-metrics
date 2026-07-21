import type { MaterialsItemRow } from "@/lib/metrics/materials";

export function buildMaterialsCsv(items: MaterialsItemRow[], priorShort: string): string {
  const header = [
    "Item",
    "Part No",
    "Category",
    "Qty",
    `${priorShort} Qty`,
    "Qty Change",
    "Unit Sell",
    "Extended (Ex-Tax)",
    "Jobs",
    "Job IDs",
  ];
  const lines = [header.map(csvEscape).join(",")];
  for (const row of items) {
    lines.push(
      [
        row.name,
        row.partNo ?? "",
        row.category,
        row.qty,
        row.priorMonthQty,
        qtyChangeText(row.qty, row.priorMonthQty),
        row.unitSell ?? "",
        row.extended,
        row.jobCount,
        row.jobIds.join("; "),
      ]
        .map((value) => csvEscape(String(value)))
        .join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

export function materialsCsvFilename(monthKey: string): string {
  return `materials-${monthKey}.csv`;
}

function qtyChangeText(qty: number, priorQty: number): string {
  if (priorQty === 0 && qty > 0) return "new";
  const diff = Math.round((qty - priorQty) * 1000) / 1000;
  if (diff === 0) return "0";
  return diff > 0 ? `+${qtyText(diff)}` : `-${qtyText(Math.abs(diff))}`;
}

function qtyText(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function csvEscape(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
