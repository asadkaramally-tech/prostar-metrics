import type { ReactNode } from "react";

/* Approved stacked segment bar (brief §3.2 mark spec): adjacent fills
   separated by 2px SURFACE gaps, never borders. In-fill labels pick their
   color by fill luminance (caller passes it) and render only when the
   segment is wide enough for the text (a clipped numeral is worse than no
   label). font-style:normal is forced in CSS on the semantic <i> wrapper. */

export type SegBarSegment = {
  /** Width as % of the whole bar (0–100). */
  width: number;
  color: string;
  label?: ReactNode;
  /** In-fill label color (default white; pass var(--ink) on light fills). */
  labelColor?: string;
  /** Minimum width% required to render the label (default 5). */
  labelMin?: number;
};

export function SegBar({ segments, tall, ariaLabel }: { segments: SegBarSegment[]; tall?: boolean; ariaLabel: string }) {
  return (
    <div className={tall ? "stacked tall" : "stacked"} role="img" aria-label={ariaLabel}>
      {segments.map((seg, i) => (
        <i key={i} style={{ width: `${Math.max(0, seg.width)}%`, background: seg.color }}>
          {seg.label != null && seg.width >= (seg.labelMin ?? 5) ? (
            <span className="seglabel" style={seg.labelColor ? { color: seg.labelColor } : undefined}>
              {seg.label}
            </span>
          ) : null}
        </i>
      ))}
    </div>
  );
}
