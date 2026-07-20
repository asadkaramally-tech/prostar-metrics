import type { LucideIcon } from "lucide-react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";

/**
 * Disciplined KPI treatment: label, value, semantic comparison, coverage/context.
 * Direction semantics are explicit — a higher value is NOT automatically good
 * (costs, variance, late arrivals, excluded jobs, loss-making jobs).
 * Presentation-only.
 */
export type DeltaSentiment = "good" | "bad" | "neutral";

export type KpiDelta = {
  /** Already-formatted comparison text, e.g. "+4.2% vs prior month". */
  text: string;
  /** Numeric direction of the change; null renders a flat marker. */
  direction: "up" | "down" | null;
  /**
   * Whether the change is favorable. Use "neutral" when directionality is
   * ambiguous — the arrow is suppressed and the text stays muted.
   */
  sentiment: DeltaSentiment;
};

/** Helper: derive delta presentation from a raw delta value and a goodWhen rule. */
export function kpiDelta(
  deltaValue: number | null | undefined,
  text: string,
  goodWhen: "up" | "down" | "none",
): KpiDelta {
  if (deltaValue === null || deltaValue === undefined || !Number.isFinite(deltaValue) || deltaValue === 0) {
    return { text, direction: null, sentiment: "neutral" };
  }
  const direction: "up" | "down" = deltaValue > 0 ? "up" : "down";
  if (goodWhen === "none") {
    return { text, direction: null, sentiment: "neutral" };
  }
  return { text, direction, sentiment: direction === goodWhen ? "good" : "bad" };
}

const sentimentText: Record<DeltaSentiment, string> = {
  good: "text-[color:var(--success)]",
  bad: "text-[color:var(--danger)]",
  neutral: "text-[color:var(--muted)]",
};

type KpiTileProps = {
  label: string;
  value: string;
  icon?: LucideIcon;
  delta?: KpiDelta;
  /** Coverage/context line, e.g. "41/44 jobs covered". */
  context?: string;
  /** Optional trailing status affordance (StatusPill or badge). */
  status?: React.ReactNode;
  /** "primary" gets a stronger value size for owner-ranked metrics. */
  emphasis?: "primary" | "default";
  className?: string;
};

export function KpiTile({
  label,
  value,
  icon: Icon,
  delta,
  context,
  status,
  emphasis = "default",
  className = "",
}: KpiTileProps) {
  const DeltaIcon = delta?.direction === "up" ? ArrowUpRight : delta?.direction === "down" ? ArrowDownRight : Minus;
  return (
    <section
      className={`metric-stat flex min-w-0 flex-col ${className}`}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-[10.5px] font-semibold uppercase text-[color:var(--subtle)]" title={label}>
          {label}
        </p>
        {Icon ? (
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[color:var(--surface-soft)] text-[color:var(--series-strong)]">
            <Icon className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
        ) : null}
      </div>
      <p
        className={`tnum mt-1 font-bold text-[color:var(--ink)] ${
          emphasis === "primary" ? "text-[1.8rem] leading-9" : "text-[25px] leading-8"
        }`}
      >
        {value}
      </p>
      {delta ? (
        <p className={`tnum mt-2 flex items-start gap-0.5 text-[11px] font-bold ${sentimentText[delta.sentiment]}`}>
          <DeltaIcon className="h-3 w-3 shrink-0" aria-hidden="true" />
          <span className="min-w-0" title={delta.text}>
            {delta.text}
          </span>
        </p>
      ) : null}
      {context ? (
        <p className="tnum mt-1 text-[11.5px] leading-4 text-[color:var(--muted)]" title={context}>
          {context}
        </p>
      ) : null}
      {status ? <div className="mt-auto pt-2">{status}</div> : null}
    </section>
  );
}
