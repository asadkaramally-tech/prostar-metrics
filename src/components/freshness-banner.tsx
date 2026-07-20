import type { FreshnessStatus } from "@/lib/metrics/freshness";

/**
 * Approved freshness pill (tokens.css .pill): "Updated N min ago" from the
 * last successful ingestion run — truthful, never "Live". Green only when the
 * data state is current; every other state renders the amber .warn variant.
 * The full factual detail stays available on hover (title) and to screen
 * readers.
 */
export function FreshnessBanner({ freshness, now }: { freshness: FreshnessStatus; now?: Date }) {
  const updatedAt = freshness.lastSuccessfulRunAt ? new Date(freshness.lastSuccessfulRunAt) : null;
  const hasTimestamp = updatedAt !== null && !Number.isNaN(updatedAt.getTime());
  const text = hasTimestamp ? `Updated ${relativeAge(updatedAt, now ?? new Date())}` : freshness.label;
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

function relativeAge(updatedAt: Date, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - updatedAt.getTime()) / 60000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} ${hours === 1 ? "hr" : "hrs"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} days ago`;
}
