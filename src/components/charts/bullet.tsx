"use client";

import type { CSSProperties } from "react";
import type { ValueFormatter } from "./fmt";

/* Bullet strip for hero panels (Few's bullet-graph anatomy, dark theme).
   The featured bar is the selected month on a
   zero-based scale to the 12-month high; the comparative tick is the same
   month last year. Every mark is labeled and source labels render as text. */

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
  const anchor: CSSProperties = bx < 16 ? { left: 0 } : bx > 84 ? { right: 0 } : { left: `${bx}%`, transform: "translateX(-50%)" };
  const comparisonAnchor: CSSProperties = cx == null || cx < 18
    ? { left: 0 }
    : cx > 70
      ? { right: `${(100 - cx).toFixed(1)}%` }
      : { left: `${cx}%`, transform: "translateX(-50%)" };
  const swatch = (background: string) => (
    <span style={{ display: "inline-block", width: 2, height: 10, background, borderRadius: 1, verticalAlign: -1, marginRight: 6 }} />
  );

  return (
    <div className={props.className} style={props.style}>
      <div style={{ position: "relative", height: 16, marginBottom: 5 }}>
        <span className="tnum" style={{ position: "absolute", ...anchor, bottom: 0, fontSize: 12, fontWeight: 700, color: "#aab0f0", whiteSpace: "nowrap" }}>{curText}</span>
      </div>
      <div style={{ position: "relative", height: 14, borderRadius: 5, background: "rgba(255,255,255,.08)" }}>
        <span style={{ position: "absolute", top: 3, bottom: 3, left: 0, width: `${bx}%`, borderRadius: 4, background: "#8087ec" }} />
        <span style={{ position: "absolute", top: "50%", left: `${bx}%`, width: 10, height: 10, margin: "-5px 0 0 -5px", borderRadius: "50%", background: "#8087ec", boxShadow: "0 0 0 2px rgba(255,255,255,.8)" }} />
        {cx != null ? <span style={{ position: "absolute", top: -3, bottom: -3, left: `${cx}%`, width: 2, marginLeft: -1, borderRadius: 1, background: "rgba(255,255,255,.85)" }} /> : null}
        {tx != null ? <span style={{ position: "absolute", top: -3, bottom: -3, left: `${tx}%`, width: 2, marginLeft: -1, borderRadius: 1, background: "#e6c07a" }} /> : null}
      </div>
      <div style={{ position: "relative", height: 16, marginTop: 6, fontSize: 11, color: "#8b90a6" }}>
        {cx != null && props.comp ? (
          <span className="tnum" style={{ position: "absolute", ...comparisonAnchor, whiteSpace: "nowrap" }}>{swatch("rgba(255,255,255,.85)")}{props.comp.m} · {f(props.comp.v)}</span>
        ) : null}
        {tx != null && props.target ? (
          <span className="tnum" style={{ position: "absolute", left: 0, whiteSpace: "nowrap" }}>{swatch("#e6c07a")}{props.target.m} · {f(props.target.v)}</span>
        ) : null}
        <span className="tnum" style={{ position: "absolute", right: 0, whiteSpace: "nowrap" }}>{isHigh ? "" : `High · ${props.high.m} · ${f(props.high.v)}`}</span>
      </div>
    </div>
  );
}
