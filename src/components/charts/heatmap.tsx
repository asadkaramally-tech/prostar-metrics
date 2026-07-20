"use client";

import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { heatRamp, heatReprOverlay, heatTextFor } from "./geometry";
import { tipHide, tipRow, tipShow, tipTitle } from "./tooltip";

/* Heatmap with hover tooltips — a 1:1 port of kit.js heatmap. Contrast-safe
   single-hue indigo ramp (red reserved for cells below the stated 15%
   threshold); representative cells render with a hatched overlay; empty
   cells show — (never 0%). The kit builds rows via innerHTML — the same
   markup is reproduced here so implementation captures overlay-diff clean. */

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
  const head = `<div></div>` + months.map((m) => `<div class="hcol">${m}</div>`).join("");
  const body = props.rows
    .map((r) => {
      const cells = r.cells
        .map((c, i) => {
          if (c.v == null) return `<div class="hcell na" data-m="${months[i]}" data-t="${r.name}">—</div>`;
          const cls = "hcell" + (i === months.length - 1 && props.highlightLast ? " now" : "");
          return `<div class="${cls}" data-m="${months[i]}" data-t="${r.name}" data-v="${c.v.toFixed(1)}" data-r="${c.repr ? 1 : ""}" style="background-color:${heatRamp(c.v)};color:${heatTextFor(c.v)}${c.repr ? ";" + heatReprOverlay(c.v) : ""}"><span class="tnum">${Math.round(c.v)}%</span></div>`;
        })
        .join("");
      return `<div class="hrow"><div class="hlab">${r.name}</div>${cells}</div>`;
    })
    .join("");
  const html = `<div class="hrow">${head}</div>${body}`;

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
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
