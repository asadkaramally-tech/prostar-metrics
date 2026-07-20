"use client";

import type { CSSProperties, MouseEventHandler, ReactNode } from "react";

/* Approved breakdown row with in-row share bar (tokens.css .brow — the
   Plausible/Mercury pattern): absolute .bbar share bar behind name + value. */

export type BRowProps = {
  /** Share-bar width as a percentage of the row (0–100). */
  barWidth: number;
  /** Red share bar (losses). */
  neg?: boolean;
  /** Remainder row treatment (.brem): muted, non-interactive cursor. */
  rem?: boolean;
  /** Override the bar colour (e.g. #f1f2f6 for remainder rows). */
  barColor?: string;
  /** Primary line (.id1) — or pass a fully custom node via nameRow. */
  name?: ReactNode;
  /** Secondary line (.id2). */
  sub?: ReactNode;
  /** Replaces the default .id1/.id2 stack inside .bname when provided. */
  nameRow?: ReactNode;
  /** Nodes between the name block and the value (age chips etc.). */
  mid?: ReactNode;
  /** Right-aligned value (.bval, bold + tabular by default). */
  value?: ReactNode;
  valueBold?: boolean;
  valueStyle?: CSSProperties;
  onClick?: MouseEventHandler<HTMLDivElement>;
  className?: string;
  style?: CSSProperties;
};

export function BRow({
  barWidth,
  neg,
  rem,
  barColor,
  name,
  sub,
  nameRow,
  mid,
  value,
  valueBold = true,
  valueStyle,
  onClick,
  className,
  style,
}: BRowProps) {
  const cls = ["brow", onClick ? "rowlink" : null, rem ? "brem" : null, className].filter(Boolean).join(" ");
  const barCls = neg ? "bbar neg" : "bbar";
  const barStyle: CSSProperties = { width: `${barWidth}%`, ...(barColor ? { background: barColor } : {}) };
  const rowStyle: CSSProperties | undefined = onClick || rem ? style : { cursor: "default", ...style };
  const valueNode =
    value != null ? (
      valueBold ? (
        <b className="bval tnum" style={valueStyle}>
          {value}
        </b>
      ) : (
        <span className="bval tnum" style={valueStyle}>
          {value}
        </span>
      )
    ) : null;
  return (
    <div className={cls} style={rowStyle} onClick={onClick}>
      <span className={barCls} style={barStyle} />
      <div className="bname">
        {nameRow ?? (
          <>
            {name != null ? <div className="id1">{name}</div> : null}
            {sub != null ? <div className="id2">{sub}</div> : null}
          </>
        )}
      </div>
      {mid}
      {valueNode}
    </div>
  );
}
