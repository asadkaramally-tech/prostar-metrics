import type { CSSProperties, ReactNode } from "react";
import { FiIcon, type FiTone } from "./icons";

/* Approved exception flags (tokens.css .flags/.flag/.fi): tone-coloured
   left border + icon tile, one-line body with bold figures. */

export function Flags({ children, className, style }: { children?: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <div className={className ? `flags ${className}` : "flags"} style={style}>
      {children}
    </div>
  );
}

export type FlagProps = {
  tone: FiTone;
  /** Custom icon; defaults to the approved stroke icon for the tone. */
  icon?: ReactNode;
  children?: ReactNode;
  style?: CSSProperties;
};

export function Flag({ tone, icon, children, style }: FlagProps) {
  return (
    <div className={`flag ${tone}`} style={style}>
      <span className={`fi ${tone}`}>{icon ?? <FiIcon tone={tone} />}</span>
      <span>{children}</span>
    </div>
  );
}
