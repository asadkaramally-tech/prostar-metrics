# Pro Star Metrics — Design Implementation Brief for Codex

Goal: implement the reverse-engineered "Linear/Ramp" visual language (see `redesign-handoff/premium-mockups/jobs_ref.html`, the canonical reference) across all four routes, in the existing Next.js/React/Tailwind/Recharts codebase. **Frontend/presentation only — no backend, data, metric, or behavior changes.**

The mockup HTML files are the pixel-accurate source of truth: `jobs_ref.html` (canonical language) plus `quotes_premium.html`, `tech_premium.html`, `comm_premium.html` (per-route layout intent). Lift exact hex/gradient/shadow/SVG values from them.

---

## 0. The one governing principle (do not violate)

**One accent, used only for meaning — never decoratively.** Everything else is neutral. Per route, exactly one metric is "the star" and carries the accent color; all supporting series/elements are grayscale. Green and red appear ONLY as semantic up/down or positive/negative. This restraint is what makes it read as premium rather than "colorful SaaS." If in doubt, remove color.

---

## 1. Design tokens (put in `src/app/globals.css`)

```
/* Accent — the single expressive color */
--acc:#5b63d3;            /* indigo — active nav, focus, hero, the star metric */
--acc-2:#8087ec;          /* lighter accent for on-dark strokes/glow */
--acc-weak:#eef0fb;       /* accent tint for subtle fills */

/* Ink / neutral text ramp */
--ink:#101422; --ink-2:#2a3140; --muted:#5c6474; --subtle:#8b93a3; --faint:#aeb4c0;

/* Neutral chart series (supporting, never the star) */
--series-strong:#404a60;  /* e.g. revenue */
--series-weak:#9aa2b2;    /* e.g. gross profit */

/* Semantic — only for up/down, positive/negative, live states */
--up:#1a8a5a; --down:#d0463a; --warn:#b4791a;

/* Surfaces (light content area) */
--canvas-a:#f8f9fb; --canvas-b:#f2f4f7;   /* page gradient */
--surface:#ffffff;
--hair:#e9ebf0; --hair-2:#f1f2f6;         /* hairline borders / row dividers */

/* Dark chrome (rail + hero) */
--rail:#0a0b0f;
--hero-a:#171a26; --hero-b:#101320; --hero-c:#0c0e18;  /* hero gradient stops */

/* Radii */
--r-control:11px; --r-stat:16px; --r-card:18px; --r-hero:20px; --r-pill:999px;

/* Elevation (soft, multi-layer — never harsh) */
--sh-1:0 1px 2px rgba(16,24,40,.04);
--sh-card:0 1px 2px rgba(16,24,40,.04), 0 14px 30px -18px rgba(16,24,40,.18);
--sh-stat:0 1px 2px rgba(16,24,40,.04), 0 10px 24px -16px rgba(16,24,40,.14);
--sh-hero:0 24px 48px -16px rgba(12,14,24,.55), inset 0 1px 0 rgba(255,255,255,.06);
```

Page canvas: `radial-gradient(900px 460px at 82% -10%, #fff, transparent 55%), linear-gradient(180deg, var(--canvas-a), var(--canvas-b))`.

## 2. Typography

- **Font: Inter** (self-hosted — see §7). Fallback `system-ui, sans-serif`. Enable `font-feature-settings:"cv05" 1,"ss01" 1`.
- Numerals: `font-variant-numeric: tabular-nums; letter-spacing:-.012em` on all values/counts/currency/deltas (keep the `.tnum` class).
- Scale:
  - Hero number: 52–54px / 800 / letter-spacing **−0.045em** / white.
  - Stat value: 25px / 700 / −0.03em.
  - Page h1: 26px / 700 / −0.03em.
  - Card title: 15px / 700 / −0.02em.
  - Micro-label (uppercase eyebrows, column headers): 10.5px / 600–700 / letter-spacing .08–.13em / `--subtle`/`--faint`.
  - Body: 13px / 400–500. Subtext: 11.5px / `--muted`.

## 3. Layout shell

- **Grid:** `250px` dark rail + fluid content. Content `max-width:1180px`, padding `32px 42px 52px`.
- **Rail (`app-shell.tsx`, `sidebar-nav.tsx`):** bg `--rail`; a subtle radial indigo glow top-left (`radial-gradient(380px 200px at 30% 4%, rgba(91,99,211,.14), transparent)`); hairline right border `rgba(255,255,255,.055)`. Brand mark = rounded indigo-gradient tile. Nav items 13.5px/500 muted; **active** = `rgba(255,255,255,.045)` fill + inset hairline + a 2.5px indigo left rail bar with glow + accent-colored icon + `aria-current="page"`. Owner block pinned bottom with hairline top.
- **Page header (`dashboard-page.tsx`):** eyebrow (uppercase, `Operations · <Month>`), h1, one-line subtitle; right side = period control + freshness pill. Freshness pill = white, hairline, colored dot + label (green dot for current, amber for provisional, etc. — keep all 7 states via `StatusPill`).

## 4. The hero (new shared component, e.g. `src/components/ui/metric-hero.tsx`)

Left focal panel + 2×2 supporting stat grid (`1.2fr / 1fr`).

- **Focal:** radius 20px; bg `linear-gradient(160deg, var(--hero-a), var(--hero-b) 60%, var(--hero-c))`; `--sh-hero`; a radial indigo glow top-right (`radial-gradient(closest-side, rgba(91,99,211,.42), transparent)`). Contents: eyebrow with a glowing accent pip; the big number (white); a meta row (secondary metric + a semantic delta chip); a coverage/context line (`--subtle`); and a **full-bleed accent area sparkline** of the star metric's trend bleeding to the panel's bottom edge (gradient `--acc-2` → transparent, 2.2px accent stroke).
- **Stat cards:** white, radius 16, `--sh-stat`, hairline. Label (micro) → value (25px) → a row with a small semantic delta + context on the left and a neutral gradient sparkline on the right.

Per-route star metric (drives the hero + the single accent):
- **Jobs** → Simpro Job Net Profit. Supporting: Revenue, Gross Profit, Completed Jobs, Avg Job Value.
- **Quotes** → Count Acceptance % (hero shows the rate; accepted=green, not-accepted=neutral/red are semantic). Supporting: quotes, accepted value, avg accepted deal, unclassified.
- **Technicians** → Allocated Net Profit (team). Supporting: recorded-time utilization, job capacity use, quote labor efficiency, on-time — keep the three hour-families visually distinct and labeled.
- **Commissions** → Calculated Commission Due, with the revision/edit/run + "source complete" chips and the payroll "does not confirm payment" line inside the focal; plus the Rebuild→Review→Lock stepper and the four distinct value KPIs (work value, pool, active techs, completed jobs).

## 5. Panels, tables, pills

- **Card/panel (`ui/panel.tsx`):** white, radius 18, hairline, `--sh-card`, overflow-hidden. Header: title (15/700) + subtitle (11.5/muted), optional right action. Charts and edge-to-edge tables render flush.
- **Table (`ui/table-bits.tsx`):** header row on a faint gradient (`#fbfcfe→#f7f9fc`), micro uppercase column labels in `--faint`, hairline under head; rows `14px 20px`, `--hair-2` dividers, hover `#f9fafc`; numerics right-aligned tabular. Identity/name cell = name (600 ink) + sub (11.5 muted). **Source/category pills are neutral** (gray bg, muted text, small dot) — not colored. Negative money in `--down`. A "contribution/share" numeric column may show a slim inline bar (accent if positive, `--down` if negative). MoM/delta as a bare `↑/↓ x%` in `--up`/`--down` (no filled chip needed).
- **Pills/badges:** rounded-full, 11–12.5px/600–700. Keep `StatusPill` for the 7 data states (icon+label+tone, never color-alone). Tier medals on the commissions leaderboard (gold/silver/bronze) are a deliberate, meaningful exception to the one-accent rule.

## 6. Charts (Recharts — style to match; keep all existing chart types/data/testids)

Global chart rules:
- **Only the star series gets the accent** (`--acc`), slightly thicker (2.8px), with a gradient area fill beneath it (`--acc` 14%→0%) and a soft accent drop-shadow (`feDropShadow dy=2 stdDeviation=3.5 accent @ .28`). Supporting series are `--series-strong` and `--series-weak` (1.9px, no fill).
- Use **monotone** line type (smooth). Grid: horizontal only, `#eff1f5`, no vertical lines, no axis lines. Ticks: `--faint`, 10px, tabular; y-labels sit outside right. Direct end-of-line value label for the star series.
- **Tooltip:** white, 1px `--hair`, radius 10, soft shadow, 12px, tabular; label 600 ink.
- **Legend:** small line-swatches (14×3px rounded), 11.5px, `--ink-2`.
- **Bars/waterfall:** rounded 4px tops; revenue/base = `--ink`; deductions = neutral `#c3cad6`; result = `--acc`; dashed connectors between waterfall steps; baseline hairline. Value labels above bars in `--ink-2`.
- **Sparklines:** series-colored smooth line + matching 16%→0% gradient fill.
- **Donut (quotes):** accepted = `--up`, not-accepted = `--down` (semantic), butt caps, big center % + micro label.
- **Heatmap (quotes tiers / technician-month):** keep the data-encoded green→amber→red ramp (it's semantic, not decorative); align cell radius (5px) and spacing to the system.

Recharts specifics: define the gradients/filters in `<defs>` inside a shared `chart-bits.tsx`; pass colors from the tokens; set `isAnimationActive={false}` is NOT required (keep motion but respect reduced-motion). Keep every `data-testid` (`jobs-financial-value-trend`, `jobs-profit-waterfall`, etc.) and every series exactly.

## 7. Fonts — the one dependency decision

Inter is what gives the premium feel. Two options (pick one; no runtime network):
1. **Self-host (recommended, no npm dep):** add `inter-latin-{400,500,600,700,800}-normal.woff2` under `public/fonts/` and declare `@font-face` blocks in `globals.css` (`font-display:swap`). ~120 KB total.
2. `@fontsource/inter` as a dependency (needs your dependency-policy approval).
If neither is approved, the design still works on a tuned system stack (`ui-sans-serif, -apple-system, "Segoe UI", Roboto, Helvetica, Arial`) — ~90% of the effect. Flag this as the single approval needed.

## 8. Files to touch (all presentation-layer, all already in-scope)

`src/app/globals.css` (tokens, font-face, base type) · `src/components/app-shell.tsx` + `sidebar-nav.tsx` + `mobile-nav.tsx` (dark rail, active state) · `dashboard-page.tsx` (header) · new `src/components/ui/metric-hero.tsx` (hero) · `kpi-card.tsx`/`kpi-tile.tsx` (stat cards) · `ui/panel.tsx`, `ui/table-bits.tsx`, `ui/chart-bits.tsx`, `ui/status-pill.tsx`, `ui/empty-state.tsx`, `ui/page-states.tsx` · the four route dashboards (`quotes/quote-metrics-dashboard.tsx`, `jobs-dashboard.tsx`, `technicians-dashboard.tsx`, `commissions-dashboard.tsx`) · `data-health-drawer.tsx` (markup only). **Do NOT touch** anything under `infra/ workers/ scripts/ src/lib/ src/app/api/ src/proxy.ts`, migrations, or `package.json` (except the Inter decision in §7).

## 9. Preserve exactly (hard requirements)

Every metric name/meaning, chart, table, filter, drilldown, action, export, audit, and status stays present and functional. Keep all URL params, GET forms, POST endpoints/bodies, poll/reload behavior, RBAC gating, exported symbol names, chart `data-testid`s, and every truthful `N/A`/unavailable/coverage/provisional state (never render a truthful unavailable as a polished zero). Net profit stays distinct from gross and from commissions; utilization ≠ capacity utilization ≠ labor efficiency; "calculated commission due" is never labeled paid, and the payroll disclaimer stays verbatim. The existing component tests (`tests/components/*`, `tests/store/dashboard-mobile-controls.test.ts`) must still pass — they pin copy strings, exports, and containment classes; satisfy them in the components, don't weaken them.

## 10. Accessibility

WCAG 2.2 AA contrast for text, controls, focus, chart annotations, and semantic states (verify the indigo accent on white and on the dark hero). Keep visible focus rings (2px accent), `aria-current` on active nav, icon-button names/titles, chart adjacent text summaries, dialog/drawer focus management, and ~40px+ mobile touch targets. Never rely on color alone — always pair with icon/label.

## 11. Validate

`npm test` · `npm run test:integration` · `npm exec -- tsc --noEmit --pretty false` · `npm run lint -- --max-warnings=0` · `npm run build` · `npm run plan:check` · `npm run reference:check` · `npm run guard:no-mirror`. Then authenticated live-browser checks at 1440×1000, 1024×768, 768×1024, 390×844: charts render with data, no horizontal overflow, no overlap/clipping, keyboard nav + visible focus, data-health drawer, and all data-states.
```
```

---

## 12. PIXEL REDLINE — exact measured values

The canonical mockup is `mockups/jobs.CANONICAL.html`. It is self-contained (Inter embedded). **To match pixel-perfect: open it in Chrome, use DevTools → Inspect / Computed to read any exact value, and port `reference-styles.css` (the extracted stylesheet, every value exact) into `globals.css` + components.** The font assets in `fonts/` are the exact woff2 files — drop them into `public/fonts/`.

Measured spec (all values exact, in px unless noted):

**Shell / grid**
- App grid: `250px` rail + `1fr`. Content `max-width:1180`, padding `32 42 52`.
- Rail: bg `#0a0b0f`; right border `1px rgba(255,255,255,.055)`; radial glow `380×200 at 30% 4%, rgba(91,99,211,.14)→transparent 70%`.
- Brand mark: `34×34`, radius `10`, gradient `140deg #6a72e0→#4b52c0`, shadow `0 6px 18px rgba(75,82,192,.45), inset 0 1px 0 rgba(255,255,255,.3)`. Brand title 15/700/−.02em `#f4f5fa`; sub 11/500 `#6f7686`.
- Nav section label: 10/700/.16em uppercase `#565d6e`, margin `14 0 8`. Nav link: pad `9 13`, radius `9`, 13.5/500 `#9298a6`, icon 17. Active: bg `rgba(255,255,255,.045)`, inset `0 0 0 1px rgba(255,255,255,.06)`, text `#f4f5fa`/600, icon `#8087ec`, left bar `2.5×18` radius `0 3 3 0` `#5b63d3` glow `0 0 10px rgba(91,99,211,.9)` at `left:-14`.
- Owner: pad `16 24`, top border `1px rgba(255,255,255,.05)`; avatar `31×31` circle gradient `#5b63d3→#3c42a0`; name 12.5/600 `#e7e9f1`; role 10.5 `#6f7686`.

**Content header**
- Eyebrow 11/600/.1em uppercase `#8b93a3`, mb `9`. h1 26/700/−.03em `#101422`. Sub 13/`#5c6474`, mt `8`, max-width `600`, line-height 1.5. Header mb `26`.
- Control chip: h `40`, pad `0 14`, radius `11`, bg `#fff`, border `1px #e9ebf0`, 13/600 `#2a3140`, shadow `0 1px 2px rgba(16,24,40,.05)`, icon 15 `#8b93a3`. Freshness pill: same metrics, text `#177a4f`, border `#d6ebe0`, dot `7×7 #1a8a5a` + `0 0 0 3px rgba(26,138,90,.16)`.

**Hero** (grid `1.2fr / 1fr`, gap `18`, mb `18`)
- Focal: radius `20`, pad `26 28 0`, bg `linear-gradient(160deg,#171a26,#101320 60%,#0c0e18)`, shadow `0 24px 48px -16px rgba(12,14,24,.55), inset 0 1px 0 rgba(255,255,255,.06)`. Glow `::before` `300×250 at top:-70 right:-30, radial rgba(91,99,211,.42)→transparent`.
- Eyebrow 11/600/.13em uppercase `#8b90a6` + pip `6×6 #8087ec` glow `0 0 10px rgba(128,135,236,.9)`.
- Big number 54/800/−.045em `#fff`, mt `14`. Meta row mt `14`, gap `12`: margin text 14/600 `#c3c8db`; delta chip 12.5/700 pad `4 10` radius `999` bg `rgba(30,150,95,.18)` text `#5fd39b` border `1px rgba(40,170,110,.32)`. Coverage 12 `#868ca2` mt `16`. Hero sparkline: full-bleed `margin:8 -28 0`, height `86`, area gradient `#8087ec .36→0`, stroke `#8087ec` 2.2.
- Stat card: radius `16`, pad `16 18`, bg `#fff`, border `1px #e9ebf0`, shadow `0 1px 2px rgba(16,24,40,.04), 0 10px 24px -16px rgba(16,24,40,.14)`. Label 10.5/600/.08em uppercase `#8b93a3`. Value 25/700/−.03em, mt `8`. Row mt `10`: delta 11/700 (`#1a8a5a` up / `#d0463a` down) + context 11.5 `#5c6474`; sparkline `108×32` (revenue `#404a60`, gross `#9aa2b2`, else `#8b93a3`), gradient .16→0.

**Charts card** (grid `1fr 1fr`, gap `18`, mt `18`)
- Card: radius `18`, bg `#fff`, border `1px #e9ebf0`, shadow `0 1px 2px rgba(16,24,40,.04), 0 14px 30px -18px rgba(16,24,40,.18)`. Header pad `18 20 2`: title 15/700/−.02em; subtitle 11.5 `#5c6474` mt `3`. Legend pad `2 20`, gap `16`: swatch `14×3` radius `2`, text 11.5/500 `#2a3140`.
- Trend SVG viewBox `560×250`, inner L6 R58 T18 B28. Gridlines horizontal `#eff1f5` 1px at 0/25/50/75/100K; y-labels outside right `#aeb4c0` 10. Lines monotone: revenue `#404a60` 1.9, gross `#9aa2b2` 1.9, **net `#5b63d3` 2.8 with area fill `#5b63d3` .14→0 and drop-shadow dy2 blur3.5 `#5b63d3`@.28**. End dots r2.4 (support)/r3.4 (net) white fill + colored 2px stroke; net end label `#5b63d3` 11/700. x-labels `#8b93a3` 10.5.
- Waterfall viewBox `520×250`: bars radius `4`; revenue `#101422`, deductions `#c3cad6`, net `#5b63d3`; dashed connectors `#d3dae3 1.2 (2 3)`; baseline `#d3dae3 1.2`; value labels `#2a3140` 11/700 above bars.

**Drilldown table** (card, mt `18`)
- Header row: bg `linear-gradient(#fbfcfe,#f7f9fc)`, labels 10.5/700/.06em uppercase `#aeb4c0`, pad `13 20`, hairline under `#e9ebf0`. Body cell pad `14 20`, divider `1px #f1f2f6`, text `#2a3140`; row hover `#f9fafc`. Job id 12/600 `#8b93a3`. Name 600 `#101422` + sub 11.5 `#8b93a3`. Source pill: neutral `#f1f2f7` bg, `#5c6474` text, 11/600, pad `3 10`, radius 999, `5×5` dot `#8b93a3`. Net cell: `44×4` track `#eef0f4` + fill (`#5b63d3` if ≥0 / `#d0463a`) radius 3, gap 9, value 700. Negative money `#d0463a`. MoM: bare `↑/↓ x%` 600 (`#1a8a5a`/`#d0463a`). Footer pad `14 20`, top hairline, 12 `#5c6474`.
- Export chip: h `34`, pad `0 13`, radius `10`, `#fff` + border, 12.5/600 `#2a3140`.

**Methodology note:** mt `18`, pad `14 18`, radius `14`, bg `#f4f5fa`, border `1px #e6e8f2`, 12/`#454c60`, line-height 1.5; bold in `#5b63d3`; leading info icon 15 `#5b63d3`.

## 13. Per-route notes (see `mockups/{quotes,technicians,commissions}.html` for exact layout)
- **Quotes:** hero = Count Acceptance % (donut in the trend card: accepted `#1a8a5a` / not-accepted `#d0463a`); 12-month reference line dashed on the trend; tier-month heatmap ramp `#12855a / #7cbfa0 / #e6c07a / #e79b8a` (≥75/≥50/≥25/else), cell `26h` radius `5`; not-accepted table with neutral outcome pills (`Excluded` gray, `Not Accepted` `#fbece8/#b23a22`).
- **Technicians:** three hour-families as separate KPIs; horizontal allocated-economics bars (`#1f4e7a`→ port to `#404a60`+accent for the star); segmented capacity bars (Job `#404a60`, Travel `#2673a5`, Parts `#b4791a`, Support `#64748b`, Unused `#e4e9ef`); scorecard with inline utilization meter (`44×4`, green ≥75 else amber) + `↑/↓ pts` vs-target.
- **Commissions:** focal = Calculated Commission Due with revision/edit/run chips + "does not confirm payment" line; Rebuild→Review→Lock stepper (done `#12855a` / active `#5b63d3` / locked muted) with the disabled-reason line beneath; tier-colored bonus bars (Gold `#a87f28`, Silver `#7d8896`, Bronze `#9a5f38`, else accent); medal leaderboard with pool-share rails; roster table with Included/No-row pills. Keep every action's disabled condition + the payroll disclaimer verbatim.
