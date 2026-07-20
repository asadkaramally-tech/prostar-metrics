# Pro Star Metrics — Visual Audit & Component-Level Change Map

Author: senior product designer / frontend design engineer (Claude handoff)
Scope: frontend presentation only. No backend, data-contract, metric, or behavior changes.

## A. Visual Audit (current state)

**Identity & type.** Body font is Arial with no type scale discipline; headings, labels, and numerals carry no differentiation beyond size/weight. Financial values do not consistently use tabular numerals (jobs uses `tabular-nums`, quotes does not). The one-note navy/slate palette makes every panel read at the same priority.

**Token poverty.** `globals.css` has 13 tokens; everything else is inline Tailwind with hardcoded hexes (chart colors, heatmap ramps, tier colors, badge tints are all scattered literals). Semantic states (current/partial/building/stale/suspect/failed/missing) exist in the model and freshness banner but have no shared token or component treatment — each surface re-invents them.

**Component drift between routes.** Quotes uses square badges/inputs and `focus:border` focus; jobs uses `rounded-md` + `.focus-ring`. Panel headers differ (quotes ChartCard vs jobs Panel vs technicians Panel vs commissions Panel — four hand-rolled variants). Number precision differs (quotes 0dp vs jobs 1dp for the same kinds of values). Empty states have four visual dialects. Pagination is icon-buttons in quotes, links in jobs.

**Hierarchy.** Every panel has equal visual weight; the first viewport spends itself on notices and snapshot prose rather than decision KPIs. KPI cards show every metric at identical size with no ranking; deltas use one green/red mapping even where direction is ambiguous or inverted (costs, variance, excluded jobs). The methodology strips (blue) sit above the KPIs on jobs/technicians, pushing the operating result down.

**Navigation.** Desktop sidebar has NO active-route state (mobile nav has one). Owner identity block is fine but the sidebar wastes width (w-64 for four items). Data-health trigger is fixed bottom-left at 232px wide — heavy, and its `bottom-[76px]` offset is arbitrary.

**Charts.** Reasonable Recharts usage with fixed heights (good), but: default Recharts legends (small gray text, no alignment discipline), inconsistent categorical hexes across routes (`#18794e` vs `#1f7a4d` vs `#2f7d5a` all "green"), rainbow risk in tier palette, tooltips unstyled default white boxes, no reference lines, axis ticks 11px with no tabular figures.

**Tables.** Dense and functional but noisy: full `border-b` on every row, uppercase headers not sticky (except one), no row hover, no zebra option, numeric alignment inconsistent. Wide min-widths force horizontal scroll on mobile with no affordance hint.

**States.** Loading skeletons exist only for /jobs and /commissions; /quotes and /technicians have none. Freshness banner is a text-only tinted box (color-alone risk, no icon). Provisional badges vary (blue text chip, blue border on heatmap, "Provisional" text in tables).

**Accessibility.** Generally strong semantics (the inventories catalog aria usage). Gaps: quotes controls lack `.focus-ring`; freshness/state conveyed by color+text but no icon in several chips; some amber-on-amber text pairs near 3:1; sidebar links lack `aria-current`.

## B. Design System Decisions

1. **Tokens (globals.css).** Extend to a full scale while keeping the existing 13 token names working (no component breaks): neutral ramp (`--n0..--n900`), brand (navy kept), semantic state tokens (`--state-current/partial/building/stale/suspect/failed/missing` with `-bg`/`-fg`/`-border` triads), chart categorical palette `--chart-1..8` (navy, teal, amber, green, purple, red reserved-for-negative, slate, sky), radius tokens (`--radius-sm 6px`, `--radius 8px` max), focus ring token. Font: system UI stack (`ui-sans-serif, -apple-system, "Segoe UI", Roboto, Helvetica, Arial`) — no new dependency, crisper than Arial. `font-variant-numeric: tabular-nums` utility class `.tnum` applied to all numeric cells/KPIs.
2. **New reusable presentation-only components** under `src/components/ui/`:
   - `status-pill.tsx` — icon + label + tone for the 7 data states + generic success/warn/danger/neutral; never color-alone.
   - `panel.tsx` — Panel + PanelHeader (title, subtitle, actions slot) unifying the four dialects.
   - `kpi-tile.tsx` — disciplined KPI: label, value (tnum), delta with **explicit direction semantics** (`goodWhen="up"|"down"|"none"` → arrows suppressed when `none`), coverage/context line, optional status pill.
   - `empty-state.tsx` — single empty/unavailable treatment (icon, title, detail) reused by charts and tables.
   - `chart-bits.tsx` — shared Recharts tooltip content, legend row, axis defaults, chart frame with fixed height and stable layout.
   - `table-bits.tsx` — DataTable wrapper (overflow, min-width, sticky header option), Th/Td numeric helpers, PaginationBar.
   - `section-nav` is NOT added (no landing page, no new IA).
3. **Chart palette** (consistent meaning across routes): Accepted/positive = green `--chart-green`; Not Accepted/negative-outcome = red (reserved); revenue/primary series = navy; secondary = teal; tertiary = amber; quaternary = purple. Tier palette keeps 4 distinct hues but normalized to the categorical set.
4. **Page skeleton order** (all four routes): compact context header (icon+title+one-line description) + period/freshness controls → warnings/exceptions → headline KPIs (ranked) → trends/comparisons → segments → drilldowns → methodology (compressed reference band). Methodology strips move BELOW the KPI row as compact reference treatments unless they carry an active warning.

## C. Component-Level Change Map (file by file)

Allowed files only. Every feature listed in `.design/inventory-*.md` must remain present and functional.

| File | Change |
|---|---|
| `src/app/globals.css` | Token expansion, font stack, `.tnum`, `.focus-ring` retained, scrollbar/scroll-hint styling, reduced-motion guard. Keep all existing token names valid. |
| `src/components/ui/*` (new) | New presentation-only primitives listed in B2. |
| `src/components/app-shell.tsx` | Sidebar: active-route state (server-side via a small client nav list or pathname-aware client subcomponent), `aria-current="page"`, tighter width (w-60), grouped nav, understated identity footer; no auth/data changes. |
| `src/components/mobile-nav.tsx` | Keep behavior; align tokens/focus states; ensure no overlap with data-health trigger (drawer trigger stays top-right; nav button offset preserved). |
| `src/components/dashboard-page.tsx` | Compact header: smaller icon tile, title + one-line description, controls row with stable dimensions; freshness rendered as StatusPill + detail popover-free inline text. |
| `src/components/period-selector.tsx` | Same form semantics/params; visual alignment with control system; stable width. |
| `src/components/freshness-banner.tsx` | Rebuild on StatusPill (icon + label + detail), same 7 states, same props. |
| `src/components/kpi-card.tsx` | Becomes thin wrapper over `kpi-tile` (same props, still used by commissions/technicians); no metric changes. |
| `src/app/quotes/` | Add presentation-only `loading.tsx` + `error.tsx` (parity with jobs; truthful copy). |
| `src/components/quotes/quote-metrics-dashboard.tsx` | Reorder first viewport: snapshot compressed into comparison grid, trailing KPIs promoted; unify badges/inputs to system; tabular nums; shared chart bits; keep every section, filter, export, workbench, evidence panel, override form, methodology footer (compressed dark band → reference section). No URL/param/POST changes. |
| `src/components/jobs-dashboard.tsx` | Net profit/margin KPIs promoted to slots 1–2 with larger emphasis tier; methodology strip compressed + moved below KPIs; shared panels/tables/charts; semantic deltas (loss jobs, labor variance marked `goodWhen:"down"`/`none`); keep all 17 sections. |
| `src/components/technicians-dashboard.tsx` | Three hour-ratio families visually grouped under labeled sub-headers (Utilization vs Capacity vs Labor efficiency) without renaming metrics; KPI ranking; scorecard sticky first column; heatmap tokens; keep all panels/drilldowns. |
| `src/components/commissions-dashboard.tsx` | Owner control surface: worksheet state + next-action emphasized in a lifecycle header (state pill, revision chip, action buttons with visible disable reasons); config/override areas grouped with deliberate high-trust styling; keep every action, gate, poll, export, audit, summary. Payroll disclaimer stays prominent. |
| `src/components/data-health-drawer.tsx` | Presentation markup only: align pills/sections to system, keep polling, focus management, all 10 sections, both triggers (desktop trigger slimmer; mobile dot unchanged in behavior). |

## D. Explicitly Preserved (verified against inventories)

All URL params (`month/search/category/tier/outcome/sort/page`, `costCenter/technician/jobPage`, `year/month/summaryYear`), all GET forms, POST endpoints + bodies (overrides, config, lifecycle, rebuild, exports, data-refresh), reload/poll behaviors, CSV/PDF exports, pagination semantics, RBAC-gated rendering, every empty/N-A/unavailable string's truthfulness (wording may be restyled, never softened from a warning to a decoration), disabled reasons, `aria-*` semantics (extended, never removed), all Recharts chart types and series.

## E. Future ideas (NOT implemented — would need new data/contract)

- Exception feed ("what needs attention now") synthesized across routes — needs a cross-route read model.
- Per-KPI targets/thresholds — no configured targets exist in the model; not invented.
- Sticky compare-to selector — current model fixes comparison windows.
