const AR_QUALIFIERS = new Set([
  "account",
  "accounts",
  "age",
  "aged",
  "aging",
  "balance",
  "balances",
  "receivable",
  "receivables",
  "status",
  "statuses",
]);

export function normalizeApiDimensionName(value) {
  return String(value ?? "")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

export function isForbiddenInvoiceArDimensionName(value) {
  const terms = normalizeApiDimensionName(value);
  const compact = terms.join("");
  if (compact.includes("invoic") || compact.includes("receivabl")) return true;

  const arIndex = terms.indexOf("ar");
  if (arIndex < 0) return false;
  return terms.length === 1 || terms.some((term, index) => index !== arIndex && AR_QUALIFIERS.has(term));
}

export function forbiddenInvoiceArDimensionPaths(value, prefix = "dimensions") {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => forbiddenInvoiceArDimensionPaths(item, `${prefix}[${index}]`));
  }
  if (!value || typeof value !== "object") return [];

  return Object.entries(value).flatMap(([key, nested]) => {
    const path = `${prefix}.${key}`;
    return [
      ...(isForbiddenInvoiceArDimensionName(key) ? [path] : []),
      ...forbiddenInvoiceArDimensionPaths(nested, path),
    ];
  });
}
