import type { CSSProperties, ReactNode } from "react";

/* Approved KPI band (brief §3.1, mockups .kpis.hero): a primary dark stat
   card (204px) beside a 2×2 grid of 96px tiles. Presentational only. */

/** Bullet-caption money: "$149.9K" / "$1.96M" / "$444". */
export function moneyK(v: number): string {
  const a = Math.abs(v);
  const s = v < 0 ? "−$" : "$";
  if (a >= 1e6) return `${s}${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${s}${(a / 1e3).toFixed(1)}K`;
  return s + Math.round(a).toLocaleString();
}

export function KpiBand({ ariaLabel, children, style, className }: { ariaLabel?: string; children?: ReactNode; style?: CSSProperties; className?: string }) {
  return (
    <section className={className ? `kpis hero ${className}` : "kpis hero"} aria-label={ariaLabel} style={style}>
      {children}
    </section>
  );
}

export function KpiTiles({ children }: { children?: ReactNode }) {
  return <div className="ktiles">{children}</div>;
}

export function KpiBandNote({ children }: { children?: ReactNode }) {
  return <p className="kpiband-note">{children}</p>;
}

/* Delta pill — the text always names its comparison ("↓ 91.8% vs Jul ’25");
   a bare percentage is banned everywhere. */
export type DpillProps = {
  tone: "up" | "down" | "neutral";
  def?: string;
  children?: ReactNode;
};

export function Dpill({ tone, def, children }: DpillProps) {
  return (
    <span className={`dpill ${tone}`} data-def={def}>
      {children}
    </span>
  );
}

/* ONE comparison bar (bullet): fill = this month-to-date; two tick marks on
   the same track mark the prior month and the same month last year, keyed by
   the caption row. Scale = 1.04 × the largest of the values present. Where a
   prior period has no data its tick is omitted and the caption says so —
   never an invented number. */
export type BulletMarkSpec = {
  label: string;
  value: number | null;
  /** Caption text when value is absent (e.g. "no run", "pending", "no data"). */
  ghost?: string;
};

export type BulletBarProps = {
  value: number;
  m1?: BulletMarkSpec | null;
  m2?: BulletMarkSpec | null;
  fmt: (v: number) => string;
  ariaLabel: string;
};

export function BulletBar({ value, m1, m2, fmt, ariaLabel }: BulletBarProps) {
  const present = [value, m1?.value ?? null, m2?.value ?? null].filter(
    (v): v is number => v != null && Number.isFinite(v) && v > 0,
  );
  const scale = 1.04 * Math.max(...(present.length ? present : [1]));
  const pct = (v: number) => `${Math.max(0, Math.min(100, (v / scale) * 100)).toFixed(1)}%`;
  const mark = (spec: BulletMarkSpec | null | undefined, cls: "m1" | "m2") =>
    spec && spec.value != null && Number.isFinite(spec.value) ? (
      <span className={`bmark ${cls}`} style={{ left: pct(spec.value) }} />
    ) : null;
  const key = (spec: BulletMarkSpec | null | undefined, cls: "m1" | "m2") => {
    if (!spec) return null;
    if (spec.value == null || !Number.isFinite(spec.value)) {
      return (
        <span className="bkey">
          {spec.label} <b>{spec.ghost ?? "no data"}</b>
        </span>
      );
    }
    return (
      <span className="bkey">
        <i className={`tick ${cls}`} />
        {spec.label} <b>{fmt(spec.value)}</b>
      </span>
    );
  };
  return (
    <div className="bullet" data-viz="" aria-label={ariaLabel}>
      <div className="btrack">
        <i style={{ width: pct(Math.max(value, 0)) }} />
        {mark(m1, "m1")}
        {mark(m2, "m2")}
      </div>
      <div className="bcap">
        {key(m1, "m1")}
        {key(m2, "m2")}
      </div>
    </div>
  );
}

/* Primary stat card: label row (label + labeled delta pills), 34px value,
   sub-line, and the ONE comparison bar. Rendered as an anchor when it links
   to the page's primary chart card. */
export type PrimaryStatCardProps = {
  label: ReactNode;
  pills?: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  bullet?: BulletBarProps | null;
  href?: string;
  labelDef?: string;
};

export function PrimaryStatCard({ label, pills, value, sub, bullet, href, labelDef }: PrimaryStatCardProps) {
  const body = (
    <>
      <span className="lblrow">
        <span className="lbl">{labelDef ? <span className="def" data-def={labelDef}>{label}</span> : label}</span>
        {pills ? <span className="pills">{pills}</span> : null}
      </span>
      <span className="val">{value}</span>
      {sub != null ? <span className="sub">{sub}</span> : null}
      {bullet ? <BulletBar {...bullet} /> : null}
    </>
  );
  if (href) {
    return (
      <a className="kpi primary" href={href}>
        {body}
      </a>
    );
  }
  return <div className="kpi primary">{body}</div>;
}

/* 96px tile (brief §3.1a): nowrap label row with pills right, proportional-
   figure value, optional bottom sub. */
export type KpiTileProps = {
  label: ReactNode;
  labelDef?: string;
  pills?: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  alert?: boolean;
};

export function KpiTile({ label, labelDef, pills, value, sub, alert }: KpiTileProps) {
  const lbl = labelDef ? <span className="def" data-def={labelDef}>{label}</span> : label;
  return (
    <div className={alert ? "kpi alert" : "kpi"}>
      {pills ? (
        <span className="lblrow">
          <span className="lbl">{lbl}</span>
          <span className="pills">{pills}</span>
        </span>
      ) : (
        <span className="lbl">{lbl}</span>
      )}
      <span className="val">{value}</span>
      {sub != null ? <span className="sub">{sub}</span> : null}
    </div>
  );
}
