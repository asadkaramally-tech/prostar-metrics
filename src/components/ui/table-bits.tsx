import { ChevronLeft, ChevronRight } from "lucide-react";

/**
 * Shared dense-table primitives: consistent alignment, tabular numerals,
 * optional sticky header, restrained separators, intentional horizontal
 * scrolling. Presentation-only.
 */
type DataTableProps = {
  children: React.ReactNode;
  /** Explicit min width keeps columns readable and makes mobile scroll intentional. */
  minWidth?: string;
  stickyHeader?: boolean;
  className?: string;
  /** Constrain height (adds vertical scroll); pairs well with stickyHeader. */
  maxHeightClassName?: string;
};

export function DataTable({ children, minWidth, stickyHeader = false, className = "", maxHeightClassName }: DataTableProps) {
  return (
    <div
      className={`scroll-shadow-x min-w-0 max-w-full overflow-x-auto ${maxHeightClassName ? `overflow-y-auto ${maxHeightClassName}` : ""} ${className}`}
      tabIndex={minWidth ? 0 : undefined}
      role={minWidth ? "region" : undefined}
      aria-label={minWidth ? "Scrollable data table" : undefined}
    >
      <table
        className={`w-full border-collapse text-[13px] ${stickyHeader ? "[&>thead]:sticky [&>thead]:top-0 [&>thead]:z-10" : ""}`}
        style={minWidth ? { minWidth } : undefined}
      >
        {children}
      </table>
    </div>
  );
}

type ThProps = {
  children?: React.ReactNode;
  numeric?: boolean;
  className?: string;
  colSpan?: number;
  scope?: "col" | "row";
};

export function Th({ children, numeric = false, className = "", colSpan, scope = "col" }: ThProps) {
  return (
    <th
      scope={scope}
      colSpan={colSpan}
      className={`whitespace-nowrap border-b border-[color:var(--hair)] bg-[linear-gradient(180deg,#fbfcfe,#f7f9fc)] px-5 py-[13px] text-[10.5px] font-bold uppercase text-[color:var(--faint)] ${
        numeric ? "text-right" : "text-left"
      } ${className}`}
    >
      {children}
    </th>
  );
}

type TdProps = {
  children?: React.ReactNode;
  numeric?: boolean;
  className?: string;
  colSpan?: number;
  title?: string;
};

export function Td({ children, numeric = false, className = "", colSpan, title }: TdProps) {
  return (
    <td
      colSpan={colSpan}
      title={title}
      className={`border-b border-[color:var(--hair-2)] px-5 py-3.5 align-middle text-[color:var(--ink-2)] ${
        numeric ? "tnum text-right" : "text-left"
      } ${className}`}
    >
      {children}
    </td>
  );
}

/** Centered muted row for truthful table empty states. */
export function EmptyRow({ colSpan, children }: { colSpan: number; children: React.ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-5 py-10 text-center text-[13px] text-[color:var(--muted)]">
        {children}
      </td>
    </tr>
  );
}

type PaginationBarProps = {
  summary: string;
  onPrevious?: () => void;
  onNext?: () => void;
  previousHref?: string;
  nextHref?: string;
  previousDisabled: boolean;
  nextDisabled: boolean;
  previousLabel?: string;
  nextLabel?: string;
};

/**
 * Pagination footer supporting both callback (client push) and href (link)
 * navigation so existing quotes/jobs semantics are preserved unchanged.
 */
export function PaginationBar({
  summary,
  onPrevious,
  onNext,
  previousHref,
  nextHref,
  previousDisabled,
  nextDisabled,
  previousLabel = "Previous page",
  nextLabel = "Next page",
}: PaginationBarProps) {
  const buttonClass =
    "focus-ring inline-flex h-10 w-10 items-center justify-center rounded-[10px] border border-[color:var(--hair)] bg-[color:var(--surface)] text-[color:var(--ink-2)] shadow-[var(--sh-1)] transition-colors hover:bg-[color:var(--surface-soft)] disabled:cursor-not-allowed disabled:opacity-40";
  const disabledLinkClass =
    "inline-flex h-10 w-10 items-center justify-center rounded-[10px] border border-[color:var(--hair)] bg-[color:var(--surface)] text-[color:var(--ink-2)] opacity-40";
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[color:var(--hair)] px-5 py-3.5">
      <p className="tnum text-xs text-[color:var(--muted)]">{summary}</p>
      <div className="flex items-center gap-2">
        {previousHref !== undefined ? (
          previousDisabled ? (
            <span className={disabledLinkClass} aria-hidden="true">
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            </span>
          ) : (
            <a href={previousHref} className={buttonClass} title={previousLabel} aria-label={previousLabel}>
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            </a>
          )
        ) : (
          <button
            type="button"
            className={buttonClass}
            onClick={onPrevious}
            disabled={previousDisabled}
            title={previousLabel}
            aria-label={previousLabel}
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
        {nextHref !== undefined ? (
          nextDisabled ? (
            <span className={disabledLinkClass} aria-hidden="true">
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </span>
          ) : (
            <a href={nextHref} className={buttonClass} title={nextLabel} aria-label={nextLabel}>
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </a>
          )
        ) : (
          <button
            type="button"
            className={buttonClass}
            onClick={onNext}
            disabled={nextDisabled}
            title={nextLabel}
            aria-label={nextLabel}
          >
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}
