import type { CSSProperties, ReactNode } from "react";

/* Approved hero band grammar (tokens.css .hero/.hero.split/.focal + focal
   internals). The split variant is the flagship fusion band: dark focal +
   flagship chart card in one first-screen band. */

export type HeroProps = {
  /** Flagship fusion band: 410px focal + flagship chart card. */
  split?: boolean;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
};

export function Hero({ split, className, style, children }: HeroProps) {
  const cls = ["hero", split ? "split" : null, className].filter(Boolean).join(" ");
  return (
    <div className={cls} style={style}>
      {children}
    </div>
  );
}

export type FocalProps = { className?: string; style?: CSSProperties; children?: ReactNode };

export function Focal({ className, style, children }: FocalProps) {
  return (
    <div className={className ? `focal ${className}` : "focal"} style={style}>
      {children}
    </div>
  );
}

/* .lab — uppercase eyebrow with the glowing pip. */
export function FocalLabel({ children }: { children?: ReactNode }) {
  return (
    <div className="lab">
      <span className="pip" />
      {children}
    </div>
  );
}

/* .big — the headline figure. */
export function FocalValue({ children, style }: { children?: ReactNode; style?: CSSProperties }) {
  return (
    <div className="big tnum" style={style}>
      {children}
    </div>
  );
}

/* .meta — the row of margin text + delta chips under the headline. */
export function FocalMeta({ children, style }: { children?: ReactNode; style?: CSSProperties }) {
  return (
    <div className="meta" style={style}>
      {children}
    </div>
  );
}

/* .mgn — supporting measure inside .meta ("$139,937 net · 53.5% margin"). */
export function Mgn({ children }: { children?: ReactNode }) {
  return <span className="mgn tnum">{children}</span>;
}

/* .cov — coverage/context line at the focal foot. */
export function FocalCov({ children, style }: { children?: ReactNode; style?: CSSProperties }) {
  return (
    <div className="cov" style={style}>
      {children}
    </div>
  );
}

/* .hs — full-bleed sparkline slot pinned to the focal foot. */
export function HeroSparkline({ children, style }: { children?: ReactNode; style?: CSSProperties }) {
  return (
    <div className="hs" style={style}>
      {children}
    </div>
  );
}
