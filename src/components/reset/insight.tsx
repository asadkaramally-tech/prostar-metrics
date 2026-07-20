import type { CSSProperties, ReactNode } from "react";

/* Approved insight callout (tokens.css .insight + .idot): indigo diamond
   marker, one takeaway sentence with a bold lead-in. */

export type InsightProps = { down?: boolean; children?: ReactNode; className?: string; style?: CSSProperties };

export function Insight({ down, children, className, style }: InsightProps) {
  const cls = ["insight", down ? "down" : null, className].filter(Boolean).join(" ");
  return (
    <div className={cls} style={style}>
      <i className="idot" />
      <span>{children}</span>
    </div>
  );
}
