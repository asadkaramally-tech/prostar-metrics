"use client";

import type { CSSProperties } from "react";
import type { ValueFormatter } from "./fmt";

/* Bullet strip for hero panels (Few's bullet-graph anatomy, dark theme) —
   a 1:1 port of kit.js bullet(). The featured bar is the selected month on a
   zero-based scale to the 12-month high; the comparative tick is the same
   month last year. Every mark labeled. The kit builds this via innerHTML;
   the identical markup is reproduced here for pixel fidelity. */

export type BulletMark = { m: string; v: number };

export type BulletProps = {
  cur: BulletMark;
  comp?: BulletMark | null;
  high: BulletMark;
  target?: BulletMark | null;
  fmt?: ValueFormatter;
  className?: string;
  style?: CSSProperties;
};

export function Bullet(props: BulletProps) {
  const f = props.fmt || ((v: number) => String(v));
  const hi = props.high.v || 1;
  const pct = (v: number) => Math.max(0, Math.min(100, (v / hi) * 100));
  const bx = pct(props.cur.v);
  const cx = props.comp ? pct(props.comp.v) : null;
  const tx = props.target ? pct(props.target.v) : null;
  const isHigh = props.cur.v >= hi * 0.999;
  const curText = `${props.cur.m} · ${f(props.cur.v)}${isHigh ? " — 12-mo high" : ""}`;
  const anchor = bx < 16 ? "left:0" : bx > 84 ? "right:0" : `left:${bx}%;transform:translateX(-50%)`;
  const tickSwatch = (c: string) =>
    `<span style="display:inline-block;width:2px;height:10px;background:${c};border-radius:1px;vertical-align:-1px;margin-right:6px"></span>`;
  const html = `
    <div style="position:relative;height:16px;margin-bottom:5px">
      <span class="tnum" style="position:absolute;${anchor};bottom:0;font-size:12px;font-weight:700;color:#aab0f0;white-space:nowrap">${curText}</span>
    </div>
    <div style="position:relative;height:14px;border-radius:5px;background:rgba(255,255,255,.08)">
      <span style="position:absolute;top:3px;bottom:3px;left:0;width:${bx}%;border-radius:4px;background:#8087ec"></span>
      <span style="position:absolute;top:50%;left:${bx}%;width:10px;height:10px;margin:-5px 0 0 -5px;border-radius:50%;background:#8087ec;box-shadow:0 0 0 2px rgba(255,255,255,.8)"></span>
      ${cx != null ? `<span style="position:absolute;top:-3px;bottom:-3px;left:${cx}%;width:2px;margin-left:-1px;border-radius:1px;background:rgba(255,255,255,.85)"></span>` : ""}
      ${tx != null ? `<span style="position:absolute;top:-3px;bottom:-3px;left:${tx}%;width:2px;margin-left:-1px;border-radius:1px;background:#e6c07a"></span>` : ""}
    </div>
    <div style="position:relative;height:16px;margin-top:6px;font-size:11px;color:#8b90a6">
      ${cx != null && props.comp ? `<span class="tnum" style="position:absolute;${cx < 18 ? "left:0" : cx > 70 ? `right:${(100 - cx).toFixed(1)}%` : `left:${cx}%;transform:translateX(-50%)`};white-space:nowrap">${tickSwatch("rgba(255,255,255,.85)")}${props.comp.m} · ${f(props.comp.v)}</span>` : ""}
      ${tx != null && props.target ? `<span class="tnum" style="position:absolute;left:0;white-space:nowrap">${tickSwatch("#e6c07a")}${props.target.m} · ${f(props.target.v)}</span>` : ""}
      <span class="tnum" style="position:absolute;right:0;white-space:nowrap">${isHigh ? "" : `High · ${props.high.m} · ${f(props.high.v)}`}</span>
    </div>`;
  return <div className={props.className} style={props.style} dangerouslySetInnerHTML={{ __html: html }} />;
}
