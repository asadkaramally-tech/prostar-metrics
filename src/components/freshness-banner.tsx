import type { FreshnessStatus } from "@/lib/metrics/freshness";

/**
 * Freshness separates the business-data cutoff from the pipeline check time.
 * The two timestamps answer different questions and must never be collapsed
 * into a generic "Updated" or "Live" claim.
 * The full factual detail stays available on hover (title) and to screen
 * readers.
 */
export function FreshnessBanner({ freshness, now }: { freshness: FreshnessStatus; now?: Date }) {
  const updatedAt = freshness.lastSuccessfulRunAt ? new Date(freshness.lastSuccessfulRunAt) : null;
  const hasTimestamp = updatedAt !== null && !Number.isNaN(updatedAt.getTime());
  const throughAt = freshness.dataThrough ? new Date(freshness.dataThrough) : null;
  const hasDataThrough = throughAt !== null && !Number.isNaN(throughAt.getTime());
  const checked = hasTimestamp ? `checked ${relativeAge(updatedAt, now ?? new Date())}` : null;
  const text = hasDataThrough
    ? `Data through ${formatCutoff(throughAt)}${checked ? ` · ${checked}` : ""}`
    : checked ? `Pipeline ${checked}` : freshness.label;
  const warn = freshness.state !== "current";
  return (
    <span
      className={warn ? "pill warn" : "pill"}
      style={{ cursor: "default" }}
      role="status"
      title={freshness.detail}
    >
      <span className="dot" />
      {text}
      <span className="sr-only">{freshness.label}. {freshness.detail}</span>
    </span>
  );
}

function formatCutoff(value: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(value);
}

function relativeAge(updatedAt: Date, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - updatedAt.getTime()) / 60000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} ${hours === 1 ? "hr" : "hrs"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} days ago`;
}
