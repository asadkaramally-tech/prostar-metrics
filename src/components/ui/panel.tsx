/**
 * Shared panel + header treatment, unifying the four per-route card dialects.
 * Presentation-only.
 */
type PanelProps = {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Right-aligned header slot (export buttons, counts, toggles). */
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /** Remove body padding (edge-to-edge tables). */
  flush?: boolean;
  id?: string;
  headingLevel?: "h2" | "h3";
};

export function Panel({
  title,
  subtitle,
  actions,
  children,
  className = "",
  flush = false,
  id,
  headingLevel = "h2",
}: PanelProps) {
  const Heading = headingLevel;
  const bodyClassName = flush
    ? "dashboard-panel-body dashboard-panel-body--flush"
    : title
      ? "dashboard-panel-body dashboard-panel-body--padded"
      : "dashboard-panel-body dashboard-panel-body--standalone";

  return (
    <section
      id={id}
      className={`dashboard-panel min-w-0 ${className}`}
    >
      {title ? (
        <div className="dashboard-panel-header flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <Heading className="text-[15px] font-bold leading-5 text-[color:var(--ink)]">{title}</Heading>
            {subtitle ? <p className="mt-0.5 text-[11.5px] leading-[18px] text-[color:var(--muted)]">{subtitle}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

/** Section label used to group related panels without nesting cards. */
export function SectionLabel({ children, id }: { children: React.ReactNode; id?: string }) {
  return (
    <h2 id={id} className="mt-2 text-[11px] font-bold uppercase text-[color:var(--subtle)]">
      {children}
    </h2>
  );
}
