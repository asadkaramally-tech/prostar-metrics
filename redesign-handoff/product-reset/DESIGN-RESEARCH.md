# Design Research — How the Best Products Solve This

Prepared 2026-07-14, before the third mockup round. Three parallel research passes: (1) field-service
owner dashboards (ServiceTitan, Jobber, Housecall Pro, simPRO BI, FieldEdge, Workiz — help centers,
docs, and G2/Capterra owner reviews), (2) best-in-class SaaS dashboards (Stripe docs + design
writeups, Mercury and Plausible inspected live in a browser, Ramp, Linear, Fathom, Shopify Polaris and
IBM Carbon dataviz systems), (3) the information-design canon (Stephen Few's primary PDFs, Tufte,
NN/g, Big Book of Dashboards) plus specialists per screen (Runn/Float/Harvest capacity, Pipedrive/
HubSpot/Salesforce pipeline, CaptivateIQ/Spiff/Everstage/QuotaPath compensation). Full agent reports
with per-claim source URLs are preserved in the session transcript; key sources cited inline below.

## The evaluation standard (now the permanent bar for every element)

Synthesized from Few, Tufte, and NN/g — an element ships only if it passes all ten:

1. **Erasure test** — removing it loses data-information (Tufte, data-ink).
2. **Glance test** — it changes what the owner notices in ~5 seconds (Few).
3. **Context test** — every featured number carries a comparison: prior year, prior period, range, or target (Few pitfall #2).
4. **Directness test** — it shows the quantity needed (the variance), not inputs to mental math (Few pitfall #4).
5. **Encoding test** — quantity is encoded as length/position, never angle, area, or hue (NN/g preattentive; Few's gauge critique).
6. **Space-efficiency test** — clearest presentation in the least space (Few).
7. **Color discipline** — color only for meaning; magnitude never by hue; single-hue ramps for intensity (NN/g; Few bullet spec).
8. **State count** — at most five, ideally three qualitative states (Few bullet spec).
9. **Comparability** — sets of small graphics share scales; per-row autoscaling is lying (Tufte sparkline rules).
10. **Hierarchy** — size/position matches importance; the big picture needs no scrolling (Few pitfall #1; Big Book of Dashboards).

## Convergent findings (all three research passes agree)

**F1. Tile anatomy: label / big value / semantic delta — and no sparkline when a flagship chart sits
below.** Plausible, Fathom, and Mercury keep KPI tiles as pure number+delta and pour all trend into
one big chart; Stripe/Shopify put mini-charts in tiles only where the tile IS the chart surface.
Rule: sparkline in a tile only if the screen has no flagship chart; never both. Our screens are
single-question screens with flagships → clean tiles. (Confirms removal of the tile squiggles — the
critique that triggered this research is the documented industry rule.)

**F2. In HVAC, the primary comparison is the same period last year, not last month.** Housecall Pro
puts a green/red YoY pill on every homepage stat; ServiceTitan's 18-month trend hover shows the same
month last year; seasonality makes MoM misleading. Plausible's compare mode even offers
"match day of week" to avoid weekday skew.

**F3. Previous period on a chart = a muted second line on the same axes** (Stripe's canonical
treatment; codified by Polaris as "current in color, historical in grey"; Plausible implemented it by
explicitly copying Stripe). Deltas live in tiles and tooltips, not as extra axes.

**F4. Every number drills to records.** Mercury's breakdown rows are literal links to the filtered
transaction ledger; Ramp: "drill from a spike to the exact transactions"; Linear: click any slice →
filtered issue list; ServiceTitan: one click from any dashboard number to job level. The #1 owner
complaint about Housecall Pro is dashboards that dead-end ("export to Excel to get what you want").

**F5. Trust comes from visible definitions.** ServiceTitan puts an info icon on every KPI exposing
the exact formula and its date anchor (completion vs invoice vs sold date); Stripe publishes each
metric's formula next to the chart and exposes definition switches; Mercury dotted-underlines KPI
labels for definition tooltips. This matches our locked-rules regime perfectly — surface it in the UI.

**F6. Three-tier page anatomy: glance → scan → investigate.** Headline KPIs, then trend/breakdown
charts, then a bounded detail table (simPRO ecosystem guidance; ServiceTitan module order;
Observable's "overview first, zoom and filter, details on demand"). Our composition already follows
this — keep.

**F7. Breakdown lists: name + right-aligned value + in-row proportional bar, top-N + a "remaining"
row.** Plausible draws the share bar as the row's background; Mercury prints % of total with a
cumulative inline bar and ends with "Remaining recipients 14.8%". This is the *legible* version of
what our 3px underline bars gestured at.

**F8. Mark incomplete periods visually.** Plausible renders the in-progress period as a
dotted/detached tail so partial data never reads as a crash — matches our locked provisional-month
rules; adopt the visual convention.

**F9. Gauges fail; linear forms win.** Few's gauge critique + NN/g ("pies, donuts, gauges perform
poorly"). ServiceTitan's revenue *gauge* is the exception that proves it — adopt its **content**
(made vs missed money) as paired numbers, reject the gauge form.

**F10. Big numbers anchor; typography beats boxes.** Stripe removed cards entirely in their redesign
("cards buried crucial information") — hierarchy via type and whitespace. Big Book of Dashboards
endorses BANs (big anchor numbers) as context-setters and color legends.

## Screen-specific patterns to borrow

**Quotes** — Pipedrive puts win rate as the headline with win/loss inspectable below; its "rotting"
pattern turns a deal red by rule when idle past a per-stage threshold (no manual flagging);
Salesforce flags "needs attention" from high-signal fields (stage-stuck, no activity in 7/14/21
days); ServiceTitan pairs made vs missed revenue; HubSpot explains pipeline change as a waterfall of
named movements (created/won/lost/pushed).

**Jobs** — Mosaic's P&L waterfall grammar (anchors + floating deductions + gross-profit checkpoint)
is exactly our bridge — waterfalls only for "what changed between A and B." Jobber highlights per-job
profit % on recent-job rows; ServiceTitan's GM definition matches ours.

**Technicians** — Runn/Float/Harvest converge: person-per-row, a hard 100%-capacity reference line,
red reserved exclusively for over-capacity (intensity = severity), hours AND percentage co-displayed,
billable vs non-billable split. ServiceTitan scorecards: sortable table (sorting IS the leaderboard),
tabs per KPI domain, a totals/averages footer row, click a tech → their own page. ServiceTitan also
computes fair ratios only over "opportunity" jobs — the cohort-fairness instinct our locked rules share.

**Commissions** — Housecall Pro pairs Commission Cost per employee with the sales performance that
earned it, rows drilling to line items; Spiff's "Trace" opens the full calculation behind any payout
line (the anti-"shadow accounting" pattern); Workiz shows which rule produced each payout; QuotaPath
draws a pace line (n/a for our pool model). Attribution must be explicit — HCP's leaderboard crediting
the whole job to every assigned tech is the documented credibility-killer our hours-share rule avoids.

## Adopt / adapt / reject — what changes in our mockups

| # | Decision | Source basis |
|---|---|---|
| A1 | **Adopt** YoY-first deltas: every hero/tile delta leads with "vs Jun ’25", MoM second | F2 (HCP, ST) |
| A2 | **Adopt** clean tiles (label/value/delta only) — no tile charts anywhere | F1 |
| A3 | **Adopt** same-month-last-year in flagship tooltips + a "vs last year" muted overlay line where real data exists (jobs revenue); omit where we lack prior-year data rather than fake it | F2, F3 |
| A4 | **Adopt** per-KPI ⓘ definition affordance: formula + date anchor in a tooltip (content from the locked rules) | F5 (ST, Stripe) |
| A5 | **Adopt** Plausible/Mercury breakdown rows: full-height row share bars + printed values + "remaining N" row — replaces the faint underline bars on sites/quotes lists | F7 |
| A6 | **Adopt** made-vs-missed pairing on Quotes hero: "Won $189,074 · Not accepted $1.96M" as first-class paired numbers (no gauge) | F9 (ST content, Few form) |
| A7 | **Adopt** rule-driven aging states on open quotes: >30d amber, >45d red chip, rule stated in the card footer | Pipedrive rotting; Salesforce flags |
| A8 | **Adopt** scorecard conventions: totals/averages footer row + sortable headers (mockup shows sort affordance + one sorted state) | ST scorecards |
| A9 | **Adopt** Spiff-style calculation trace in the leaderboard expansion: allocated → base share → rank boost → normalized → final, per technician | Spiff/CaptivateIQ |
| A10 | **Adopt** dotted/detached tail for partial periods (structure shown in state treatments; July when live) | F8 (Plausible) |
| A11 | **Adapt** Few's bullet-graph anatomy for the hero "June vs last 12 months" strip: featured measure + comparative tick + labeled endpoints (replaces both the deleted hero squiggles and my improvised range strip) | Few bullet spec |
| A12 | **Adapt** lighter card chrome: keep the canonical card system (it's in the approved visual language) but flatten intra-card boxes; hierarchy inside cards via type, not nested containers | F10 (Stripe) |
| A13 | **Adapt** Polaris chart thresholds as our defaults: <30 points → bars, >6 categories → table, ≤4 lines per chart, k/M-abbreviated axes | Polaris |
| R1 | **Reject** gauges/donuts/radial anything, permanently | Few, NN/g |
| R2 | **Reject** tile sparklines and any unlabeled micro-chart | F1 + owner feedback |
| R3 | **Reject** QuotaPath pace line for commissions (pool model has no quota) — keep the as-of date instead | fit |
| R4 | **Reject** report-builder/custom-dashboard machinery — opinionated screens only (the #1 ServiceTitan complaint is unusable power) | G2/Capterra |
| R5 | **Reject** HubSpot pipeline-movement waterfall for v1 quotes (needs open-pipeline tracking, which is explicitly out of scope) | brief §4 |

Anti-patterns from owner reviews, now hard constraints: no dead-end cards (everything drills);
no ambiguous attribution (hours-share only, rules stated); no burying the money answer; no chart
without a mapped decision.


## Legibility gate (added 2026-07-15 — hard, measurable, checked before every presentation)

Every text style must pass ALL of these before a round is shown. No exceptions, no "it's just a caption":

1. **Contrast ≥ 4.5:1** (WCAG AA small text) for every text color on its actual surface — computed,
   not eyeballed. Tokens after this pass: `--muted #5c6474` (5.95), `--subtle #6b7383` (4.77),
   `--faint #6d7585` (4.63) on white; `#9ba2b6` (6.8) and `#8b90a6` (5.5) on the dark hero;
   `#7c8496` (5.2) on the rail. Chart axis/annotation ink: `#6b7383`.
   Non-text graphics (series lines, swatches) ≥ 3:1.
2. **Size floor (v2, 2026-07-15):** base body 14px. ≥ 11.5px for uppercase micro-labels with
   letter-spacing; ≥ 12px for numerals, chips and axis labels; ≥ 13px for any running sentence.
   (v1 floors — 10.5/11/12 on a 13px base — were written to fit the existing build and the owner
   correctly rejected them as still too small. The floor serves the reader, not the layout.)
3. **Verbosity budget:** footnotes ≤ 1 sentence-and-a-half at 1440 width; methodology detail lives
   in [data-def] tooltips, not in visible captions.
4. **Verification at native size:** review crops are taken at deviceScaleFactor 1 and read 1:1 —
   never judge text legibility from a downscaled full-page screenshot.

Failure history that forced this: five rounds shipped with `--faint #aeb4c0` axis labels at 2.08:1
and `--subtle #8b93a3` captions at 3.09:1.
