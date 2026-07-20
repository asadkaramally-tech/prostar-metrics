"use client";

import { useEffect, type CSSProperties, type ReactNode } from "react";

/* Approved detail drawer (tokens.css .scrim/.drawer): right-hand sheet with
   header title/subtitle, ✕ button, scroll body. Scrim click and Escape both
   close, matching kit.js drawerInit. */

export type DrawerProps = {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  sub?: ReactNode;
  children?: ReactNode;
  ariaLabel?: string;
};

export function Drawer({ open, onClose, title, sub, children, ariaLabel }: DrawerProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <>
      <div className={open ? "scrim open" : "scrim"} onClick={onClose} aria-hidden="true" />
      <aside className={open ? "drawer open" : "drawer"} role="dialog" aria-modal="true" aria-label={ariaLabel} aria-hidden={!open}>
        <div className="dh">
          <div>
            <div className="ti">{title}</div>
            <div className="st">{sub}</div>
          </div>
          <button type="button" className="x" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="db">{children}</div>
      </aside>
    </>
  );
}

/* Key-value grid inside the drawer body (tokens.css .kv). */
export function KV({ four, children, style }: { four?: boolean; children?: ReactNode; style?: CSSProperties }) {
  return (
    <div className={four ? "kv kv4" : "kv"} style={style}>
      {children}
    </div>
  );
}

export type KVCellProps = {
  label: ReactNode;
  def?: string;
  value: ReactNode;
  valueStyle?: CSSProperties;
};

export function KVCell({ label, def, value, valueStyle }: KVCellProps) {
  return (
    <div className="cell">
      <div className="l">{def ? <span className="def" data-def={def}>{label}</span> : label}</div>
      <div className="v tnum" style={valueStyle}>
        {value}
      </div>
    </div>
  );
}

export function DSec({ children }: { children?: ReactNode }) {
  return <div className="dsec">{children}</div>;
}

export function DNote({ children, style }: { children?: ReactNode; style?: CSSProperties }) {
  return (
    <div className="dnote" style={style}>
      {children}
    </div>
  );
}
