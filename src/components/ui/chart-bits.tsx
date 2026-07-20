/**
 * Shared chart constants and presentation pieces for Recharts.
 * One restrained categorical palette with consistent meaning across routes.
 * Presentation-only — chart data, series, and types are unchanged.
 */

/** Categorical palette. Meaning is stable across all four routes. */
export const CHART = {
  /** The only expressive series color; use only for each route's star metric. */
  accent: "#5b63d3",
  /** Strong neutral supporting series: revenue, counts, primary capacity. */
  navy: "#404a60",
  /** Travel is a meaningful capacity-family exception. */
  sky: "#2673a5",
  /** Positive outcomes only. */
  green: "#1a8a5a",
  /** Caution and parts-time data. */
  amber: "#b4791a",
  /** Negative outcomes only. */
  red: "#d0463a",
  /** Neutral categorical support. */
  purple: "#8d95a5",
  /** Neutral categorical support. */
  teal: "#707a8c",
  /** Neutral/supporting series. */
  slate: "#64748b",
  /** Remainder/unrecorded fills. */
  fog: "#e4e9ef",
  /** Weak neutral supporting series. */
  weak: "#9aa2b2",
  /** Waterfall deductions. */
  deduction: "#c3cad6",
  /** Strong ink for a waterfall base. */
  ink: "#101422",
  /** Grid lines. */
  grid: "#eff1f5",
} as const;

/** Neutral deal-tier series palette; semantic heatmaps define their own ramp. */
export const TIER_COLORS = [CHART.navy, "#667184", "#87909f", "#adb4bf"] as const;

/** Shared axis tick styling. */
export const AXIS_TICK = { fontSize: 10.5, fill: "#687183", fontVariantNumeric: "tabular-nums" } as const;

/** Shared props for CartesianGrid. */
export const GRID_PROPS = { stroke: CHART.grid, vertical: false } as const;

/** Recharts Tooltip contentStyle/wrapper styling for a consistent look. */
export const TOOLTIP_STYLE = {
  contentStyle: {
    borderRadius: 10,
    border: "1px solid var(--hair)",
    background: "#ffffff",
    boxShadow: "0 14px 30px -14px rgba(16, 24, 40, 0.28)",
    fontSize: 12,
    padding: "9px 11px",
    fontVariantNumeric: "tabular-nums",
  },
  labelStyle: { fontWeight: 600, color: "var(--ink)", marginBottom: 4 },
  itemStyle: { padding: 0 },
} as const;

/** Shared Legend wrapper style (fontSize etc.). */
export const LEGEND_STYLE = { fontSize: 11.5, color: "var(--ink-2)", paddingTop: 8 } as const;

export function ChartDefs({ id, color = CHART.accent, fillOpacity = 0.14 }: { id: string; color?: string; fillOpacity?: number }) {
  return (
    <defs>
      <linearGradient id={`${id}-area`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor={color} stopOpacity={fillOpacity} />
        <stop offset="100%" stopColor={color} stopOpacity="0" />
      </linearGradient>
      <filter id={`${id}-glow`} x="-20%" y="-30%" width="140%" height="170%">
        <feDropShadow dx="0" dy="2" stdDeviation="3.5" floodColor={color} floodOpacity="0.28" />
      </filter>
    </defs>
  );
}

type ChartFrameProps = {
  /** Fixed-height class, e.g. "h-72" — stable heights prevent layout shift. */
  heightClassName: string;
  children: React.ReactNode;
  /**
   * Accessible textual summary of what the chart answers, using data already
   * present in the model. Rendered visually-hidden for screen readers.
   */
  summary?: string;
  className?: string;
};

/** Stable-size wrapper for a ResponsiveContainer with an accessible summary. */
export function ChartFrame({ heightClassName, children, summary, className = "" }: ChartFrameProps) {
  return (
    <figure className={`m-0 min-w-0 ${className}`}>
      {summary ? <figcaption className="sr-only">{summary}</figcaption> : null}
      <div className={`${heightClassName} w-full min-w-0`}>{children}</div>
    </figure>
  );
}

type LegendSwatchProps = {
  color: string;
  label: string;
  value?: string;
};

/** Inline manual legend row item (used where custom legends already exist). */
export function LegendSwatch({ color, label, value }: LegendSwatchProps) {
  return (
    <span className="inline-flex items-center gap-[7px] text-[11.5px] font-medium text-[color:var(--ink-2)]">
      <span className="h-[3px] w-3.5 shrink-0 rounded-sm" style={{ backgroundColor: color }} aria-hidden="true" />
      <span>{label}</span>
      {value ? <span className="tnum font-medium text-[color:var(--brand-ink)]">{value}</span> : null}
    </span>
  );
}
