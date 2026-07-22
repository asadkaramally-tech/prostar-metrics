export default function MaterialsLoading() {
  return (
    <div className="dashboard-content materials-loading" role="status" aria-busy="true" aria-label="Loading Materials">
      <span className="sr-only">Loading Materials</span>
      <div className="mb-[26px] flex min-h-[66px] items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="h-3 w-28 animate-pulse rounded bg-[color:var(--surface-sunken)]" />
          <div className="mt-2.5 h-7 w-40 animate-pulse rounded-md bg-[color:var(--surface-sunken)]" />
          <div className="mt-2 h-3 w-full max-w-[380px] animate-pulse rounded bg-[color:var(--surface-sunken)]" />
        </div>
        <div className="ml-auto hidden h-10 w-52 animate-pulse rounded-[11px] bg-[color:var(--surface-sunken)] sm:block" />
      </div>
      <section className="kpis hero" aria-hidden="true">
        <div className="kpi primary"><div className="skel h-4 w-28" /><div className="skel mt-5 h-10 w-48" /><div className="skel mt-4 h-4 w-64" /><div className="skel mt-auto h-10 w-full" /></div>
        <div className="ktiles">
          <div className="kpi"><div className="skel h-4 w-28" /><div className="skel mt-3 h-7 w-32" /></div>
          <div className="kpi"><div className="skel h-4 w-28" /><div className="skel mt-3 h-7 w-32" /></div>
          <div className="kpi"><div className="skel h-4 w-28" /><div className="skel mt-3 h-7 w-20" /></div>
          <div className="kpi"><div className="skel h-4 w-28" /><div className="skel mt-3 h-7 w-32" /></div>
        </div>
      </section>
      <div className="grid12"><div className="card span12"><div className="hd"><div className="skel h-7 w-52" /></div><div className="bd"><div className="skel h-[250px] w-full" /></div></div></div>
      <div className="grid12"><div className="card span12"><div className="hd"><div className="skel h-7 w-56" /></div><div className="bd"><div className="skel h-52 w-full" /></div></div></div>
    </div>
  );
}
