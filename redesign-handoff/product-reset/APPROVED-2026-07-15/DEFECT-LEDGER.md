# Defect Ledger — full adversarial review, 2026-07-15

Six independent reviews (5 per-page + cross-page) + functional click-through + source data
reconciliation. Every finding gets a disposition: FIX (this pass), SKIP (reason), or DEFER (needs
Asad/implementation). This file is the checklist for the consolidated fix pass and the record shown
to Asad.

## Review scope

Covered: 5 per-page adversarial reviews (all 4 viewports + alternate states), cross-page
consistency + data-agreement audit, functional click-through of all interactive controls (1440),
source-data reconciliation pulls. Residual gaps closed in this pass's verification: statestrip
blocks reviewed explicitly; tooltip-content sweep across all charts; key interactions re-run at
390. Deferred to implementation (recorded decisions, not omissions): cross-browser rendering;
accessibility beyond contrast (keyboard order, SR semantics, touch-target sizes).

## Verified data corrections (Simpro re-pulls, 2026-07-15)

- **Quote-linked labor efficiency, June (team):** est 614.0h / act 661.5h = **0.93× (act +7.7% over
  est), 73 covered of 85 quote-linked jobs** (12 more have actuals but no estimate). Replaces BOTH
  prior displays: Jobs card "+16.1% (601.8/698.8, 55 of 58)" and Technicians "0.99× (88 jobs)".
- **Per-technician efficiency is NOT derivable from job records**: 69 of 73 covered jobs have no
  job-level technician assignment. Per-tech bars/ratios (Technicians chart, Commissions eff
  ratios) must be marked representative until timesheet attribution is verified. Team ratio is
  verified. (Data: scratchpad eff-recon.json, eff-pertech.json.)
- **July quotes MTD**: 14 / $91,636 (verified). The quotes states-block example "86 through day 14,
  pace ~184" is stale fiction → replace with real figures (pace ≈ 31).
- Outside-roster June work: itemization sums to **$20.6K** (8.6+10.4+1.6) — use $20.6K everywhere.

## Shared fixes — kit.js (K) and tokens.css (T)

- K1 FIX Stranded tooltips: tipHide on window scroll + pointerdown outside.
- K2 FIX bandLabel anchored above the band's x (clamped to plot), not pinned top-right (collisions
  on Today/Jobs-390/Quotes).
- K3 FIX Band month/day always gets an x-axis label (force band index into stride).
- K4 FIX Label stride: draw second-to-last label when ≥50px from last (kills Mar→Jun gaps).
- K5 FIX Dashed series now included in hover tooltips (YoY mode was missing the ’25 value — the
  mode's whole point).
- K6 FIX devStrip right gutter widened; axis max label no longer clips ("+13.0h").
- K7 FIX devBars domain derived from data (clamped); compact label collision guard (row labels no
  longer crossed by the zero axis).
- K8 FIX bullet: comparison label sits under its tick (not pinned far-left); separator grammar
  unified ("Jun ’25 · $186K" / "High · Dec ’25 · $585K").
- K9 FIX histogram: n≤3 bars centered at fixed slot width (no 600px voids); bars square on the
  baseline (round top corners only); y-formatter never prints "$0" for real ticks.
- K10 FIX heatmap: text-contrast-safe ramp (mid indigo→#4f58bd w/ white 6.1:1, red→#b8453a 5.3:1,
  light cells → ink text 5.9–9.3:1); representative cells = lighter fill + dashed ring at FULL text
  opacity (opacity fade killed contrast); cell text ≥10.5px at all widths.
- K11 FIX Dual-axis charts: right/left tick counts aligned so every % label sits on a gridline.
- K12 FIX (jobs) margin series recolored to --series-strong (two same-hue indigo dashed lines were
  indistinguishable); axis-2 series noted in legend/chips.
- K13 FIX nav scrollIntoView → inline:"nearest" (brand/logo no longer scrolled off at 390).
- K14 FIX mobile nav: stronger edge fade + guaranteed first-item visibility (K13).
- T1 FIX --up darkened to pass 4.5:1 at small sizes; single green for "good delta" (removes
  #5fd39b/#7fd4a8 split).
- T2 FIX srcpill decorative dot removed; loss-class pills get the legend's two reds and stay
  visible at 390.
- T3 FIX .flags = 3-col grid ≥1180 (no orphan wrap dead zone).
- T4 FIX Scorecard: Unbilled visible at 1024 (hide-lg moved to On-Time, which is representative).
- T5 FIX Pager: disabled pages get a distinct disabled style.
- T6 FIX "Viewed by customer" status pill gets an engaged (indigo-tint) variant vs plain "Sent".
- T7 FIX Heatmap grid: fixed row gap (no space-evenly stretch); headers carry the year once.

## Cross-page unification (all pages)

- X1 FIX Metric name: "Revenue" everywhere (tile/label); "completed work value" survives only
  inside the pool formula sentence. X2 FIX Eyebrow "Operations" on all five. X3 FIX Pill grammar:
  "Updated N min ago" on all five. X4 FIX Hero label suffix = scope month ("· June", "· July so
  far"). X5 FIX Pool cents everywhere ($1,307.13 on Today). X6 FIX $435,979 (no cents) in prose.
  X7 FIX Today gets a month stepper (‹ June 2026 · › disabled). X8 FIX Tabs "Worksheet / Summary".
  X9 FIX Footlines start "Source: Simpro" on all five, ≤1 sentence, no IANA strings, no roadmap
  jargon, no Q1/Q2 ticket refs. X10 FIX Age chips "44d" both pages. X11 FIX Band labels via
  fmt.money ("$212K", not "$211.5K"). X12 FIX Legend populated in every chart mode. X13 FIX
  Capacity % integers everywhere (102%, 114%). X14 FIX Roberto in Jobs technician filter (9).
  X15 FIX CSV button on Quotes history table. X16 FIX Today gets a states block + statestrip
  capture. X17 FIX "9-technician roster" / "Completed Jobs" / full site names / "cleared by any
  quote activity" / "hover or tap" / hours always carry "h" — unified wording everywhere.
  X18 FIX JW Marriott completed job vs open quote disambiguated (ids on both).
  X19 FIX "×1.30" prefix style + 2-dp everywhere for multipliers; minus sign always "−".
  X20 FIX Footnote budget ≤1.5 sentences — methodology moved into data-def tooltips on all pages.

## Per-page fix lists

### jobs.html (42 findings)
J1 FIX $1 reconciliation: component rounding adjusted (largest-remainder) so waterfall sums to
$211,534 exactly; same for loss split (−$16,524 − $9,342 = −$25,866). J2 FIX Variance strip rebuilt
from verified per-job data (73 bars, Σ = +47.5h, consistent with +7.7%); overrun list recomputed
with real job names. J3 FIX Labor card numbers → 614.0/661.5/+7.7%/73-of-85 (+12 uncovered
disclosure). J4 FIX Margin line gets its own honest delta ("↓ 7.9 pts vs Jun ’25") separate from the
dollar chip; sub-target state visible. J5 FIX Gross tile delta slot = "↑ 26.2%", margin moves to
sub. J6 FIX Work-source: negative bar drawn red/leftward, no 6% floor, encoding stated in subtitle.
J7 FIX Sites: scale = largest real site; remainder row de-emphasized, no bar. J8 FIX Dead space:
bridge fills its card; hero void closed (bullet + content spacing). J9 FIX Recurring labor mode:
jobs without estimates excluded from the % and said so; repr marking. J10 FIX Insight glyph ◆ only;
one insight for the diagnostic-fee story (work-source card gets a plain footnote). J11 FIX naming
dedupe (job titles match table), "an $863", picker wrap spacing, waterfall compact labels at 390,
gross-profit checkpoint bar added, minus signs, axis "Jan ’25", loss-row padding, header wrap at
1024, subtitle wraps. J-SKIP #34 (Simpro data artifacts are real), #30 target example (C6 approved).

### quotes.html (32)
Q1 FIX Heatmap contrast system (K10). Q2 FIX June annotation collision → removed; band label (K2)
carries it. Q3 FIX By-customer mode: subtitle/footer swap to mode-true copy; rows get drawers (same
detail as by-quote), pointer honest. Q4 FIX T12 footer sums computed from the arrays (no hardcode).
Q5 FIX YoY chip = 8.6 pts (display-rounded policy stated in tooltip). Q6 FIX Tier caption
"bar = size relative to the largest tier". Q7 FIX yMax 50 (kills dead band). Q8 FIX repr-fade
replaced (K10) + fade convention in legend line. Q9 FIX Queue scope stated ("June-cohort quotes").
Q10 FIX Volume annotation leader anchored to the Accepted line, sub shortened. Q11 FIX bullet label
(K8). Q12 FIX heatmap sizes (K10/T7). Q13 FIX footers/subtitles to budget. Q14 FIX Volume mode June
band label with sent/accepted values. Q15 FIX cov line rewritten (chips aren't green). Q16 FIX
"Won" naming unified (hero, tile "Won Value", volume legend). Q17 FIX $2,152,685 full form; tier
subtitles consistent format. Q18 FIX (K4) axis rhythm. Q19 FIX "hover or tap"; 390 note when
annotations suppressed. Q20/21 FIX wraps (subtitle shortened; View-all nowrap). Q22 FIX (T6).
Q23 FIX chip pips show series color when inactive. Q24 FIX (T7). Q25 FIX discrete 4-swatch legend
with bounds. Q26 FIX "still in play" def tooltip explains no-decline-state. Q27 FIX pill grammar
(X3). Q28 FIX (K13/14). Q29 FIX methodology → tooltips. Q30 FIX history: consistent weight, June
row highlighted. Q31 FIX grammar. Q32 FIX bullet strip de-duplicated (bullet keeps scale story;
trend annotation removed per Q2).

### technicians.html (33)
TE1 FIX 88→73-of-85, 0.99×→0.93×; hero tile + fnote consistent. TE2 FIX Roberto scorecard row:
util/capacity shown as "—" with inactive tag (no 100% artifact), excluded from util sort top.
TE3 FIX (K7) recurring mode domain. TE4 FIX Hero/tiles get honest "no prior-period yet" note
(history verification pending — no fabricated YoY); recorded as open data gap. TE5 FIX $/hr ratio
replaced with share-of-team-net. TE6 FIX #drill moved directly under scorecard. TE7 FIX drill KPIs
+ On-Time/Unbilled/Quote-eff. TE8 FIX placeholder drill tables labeled as representative rows
honestly per tech. TE9 FIX .repr elements get data-def (or lose help cursor). TE10 FIX over-capacity
= amber everywhere (hero slice/chip recolored). TE11 FIX "Unbilled" naming unified (legend, tooltip,
scorecard). TE12 FIX chart fills ≥3:1 (punctuality/econ/series-weak greys darkened). TE13 FIX hero
bar redrawn on one scale (recorded = job + unbilled; capacity tick; no carve-out slice). TE14 SKIP
target example (C6 approved, labeled). TE15 DEFER tiles/rows drill navigation (implementation).
TE16 FIX Job-Hours tile → Unbilled Hours tile (655h · 40.7%). TE17 FIX precision/unit drift
(955h/59%/102% one style). TE18 FIX punctuality axis label "minutes vs planned start"; def notes
Early counts on-time. TE19 FIX capacity tooltip drops "adjusted for verified leave". TE20 FIX
On-Time column sortable + asc/desc + default sort (job hrs desc, marked). TE21 FIX (K13).
TE22 FIX compact notes keep "inactive"; coverage counts in tooltip; "hover or tap". TE23 FIX Tadeo
sub wrap. TE24 FIX (T3). TE25 FIX footnotes to budget; Furtado/Sarmiento explained. TE26 FIX tooltip
swatch = bar color. TE27 FIX econ legend swatches hatched; Villalta absence noted; revenue value in
tooltip. TE28 FIX (T4). TE29 FIX copy dedupe. TE30 FIX default sort labeled; team footer computed.
TE31 SKIP (89%/89% coincidence — values differ in sub-text). TE32 FIX hero min-height at 1024;
punctuality slot width capped. TE33 FIX drill 390 keeps est/act (drop ratio-only), covered-wording
fixed.

### commissions.html (33)
C1 FIX Trace arithmetic reproduces: the efficiency step shows the composite factor (emult ×
re-scale) so printed math multiplies out to the payout. C2 FIX One ratio story: worksheet column
labeled "payout adjustment ×" with def linking ratio→remap→re-scale; chart label keeps raw ratio.
C3 FIX Hero strip: rank ramp (5 indigos) never reuses the boost legend color; "+5 more" swatch
matches. C4 FIX Negative-efficiency color identical solid tint in bar + legend. C5 FIX Trace says
"interim equal-split" (matches table) until hours-share ships. C6 DEFER YoY pool delta (needs
prior-June pool history — flagged as data gap, not faked). C7 FIX Legend shows efficiency entries
only when the toggle is on. C8 FIX (K7). C9 FIX Column header/def for the ×-column (see C2).
C10 FIX Annual view: table gains per-half subtotal columns + chart stays (6 monthly bars, annual
line) — no verbatim KPI repeat. C11 FIX (K9) quarterly layout. C12/13 FIX footnotes/trace ≥12px,
≤1.5 sentences, methodology → defs. C14 FIX (T1) green + 11.5px floor. C15 FIX Q1/Q2 refs removed
from customer copy (kept in MOCKUP-DECISIONS). C16 FIX placeholder detail rows are honest repr
copy per tech (kept, reworded — implementation lists all). C17 FIX (K9). C18 FIX Top-payout def
added. C19 FIX (X6). C20 FIX detail rows sorted by allocated $. C21 FIX (X19). C22 FIX dash
convention closed en-dash. C23 FIX "redistributed to the eligible nine" → "to technicians with June
hours (8 this month)". C24 FIX (K9). C25 FIX subtitle single sentence. C26 FIX jargon → plain
("Months with a run", "n/c"→"not covered"). C27 FIX cents scale with the figure at 390. C28 FIX
stat labels nowrap/two-line balance. C29 FIX legend wrap (flex-wrap tidy, order). C30 FIX Roberto:
no tier chip / no ×1.000 when no work. C31 FIX Jan–May rows + bars get the amber repr mark (dashed
ring on bars, "draft" chip), footnote shortened. C32 FIX helper text shown only when toggle on;
duplication removed. C33 FIX (K13/14).

### today.html (31)
TD1 FIX Jul ’25 line ≥3:1 (#8a92a4) and June ’26 distinct darker (#6d7585); legend order = chip
order; one naming style ("Jul ’25/Jun ’26/Jul ’26"). TD2 FIX Loss insight math: "July's bleed is 6%
of what June lost in its FULL month" (wording now true). TD3 FIX Losses card: remainder row ("4
more · −$252") so rows sum to −$1,460; share bars added (A5 grammar) to losses AND completions
(Creekwood's 39% visible). TD4 FIX Hero void closed (chart h tuned + content spacing). TD5 FIX
Legend/subtitle wrap fixed (legend nowrap, subtitle shortened). TD6 FIX (K2) band label anchored.
TD7 FIX (K3) day-14 axis label present. TD8 FIX (K13/14) nav. TD9 FIX Best Western / JW split into
two rows, each with true age + em-dash grammar. TD10 FIX Chip semantics: quote rows amber/red only;
Roberto = red "0h" moved to a "roster" group with its own footer clause; capacity row chip amber.
TD11 FIX (TD3). TD12 FIX footline/queue footer to budget. TD13 FIX yMax 500K (dead quarter gone).
TD14/15/16 FIX naming/precision/labels unified; sub-values labeled (total/avg/rate). TD17 FIX age
stated once (chip carries it; text says "unanswered since Jun 1"). TD18 FIX both positive chips
same green; June comparison de-emphasized via order not color. TD19 FIX "Sunland Park — MH-17
water-heater cabin" plain-English (uses job name from Simpro) + hyphenation unified. TD20/21 FIX
grammar ("111 jobs", "profitably", dedupe repeated insight). TD22 FIX nbsp on "45-day line",
subtitle/footer wraps. TD23 FIX in-progress July line gets live-end treatment (solid dot + "live"
tag) vs finished months' plain ends. TD24 FIX stepper real (X7); pill = X3 grammar. TD25 FIX
"Month elapsed" def added; chart title def added. TD26 FIX meters use series indigo; inline hexes
replaced with tokens. TD27 SKIP icon glyphs (system-wide convention; queue icons match the other
pages' flags — revisit in implementation with an icon set). TD28 FIX capacity tooltip notes Jul 3
observed holiday is NOT deducted (flat-capacity rule per brief) — copy honest instead of silently
wrong. TD29 FIX "hover or tap"; 390 stride evened. TD30 FIX queue moved to the 7fr column (lists
to 5fr). TD31 FIX footer scoped to quote rows (TD10).

## Functional pass (mine)
F1 FIX Loss drawer: absurd "-3545.9%" margin replaced with "n/m — $59 ticket" treatment + true
minus. F2 FIX (K1). F3 FIX drawer "Approved" label → "Sent" (def keeps DateApproved provenance).
F4 FIX value-mode annotation labeled as value-rate peak.

## Cross-page ledger items already fixed pre-review
Legibility gate (tokens/kit contrast + sizes), overflow probe, A1–A22 compliance audit.


## Execution status (2026-07-15, round 7)

All FIX items implemented (shared layer by the orchestrator; pages by five parallel fix agents,
each reporting item-by-item) and re-verified centrally: full recapture at 4 viewports + all states
(zero console errors, zero horizontal overflow), tooltip-content sweep across all charts (YoY
tooltip now carries both years), 390 touch interactions (drawers/drill/expand all clean), and
native-1x crops of changed regions. Noted implementation deviations, both justified: C1 uses a
5-decimal composite factor (3 decimals provably cannot reproduce the cent math; verified over
5,888 setting combinations); C10's annual table uses H1/H2/Total/Peak (no chart line). New
verified fact settled during the pass: quote-linked (85) vs Quote-generated (58) differ because
recurring-plan quote conversions count as quote-linked but not Quote-generated — clarified in a
def on the Jobs labor card (jobs 17064/17066 checked against Simpro conversion records).
Open items for implementation (not mockup defects): TE15 drill-everywhere navigation, C6/TE4
prior-period history verification, cross-browser + full accessibility.

## Round 7b (2026-07-15) — type scale + skip-audit reversals

Owner verdict on round 7: text still too small. Root cause: the gate's size floors were authored to
fit the existing build (rationalization), and "passes contrast" was treated as "readable". Fixed:
global type scale raised one notch (base 13→14px; every sub-14px size +1px across tokens, kit SVG
text, and page inline styles; chart gutters/fixed widths widened to match) — re-verified with zero
overflow and zero errors at all viewports/states, native-1x reading checks clean. Skip-audit
reversals: TE31 fixed (explicit 342-visit denominator); TD27 fixed (⚠ ▼ › ! ◆ text glyphs replaced
with stroke SVG icons matching the nav's icon language, 27 instances across 5 pages); Q26 promoted
to MOCKUP-DECISIONS **Q6** (lost/declined quote state — owner policy call, not a tooltip).
