"use client";

import type { CSSProperties, MouseEventHandler, ReactNode } from "react";
import { CaretIcon, FiIcon, type FiTone } from "./icons";

/* Approved needs-attention list (tokens.css .alist/.arow) — inline stroke
   icon, flowing text with bold subject, right-aligned age tag, caret. */

export function AList({ children, className, style }: { children?: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <div className={className ? `alist ${className}` : "alist"} style={style}>
      {children}
    </div>
  );
}

export type ARowProps = {
  /** Row tone: amber triangle, red down-arrow, indigo info circle. */
  tone: FiTone;
  /** Row body (.atext) — use <b> for the subject per the approved markup. */
  children?: ReactNode;
  /** Right-aligned tag (.atag), e.g. "44d". */
  tag?: ReactNode;
  tagTone?: "amber" | "red";
  href?: string;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
  style?: CSSProperties;
};

export function ARow({ tone, children, tag, tagTone, href, onClick, style }: ARowProps) {
  const tagCls = ["atag", tagTone, "tnum"].filter(Boolean).join(" ");
  return (
    <a className="arow" href={href} onClick={onClick} style={style}>
      <span className={`fi ${tone}`}>
        <FiIcon tone={tone} />
      </span>
      <span className="atext">{children}</span>
      {tag != null ? <span className={tagCls}>{tag}</span> : null}
      <span className="acaret">
        <CaretIcon />
      </span>
    </a>
  );
}
