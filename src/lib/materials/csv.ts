import type { MaterialsItemRow } from "@/lib/metrics/materials";
import { csvCell } from "@/lib/csv";

/** CSV comparison columns use the page's single, matched comparator. Prior
 * month is retained only as explicitly-labelled operating context. */
export function buildMaterialsCsv(items: MaterialsItemRow[], comparisonShort: string, priorMonthShort?: string): string {
  const header = [
    "Item",
    "Part No",
    "Category",
    "Sales (Ex-Tax)",
    `${comparisonShort} Sales (Ex-Tax)`,
    `Sales Change (${comparisonShort})`,
    "Qty",
    `${comparisonShort} Qty`,
    `Qty Change (${comparisonShort})`,
    ...(priorMonthShort ? [`${priorMonthShort} Sales (Context)`, `${priorMonthShort} Qty (Context)`] : []),
    "Unit Sell",
    "Extended (Ex-Tax)",
    "Jobs",
    "Job IDs",
  ];
  const lines = [header.map(csvCell).join(",")];
  for (const row of items) {
    lines.push(
      [
        row.name,
        row.partNo ?? "",
        row.category,
        row.extended,
        row.comparisonSales ?? "",
        signedText(row.comparisonSalesDelta),
        row.qty,
        row.comparisonQty ?? "",
        signedText(row.comparisonQtyDelta),
        ...(priorMonthShort ? [row.priorMonthExtended ?? "", row.priorMonthQty ?? ""] : []),
        row.unitSell ?? "",
        row.extended,
        row.jobCount,
        row.jobIds.join("; "),
      ]
        .map((value) => csvCell(value))
        .join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

function signedText(value: number | null): string {
  if (value === null) return "";
  if (value === 0) return "0";
  return value > 0 ? `+${value}` : String(value);
}

export function materialsCsvFilename(monthKey: string): string {
  return `materials-${monthKey}.csv`;
}
