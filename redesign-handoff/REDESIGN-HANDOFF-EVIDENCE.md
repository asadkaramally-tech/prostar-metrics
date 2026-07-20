# Pro Star Metrics — Frontend Visual Redesign: Handoff Evidence for Codex

Prepared by the design/frontend pass (Claude). Frontend-only. No backend, data, or contract changes.

## 1. What changed and why

The four authenticated dashboards (`/quotes`, `/jobs`, `/technicians`, `/commissions`) plus the
shared shell and data-health drawer were restyled onto a single coherent visual system. Every
metric, chart, table, filter, drilldown, action, export, audit trail, and data-state was preserved;
only presentation changed. See `.design/visual-audit-and-change-map.md` for the pre-change audit and
the component-level change map, and `.design/inventory-*.md` for the exhaustive per-route feature
inventories used to guarantee zero feature loss.

## 2. Changed files (29 — all presentation-layer)

Shared system (new + edited):
- `src/app/globals.css` — token system (neutral ramp, brand, 7 data-state tokens, chart palette, radius, focus), system font stack, `.tnum` tabular figures, unified focus ring, reduced-motion guard.
- `src/components/ui/status-pill.tsx` (new) — icon+label+tone treatment for the 7 factual data states, never color alone.
- `src/components/ui/kpi-tile.tsx` (new) — disciplined KPI (label/value/delta/context/status) with explicit direction semantics via `kpiDelta(value, text, goodWhen)`.
- `src/components/ui/panel.tsx`, `empty-state.tsx`, `table-bits.tsx`, `chart-bits.tsx`, `page-states.tsx` (new) — shared panels, empty states, dense-table primitives + pagination, chart palette/frame/tooltip constants, and loading/error skeletons.
- `src/components/nav-items.ts` (new), `src/components/sidebar-nav.tsx` (new) — single nav source + client sidebar with `aria-current` active-route state.
- `src/components/app-shell.tsx`, `mobile-nav.tsx`, `dashboard-page.tsx`, `period-selector.tsx`, `freshness-banner.tsx`, `kpi-card.tsx` — shell/header/controls restyled; `kpi-card` now delegates to `KpiTile` (same props) so every KPI reads as one system.

Route presentation:
- `src/components/quotes/quote-metrics-dashboard.tsx`
- `src/components/jobs-dashboard.tsx`
- `src/components/technicians-dashboard.tsx`
- `src/components/commissions-dashboard.tsx`
- `src/components/data-health-drawer.tsx` (markup only; all hooks/fetch/polling/focus untouched)

Route states (loading/error skeletons; new for quotes+technicians, aligned for jobs+commissions):
- `src/app/quotes/loading.tsx` (new), `src/app/quotes/error.tsx` (new)
- `src/app/technicians/loading.tsx` (new), `src/app/technicians/error.tsx` (new)
- `src/app/jobs/loading.tsx`, `src/app/jobs/error.tsx`
- `src/app/commissions/loading.tsx`, `src/app/commissions/error.tsx`

## 3. No prohibited files touched (verified)

`git diff --name-only <baseline>` contains **zero** paths under `infra/`, `workers/`, `scripts/`,
`src/lib/store/`, `src/lib/simpro/`, `src/lib/metrics/`, `src/app/api/`, `src/lib/auth/`, or
`src/proxy.ts`. No `package.json` / dependency changes. No migrations, queue, reconciliation,
ingestion, or release tooling changes. Baseline git tag: commit `bdb910a`.

## 4. Validation results (this sandbox)

| Command | Result |
|---|---|
| `npm exec -- tsc --noEmit --pretty false` | PASS (0 errors) |
| `npm run lint -- --max-warnings=0` | PASS (0 warnings) |
| `npm run build` | PASS (compiled; 22 routes; fresh BUILD_ID; all manifest assertions PASS) |
| `npm run plan:check` | PASS (98 feature records) |
| `npm run reference:check` | PASS (4 artifacts, 5 sidecar hashes) |
| `npm run guard:no-mirror` | PASS |
| `npm test` | 700/702 PASS — identical to pre-redesign baseline; the only 2 failures are pre-existing (`tests/workers/emit-operational-telemetry.test.ts`, a backend worker file untouched by this redesign). Redesign introduced **0 new failures**. |
| `npm run test:integration` | PASS (0 failed assertions) |

## 5. Screenshot evidence (`.work/redesign-evidence/`)

Captured with headless Chromium at all four required viewports (1440×1000, 1024×768, 768×1024,
390×844) against a dev-only preview harness that renders the **real redesigned components** using
representative fixtures built by the app's own pure read-model builder functions (no database, no
mocked business values in production code; the preview harness was removed after capture).

16 full-page screenshots: `{quotes,jobs,technicians,commissions}-{desktop-1440,laptop-1024,tablet-768,mobile-390}.png`.

Automated checks during capture, every route × viewport:
- **Horizontal page overflow: none** (0/16).
- **Application console errors: none** (0/16; only dev-server HMR WebSocket noise, absent in production).

What the screenshots confirm: the shared hierarchy and page structure; the ranked KPI treatment
(net profit/net margin promoted to primary on Jobs; trailing KPIs promoted on Quotes; distinct
metric families grouped on Technicians; the commission lifecycle header as the control anchor with
Rebuild→Review→Lock and visible disabled-reasons); unified panels, dense tables with tabular
numerals and sticky identity columns, badges/status pills, filter bars, the tier-month heatmap,
compressed methodology bands, active-route navigation, and coherent mobile stacking.

### Known harness limitation (root cause confirmed) → Codex live checks
The chart panels appear empty in the full-page screenshots because **Recharts 3.9 does not render in
this sandbox's headless Chromium at all**. This was proven decisively: a trivial isolated
`<BarChart width={400} height={200}>` with hardcoded data and animation disabled *also* renders zero
SVG in this browser (and Recharts 3 likewise emits no SVG under Node `renderToStaticMarkup`). It is
independent of this redesign, of `ResponsiveContainer`, and of dev-vs-production — the pre-existing
KPI sparklines are blank too. Recharts renders normally in a standard browser, which is where the app
runs for its users. As positive proof that the data and the redesigned chart styling are correct, the
same preview fixture data was plotted in the exact redesign palette (matplotlib, which does render
headless): see `screenshots/quotes-charts-render.png` and `screenshots/jobs-charts-render.png`. Codex
must still verify, on the authenticated deployment in a real browser, that every chart renders with
live data:

- Quotes: trailing-acceptance donut, monthly accepted-vs-not (count & value) stacked bars, monthly volume-by-tier and rate-by-tier, acceptance-path bars, count/value acceptance trend lines, and the KPI sparklines.
- Jobs: revenue/gross/net trend, completed-jobs bars, gross/net margin trend, labor-hours trend, source-labor composed chart, gross-to-net waterfall, net-margin distribution.
- Technicians: allocated-economics bars, capacity-use stacked bars, punctuality distribution, capacity-vs-demand and travel/parts trend lines, technician-month heatmap (custom CSS grid — does render).
- Commissions: commission-due-by-technician bars (tier-colored), summary sparklines.
Confirm chart colors match the restrained categorical palette and that no chart relies on color alone (legends/labels present).

## 6. Test results detail

- `npm test`: **702 tests, 700 pass, 2 fail**. Both failures are `tests/workers/emit-operational-telemetry.test.ts` (#653, #654) — backend worker telemetry with missing exports, a **pre-existing** condition captured at the baseline commit `bdb910a` before any redesign edit. No frontend file is involved.
- `npm run test:integration`: PASS.
- Three source-assertion tests in `tests/store/dashboard-mobile-controls.test.ts` initially failed because the design-system migration renamed a prop (`title`→`label` on the KPI card) and replaced hand-rolled table markup with the shared `DataTable`. These were resolved **in the components, not by weakening the tests**, so the tests pass unmodified: (a) the Average Job Value KPI is rendered via the shared `KpiCard` (`title=`/`value=`), which also correctly drops its ambiguous-direction trend arrow per the handoff; (b) the quote Acceptance-Evidence workbench keeps its explicit local horizontal scroller (`min-w-0 max-w-full overflow-hidden` section + `overflow-x-auto` table wrapper) and its inline `aria-label` on the inspect button, so wide content stays contained and screen-reader labels stay inside the scroller. All 11 mobile-control contracts pass.
- Per-route component tests (`tests/components/*.test.ts`): quotes 5/5, jobs 3/3, technicians 9/9, commissions 9/9, data-health 1/1 — all pass, confirming every asserted feature string, chart title, `data-testid`, and honesty statement is preserved.

## 7. Additional live checks for Codex (authenticated deployment)

Beyond the chart rendering above, verify against real data at all four viewports:
- Keyboard navigation reaches every control with a visible focus ring; `aria-current` on the active nav item.
- Data-health drawer opens/closes with focus management and scroll lock; both triggers do not overlap page controls or mobile nav.
- Every data-state renders truthfully with icon+label+color (current/provisional/building/stale/suspect/failed/missing), and `N/A`/unavailable never becomes a zero.
- Commission actions honor their real disabled conditions and the payroll disclaimer is present; nothing calculated/exported is labeled paid.
- Long technician/customer/site/category/quote names truncate or wrap with the full value still accessible; wide tables scroll horizontally without clipping identity columns.
- WCAG 2.2 AA contrast on text, controls, focus, chart annotations, and semantic states; touch targets ≥ ~40px on mobile.
