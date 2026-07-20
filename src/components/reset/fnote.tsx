import type { CSSProperties, ReactNode } from "react";

/* Approved card footnote (tokens.css .fnote): one-and-a-half sentences max
   at 1440 width — methodology detail belongs in [data-def] tooltips. */

export function Fnote({ children, className, style }: { children?: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <div className={className ? `fnote ${className}` : "fnote"} style={style}>
      {children}
    </div>
  );
}
