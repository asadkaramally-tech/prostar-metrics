"use client";

import type { CSSProperties, MouseEventHandler, ReactNode } from "react";

/* Approved leaderboard row (tokens.css .lrow, commissions board): rank,
   name + sub, segmented share bar, tier chip, optional multiplier, amount,
   rotating caret, expandable .ldetail. */

export type LRowSegment = { widthPct: number; color: string };

export type LRowProps = {
  rank: ReactNode;
  /** Primary line (.id1). */
  name: ReactNode;
  /** Secondary line (.id2, tabular). */
  sub?: ReactNode;
  /** Share-bar segments, left to right (widths in % of the bar). */
  segments?: LRowSegment[];
  /** Custom bar content; overrides segments. */
  bar?: ReactNode;
  /** Tier chip slot (use <TierChip …/>). */
  tier?: ReactNode;
  /** Multiplier column (.lmult), e.g. "×1.02331". */
  mult?: ReactNode;
  multStyle?: CSSProperties;
  /** Right-aligned amount (.lamt). */
  amount: ReactNode;
  open?: boolean;
  onClick?: MouseEventHandler<HTMLDivElement>;
  ariaControls?: string;
  ariaLabel?: string;
  className?: string;
  style?: CSSProperties;
};

export function LRow({
  rank,
  name,
  sub,
  segments,
  bar,
  tier,
  mult,
  multStyle,
  amount,
  open,
  onClick,
  ariaControls,
  ariaLabel,
  className,
  style,
}: LRowProps) {
  const cls = ["rowlink", "lrow", open ? "open" : null, className].filter(Boolean).join(" ");
  return (
    <div
      className={cls}
      style={style}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-expanded={onClick ? Boolean(open) : undefined}
      aria-controls={onClick ? ariaControls : undefined}
      aria-label={onClick ? ariaLabel : undefined}
      onKeyDown={onClick ? (event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.currentTarget.click();
        }
      } : undefined}
    >
      <span className="lrank tnum">{rank}</span>
      <div className="lname">
        <div className="id1">{name}</div>
        {sub != null ? <div className="id2 tnum">{sub}</div> : null}
      </div>
      <div className="lbar" style={{ display: "flex" }}>
        {bar ??
          segments?.map((seg, i) => (
            <div key={i} style={{ width: `${seg.widthPct}%`, background: seg.color, borderRadius: 0 }} />
          ))}
      </div>
      {tier}
      {mult != null ? (
        <span className="lmult tnum" style={multStyle}>
          {mult}
        </span>
      ) : null}
      <b className="lamt tnum">{amount}</b>
      <span className="lcaret">▸</span>
    </div>
  );
}

export function LDetail({ children, className, style }: { children?: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <div className={className ? `ldetail ${className}` : "ldetail"} style={style}>
      {children}
    </div>
  );
}
