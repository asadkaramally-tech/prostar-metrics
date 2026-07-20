import type { CSSProperties, ReactNode } from "react";

/* Approved inline meter (tokens.css .meter): 44px track + bold tabular
   value, used in table cells ("73%" utilisation etc.). The track hides at
   ≤480px, leaving the value. */

export type MeterProps = {
  /** Fill percentage 0–100. */
  pct: number;
  /** Red fill (negative measure). */
  neg?: boolean;
  /** The printed value (rendered bold + tabular). */
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
};

export function Meter({ pct, neg, children, className, style }: MeterProps) {
  return (
    <span className={className ? `meter ${className}` : "meter"} style={style}>
      <span className="track">
        <span className={neg ? "fill neg" : "fill"} style={{ width: `${pct}%` }} />
      </span>
      <b className="tnum">{children}</b>
    </span>
  );
}
