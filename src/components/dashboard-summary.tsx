import { AlertTriangle, BarChart3, CircleSlash, DollarSign, Hash, Percent } from "lucide-react";
import { KpiCard } from "@/components/kpi-card";
import type { DashboardReadModel } from "@/lib/store/dashboard-read-models";
import type { RollupRow } from "@/lib/store/rollups";

const fallbackIcons = [Hash, DollarSign, Percent, BarChart3];

export function DashboardSummary({ model }: { model: DashboardReadModel }) {
  return (
    <div className="space-y-5">
      {model.warnings.length > 0 ? (
        <section className="rounded-md border border-yellow-200 bg-yellow-50 p-4 text-sm text-yellow-900">
          <div className="mb-2 flex items-center gap-2 font-semibold">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            Coverage and implementation notes
          </div>
          <ul className="list-inside list-disc space-y-1">
            {model.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {model.kpis.length > 0 ? (
        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {model.kpis.map((kpi, index) => (
            <KpiCard
              key={kpi.label}
              title={kpi.label}
              value={kpi.value}
              subtitle={kpi.detail}
              icon={fallbackIcons[index % fallbackIcons.length]}
            />
          ))}
        </section>
      ) : (
        <EmptyRollupState />
      )}

      <RollupTable rows={model.rollups} />
    </div>
  );
}

function EmptyRollupState() {
  return (
    <section className="rounded-md border border-[color:var(--border)] bg-white p-6 text-sm">
      <div className="flex items-start gap-3">
        <CircleSlash className="mt-0.5 h-5 w-5 text-[color:var(--muted)]" aria-hidden="true" />
        <div>
          <h2 className="font-semibold text-[color:var(--brand-ink)]">No app-owned rollups available</h2>
          <p className="mt-1 max-w-2xl text-[color:var(--muted)]">
            This page is wired to the serving store, but ingestion and rollup rebuilds have not produced data for it yet.
          </p>
        </div>
      </div>
    </section>
  );
}

function RollupTable({ rows }: { rows: RollupRow[] }) {
  return (
    <section className="rounded-md border border-[color:var(--border)] bg-white">
      <div className="border-b border-[color:var(--border)] px-4 py-3">
        <h2 className="text-sm font-semibold text-[color:var(--brand-ink)]">App-Owned Rollups</h2>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-[color:var(--border)] text-left text-xs uppercase text-[color:var(--muted)]">
              <th className="px-4 py-3 font-semibold">Period</th>
              <th className="px-4 py-3 font-semibold">Metric</th>
              <th className="px-4 py-3 text-right font-semibold">Value</th>
              <th className="px-4 py-3 text-right font-semibold">Snapshots</th>
              <th className="px-4 py-3 font-semibold">State</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-6 text-center text-[color:var(--muted)]" colSpan={5}>
                  No rollup rows found.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={`${row.period_start}-${row.metric_key}-${JSON.stringify(row.dimensions)}`} className="border-b border-[color:var(--border)]">
                  <td className="px-4 py-3">{row.period_start}</td>
                  <td className="px-4 py-3 font-medium">{row.metric_key}</td>
                  <td className="px-4 py-3 text-right">{row.metric_value}</td>
                  <td className="px-4 py-3 text-right">{row.source_snapshot_count}</td>
                  <td className="px-4 py-3">{row.provisional ? "Provisional" : "Final"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
