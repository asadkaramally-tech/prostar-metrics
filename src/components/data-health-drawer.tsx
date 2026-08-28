"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Database,
  Gauge,
  Layers3,
  ListRestart,
  RefreshCw,
  ShieldAlert,
  X,
  type LucideIcon,
} from "lucide-react";
import type {
  DataHealthAlert,
  DataHealthModel,
  DataHealthStatus,
} from "@/lib/store/data-health";
import type { BoundedSourceWorkRequest } from "@/lib/store/bounded-source-work";
import { StatusPill, type PillTone } from "@/components/ui/status-pill";

type DataHealthDrawerProps =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; model: DataHealthModel };

// Trigger-chip tint, re-mapped to the shared StatusPill palette (paired with the
// Activity icon + label text, so state is never conveyed by color alone).
const statusTone: Record<DataHealthStatus, string> = {
  healthy: "border-[rgba(26,138,90,.35)] bg-[rgba(26,138,90,.14)] text-[#62c99a]",
  attention: "border-[rgba(180,121,26,.4)] bg-[rgba(180,121,26,.14)] text-[#e3b765]",
  critical: "border-[rgba(208,70,58,.4)] bg-[rgba(208,70,58,.14)] text-[#ee8b82]",
};

// Summary status → shared StatusPill tone (healthy→success, attention→warning,
// critical→danger). Page states map 1:1 onto the StatusPill data-state tones.
const statusPillTone: Record<DataHealthStatus, PillTone> = {
  healthy: "success",
  attention: "warning",
  critical: "danger",
};

export function DataHealthDrawer(props: DataHealthDrawerProps) {
  const [open, setOpen] = useState(false);
  const [workRequests, setWorkRequests] = useState<BoundedSourceWorkRequest[]>([]);
  const [workRequestsLoading, setWorkRequestsLoading] = useState(false);
  const [workRequestsError, setWorkRequestsError] = useState<string | null>(null);
  const [workNotice, setWorkNotice] = useState<string | null>(null);
  const [workSubmitting, setWorkSubmitting] = useState(false);
  const panelId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const summary = props.state === "ready" ? props.model.summary : null;
  const triggerStatus = props.state === "loading"
    ? "Loading"
    : props.state === "error"
      ? "Unavailable"
      : summary?.activeAlertCount
        ? `${summary.activeAlertCount} active`
        : "Healthy";

  useEffect(() => {
    if (!open) return;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = [...panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter((element) => !element.hidden);
      if (focusable.length === 0) {
        event.preventDefault();
        panelRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = originalOverflow;
      window.removeEventListener("keydown", onKeyDown);
      triggerRef.current?.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open || props.state !== "ready") return;
    let active = true;

    async function loadQueueStatus(showLoading: boolean) {
      if (showLoading) setWorkRequestsLoading(true);
      try {
        const response = await fetch("/api/data-refresh", { cache: "no-store" });
        const payload = await response.json() as { requests?: BoundedSourceWorkRequest[]; error?: string };
        if (!response.ok) throw new Error(payload.error || "Unable to load refresh queue status.");
        if (active) {
          setWorkRequests(payload.requests ?? []);
          setWorkRequestsError(null);
        }
      } catch (error) {
        if (active) setWorkRequestsError(error instanceof Error ? error.message : "Unable to load refresh queue status.");
      } finally {
        if (active && showLoading) setWorkRequestsLoading(false);
      }
    }

    void loadQueueStatus(true);
    const poll = window.setInterval(() => void loadQueueStatus(false), 5_000);
    return () => {
      active = false;
      window.clearInterval(poll);
    };
  }, [open, props.state]);

  async function submitBoundedWork(payload: Record<string, unknown>) {
    setWorkSubmitting(true);
    setWorkNotice(null);
    setWorkRequestsError(null);
    try {
      const response = await fetch("/api/data-refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json() as { request?: BoundedSourceWorkRequest; error?: string };
      if (!response.ok || !body.request) throw new Error(body.error || "Unable to enqueue bounded source work.");
      setWorkRequests((current) => [body.request as BoundedSourceWorkRequest, ...current.filter((item) => item.requestId !== body.request?.requestId)].slice(0, 20));
      setWorkNotice(body.request.duplicate ? "Matching work is already active or complete." : "Bounded work queued.");
    } catch (error) {
      setWorkRequestsError(error instanceof Error ? error.message : "Unable to enqueue bounded source work.");
    } finally {
      setWorkSubmitting(false);
    }
  }

  function showDrawer(event: React.MouseEvent<HTMLButtonElement>) {
    triggerRef.current = event.currentTarget;
    setOpen(true);
  }

  return (
    <>
      <button
        type="button"
        onClick={showDrawer}
        className="focus-ring fixed right-[210px] top-2 z-40 hidden h-10 w-[150px] items-center gap-2 rounded-[8px] border border-white/[.08] bg-white/[.055] px-3 text-left text-xs font-medium text-[#c9ced8] shadow-[inset_0_0_0_1px_rgba(255,255,255,.015)] hover:bg-white/[.08] hover:text-white lg:flex"
        aria-expanded={open}
        aria-controls={panelId}
      >
        <Activity className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">Data health</span>
        <span className={summary ? `tnum rounded-full border px-2 py-0.5 text-[10px] font-semibold ${statusTone[summary.status]}` : "tnum text-[#6f7686]"}>
          {triggerStatus}
        </span>
      </button>

      <button
        type="button"
        onClick={showDrawer}
        className="data-health-mobile-trigger focus-ring fixed right-4 z-30 flex h-11 w-11 items-center justify-center rounded-[10px] border border-white/[.12] bg-[#181c29] text-[#e4e7ef] shadow-lg lg:hidden"
        aria-label={`Data health: ${triggerStatus}`}
        aria-expanded={open}
        aria-controls={panelId}
        title="Data health"
      >
        <Activity className="h-4 w-4" aria-hidden="true" />
        {summary?.status === "critical" || summary?.status === "attention" ? (
          <span
            className={`absolute right-1 top-1 h-2 w-2 rounded-full ${summary.status === "critical" ? "bg-red-600" : "bg-amber-500"}`}
            aria-hidden="true"
          />
        ) : null}
      </button>

      {open ? (
        <div className="fixed inset-0 z-50">
          <button
            type="button"
            className="absolute inset-0 h-full w-full bg-[#080a10]/45 backdrop-blur-[1px]"
            onClick={() => setOpen(false)}
            aria-label="Close data health"
            tabIndex={-1}
          />
          <aside
            ref={panelRef}
            id={panelId}
            role="dialog"
            aria-modal="true"
            aria-labelledby={`${panelId}-title`}
            tabIndex={-1}
            className="absolute inset-y-0 right-0 flex w-full max-w-[430px] flex-col border-l border-[color:var(--hair)] bg-[color:var(--surface)] shadow-[var(--shadow-pop)]"
          >
            <header className="flex min-h-[72px] items-start gap-3 border-b border-[color:var(--hair)] px-5 py-4">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-[color:var(--ink)] text-white shadow-[var(--sh-1)]">
                <Activity className="h-5 w-5" aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 id={`${panelId}-title`} className="text-[15px] font-bold text-[color:var(--ink)]">
                    Data health
                  </h2>
                  {summary ? (
                    <StatusPill tone={statusPillTone[summary.status]} label={statusLabel(summary.status)} size="sm" />
                  ) : null}
                </div>
                <p className="tnum mt-0.5 text-xs text-[color:var(--muted)]">
                  {props.state === "ready" ? `Checked ${formatTimestamp(props.model.generatedAt)}` : triggerStatus}
                </p>
              </div>
              <button
                ref={closeButtonRef}
                type="button"
                onClick={() => setOpen(false)}
                className="focus-ring flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] text-[color:var(--muted)] hover:bg-[color:var(--surface-soft)] hover:text-[color:var(--ink)]"
                aria-label="Close data health"
                title="Close"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {props.state === "loading" ? <LoadingState /> : null}
              {props.state === "error" ? <ErrorState message={props.message} /> : null}
              {props.state === "ready" ? (
                <ReadyState
                  model={props.model}
                  workRequests={workRequests}
                  workRequestsLoading={workRequestsLoading}
                  workRequestsError={workRequestsError}
                  workNotice={workNotice}
                  workSubmitting={workSubmitting}
                  onSubmitWork={submitBoundedWork}
                />
              ) : null}
            </div>
          </aside>
        </div>
      ) : null}
    </>
  );
}

function ReadyState({
  model,
  workRequests,
  workRequestsLoading,
  workRequestsError,
  workNotice,
  workSubmitting,
  onSubmitWork,
}: {
  model: DataHealthModel;
  workRequests: BoundedSourceWorkRequest[];
  workRequestsLoading: boolean;
  workRequestsError: string | null;
  workNotice: string | null;
  workSubmitting: boolean;
  onSubmitWork: (payload: Record<string, unknown>) => Promise<void>;
}) {
  return (
    <>
      <section className="grid grid-cols-3 border-b border-[color:var(--border)] bg-[color:var(--surface-soft)]">
        <SummaryMetric label="Queued" value={model.summary.queueDepth} />
        <SummaryMetric label="Failed" value={model.summary.failedWorkCount} />
        <SummaryMetric label="Dead-letter" value={model.summary.deadLetterCount} />
      </section>

      <DrawerSection title="Latest alerts" icon={ShieldAlert} count={model.alerts.length}>
        {model.alerts.length > 0 ? (
          <ol className="divide-y divide-[color:var(--border)]">
            {model.alerts.map((alert) => <AlertRow key={alert.id} alert={alert} />)}
          </ol>
        ) : (
          <EmptyState icon={CheckCircle2} text="No active data-health alerts" tone="success" />
        )}
      </DrawerSection>

      <DrawerSection title="Pipeline queues" icon={Layers3}>
        {model.queues.length > 0 ? (
          <div className="grid grid-cols-1 gap-px bg-[color:var(--border)] sm:grid-cols-2">
            {model.queues.map((queue) => (
              <div key={queue.kind} className="bg-[color:var(--surface)] px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-[color:var(--brand-ink)]">{title(queue.kind)}</span>
                  <span className="tnum text-xs text-[color:var(--muted)]">{queue.running} running</span>
                </div>
                <div className="mt-2 flex items-end justify-between gap-2">
                  <span className="tnum text-2xl font-semibold text-[color:var(--foreground)]">{queue.queued}</span>
                  <span className="tnum text-xs text-[color:var(--muted)]">
                    {queue.oldestAgeSeconds === null ? "No queued work" : `${formatAge(queue.oldestAgeSeconds)} oldest`}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState icon={Layers3} text="Queue telemetry is empty" />
        )}
      </DrawerSection>

      <DrawerSection title="Bounded refresh" icon={ListRestart} count={workRequests.length}>
        <BoundedWorkControls
          currentMonth={pacificMonth(model.generatedAt)}
          submitting={workSubmitting}
          onSubmit={onSubmitWork}
        />
        {workNotice ? <p className="border-t border-[color:var(--border)] px-4 py-2 text-xs text-[color:var(--success-fg)]">{workNotice}</p> : null}
        {workRequestsError ? <p className="border-t border-[color:var(--border)] px-4 py-2 text-xs text-[color:var(--state-failed-fg)]">{workRequestsError}</p> : null}
        {workRequestsLoading ? (
          <div className="flex items-center gap-2 border-t border-[color:var(--border)] px-4 py-3 text-xs text-[color:var(--muted)]">
            <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
            Loading queue status
          </div>
        ) : workRequests.length > 0 ? (
          <ul className="divide-y divide-[color:var(--border)] border-t border-[color:var(--border)]">
            {workRequests.map((request) => <BoundedWorkRow key={`${request.requestId}-${request.createdAt}`} request={request} />)}
          </ul>
        ) : (
          <div className="border-t border-[color:var(--border)]">
            <EmptyState icon={ListRestart} text="No bounded refresh requests" />
          </div>
        )}
      </DrawerSection>

      <DrawerSection title="Failed work" icon={CircleAlert} count={model.failures.total}>
        {model.failures.items.length > 0 ? (
          <ul className="divide-y divide-[color:var(--border)]">
            {model.failures.items.map((failure) => (
              <li key={`${failure.kind}-${failure.id}`} className="px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="tnum min-w-0 truncate text-xs font-semibold text-[color:var(--brand-ink)]">
                    {title(failure.source)} #{failure.id}
                  </span>
                  <StatusPill
                    tone={failure.status === "dead_lettered" ? "danger" : "warning"}
                    label={failure.status === "dead_lettered" ? "Dead-letter" : "Failed"}
                    size="sm"
                  />
                </div>
                <p className="tnum mt-1 break-words text-xs text-[color:var(--muted)]">
                  {failure.error || `${title(failure.kind)} work failed`} {failure.occurredAt ? `- ${formatTimestamp(failure.occurredAt)}` : ""}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon={CheckCircle2} text="No unresolved failed work" tone="success" />
        )}
      </DrawerSection>

      <DrawerSection title="Page freshness" icon={Gauge} count={model.pages.length}>
        <ul className="divide-y divide-[color:var(--border)]">
          {model.pages.map((page) => (
            <li key={page.pageKey} className="px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-semibold text-[color:var(--brand-ink)]">{pageLabel(page.pageKey)}</span>
                <StatusPill tone={page.state} label={title(page.state)} size="sm" />
              </div>
              <div className="mt-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-[color:var(--muted)]">
                <span className="tnum">{coverageLabel(page.coveragePercent)}</span>
                <span className="tnum">{page.dataThrough ? `Through ${formatTimestamp(page.dataThrough)}` : "No data-through watermark"}</span>
              </div>
              {page.coreTotal > 0 || page.secondaryTotal > 0 ? (
                <p className="tnum mt-1 text-[11px] text-[color:var(--muted)]">
                  Core {page.coreCovered}/{page.coreTotal}
                  {page.secondaryTotal > 0 ? `; secondary ${page.secondaryCovered}/${page.secondaryTotal}` : ""}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      </DrawerSection>

      <DrawerSection title="Profit and capacity contract" icon={Database} count={model.profitCapacity.totalMissing}>
        <div className="divide-y divide-[color:var(--border)]">
          <ContractCount
            label="Completed jobs"
            missing={model.profitCapacity.completedJobsMissing}
            total={model.profitCapacity.completedJobsTotal}
          />
          <ContractCount
            label="Active completed cost centers"
            missing={model.profitCapacity.activeCompletedCostCentersMissing}
            total={model.profitCapacity.activeCompletedCostCentersTotal}
          />
          <ContractCount
            label="People capacity"
            missing={model.profitCapacity.peopleMissing}
            total={model.profitCapacity.peopleTotal}
          />
        </div>
      </DrawerSection>

      <DrawerSection title="Source watermarks" icon={Database} count={model.watermarks.length}>
        {model.watermarks.length > 0 ? (
          <ul className="divide-y divide-[color:var(--border)]">
            {model.watermarks.map((watermark) => (
              <li key={`${watermark.sourceFamily}-${watermark.windowKey}`} className="px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate text-xs font-semibold text-[color:var(--brand-ink)]">
                    {title(watermark.sourceFamily)}
                  </span>
                  <StatusPill
                    tone={watermark.gapDetected || watermark.status === "failed" ? "danger" : "neutral"}
                    label={watermark.gapDetected ? "Gap" : title(watermark.status)}
                    size="sm"
                    icon={watermark.gapDetected || watermark.status === "failed" ? undefined : null}
                  />
                </div>
                <div className="mt-1 flex flex-wrap justify-between gap-x-3 gap-y-1 text-xs text-[color:var(--muted)]">
                  <span className="tnum">{watermark.windowKey}</span>
                  <span className="tnum">{watermark.dataThrough ? `Through ${formatTimestamp(watermark.dataThrough)}` : "No committed watermark"}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon={Database} text="No source watermarks recorded" />
        )}
      </DrawerSection>

      <DrawerSection title="Reconciliation" icon={RefreshCw} count={model.reconciliations.length}>
        {model.reconciliations.length > 0 ? (
          <ul className="divide-y divide-[color:var(--border)]">
            {model.reconciliations.map((item) => (
              <li key={item.scope} className="px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs font-semibold text-[color:var(--brand-ink)]">{title(item.scope)}</span>
                  <StatusPill
                    tone={item.status === "matched" ? "success" : "danger"}
                    label={title(item.status)}
                    size="sm"
                  />
                </div>
                <div className="mt-1 flex flex-wrap justify-between gap-x-3 gap-y-1 text-xs text-[color:var(--muted)]">
                  <span className="tnum">{driftLabel(item.countDrift, item.valueDrift)}</span>
                  <span className="tnum">{item.checkedAt ? formatTimestamp(item.checkedAt) : "Not checked"}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon={RefreshCw} text="No reconciliation results recorded" />
        )}
      </DrawerSection>

      <DrawerSection title="Historical backfill" icon={Clock3}>
        <div className="px-4 py-4">
          <div className="flex items-end justify-between gap-3">
            <div>
              <p className="tnum text-2xl font-semibold text-[color:var(--foreground)]">{formatPercent(model.backfill.percentComplete)}</p>
              <p className="tnum mt-0.5 text-xs text-[color:var(--muted)]">
                {monthLabel(model.backfill.startMonth)} to {monthLabel(model.backfill.throughMonth)}
              </p>
            </div>
            <p className="tnum text-right text-xs text-[color:var(--muted)]">
              {model.backfill.completeMonths}/{model.backfill.totalMonths} months complete
            </p>
          </div>
          <div
            className="mt-3 h-2 overflow-hidden rounded bg-[color:var(--surface-sunken)]"
            role="progressbar"
            aria-label="Backfill completion"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(model.backfill.percentComplete)}
          >
            <div className="h-full bg-[color:var(--success)]" style={{ width: `${model.backfill.percentComplete}%` }} />
          </div>
          <div className="tnum mt-2 flex flex-wrap justify-between gap-2 text-[11px] text-[color:var(--muted)]">
            <span>{model.backfill.completedRequiredUnits}/{model.backfill.totalRequiredUnits} required source-months</span>
            <span>{model.backfill.missingPlanMonths} months missing plan coverage</span>
          </div>
        </div>
      </DrawerSection>
    </>
  );
}

function ContractCount({ label, missing, total }: { label: string; missing: number; total: number }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3 text-xs">
      <span className="font-semibold text-[color:var(--brand-ink)]">{label}</span>
      <StatusPill
        tone={missing > 0 ? "warning" : "success"}
        label={missing > 0 ? `${missing}/${total} missing` : `${total}/${total} complete`}
        size="sm"
        className="tnum"
      />
    </div>
  );
}

function BoundedWorkControls({
  currentMonth,
  submitting,
  onSubmit,
}: {
  currentMonth: string;
  submitting: boolean;
  onSubmit: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const [kind, setKind] = useState<"entity_refresh" | "period_backfill">("entity_refresh");
  const [entityType, setEntityType] = useState("job");
  const [entityId, setEntityId] = useState("");
  const [sourceFamily, setSourceFamily] = useState("jobs");
  const [periodStart, setPeriodStart] = useState(currentMonth);
  const [periodEnd, setPeriodEnd] = useState(currentMonth);
  const [reason, setReason] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const payload = kind === "entity_refresh"
      ? { kind, entityType, entityId: Number(entityId), reason }
      : {
          kind,
          sourceFamily,
          periodStart: `${periodStart}-01`,
          periodEnd: `${periodEnd}-01`,
          reason,
        };
    await onSubmit(payload);
  }

  return (
    <form onSubmit={submit} className="space-y-3 px-4 py-4">
      <div className="grid grid-cols-2 rounded-md border border-[color:var(--border)] bg-[color:var(--surface-soft)] p-0.5" role="group" aria-label="Refresh mode">
        <button
          type="button"
          onClick={() => setKind("entity_refresh")}
          className={`focus-ring h-10 rounded-[8px] text-xs font-medium ${kind === "entity_refresh" ? "bg-[color:var(--surface)] text-[color:var(--brand-ink)] shadow-[var(--shadow-card)]" : "text-[color:var(--muted)]"}`}
          aria-pressed={kind === "entity_refresh"}
        >
          Record
        </button>
        <button
          type="button"
          onClick={() => setKind("period_backfill")}
          className={`focus-ring h-10 rounded-[8px] text-xs font-medium ${kind === "period_backfill" ? "bg-[color:var(--surface)] text-[color:var(--brand-ink)] shadow-[var(--shadow-card)]" : "text-[color:var(--muted)]"}`}
          aria-pressed={kind === "period_backfill"}
        >
          Period
        </button>
      </div>

      {kind === "entity_refresh" ? (
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3">
          <label className="min-w-0 text-xs font-medium text-[color:var(--brand-ink)]">
            Type
            <select
              value={entityType}
              onChange={(event) => setEntityType(event.target.value)}
              className="focus-ring mt-1 h-10 w-full rounded-md border border-[color:var(--border)] bg-[color:var(--surface)] px-2 text-xs"
            >
              <option value="quote">Quote</option>
              <option value="job">Job</option>
              <option value="employee">Employee</option>
              <option value="schedule">Schedule</option>
            </select>
          </label>
          <label className="min-w-0 text-xs font-medium text-[color:var(--brand-ink)]">
            Simpro ID
            <input
              type="number"
              min={1}
              step={1}
              required
              value={entityId}
              onChange={(event) => setEntityId(event.target.value)}
              className="focus-ring mt-1 h-10 w-full rounded-md border border-[color:var(--border)] bg-[color:var(--surface)] px-2 text-xs"
            />
          </label>
        </div>
      ) : (
        <>
          <label className="block text-xs font-medium text-[color:var(--brand-ink)]">
            Source
            <select
              value={sourceFamily}
              onChange={(event) => setSourceFamily(event.target.value)}
              className="focus-ring mt-1 h-10 w-full rounded-md border border-[color:var(--border)] bg-[color:var(--surface)] px-2 text-xs"
            >
              <option value="quotes">Quotes</option>
              <option value="quote_nested">Quote detail</option>
              <option value="jobs">Jobs</option>
              <option value="job_nested">Job detail</option>
              <option value="employees">Employees</option>
              <option value="timesheets">Timesheets</option>
              <option value="jobs_from_timesheets">Timesheet jobs</option>
              <option value="schedules">Schedules</option>
              <option value="mobile_status">Mobile status</option>
            </select>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="min-w-0 text-xs font-medium text-[color:var(--brand-ink)]">
              Start month
              <input
                type="month"
                min="2023-01"
                max={currentMonth}
                required
                value={periodStart}
                onChange={(event) => setPeriodStart(event.target.value)}
                className="focus-ring mt-1 h-10 w-full min-w-0 rounded-md border border-[color:var(--border)] bg-[color:var(--surface)] px-2 text-xs"
              />
            </label>
            <label className="min-w-0 text-xs font-medium text-[color:var(--brand-ink)]">
              End month
              <input
                type="month"
                min="2023-01"
                max={currentMonth}
                required
                value={periodEnd}
                onChange={(event) => setPeriodEnd(event.target.value)}
                className="focus-ring mt-1 h-10 w-full min-w-0 rounded-md border border-[color:var(--border)] bg-[color:var(--surface)] px-2 text-xs"
              />
            </label>
          </div>
        </>
      )}

      <label className="block text-xs font-medium text-[color:var(--brand-ink)]">
        Reason
        <input
          type="text"
          minLength={5}
          maxLength={500}
          required
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          className="focus-ring mt-1 h-10 w-full rounded-md border border-[color:var(--border)] bg-[color:var(--surface)] px-2 text-xs"
        />
      </label>

      <button
        type="submit"
        disabled={submitting}
        className="focus-ring flex h-10 w-full items-center justify-center gap-2 rounded-[10px] bg-[color:var(--ink)] px-3 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
      >
        <RefreshCw className={`h-4 w-4 ${submitting ? "animate-spin" : ""}`} aria-hidden="true" />
        {submitting ? "Queueing" : "Queue refresh"}
      </button>
    </form>
  );
}

function BoundedWorkRow({ request }: { request: BoundedSourceWorkRequest }) {
  const tone: PillTone = request.status === "succeeded"
    ? "success"
    : request.status === "failed"
      ? "danger"
      : request.status === "running"
        ? "building"
        : "neutral";
  return (
    <li className="px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="break-words text-xs font-semibold text-[color:var(--brand-ink)]">{request.targetLabel}</p>
          <p className="tnum mt-1 text-[11px] text-[color:var(--muted)]">
            {request.kind === "entity_refresh" ? "Record refresh" : `${request.unitCount} source-month${request.unitCount === 1 ? "" : "s"}`}
            {request.duplicate ? "; duplicate" : ""}
          </p>
        </div>
        <StatusPill tone={tone} label={title(request.status)} size="sm" className="shrink-0" />
      </div>
      <p className="tnum mt-1 text-[11px] text-[color:var(--muted)]">
        {formatTimestamp(request.createdAt)} by {request.requestedBy}
      </p>
    </li>
  );
}

function LoadingState() {
  return (
    <div className="flex min-h-48 items-center justify-center px-6 py-12 text-center">
      <div>
        <RefreshCw className="mx-auto h-6 w-6 animate-spin text-[color:var(--series-strong)]" aria-hidden="true" />
        <p className="mt-3 text-sm font-medium text-[color:var(--brand-ink)]">Loading operational state</p>
        <p className="mt-1 text-xs text-[color:var(--muted)]">Reading the latest app-owned evidence.</p>
      </div>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="flex min-h-48 items-center justify-center px-6 py-12 text-center">
      <div>
        <AlertTriangle className="mx-auto h-7 w-7 text-[color:var(--state-failed-fg)]" aria-hidden="true" />
        <p className="mt-3 text-sm font-semibold text-[color:var(--brand-ink)]">Data health is unavailable</p>
        <p className="mt-1 text-xs text-[color:var(--muted)]">{message}</p>
      </div>
    </div>
  );
}

function DrawerSection({
  title: sectionTitle,
  icon: Icon,
  count,
  children,
}: {
  title: string;
  icon: LucideIcon;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section className="border-b border-[color:var(--border)]">
      <div className="flex h-10 items-center gap-2 bg-[color:var(--surface-soft)] px-4 text-xs font-semibold text-[color:var(--brand-ink)]">
        <Icon className="h-4 w-4 text-[color:var(--muted)]" aria-hidden="true" />
        <h3 className="flex-1">{sectionTitle}</h3>
        {count !== undefined ? <span className="tnum font-normal text-[color:var(--muted)]">{count}</span> : null}
      </div>
      {children}
    </section>
  );
}

function SummaryMetric({ label: metricLabel, value }: { label: string; value: number }) {
  return (
    <div className="border-r border-[color:var(--border)] px-3 py-3 text-center last:border-r-0">
      <p className="tnum text-lg font-semibold text-[color:var(--foreground)]">{value}</p>
      <p className="mt-0.5 text-[11px] text-[color:var(--muted)]">{metricLabel}</p>
    </div>
  );
}

function AlertRow({ alert }: { alert: DataHealthAlert }) {
  const Icon = alert.severity === "critical" ? CircleAlert : AlertTriangle;
  const iconTone = alert.severity === "critical" ? "text-[color:var(--state-failed-fg)]" : "text-[color:var(--state-suspect-fg)]";
  return (
    <li className="flex gap-3 px-4 py-3">
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${iconTone}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
          <p className="text-xs font-semibold text-[color:var(--brand-ink)]">{alert.title}</p>
          {alert.occurredAt ? <span className="tnum text-[11px] text-[color:var(--muted)]">{formatTimestamp(alert.occurredAt)}</span> : null}
        </div>
        <p className="mt-1 break-words text-xs text-[color:var(--muted)]">{alert.detail}</p>
      </div>
    </li>
  );
}

function EmptyState({ icon: Icon, text, tone = "neutral" }: { icon: LucideIcon; text: string; tone?: "neutral" | "success" }) {
  return (
    <div className="flex items-center gap-2 px-4 py-4 text-xs text-[color:var(--muted)]">
      <Icon className={`h-4 w-4 ${tone === "success" ? "text-emerald-700" : "text-[color:var(--muted)]"}`} aria-hidden="true" />
      {text}
    </div>
  );
}

function formatTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function formatAge(seconds: number) {
  if (seconds >= 86_400) return `${Math.floor(seconds / 86_400)}d ${Math.floor((seconds % 86_400) / 3_600)}h`;
  if (seconds >= 3_600) return `${Math.floor(seconds / 3_600)}h ${Math.floor((seconds % 3_600) / 60)}m`;
  return `${Math.max(1, Math.floor(seconds / 60))}m`;
}

function coverageLabel(value: number | null) {
  return value === null ? "Coverage pending" : `${formatPercent(value)} source coverage`;
}

function formatPercent(value: number) {
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value)}%`;
}

function driftLabel(countDrift: number | null, valueDrift: number | null) {
  const parts: string[] = [];
  if (countDrift !== null) parts.push(`${signedNumber(countDrift)} count`);
  if (valueDrift !== null) parts.push(`${signedCurrency(valueDrift)} value`);
  return parts.length > 0 ? parts.join("; ") : "No numeric drift evidence";
}

function signedNumber(value: number) {
  return `${value > 0 ? "+" : ""}${value}`;
}

function signedCurrency(value: number) {
  return `${value > 0 ? "+" : ""}${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value)}`;
}

function monthLabel(value: string) {
  const date = new Date(`${value.slice(0, 7)}-01T00:00:00.000Z`);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" }).format(date);
}

function pacificMonth(value: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date(value));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  return year && month ? `${year}-${month}` : value.slice(0, 7);
}

function pageLabel(value: string) {
  return value === "technicians" ? "Technician Performance" : value === "commissions" ? "Technician Commissions" : `${title(value)} Metrics`;
}

function statusLabel(value: DataHealthStatus) {
  return value === "attention" ? "Needs attention" : title(value);
}

function title(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}
