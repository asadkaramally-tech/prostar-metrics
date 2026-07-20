"use client";

import type { CSSProperties, MouseEventHandler, ReactNode } from "react";

/* Approved bar-list (brief §3.3, mockups .barlist): label + right value,
   mandatory shared-scale proportional bar, meta line. Aggregate/summary rows
   render bar-less with a 2px top border — never a bar silently capped at
   100% (two scales in one list misleads). */

export type BarListProps = {
  /** "tiergrid" = 4-up grid (quotes deal size); "cols2" = two-column list. */
  variant?: "tiergrid" | "cols2";
  children?: ReactNode;
  ariaLabel?: string;
  style?: CSSProperties;
};

export function BarList({ variant, children, ariaLabel, style }: BarListProps) {
  const cls = variant ? `barlist ${variant}` : "barlist";
  return (
    <div className={cls} aria-label={ariaLabel} style={style}>
      {children}
    </div>
  );
}

export type BarListRowProps = {
  name: ReactNode;
  /** Right-aligned headline value (15px/700 tnum). */
  value: ReactNode;
  /** Red value treatment (bad signal, e.g. 0.0% acceptance / +5.5h overrun). */
  bad?: boolean;
  /** Bar width 0–100 on the list's shared scale. */
  barPct?: number;
  barBad?: boolean;
  barNeutral?: boolean;
  meta?: ReactNode;
  /** Summary/aggregate row: 2px top border, NO bar. */
  total?: boolean;
  onClick?: MouseEventHandler<HTMLDivElement>;
};

export function BarListRow({ name, value, bad, barPct, barBad, barNeutral, meta, total, onClick }: BarListRowProps) {
  const cls = ["blrow", total ? "total" : null, onClick ? "rowlink" : null].filter(Boolean).join(" ");
  const fillCls = barBad ? "bad" : barNeutral ? "neutral" : undefined;
  return (
    <div
      className={cls}
      onClick={onClick}
      onKeyDown={onClick ? (e) => { if (e.key === "Enter") onClick(e as unknown as Parameters<NonNullable<BarListRowProps["onClick"]>>[0]); } : undefined}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      <div className="toprow">
        <span className="name">{name}</span>
        <span className={bad ? "rv bad" : "rv"}>{value}</span>
      </div>
      {!total && barPct != null ? (
        <div className="bar">
          <i className={fillCls} style={{ width: `${Math.max(0, Math.min(100, barPct))}%` }} />
        </div>
      ) : null}
      {meta != null ? <div className="meta">{meta}</div> : null}
    </div>
  );
}
