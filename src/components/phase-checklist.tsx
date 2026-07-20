type ChecklistItem = {
  id: string;
  label: string;
  status: "DONE" | "NOT STARTED" | "BLOCKED" | "DEFERRED BY ASAD";
};

const statusClass = {
  DONE: "bg-green-50 text-green-800 border-green-200",
  "NOT STARTED": "bg-slate-50 text-slate-700 border-slate-200",
  BLOCKED: "bg-red-50 text-red-800 border-red-200",
  "DEFERRED BY ASAD": "bg-purple-50 text-purple-800 border-purple-200",
};

export function PhaseChecklist({ items }: { items: ChecklistItem[] }) {
  return (
    <section className="rounded-md border border-[color:var(--border)] bg-white">
      <div className="border-b border-[color:var(--border)] px-4 py-3">
        <h2 className="text-sm font-semibold text-[color:var(--brand-ink)]">Scope Checklist</h2>
      </div>
      <div className="divide-y divide-[color:var(--border)]">
        {items.map((item) => (
          <div key={item.id} className="grid gap-3 px-4 py-3 text-sm md:grid-cols-[6rem_1fr_9rem] md:items-center">
            <span className="font-mono text-xs text-[color:var(--muted)]">{item.id}</span>
            <span>{item.label}</span>
            <span className={`w-fit rounded-md border px-2 py-1 text-[11px] font-semibold ${statusClass[item.status]}`}>
              {item.status}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
