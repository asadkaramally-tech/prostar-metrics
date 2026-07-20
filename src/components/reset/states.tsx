"use client";

import type { CSSProperties, MouseEventHandler, ReactNode } from "react";
import { ErrorMarkIcon } from "./icons";

/* Approved state-treatment strip (tokens.css .states/.mini/.skel). Hidden by
   default (design reference); render with show to display it — mirrors the
   mockups' ?states=1 body-class toggle. */

export type StatesStripProps = {
  title?: ReactNode;
  /** The strip is display:none unless shown (mockups gate it behind ?states=1). */
  show?: boolean;
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
};

export function StatesStrip({ title = "State treatments (design reference)", show, children, className, style }: StatesStripProps) {
  const cls = ["states", show ? "show" : null, className].filter(Boolean).join(" ");
  return (
    <div className={cls} style={style}>
      <div className="shdr">{title}</div>
      <div className="srow">{children}</div>
    </div>
  );
}

export function StateMini({ label, children, style }: { label: ReactNode; children?: ReactNode; style?: CSSProperties }) {
  return (
    <div className="mini" style={style}>
      <div className="ml">{label}</div>
      {children}
    </div>
  );
}

/* Loading shimmer line. */
export function Skel({ width }: { width?: string | number }) {
  return <div className="skel" style={width != null ? { width } : undefined} />;
}

export function StateEmpty({ children }: { children?: ReactNode }) {
  return <div className="empt">{children}</div>;
}

export type StateErrorProps = {
  children?: ReactNode;
  onRetry?: MouseEventHandler<HTMLSpanElement>;
  retryLabel?: ReactNode;
};

export function StateError({ children, onRetry, retryLabel = "Try again" }: StateErrorProps) {
  return (
    <div className="err">
      <span className="fi">
        <ErrorMarkIcon />
      </span>
      <span>
        {children}
        <br />
        <span className="retry" onClick={onRetry} role={onRetry ? "button" : undefined}>
          {retryLabel}
        </span>
      </span>
    </div>
  );
}
