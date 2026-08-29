# Pro Star Metrics (metrics.psm.photos) — UI Redesign Brief

> ## 0. Normative reference — the converged mockups
> This brief was **rendered as working mockups and adversarially reviewed to convergence** (7 evaluator rounds with separate evaluator/improver agents; the owner rejected the round-3 state, after which desktop composition at 1440 became a P0-level rubric section and the bundled **`dataviz` skill's method was made binding** — its anti-patterns catalog is part of the acceptance bar and its palette validator gated every color choice). The final mockups are the pixel truth — **where this text and the mockups disagree, the mockups win**:
> - `docs/design/metrics-mockups/quotes.html` · `jobs.html` · `technicians.html` · `commissions.html`
> - Shared components/tokens: `docs/design/metrics-mockups/assets/tokens.css` · chart engine: `assets/charts.js` (real July 2026 data inline; jobs trend intermediate months and one MB-1 row are approximated — marked `[mockup-only]`)
> - Review rubric the implementation must also satisfy: `docs/design/metrics-mockups/review-workspace/rubric.md` (sections A–H; G = desktop composition, H = dataviz compliance).
> - Objective gate (run it against the real implementation too): `docs/design/metrics-mockups/review-workspace/gate.mjs` — page- AND card-level overflow at 1440/1280/1024/768/390, primary-viz-above-fold at 1440×900, **multi-card rows flush within 28px**, **no interior content-free block >64px inside any card**, no placeholder-empty KPI subs, no dark surface >100px, key-figure once-per-page, and a computed WCAG AA sweep over every text node (hatch worst-case modeled). It must end `GATE PASS`.
> - **Verification lesson from the loop (binding):** verify *rendered pixels*, never style attributes — one round shipped correct markup percentages that flexbox silently clamped into equal-height bars. Bar/segment proportions must be ratio-checked via getBoundingClientRect against the data values.
> Sections below are updated to match the converged state; convergence deltas are marked **[converged]**.

**For:** implementation agent
**Scope:** visual/layout redesign of the four dashboard pages (Quotes, Jobs, Technicians, Commissions) **plus one new page (§4.5 Materials)**. No data, route, auth, or backend changes. Every number, footnote, drilldown, filter, and CSV export that exists today must still exist after the redesign — this brief only changes *where and how* things are shown.
**Surveyed:** live app, July 2026 data, 1433px viewport, 2026-07-18. All example values below are the live July values; treat them as sample content, not constants.

---

## 1. Why we are redesigning (diagnosis, measured on the live app)

The current template on every page is: `[dark hero slab, left] [white tile-dump card, right]` → `[tabs]` → `[charts and tables below the fold]`. Concretely, on /quotes at 1433×691:

1. **The dark hero card is 410×751px and contains ~13 separate figures** (28.6%, 6 of 21, two delta pills, WON $10,045, 6.9%, OPEN $135,181, 15 in play, a 2×2 tile grid with 4 more stats + 4 deltas, and a slider-sparkline). No visual hierarchy separates them; it reads as a stat dump.
2. **Massive duplication.** On the /quotes first screen: 28.6% appears 3× (hero headline, COUNT RATE tile, slider label), 6.9% appears 3× (hero "of quoted value", VALUE RATE tile), $10,045 appears 3× (hero WON, WON VALUE tile), $135,181 2×, $145,225 2×, "15 open" 3×, "21 sent" 2×. The right-hand "Quote Status Mix" card is ~80% restatement of the hero.
3. **The most important visual — the Acceptance Trend chart — starts at y≈1010px**, a full viewport below the fold, *after* all the redundant tiles. Same on /jobs: the Monthly Trend chart sits at y≈2000 of 3149.
4. **Low-value content gets prime space.** The open-quote-aging row (0-30d / 31-45d / 46d+) spends a full-width row of three large tiles to say "15 / 0 / 0". VALUE RATE and COUNT RATE get two large tiles that duplicate the hero. Deal-size data is rendered three separate ways on one page (list in the status card, bar-list card, heatmap).
5. **Visualizations are subordinate to lists.** Deal Size Mix is a text list with hairline bars; Profitability by Site is a text list; the "one revenue bar" on /jobs is a lone unlabeled bar with 4 disconnected tiles under it.
6. **Wasted vertical space.** The hero row is 751px tall because the left slab is; the right card stretches to match with padded white space. Cards use ~24px padding plus large internal gaps.

### Design principles for the new layout

- **P1 — One number, one home.** Each metric appears exactly once per page (a chart may of course plot the series a tile summarizes).
- **P2 — Chart-first.** The page's primary time-series chart is fully visible without scrolling at 1440×900 (nav + page header + KPI band + full chart ≤ 900px).
- **P3 — Stats live with their visualization.** A stat that summarizes a chart sits in/on that chart's card, not in a distant tile.
- **P4 — Space is earned.** A metric's footprint is proportional to its decision value. Near-empty content (15/0/0 aging) collapses to a sentence; the money chart gets the width.
- **P5 — Same skeleton on every page** so the app feels designed: `Page header → KPI band → Primary visualization → Secondary cards (2-col) → Tables/drilldowns`.

---

## 2. What does NOT change

- Top nav bar (logo, Quotes/Jobs/Technicians/Commissions, Data-health button with active-count badge, user chip) — keep exactly as is, height 56px.
- Month stepper (`‹ July 2026 ›`) and "Updated N days ago" pill, top-right of the page header.
- The Data health drawer (right slide-over) — unchanged.
- All footnote/source lines (e.g. "Source: Simpro quotes · month assigned by DateApproved …") — keep, one per card max, and the page-bottom source line.
- All drilldowns, tooltips, row-click behaviors, Download CSV buttons, filter dropdowns, pagination, the commissions Worksheet controls (pool %, efficiency toggle, per-tech include checkboxes), and the History/Worksheet/Summary tab *contents*.
- The design-token system (see §3) — the redesign is executed **inside** the existing tokens; do not introduce new colors or fonts.
- Loading skeletons / empty / error+retry patterns (existing `skel`, `empt`, `err`, `retry` classes) — every new/moved card must keep all three states.

---

## 3. Design system (tokens exist today in `:root`; use them, don't restate hex values in components)

**Font:** `Inter, system-ui, sans-serif`. **[converged]** `font-variant-numeric: tabular-nums` (class `tnum`) applies ONLY where numbers align vertically — table columns, axis ticks, stat strips. KPI-tile and hero values use proportional figures (equal-width digits look loose at display sizes).

**[converged] New token the implementation must add:** `--series-2: #0e9aae` — categorical series slot 2. The existing token set has **no second identity hue** (grey fails the chroma floor — "reads gray" — and status colors may never carry series identity). The pair `--acc` + `--series-2` passes the dataviz validator (worst-CVD ΔE 39.8, lightness band, chroma, contrast all PASS). Grey (`--series-weak`) is only for de-emphasis/remainder fills, never a named series.

**Key tokens (already in the CSS):**
- Canvas: `--canvas-b #f2f4f7` (page), `--surface #fff` (cards), `--surface-soft #f7f8fb` (nested tiles), `--surface-sunken #eef0f4`.
- Ink: `--ink #101422`, `--muted #5c6474`, `--faint #6d7585`, `--subtle #6b7383`.
- Accent: `--acc #5b63d3`, `--acc-2 #8087ec`, `--acc-weak #eef0fb`.
- Semantic: `--up #177a52` (good), `--down #d0463a` (bad), `--warn #b4791a`.
- Series: `--series-strong #404a60`, `--series-weak #9aa2b2`, `--chart-grid #eff1f5`.
- Dark hero surface: `--hero-a #171a26 → --hero-b #101320 → --hero-c #0c0e18`, shadow `--sh-hero`.
- Radii: 8px everywhere (`--r-card`, `--r-stat`), pills `--r-pill 999px`.
- Shadows: `--sh-card`, `--sh-stat`.
- Hairlines: `--hair #e9ebf0`, strong `--border-strong #d7dbe4`.

**Layout grid (new):**
- Content container: fluid, `margin: 0 24px`, `max-width: 1560px`, centered above 1608px viewport.
- 12-column CSS grid, **column gap 16px, row gap 16px** (replaces today's ~18–48px irregular gaps).
- Page header block: 64px tall (eyebrow + H1 + subtitle left; stepper + updated pill right), margin-bottom 16px.

**Type scale (new, page-wide):**
| Role | Spec |
|---|---|
| Page eyebrow ("OPERATIONS") | 11px / 600 / letter-spacing .08em / uppercase / `--muted` |
| Page H1 | 24px / 700 / `--ink` (down from ~30px; reclaims header height) |
| Page subtitle | 13px / 400 / `--muted` |
| Card title | 15px / 600 / `--ink` |
| Card subtitle | 12.5px / 400 / `--muted` |
| KPI tile label | 11px / 600 / .08em / uppercase / `--muted` |
| KPI value | 26px / 700 / `--ink` / tnum |
| KPI value (primary tile) | 34px / 750 / `#fff` / tnum |
| KPI sub-line | 12px / 400 / `--faint` |
| Delta pill | 11.5px / 600, color `--up`/`--down`, background `--surface-soft` (on dark: `rgba(255,255,255,.08)`), radius 999px, padding 2px 8px, arrow glyph ↑/↓ |
| Table header | 11px / 600 / .06em / uppercase / `--muted` |
| Table cell | 13.5px / 400 (money cells 13.5/600 tnum) |
| Footnote / source | 12px / 400 / `--faint` |

### 3.1 Component: KPI band — **[owner-directed rework, 2026-07-19]** hero card + 2×2 tiles

Every page's band is now: **a primary stat card (left, dark, 204px tall, span ~1/3)** beside a **2×2 grid of 96px tiles**. The primary card holds, top to bottom: label row (label + labeled delta pills), value (34px), sub-line, and — per the owner's direct requirement — **ONE comparison bar with markings, in the same card** (a bullet bar, not multiple bars): the fill is this month-to-date; two tick marks on the same track mark the previous month and the same month last year. A caption row beneath keys each tick to its window and value (`Jul ’25 · d18 $149.9K` · `Jun ’26 · full $200.2K`). Ticks sit at value/scale with scale = 1.04 × the largest of the three values. Where a prior period has no data, its tick is omitted and the caption says so (`no run`, `pending`) — never an invented number.
**Every delta pill states its comparison** (`↓ 91.8% vs Jul ’25`, `↑ 4.1 pts vs Jun`) — a bare percentage is banned (owner: "completely ambiguous"). One band footnote defines day-alignment ("d18").
Below 1280px the band stacks (primary full-width, tiles 2×2 under it); label rows may wrap there.

### 3.1a Tile anatomy (the 96px tiles)

```
┌──────────────────────────────────┐  height 96px fixed; padding 14px 16px;
│ LABEL            [↓ 91.8%] pills │  bg --surface; border 1px --hair; radius 8px;
│ $145,225                         │  shadow --sh-stat
│ sub-line text                    │
└──────────────────────────────────┘
```
- **[converged] Pills do NOT sit on the value baseline** (they clip — round-1 P0). Structure is three rows: a top `lblrow` (label left, delta pills right-aligned, pill padding-block 1px), then the value alone (nowrap), then the sub-line. A tile's pills always live on the lblrow. Primary-tile sub may wrap to 2 lines at <768px; elsewhere subs ellipsize.
- **[converged] Labels carry no month suffix** ("· July", "· July to date" banned — the month lives in the stepper); long labels get short forms (e.g. "AVG DEAL", not "AVG ACCEPTED DEAL").
- **Primary variant** (first tile of each page): dark hero gradient `linear-gradient(135deg, --hero-a, --hero-b 60%, --hero-c)`, `--sh-hero`, white value at 34px, label `rgba(255,255,255,.65)`, sub-line `rgba(255,255,255,.55)`, delta pills on translucent white (`--up`/`--down` mixed 55% toward white for AA). Same 96px height as the others — the hierarchy comes from color and position, **not** from a 751px slab.
- **[converged] Band grid:** 6-tile pages use `grid-template-columns: max-content repeat(5, minmax(0,1fr)); gap: 12px` — the primary track sizes to its pill row so it can never clip; 5-tile pages use `repeat(5, minmax(0,1fr))`. Six-across requires ≥1420px (below that, label+pill genuinely don't fit); see §6 for the breakpoint ladder.
- A tile whose metric also drives a chart is clickable → scrolls to / highlights that chart card (anchor scroll, 200ms). Cursor pointer + `--focus` ring on focus.

### 3.2 Component: chart card

- Header row, 44px: title + subtitle left; controls (segmented toggles, legends) right, vertically centered, **wrapping below the title when tight** (never force card overflow). Segmented control = existing `seg` style: 28px tall, radius 8px, active segment `--surface` on `--surface-sunken` track.
- Card padding 20px (top/bottom 16px); border 1px `--hair`; shadow `--sh-card`.
- **[converged] ONE AXIS, ALWAYS (dataviz #1 anti-pattern).** No chart plots two units on one scale, openly or covertly — a series scaled onto another unit's axis is a hidden dual axis and is banned. Mixed-unit metric picks (jobs "pick up to four") split into **stacked single-axis panels**: the $ panel on top (x-labels suppressed), each % panel below on its own labeled axis (jobs renders Net margin % on a 30–70% strip in `--series-2`). The quotes Volume chip likewise renders a separate count panel, never bars behind the rate lines.
- **[converged] Charts render at the container's real pixel width** and re-render on resize (ResizeObserver) — never a fixed viewBox scaled down (round-1 P0: 4px glyphs on mobile). Plot height 300px desktop, 220px when the container is <720px wide. Axis/annotation text stays ~11px actual pixels at every width. The mockups' `assets/charts.js` is the reference implementation, including:
  - x-axis label collision-skipping (always keep first + last; drop interior labels that would overlap);
  - annotations clamped inside the plot for every anchor, and auto-nudged clear of reference-line label bands (no two text spans may ever overprint — verified 390→1440);
  - reference lines (prior-year / peak context) are **dotted 1px `1 3`** so they never read as a data series; their labels truncate at the em dash on narrow widths and sit on a `--surface` chip drawn above the series strokes;
  - a secondary series sharing a chart with a refline is distinguished by color/weight, not dash (jobs); a dashed data series is allowed only where no refline ambiguity exists (quotes By-value, `5 4`).
- In-chart annotations (peak markers, "Jul · 28.6% / 6.9%" current-month flag) use 11.5px/600 `--ink-2` with a **9px series-colored marker on a 2px surface ring** (dataviz mark spec — never sub-8px dots).
- **[converged] Mark specs (binding, from the dataviz method):** lines 2px solid round-join (data series are never dashed; dotted `1 3` is reserved for reference lines); stacked/adjacent fills separated by **2px surface gaps**, never borders (applies to the cost bar, pipeline bar, leaderboard base/boost, capacity job/unbilled); bars thin with 4px rounded data-ends; gridlines solid hairline `--chart-grid`.
- **[converged] Figures:** KPI/stat-tile values use **proportional figures** — `font-variant-numeric: tabular-nums` is reserved for columns that align vertically (tables, axis ticks). Text wears text tokens, never the series color; in-fill segment labels pick white/ink by fill luminance and render only when they fit (`font-style: normal` on any semantic `<i>` wrapper — UA italic leaks otherwise).
- **[converged] Histogram/column bars sit on an absolute-positioned track** (`position:relative` track, bar `position:absolute; bottom:0; height:X%`) so percentage heights can never be flex-clamped — a flexbox-clamped bar rendered three different values at identical heights in review. Heatmap fills use the **validated ordinal ramp**: `color-mix(in srgb, var(--acc), #fff 46%)` → `mix 23%` → `var(--acc)` → `mix(#000 22%)` (ink text on the two light bands, white on the two dark; dark bands hatch with `#00000024` stripes, light with `#ffffff1f`), plus the semantic `<15%` band `color-mix(in srgb, var(--down), #fff 30%)` with ink text.

### 3.3 Component: bar-list row (used for deal size, sites, work source, tech economics)

```
Label (13px/600)                          value right (15px/700 tnum)
[███████████░░░░░░░░░░░░░░░░]             meta right (12px --faint)
meta line (12px --faint)
```
- Bar: height 8px, radius 4px, track `--n100`, fill `--acc` (or semantic color when the row is a bad/good signal, e.g. 0.0% acceptance → `--down`). Bars in one list share a scale (largest = 100%); state the scale in the card subtitle.
- Row padding 10px 0, hairline `--hair-2` between rows.
- **The bar is mandatory** — this component exists to make lists visual. No text-only stat lists anywhere in the app.
- **[converged] Aggregate/summary rows get NO bar.** A long-tail row ("Remaining 83 sites") whose value exceeds the per-item scale renders as a summary row — 2px `--border-strong` top border, no track — never a bar silently capped at 100% (two scales in one list misleads).
- **[converged]** Interim/representative rows keep their hatch on **every** row the caveat covers (e.g. all completed-job-economics bars are hatched, since the whole allocation is interim).

### 3.4 Component: inline stat strip (replaces rows of big tiles for secondary numbers)

A single 40px row inside a card: `LABEL value · LABEL value · LABEL value`, label 11px uppercase `--muted`, value 14px/650 tnum `--ink`, separated by 20px + hairline dot. Used for things like aging buckets, coverage counts.

---

## 4. Page-by-page specification

Every page follows the same skeleton (P5). Sections are listed top-to-bottom; widths are 12-grid column spans.

---

### 4.1 /quotes — Quote Metrics

**Current content inventory → new home (nothing may be dropped):**

| Today | New home |
|---|---|
| Hero 28.6% + "6 of 21 accepted" + 2 delta pills | KPI 1 (primary) |
| Hero WON $10,045 · 6.9% of quoted value | KPI 3 (value + rate as sub-line) |
| Hero OPEN $135,181 · 15 in play | KPI 6 |
| Hero tiles: sent 21, value $145,225, won value, avg deal $1,674 (+deltas) | KPI 2, 4, 5 (won value merges into KPI 3) |
| Hero slider-sparkline (Jul vs high Dec '25 50.0% vs Jul '25 30.2%) | annotations on the Acceptance Trend chart |
| "Tile deltas compare to Jul '25 · day 18" footnote | shared tooltip on every delta pill + one footnote under the KPI band |
| Status Mix stacked bar ($10,045 vs $135,181) | Pipeline card (row 3) |
| ACCEPTED 6 / OPEN 15 / VALUE RATE 6.9% / COUNT RATE 28.6% tiles | **deleted** — all four already live in KPI 1/3/6 |
| Aging tiles 0-30d 15 / 31-45d 0 / 46d+ 0 + footnote | one sentence + micro-bar in the Pipeline card |
| Deal Size Mix list (4 tiers) **and** "Acceptance by Deal Size" card | merged into ONE Deal Size card (row 3) |
| $10K+ insight callout | kept, inside Deal Size card |
| Acceptance Trend chart + toggles | Primary chart (row 2, above the fold) |
| Deal-size × month heatmap + legend + footnotes | row 4, unchanged content |
| Overview/History tabs, Monthly Breakdown table, CSV | History becomes row 5 card (tabs removed, see below) |

**New layout:**

**Row 1 — KPI band [owner-corrected]:** primary card + 2×2 tiles (§3.1):
- **Primary: ACCEPTED · MONTH TO DATE `$10,045`** (owner: dollar value of quotes accepted MTD is the lead stat, NOT acceptance rate), pill `↓ 93.3% vs Jul ’25`, sub `6 of 21 quotes accepted · 6.9% of value sent`, comparison bars Jul ’25 d18 $149.9K · Jun ’26 full $200.2K · Jul ’26 d18 $10.0K.
- Tiles: **ACCEPTANCE RATE** `28.6%` (both labeled pills) · **QUOTES SENT** `21` · **VALUE OF QUOTES SENT** `$145,225` (owner: "quote value" was ambiguous — the label must say what it is) · **AVG ACCEPTED DEAL** `$1,674`.
- **REMOVED BY OWNER RULING:** the "Open pipeline / quotes still in play" stat, the Pipeline card (accepted-vs-open bar), and the aging strip — "invented … based on your own invented definition of what's open." These exist in the live app; they are to be **deleted**, not redesigned.

**Row 2 — Acceptance Trend** (spans 12, card height 380px): the existing chart, promoted. Keep By count / By value / Volume toggles (segmented, in card header). Add two permanent annotations replacing the hero slider: dot+label at the count-rate peak (`Dec '25 · 50.0%`) and at the same-month-last-year point (`Jul '25 · 30.2%`); current month flagged `Jul · 28.6% / 6.9%` as today. Subtitle: `Aug 2025 – Jul 2026 · hover or tap for monthly detail`.

**Row 3 — [owner-corrected] Acceptance by Deal Size, full width:** one span-12 card; the four tiers render as a **4-up grid** (tier + acceptance % / shared-scale quoted-$ bar / meta line), with the `◆ $10K+ carries the value` callout inside the card below the grid. The former Pipeline rail is deleted (see the ruling above).

**Row 4 — Acceptance by Deal Size and Month** (spans 12): the existing heatmap card unchanged (legend `<15% … 45+`, hatched=representative, both footnotes). Only restyle: cell height 36px, month header row sticky within card on horizontal overflow (<1280px it scrolls inside the card, never the page).

**Row 5 — Monthly Breakdown** (spans 12): the History tab's table becomes an always-present card at the bottom; **remove the Overview/History tab bar entirely** (one less navigation layer; the page is now one scroll). Keep Download CSV button in the card header, all 8 columns, trailing-12 total row, and the source footnote. Default state: visible (no accordion).

**Kill list (content that disappears because it is pure duplication):** the four-tile row ACCEPTED/OPEN/VALUE RATE/COUNT RATE; the three big aging tiles; the standalone Deal Size Mix list; the hero slider-sparkline; the Overview/History tabs.

**Fold math at 1440×900:** nav 56 + header 64+16 + KPI 96+~20 (footnote) + gap 16 + chart card 380 = **648px** → the full trend chart is comfortably above the fold. ✔ P2

---

### 4.2 /jobs — Job Metrics

**Content inventory → new home:**

| Today | New home |
|---|---|
| Hero NET PROFIT $165,448 · 53.6% margin · pills ↓10.2% vs Jul '25, ↓21.7% vs June · "3.6 pts above the 50% target (example)" | KPI 1 (primary; target line as sub) |
| Hero tiles REVENUE $308,386 ↑16.0% / GROSS $216,186 ↑2.1% · 70.1% margin / COMPLETED 132 ↓15.4% / AVG $2,336 ↑37.1% | KPI 2–5 |
| Hero slider (July $165K vs Jul '25 $316K vs high Dec '25 $725K) | annotations on Monthly Trend chart |
| "Green deltas vs Jul '25 · vs-June in each tile's tooltip" | KPI band footnote |
| Revenue-to-Net bar + MATERIALS/LABOR/GROSS/OVERHEAD tiles | Cost structure card (row 3) as ONE segmented bar |
| Work Source Mix (bar + 3 rows) | row 3, bar-list card |
| Estimated vs Actual Labor (toggles, variance strip, largest overruns) | row 4 left, kept |
| Profitability by Site (By site/By category, top 8 + long tail) | row 4 right, kept |
| Monthly Trend chart (metric chips, net '25 vs '26) | **Primary chart, row 2** (was at y≈2000) |
| Net-Negative Jobs card (−$1,510, 6 of 132, 4.5%, job list) | row 5, kept, compacted |
| Completed Jobs table (filters, CSV, pagination) | row 6, kept |

**New layout:**

**Row 1 — KPI band** (6 tiles):
1. **NET PROFIT** (primary): `$165,448`, sub `53.6% net margin · 3.6 pts above 50% target`, pills `↓10.2% vs Jul '25` `↓21.7% vs June`.
2. **REVENUE**: `$308,386`, pill `↑16.0%`.
3. **GROSS PROFIT**: `$216,186`, pill `↑2.1%`, sub `70.1% gross margin`.
4. **COMPLETED JOBS**: `132`, pill `↓15.4%`.
5. **AVG JOB VALUE**: `$2,336`, pill `↑37.1%`.
6. **NET-NEGATIVE JOBS**: `6`, value colored `--state-failed-fg`, sub `−$1,510 total`, clickable → scrolls to the Net-Negative card, whose headline restates −$1,510 as its `data-viz` summary; the 4.5%-of-completed share lives only in that card's strip. *(surfaces the page's only alarm to the top)*
- Band footnote: `Deltas compare to Jul '25 · day 18 · vs-June in each tile's tooltip.` Keep the margin-target note's "(example)" qualifier until the target is real.

**Row 2 — Monthly Trend** (spans 12, height 380px): existing chart promoted from the bottom. Keep all eight metric chips (Revenue, Gross profit, Net profit, Avg job value, Gross margin %, Net margin %, Completed jobs, Net '25 vs '26) and the pick-up-to-four rule, dashed=representative legend and footnote. Add annotations from the killed hero slider: `Jul '25 · $316K` reference dot and `High · Dec '25 $725K` peak label; current `Jul · $165K net` flag stays.

**Rows 3–4 — [converged] re-paired by MEASURED natural content heights** (596 vs 608px and 705 vs 809px — pairing by real height is the mechanism that killed the empty-space complaint; re-measure if content changes):
- **Row 3 left (span 6, `.colstack`): Where July Revenue Went** — ONE segmented bar, 24px tall, 2px surface gaps: Materials `$56,977` (`--n300`) / Labor `$35,223` (`--n400`) / Overhead `$50,738` (`--n600`) / Net profit `$165,448` (`--acc`); only the Net segment labels inline (`Net profit $165.4K · 53.6%`), the legend in the card header carries the greys; footnote `Gross profit = revenue − materials − labor.` — **stacked above Work Source Mix** (three bar-list rows, bar = revenue share, right value = job count, classification footnote).
- **Row 3 right (span 6, `.colstack`): Estimated vs Actual Labor** (toggle, est/actual bars, `+5.7% OVER ESTIMATE`, coverage line, per-job variance strip) **stacked above Largest Overruns** (own card: title + `top 3 by hours over estimate · bars scaled to the largest (+5.5h)` + three `--down` bar-list rows).
- **Row 4: Net-Negative Jobs** (span 6 — headline `−$1,510` as the card's `data-viz` summary, strip, 6-row table with nowrap signed money, non-inference disclaimer) beside **Profitability by Site** (span 6 — toggle, top-8 bar-list, `Remaining 83 sites` as a bar-less `.brow.total` summary row, tail footnote).


**Row 5 — Completed Jobs** (spans 12): unchanged (Download CSV, category/source/technician filters, columns Job/Source/Sell/Gross/Net/Net margin, pagination, source footnote). Restyle only to the shared table spec (§3, 48px rows).

---

### 4.3 /technicians — Technician Performance

This page is structurally the healthiest; the fix is the standard KPI band + consistency polish.

**Content inventory → new home:**

| Today | New home |
|---|---|
| Hero 62% utilization + 694h/1,111.3h + 55% capacity pill + roster/capacity math + no-prior-period note + 4-segment meter | KPI 1 (primary) + meter moves into Recorded Time card header area? **No** — meter is deleted; its four figures already appear as: 694h (KPI 1 sub), 417.3h (KPI 3), capacity 2,024h (KPI 2 sub), target 65% (KPI 1 tooltip) |
| UNBILLED HOURS 417.3h · 37.5% of recorded | KPI 3 |
| CAPACITY USED 55% · none above 115% | KPI 2 |
| QUOTE LABOR EFFICIENCY 0.91× · 27 of 28 | KPI 4 |
| ON-TIME ARRIVAL 88% · 167 of 189 | KPI 5 |
| Stephen Furtado inactive-alert banner | kept, as a 44px inline banner directly under the KPI band |
| Recorded Time vs Capacity (per-tech bars) | row 2 primary viz, kept |
| Labor Efficiency card / Punctuality card | row 3, kept |
| Technician Scorecard table | row 4, kept |
| Completed-Job Economics | row 5, kept |

**New layout:**

**Row 1 — KPI band [owner-corrected]:** primary card + tiles:
- **Primary: PRODUCTIVE UTILIZATION `62%`**, sub `694h on jobs of 1,111.3h recorded`, comparison bars: Jul ’25 and Jun ’26 render `pending` ghosts (timesheet history unverified — never invent), Jul ’26 d18 62%.
- Tiles: **UNBILLED HOURS** `417.3h` (spans 2; sub carries the REAL team split — `Travel 240.5h · Holiday 72h · Office 29.8h · Lunch 24.5h · Training 13.8h · 6 more types`) · **QUOTE LABOR EFFICIENCY** `0.91×` · **ON-TIME ARRIVAL** `88%`.
- **REMOVED BY OWNER RULING:** the CAPACITY USED tile, the 184h/2,024h capacity model, and the capacity tick line in the chart ("super unrealistic and invented") — also gone from the scorecard (no Capacity-use column) and the chart legend/subtitle.
- **[owner requirement — implemented with LIVE data] Unbilled hours are never lumped.** Data source (verified live 2026-07-19): Simpro `GET /schedules/?Type=activity&Date=between(…)` — each row's `Reference` is the activity-type ID, names from `GET /setup/activities/`. July 1–18 team split: Travel 240.5h (57.6%) · Holiday 72.0 · Office 29.8 · Lunch 24.5 · Training 13.8 · Sick 10.2 · Pickup Parts 9.8 · Delivery 7.0 · Hold 5.8 · Vehicle Maint 3.2 · Marketing 0.8 (total 417.2h; reconciles with recorded−job to ±0.1h). Rendered three ways: the Recorded-Time chart splits each bar into job-assigned / **Travel** (`--series-2`) / other unbilled (grey); the UNBILLED tile sub lists the team split; clicking a technician row opens their full per-activity breakdown (real numbers embedded per row).
- **REMOVED BY OWNER RULING:** the low-hours alert banner ("I dont need stupid ass alerts") — the fact lives in the capacity rows and scorecard, unannotated.

**Row 2 — Recorded Time vs Capacity** (spans 12): kept as the primary visualization (it already is a good one). Restyle: bar heights 20px, row spacing 12px, right labels `79% · 63% jobs` 12.5px tnum; keep capacity tick, job-assigned/unbilled legend, amber >115% rule, hover detail, `inactive · 7.5h` rows at the bottom in `--faint`.

**Row 3 — two cards:** **Labor Efficiency** (spans 6) and **Punctuality** (spans 6) — content as before (toggle, 1.00× line + legend; histogram + coverage + 67% line), plus **[owner requirement] punctuality drills down**: clicking the card opens the per-technician panel (ranked on-time %, lowest first, from real scorecard data; implementation lists each technician's late visits — job, date, minutes late — from verified mobile events).

**Row 4 — Technician Scorecard** (spans 12): kept — columns Technician/Job hrs/Unbilled/Utilization/Capacity use/Quote eff./On-time, sortable, per-row utilization micro-bar, team total row, click → drilldown, roster footnote.

**Row 5 — Completed-Job Economics** (spans 12): kept — ranked hatched bars, `$32K net · 20% of team net` right labels, interim-allocation + Roberto Villalta footnote, Net profit/Revenue legend.

---

### 4.4 /commissions — Technician Commissions

**Content inventory → new home:**

| Today | New home |
|---|---|
| Hero $1,230.74 · 0.50% of $246,147 · 6 earning · rank boosts line · progress bar with top-3 legend | KPI 1 (primary) + top-3 moves to the worksheet leaderboard (it IS the top of that list — pure duplication) |
| REVENUE $246,147 · 86 jobs | KPI 2 |
| POOL PERCENT 0.50% | merged into KPI 1 sub (it's the same fact as "0.50% of…"); the *control* stays in the Worksheet toolbar |
| TECHNICIANS EARNING 6 of 9 | KPI 3 |
| TOP CALCULATED PAYOUT $309.98 Jeffrey Perry · Gold | KPI 4 |
| (new, from Summary tab) YTD $12,495.73 | KPI 5 — gives the band a stable 5th slot and saves a tab-switch for the most-asked number |
| Worksheet tab: pool selector, efficiency toggle+slider, Commission by Technician leaderboard (rank, checkbox, jobs·$allocated, stacked base+boost bar, tier chip, payout, expand → per-job table + "How this was calculated") | row 2+, unchanged behavior |
| Summary tab: Monthly/Quarterly/Annual toggle, CSV, YTD/avg/peak/earning tiles, bar chart, per-month table with Draft/Current/N-A status, draft-runs footnote | kept as Summary tab |
| "Calculated amounts only" page subtitle + source footnote | kept verbatim (compliance-sensitive) |

**New layout:**

**Row 1 — KPI band** (5 tiles):
1. **CALCULATED COMMISSION DUE** (primary): `$1,230.74` (cents at 60% size, top-aligned, as today), sub `0.50% of $246,147 completed work value`, second sub-line `6 technicians earning · Gold ×1.30 · Silver ×1.20 · Bronze ×1.10`.
2. **COMPLETED REVENUE**: `$246,147`, sub `86 completed jobs`.
3. **TECHNICIANS EARNING**: `12`, sub `of 15 technicians` (count with a non-zero payout, of the full roster — see the defect note below; the live app's "6 of 9 eligible" framing is the bug, not the spec).
4. **TOP CALCULATED PAYOUT**: `$309.98`, sub `Jeffrey Perry · Gold`.
5. **YEAR TO DATE**: `$12,495.73`, sub `2026 · pools Jan–Jul`. (Avg/peak stay in the Summary tab only — no duplication in any tab state.)
- Keep the page subtitle **"Calculated amounts only — nothing on this page confirms that a payment was made."** directly under the H1 at full width — do not demote it into a tooltip.

**Row 2 — Worksheet / Summary tabs** (kept — unlike /quotes, these are two genuinely different working modes). Worksheet toolbar (pool % select, efficiency toggle, max-adjustment slider) stays pinned above the leaderboard.

**[converged — OWNER-REPORTED DEFECT, raised repeatedly] "Eligibility" is not a thing. The worksheet is simply the roster.** There is no eligibility list, no "eligible" count, no "not on list" state anywhere in the product — the owner has ruled the concept does not exist. The live app lists only 9 names while 6 technicians with recorded July work are silently dropped (Jim Ochoa — the month's top net earner, $32K/22 jobs — Ismael Contreras, Tadeo Jimenez, Stephen Furtado, David Jarquin, Piel Sarmiento); that filtering is the bug to delete, not a state to represent. The fix is display + computation, NOT new UI:
1. The worksheet lists the **full roster** — everyone with recorded work in the period, plus remaining roster members as `$0.00 · no July work` rows — as ordinary ranked rows in ONE list.
2. Allocations are computed over **all contributing hours** (a worker's hours can never be missing from a job's denominator).
3. The operator's per-row include **checkboxes are the only exclusion mechanism** (default all-on). No system-side "eligibility list", no warning banners, no quarantine sections, no reconciliation states — the UI never gates or annotates operator decisions (standing owner rule).
4. TECHNICIANS EARNING tile = count with a non-zero payout, sub `of N technicians`.
The mockup shows the corrected list (15 rows). The six restored rows carry hours-based **estimated** allocations marked `(est.)` — the app must compute them exactly; all payouts rescale so the pool total is preserved to the cent.

**Worksheet leaderboard restyle:** row height 64px → 56px; rank number 13px `--faint`; name 14px/600; sub `15 jobs · $45K allocated` 12px; stacked bar base `--acc-2` + boost `--acc` (keep legend Base share / Rank boost); tier chip unchanged (Gold amber, Silver grey, Bronze bronze tints, Standard `--surface-sunken`); payout right 15px/700 tnum; `$0.00 · no July work` rows collapse to 40px with everything `--faint`. Expanded row: keep the per-job allocation table and the **"How this was calculated"** walkthrough box verbatim (it's excellent), styled as the `--acc-weak` callout.

**Summary tab:** keep all content; the YEAR TO DATE tile is removed (it now lives in the KPI band) and the remaining three (AVERAGE MONTH / PEAK MONTH / EARNING TECHNICIANS · YTD) become an inline stat strip (§3.4) in the card header, bar chart to §3.2 spec (current month bar `--acc`, drafts `--series-weak`), table to §3 table spec with existing Draft (amber pill) / Current (green pill) / `No runs yet` states and the draft-runs footnote.

---

### 4.5 /materials — Material Sales **[NEW PAGE — owner-requested 2026-07-19; mockup `materials.html` is normative]**

**Data availability (verified live):** the Supabase analytical copy is ~4 months stale for materials (billable/allocation tables last synced 2026-03-11) — **this page must be fed from the live Simpro API**: for each job completed in the month, walk `sections → costCenters →` `/catalogs/?display=all` + `/oneOffs/` (Type=Material) + `/prebuilds/`; jobs filtered by `CompletedDate=between(…)` (that exact field name). Line fields: `Total.Qty`, `Total.Amount.ExTax` (extended sell), `BasePrice` (unit cost, catalog lines only). Category = the catalog item's `Group.ParentGroup.Name` (real hierarchy exists live; the synced copy's group data is unusable at 0.9% coverage). **Exclusions and category rules (owner rulings):** exclude Service Fee lines AND every line in the `Service Contract` catalog group (service billing, not materials); merge the `Raypak Cheat Sheet` group into **Raypak Parts** (one category); label one-off lines **"Special order / non-stock"** (never "uncatalogued" database-speak). July reference data ex-service-contracts (pulled 2026-07-19): $145,444 sold; June $253,182; Jul ’25 d18 $115,526 (+25.9% day-aligned); full-month pace ≈$237K.

Layout **[owner-ruled: NO KPI tiles on this page — the page is exactly what was asked for]**:
- **Band:** the lead stat card (MATERIALS SOLD · MTD `$145,444`, labeled pill `↑ 25.9% vs Jul ’25`, sub = full-month pace projection, ONE bullet bar with Jun/Jul ’25 ticks) sits BESIDE the **Materials Value by Category** card (one segmented bar, values in the legend, movers-vs-June callout). No tile grid. Four candidate tiles (material margin, jobs-billing-no-materials, share of revenue, avg per job) were offered and REJECTED — do not add tiles here without the owner asking.
- **Table:** All Materials Sold, ordered by total sold value — Item/part, Category, Qty, Jun qty, Δ (red declines, `new` for new items), Unit sell, Extended, Jobs — CSV, pagination, row drill.
- **[owner-ruled] NO narrative text on this page.** No insight callouts ("Special orders drove July…"), no methodology footnotes, no source lines — the data carries the page. All exclusion/provenance rules (live-pull recipe, service-contract exclusion, day-alignment, unit caveats) live in THIS SPEC and in tooltips if needed, never as on-page prose. The movers-vs-June information exists only as the table's Δ column. The only allowed micro-copy: the Δ column key in the table subtitle.
- Footnotes state: live-pull provenance, extended sell ex-tax, service fees excluded, quantities are Simpro billable quantities (units vary by item).

## 5. Interaction & states (all pages)

- **[owner-directed] Every delta pill is labeled with its comparison** (`vs Jul ’25`, `vs Jun`) — bare percentages are banned everywhere.

- **[converged] Drill-through is now DEMONSTRATED in the mockups, not just promised** (the static first cut made it look deleted — it is required):
  - **Charts carry a hover layer by default** (dataviz interaction spec): vertical crosshair + a surface-ringed marker per series + a tooltip card (`--surface`, `--sh-pop`, month title + one row per series + context row). Values are never tooltip-only — each chart's numbers also live in an adjacent table/labels. Reference implementation: `attachHover()` in `assets/charts.js`; tooltip data is the real monthly table.
  - **Every clickable row opens a right slide-over drill panel** — same surface language as the existing Data-health drawer (400px, scrim, ✕ + Escape to close, focus moves in). Applies to: completed-jobs rows, net-negative rows, technician scorecard rows, capacity rows, site rows, deal-size tiers, work-source rows. In the mockup the panel shows the row's own facts; in the implementation it loads the full record (job detail, technician drilldown, site's jobs) into this panel.
  - **The commissions leaderboard expands INLINE** (as live): clicking a row toggles its per-job allocation table (Job / Job value / Share / Allocated + "All 18 July allocations…" + the "How this was calculated" walkthrough callout) under the row; caret rotates. Row 1's expansion in the mockup carries the real captured table.
  - Heatmap cells expose tier · month · value · verified/representative on hover (title/tooltip).
  - Keyboard: rows are focusable (`tabindex`), Enter activates, Escape closes the panel — implementation must keep full keyboard parity including the chart hover layer (arrow keys step months).

- **Delta pills** always encode direction+goodness by color (`--up` green = good). Where down is good (none currently), the mapping is semantic, not directional. Tooltip on every pill: `vs Jul '25, aligned to day 18` / `vs June, full month`.
- **Tile → chart linking** (§3.1): KPI tiles 1 on /quotes and /jobs scroll to the primary chart; /jobs KPI 6 scrolls to Net-Negative card.
- **Hover states:** cards do not lift on hover (they are not buttons); interactive rows tint `--surface-soft`. Buttons/toggles keep existing behavior.
- **Loading:** every card renders its skeleton at final height (no layout shift). KPI band skeleton = 6 grey 96px tiles.
- **Error:** per-card error block with `Retry` (existing pattern), never blank.
- **Month stepper** reloads all cards in place; keep per-card `Updated…` freshness out — the single top-right pill remains the only freshness indicator.
- **Focus:** all interactive elements get the existing `focus-ring` (`--focus` 2px).
- **Reduced motion:** anchor scrolls and bar animations respect `prefers-reduced-motion`.

## 6. Responsive rules **[converged — measured, not guessed]**

- **≥1420px:** full layout — 6-across KPI band (`max-content repeat(5, minmax(0,1fr))`), cards per §4 spans.
- **1024–1419px:** KPI band switches to 3-col (primary spans the full first row; last tile spans 2 so no orphan cell). Card spans (`.span4…span8`) stay 2-up until 1280; below 1280 they stack full-width. Heatmap/wide tables scroll inside their card only.
- **768–1023px:** band 2-col (primary spans 2; on 6-tile pages the last tile also spans 2); all cards full-width.
- **<768px:** band single column; non-primary tiles become 72px label-left/value-right rows (sub hidden); primary keeps the stacked layout and its sub may wrap. Charts render 220px tall at true pixel size. Histograms tighten (gap 12px, col min 58px) so no numeral is ever cut mid-glyph; a 7-column histogram scrolls in-card with a right edge-fade mask. Commissions leaderboard rows regrid to `20px 18px minmax(0,1fr) auto auto` with the allocated-$ sub segment hidden and names ellipsized — payouts must right-align inside the card at 390px.
- `.grid12 { align-items: start }` at every width — cards hug their content; never stretch a short card to match its row partner (that's the old dead-white-space disease).

## 7. Acceptance checklist (implementation is done when every line passes)

1. On each page, **no metric value is rendered in more than one place** (chart plots excepted). Specifically on /quotes: 28.6%, 6.9%, $10,045, $145,225, 21 each appear exactly once outside the chart.
2. At 1440×900, the primary chart (Acceptance Trend on /quotes, Monthly Trend on /jobs, Recorded Time vs Capacity on /technicians, the Worksheet leaderboard's first 3 rows on /commissions) is fully visible without scrolling.
3. No dark surface taller than the 204px primary card exists on any page (the 751px slab is gone).
4. Every list of entities (deal tiers, sites, sources, technicians) renders with proportional bars (§3.3) — zero text-only stat lists.
5. Every figure present in the "content inventory" tables of §4 is findable on the redesigned page (screenshot-diff against the tables; nothing silently dropped — including every footnote, disclaimer, "(example)" qualifier, and source line).
6. All CSV downloads, filters, drilldowns, tooltips, tab behaviors (commissions), toggles, pagination, and the Data-health drawer work unchanged.
7. All colors, radii, shadows, and fonts resolve to existing `:root` tokens; no new hex values in component styles (chart hatching patterns excepted).
8. Skeleton, empty, and error+retry states exist for every card at final card height.
9. Lighthouse a11y ≥ 95 per page; all text ≥ 4.5:1 contrast computed, not eyeballed (note from convergence: `--faint` fails AA on `--canvas-b` — canvas-level footnotes use `--muted`; warm tier/draft chips need their fg darkened ~15% via color-mix; heatmap cell text is `--ink` on bands b0–b3 and white only on the darkest band). Tab order follows visual order; charts have text alternatives; mock `role=checkbox/switch` spans and sortable `<th>`s from the mockups must be real `<input>`/`<button>` elements in implementation.
10. The page-bottom source lines and the "Calculated amounts only" subtitle on /commissions are verbatim-unchanged.
11. **[converged]** `review-workspace/gate.mjs` (pointed at the implementation) ends `GATE PASS`: no page-level or card-level horizontal overflow at 1440/1280/1024/768/390; primary viz fully above the 900px fold; no dark surface >100px; gated key figures exactly once per page outside `svg`/`table`/`[data-viz]`; full-text AA sweep clean. Exemption definition: chart data labels, data tables, calculation-walkthrough callouts, and a card's own headline stat may restate a figure only when marked `data-viz`.
12. **[converged]** Zero overlapping text spans in any chart at any width 390–1440 (pairwise bounding-box check, as in the review probes).
13. **[converged]** Derived numbers cross-foot exactly: scorecard team row = column sums; commission payouts sum to the pool to the cent; bar widths match their values ±0.5%. The mockups were audited to this bar; the implementation must not regress it.
14. **[converged]** No chart plots two units on one scale (hidden dual axes included); mixed-unit picks render as stacked single-axis panels. Every categorical pairing and value ramp passes the dataviz `validate_palette.js` before shipping.
15. **[converged]** Every bar/segment's RENDERED pixel size is ratio-checked against its data value (getBoundingClientRect, not style attributes) — flexbox clamping produced three different values at identical heights once; the histogram-track pattern in §3.2 prevents it structurally.
16. **[converged — owner-reported]** Full-roster worksheet: every person with recorded work in the period appears on the commissions worksheet as an ordinary row with a computed allocation; the name set on /technicians is a subset of the name set on /commissions (automated diff — any absence fails the build). No eligibility pre-filter or exclusion UI exists; the include checkboxes are the only exclusion control.

## 8. Suggested build order

1. Tokens/util layer: KPI tile (+primary variant), bar-list row, inline stat strip, chart-card shell, table restyle — as shared components.
2. /quotes (the reference implementation of the skeleton).
3. /jobs (largest content move — trend chart promotion + cost bar).
4. /technicians (smallest delta).
5. /commissions (worksheet restyle last; it has the most interactive state).
6. Run the §7 checklist per page before calling it done.
