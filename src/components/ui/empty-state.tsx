import type { LucideIcon } from "lucide-react";
import { CircleSlash } from "lucide-react";

/**
 * Single empty/unavailable treatment shared by charts, tables, and lists.
 * Copy is supplied by the caller and must stay truthful (legitimate zero vs
 * unavailable vs no-matching-records are different messages, same visual).
 */
type EmptyStateProps = {
  title: string;
  detail?: string;
  icon?: LucideIcon;
  className?: string;
  /** Match the replaced content's height so layout stays stable. */
  minHeightClassName?: string;
};

export function EmptyState({
  title,
  detail,
  icon: Icon = CircleSlash,
  className = "",
  minHeightClassName = "min-h-44",
}: EmptyStateProps) {
  return (
    <div
      className={`flex ${minHeightClassName} w-full flex-col items-center justify-center gap-2 px-5 py-7 text-center ${className}`}
    >
      <span className="flex h-9 w-9 items-center justify-center rounded-full border border-[color:var(--hair)] bg-white shadow-[var(--sh-1)]">
        <Icon className="h-4 w-4 text-[color:var(--subtle)]" aria-hidden="true" />
      </span>
      <p className="text-[13px] font-semibold text-[color:var(--ink)]">{title}</p>
      {detail ? <p className="max-w-md text-[11.5px] leading-5 text-[color:var(--muted)]">{detail}</p> : null}
    </div>
  );
}
