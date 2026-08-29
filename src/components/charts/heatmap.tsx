"use client";

import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { heatRamp, heatReprBackgroundImage, heatTextFor } from "./geometry";
import { tipHide, tipRow, tipShow, tipTitle } from "./tooltip";

/* Heatmap with hover tooltips. Contrast-safe
   single-hue indigo ramp (red reserved for cells below the stated 15%
   threshold); representative cells render with a hatched overlay; empty
   cells show — (never 0%). React renders all source labels as text so
   database/Simpro values cannot become executable markup. */

export type HeatmapCell = { v: number | null; repr?: boolean };
export type HeatmapRow = { name: string; cells: HeatmapCell[] };

export type HeatmapProps = {
  months: string[];
  rows: HeatmapRow[];
  highlightLast?: boolean;
  /** Sets the CSS `--hm-cols` grid variable (defaults to months.length). */
  cols?: number;
  className?: string;
  style?: CSSProperties;
};

export function Heatmap(props: HeatmapProps) {
  const months = props.months;

  const onPointerOver = (e: ReactPointerEvent<HTMLDivElement>) => {
    const c = (e.target as Element).closest(".hcell") as HTMLElement | null;
    if (!c) return;
    const v = c.dataset.v;
    tipShow(
      tipTitle(`${c.dataset.t} · ${c.dataset.m}`) +
        (v
          ? tipRow(c.style.backgroundColor || "#e9ebf0", "Acceptance", v + "%")
          : `<span style="color:#6b7383">No quotes in this tier</span>`) +
        (c.dataset.r
          ? `<div style="color:#8a5f14;font-size:11px;margin-top:4px">Representative — pending per-month reconciliation</div>`
          : ""),
      e.clientX,
      e.clientY,
    );
  };
  const onPointerOut = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as Element).closest(".hcell")) tipHide();
  };

  return (
    <div
      className={props.className ? `heat ${props.className}` : "heat"}
      style={{ "--hm-cols": props.cols ?? months.length, ...props.style } as CSSProperties}
      onPointerOver={onPointerOver}
      onPointerOut={onPointerOut}
    >
      <div className="hrow">
        <div />
        {months.map((month, index) => <div className="hcol" key={`${month}:${index}`}>{month}</div>)}
      </div>
      {props.rows.map((row, rowIndex) => (
        <div className="hrow" key={`${row.name}:${rowIndex}`}>
          <div className="hlab">{row.name}</div>
          {row.cells.map((cell, index) => {
            const month = months[index] ?? "";
            if (cell.v == null) {
              return <div className="hcell na" data-m={month} data-t={row.name} key={`${month}:${index}`}>—</div>;
            }
            const className = `hcell${index === months.length - 1 && props.highlightLast ? " now" : ""}`;
            return (
              <div
                className={className}
                data-m={month}
                data-t={row.name}
                data-v={cell.v.toFixed(1)}
                data-r={cell.repr ? "1" : ""}
                key={`${month}:${index}`}
                style={{
                  backgroundColor: heatRamp(cell.v),
                  color: heatTextFor(cell.v),
                  backgroundImage: cell.repr ? heatReprBackgroundImage(cell.v) : undefined,
                }}
              >
                <span className="tnum">{Math.round(cell.v)}%</span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
