"use client";

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";

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
  className?: string;
};

export function Drawer({ open, onClose, title, sub, children, ariaLabel, className }: DrawerProps) {
  const drawerRef = useRef<HTMLElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => drawerRef.current?.querySelector<HTMLElement>("button")?.focus());
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key !== "Tab" || !drawerRef.current) return;
      const focusable = [...drawerRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter((element) => !element.hidden);
      if (focusable.length === 0) {
        e.preventDefault();
        drawerRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKey);
      restoreFocusRef.current?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <div className="scrim open" onClick={onClose} aria-hidden="true" />
      <aside ref={drawerRef} className={["drawer open", className].filter(Boolean).join(" ")} role="dialog" aria-modal="true" aria-label={ariaLabel} tabIndex={-1}>
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
