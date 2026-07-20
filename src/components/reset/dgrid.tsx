import type { CSSProperties, ReactNode } from "react";

/* Approved dark KPI grid inside the focal (tokens.css .dgrid/.dcell). */

export function DGrid({ className, style, children }: { className?: string; style?: CSSProperties; children?: ReactNode }) {
  return (
    <div className={className ? `dgrid ${className}` : "dgrid"} style={style}>
      {children}
    </div>
  );
}

export type DCellProps = {
  /** Uppercase micro-label (.dl2). Wrapped in [data-def] when def is set. */
  label: ReactNode;
  def?: string;
  /** Headline value (.dv2, tabular). */
  value: ReactNode;
  /** Green up-delta suffix (.u), e.g. "↑ 80.0%". */
  u?: ReactNode;
  /** Muted suffix (.s), e.g. "avg $2,588". */
  s?: ReactNode;
  sStyle?: CSSProperties;
};

export function DCell({ label, def, value, u, s, sStyle }: DCellProps) {
  return (
    <div className="dcell">
      <div className="dl2">{def ? <span className="def" data-def={def}>{label}</span> : label}</div>
      <div className="dv2 tnum">
        {value}
        {u != null ? <span className="u">{u}</span> : null}
        {s != null ? (
          <span className="s" style={sStyle}>
            {s}
          </span>
        ) : null}
      </div>
    </div>
  );
}
