# Adversarial Critique Synthesis — Round 4 Mockups

2026-07-15. Three independent adversarial reviews of the round-4 mockups: an information-design
critic (Tufte/Few school), a product-design critic (Linear/Ramp/Stripe bar), and an owner-persona
critic (HVAC owner's real jobs-to-be-done). Full reports preserved in the session transcript.
Findings triaged into three buckets.

## Bucket A — Apply now (unanimous or uncontested, mockup-level)

**Chart forms**
- A1. All ratio/variance bars become deviation bars anchored at the reference (1.00× for labor
  efficiency, $0 for commission efficiency effects). Zero-based bars waste ~85% of their ink when
  values cluster ±18% around the anchor. (info + product)
- A2. Loss module: replace the margin histogram with the two-class dollar split it was hiding —
  diagnostic-fee calls (75 jobs, −$16,523) vs execution losses (36 jobs, −$9,342) — plus tech name
  and class tag per loss row, and the conversion line the owner needs to price the $59 fee:
  39 of 189 direct-service calls produced a follow-up quote. (all three)
- A3. Estimated-vs-actual labor: add the per-job diverging variance strip (real data: 36 jobs at/under
  totaling −47.0h, 19 over totaling +49.2h) so "systemic drift vs three blowups" is answerable —
  June's +16.1% is three blowups (+13h, +7.5h, +7.25h), not drift. (info)
- A4. Work source: bar length switches from margin% (weight-inverting) to share of net dollars;
  margin stays the printed number. (info)
- A5. Quotes volume view: stacked bars → two lines (sent vs accepted) with the flatline annotated —
  accepted count holds ~55/month while volume swings 124→193. The product's hidden insight. (info)
- A6. Quotes trend default: co-plot count + value rates (the 22.8/8.8 scissors is the story). (info)
- A7. Heatmap: indigo single-hue ramp (system palette), red reserved for below-15% cells,
  representative cells desaturated vs the verified June column. (info + product)
- A8. Provenance in pixels everywhere: dashed line segments for representative trend months,
  hatched interim economics bars — captions stop contradicting saturated ink. (info + owner)

**Ordering and honesty**
- A9. Sort by the bolded metric, everywhere: sites by net, technician economics by net,
  commission rows by payout. (info + product)
- A10. Technicians: capacity rows sorted by job hours with job-share in the row note; scorecard's
  Recorded column becomes Unbilled (rec − job) — the page's biggest leak, currently one grey word;
  net-$/hour added to economics rows. (info + owner)
- A11. Punctuality: Uncovered leaves the distribution (it's a measurement fact, not an arrival
  outcome) and becomes a slim coverage line; the 30+ tail gets its annotation. (info)
- A12. Commission rows: segmented payout-chain bars (base share + rank boost + efficiency delta),
  sorted by payout; trace rewritten in plain language ("boosts come out of the same fixed pot, so
  shares are scaled to keep the total at $2,179.89"); tier chips get a criteria tooltip (rank by
  allocated value: #1 Gold ×1.30…); the ineligible-work dollars become a visible line, not a
  footnote. (all three)
- A13. Hero distribution strip: labeled top-3 inline or deleted. (info + product)

**Language (owner's words)**
- A14. "Left on the table" → "Open — not yet accepted"; list titled "Open Quotes"; "approved Jun 2"
  → "sent Jun 2" (definition tooltip keeps the DateApproved source honest). (owner + info)
- A15. Customer exposure rollup line: "Hotel Lulu holds 3 open quotes totaling $504,628 — the
  largest single exposure." (owner)
- A16. Mix-shift insight on quotes: sent +80% YoY weighted toward $10K+ (77% of value at 9.8%) —
  the blended-rate drop is mostly mix. Stated, not left to assembly. (info + owner)

**Component system (the "reads like a template" fixes)**
- A17. Mobile quote rows: title beats chip (2-line clamp; chip drops below meta). Stat cards stop
  clipping their own text; single-delta policy — primary YoY chip, MoM moves into the tile tooltip.
  (product + owner)
- A18. Bullet strip redesigned: real marker + attached label, no stray pipe glyph; hero footers
  unified across the four pages. (product)
- A19. One affordance grammar: dotted underline = definition only; sort direction shown only on the
  active column; real 16px chevrons on expandable rows; explicit ≤480 grid template for commission
  rows (kills the Roberto wrap deviation). (product)
- A20. Red means one thing: red = money-losing/late; amber = over-capacity; grey + "inactive" tag
  = Roberto's 8.5h. Threshold printed in captions. (product + owner)
- A21. Rhythm pass: month stated once above the fold (eyebrow loses it); metric picker gets its own
  toolbar row with unit grouping; 24px annotation lane above flagship plots; drilldown scrolls into
  view on open (mobile). (product + owner)
- A22. Commissions: efficiency-setting stat card deleted (control state ≠ KPI); slider row dims when
  off; hero cents demoted to superscript; one rounding rule per page. (product)

## Bucket B — Design choices (want Asad's taste before building)

- B1. Flagship default: Net profit + Net margin dual-axis (info critic) vs current Revenue/Gross/Net
  triple (familiar). Recommendation: try Net + Net margin.
- B2. A "’25 vs ’26" year-overlay mode (Jan–Dec axis, grey vs accent) as the seasonal form.
  Recommendation: add as a picker chip.
- B3. Site profitability as revenue×margin scatter (quadrant view exposing "big but thin" accounts)
  in addition to, or instead of, ranked rows. Recommendation: keep rows, add scatter as a toggle in
  implementation.
- B4. Technicians capacity×job-share scatter replacing/augmenting the bar rows. Recommendation:
  defer; sorted bars + job-share notes may suffice.
- B5. The efficiency adjustment is economically inert (±$20 on $100–$400 payouts): show a diverging
  dollar-effect chart making that visible — possibly grounds to retire the feature entirely.
  Recommendation: show the chart; keep the feature decision with Asad.
- B6. Summary tab: fold the pool bars into the table (redundancy) or keep both. Recommendation: keep
  chart, thin the table.

## Bucket C — Scope and policy (new features, or conflicts with the brief's rejected list)

- C1. **A fifth "Today/Pulse" screen** — month-to-date this-month view (currently the product cannot
  answer "how is July going"), quotes going cold, tech flags, phone-first. The owner critic's #1.
  New surface beyond the four required — Asad's call.
- C2. **Quote follow-up worklist** — assignee, last touch, next-step date, mark-dead, grouped by
  customer. Turns the $1.96M list into a Monday call sheet. Requires new data + writes — scope call.
- C3. **Finalize-month commission flow** — a single lock/freeze + payroll file, with what-if controls
  moved to a marked sandbox. The brief rejected the heavyweight lifecycle stepper; this is the
  lightweight version of the owner's real need. Policy call (relates to existing Q5).
- C4. **Callbacks everywhere** (loss reasons, scorecard column) — the brief explicitly excludes
  callback metrics from v1. The owner critic calls it "a truck with no fuel gauge." Revisit?
- C5. **Alert digest** (acceptance drop, quote crossing 45d, tech at 140%) — scheduled push was also
  a research finding (ServiceTitan). New scope.
- C6. **Owner-set targets** (utilization, margin, acceptance) — everything currently compares to
  history, never to intent. New scope.
- C7. **Exports for the monthly close** — the brief rejects owner-facing export machinery; the owner
  critic wants a close artifact. Policy call.
- C8. Invoiced-vs-paid tracking — out: Pro Star does not invoice in Simpro (locked rule); noted for
  completeness.

Also fixed as data corrections during synthesis: loss-class totals recomputed from source
(−$16,523/−$9,342 replace the earlier −$15,414 diagnostic figure, which excluded $0-ticket
diagnostic losses).


---

## Round 2 — structural review (2026-07-15, after round-5 feedback)

Round 1 critiqued chart craft; Asad's verdict on the result: "looks almost exactly the same."
Correct — the review never questioned composition. Round 2 dimensions and findings:

| # | Finding | Fix shipped |
|---|---|---|
| S1 | First screen ≠ flagship: every page opened with a number band while its most informative element sat below the fold | Jobs/Quotes/Today: headline column + flagship chart fused into one first-screen band; stat tiles folded into the column |
| S2 | Report, not decision tool: Quotes buried the $1.96M follow-up queue under analytics | Queue promoted to directly under the flagship, ordered by age with 30/45-day chips |
| S3 | Jobs told one money story in four scroll positions | Waterfall + work-source + margin distribution consolidated into one three-across band |
| S4 | Technicians' real flagship is the scorecard table; it sat fourth | Scorecard promoted to position 2 |
| S5 | Today (v1) restated other pages at lower density — no reason to exist | Rebuilt on live per-day Simpro data: cumulative pace curve vs June/Jul '25, full decision queue, live losses, biggest completions, progress meters |
| S6 | No cross-page spine | Partially addressed (consistent flagship grammar); full month-story strip deferred |

Data note: all July figures re-pulled live on 2026-07-15 — MTD value moved from $259,456 (Jul 14
pull) to $261,425 (a job total was edited in Simpro), and per-day curves/losses were fetched for the
first time. June re-validated exactly (272 / $435,979).
