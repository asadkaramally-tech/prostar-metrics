const namedEntities: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  hellip: "...",
  lt: "<",
  nbsp: " ",
  ndash: "-",
  mdash: "-",
  quot: '"',
};

export function plainDisplayText(value: string | null | undefined, fallback: string, maxLength = 180) {
  const text = (value ?? "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/p\s*>|<\/li\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_match, entity: string) => decodeEntity(entity))
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return fallback;
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(1, maxLength - 3)).trimEnd()}...`;
}

function decodeEntity(entity: string) {
  const normalized = entity.toLowerCase();
  if (normalized.startsWith("#x")) return codePoint(Number.parseInt(normalized.slice(2), 16));
  if (normalized.startsWith("#")) return codePoint(Number.parseInt(normalized.slice(1), 10));
  return namedEntities[normalized] ?? `&${entity};`;
}

function codePoint(value: number) {
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) return "";
  return String.fromCodePoint(value);
}
