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
      <section className="card materials-loading-performance">
        <div className="hd"><div><div className="skel w-36" /><div className="skel mt-2 w-72" /></div><div className="skel h-8 w-48" /></div>
        <div className="bd materials-performance-layout">
          <div className="materials-summary"><div className="skel h-4 w-36" /><div className="skel mt-3 h-10 w-48" /><div className="skel mt-5 h-28 w-full" /><div className="skel mt-5 h-24 w-full" /></div>
          <div className="materials-history"><div className="skel h-[300px] w-full" /></div>
        </div>
      </section>
      <div className="materials-analysis-grid"><div className="card h-72 animate-pulse" /><div className="card h-72 animate-pulse" /></div>
    </div>
  );
}
