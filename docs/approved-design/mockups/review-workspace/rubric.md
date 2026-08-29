# Rubric — Pro Star Metrics redesign mockups

The owner's verbatim complaints about the live app (these are the reason the redesign exists; the mockups must demonstrably fix every one):
- "stats are just randomly jumbled all together"
- "visualizations have become secondary to lists"
- "somethings take up too much space others not enough"
- "11 different stats all in one card … not clear what is and isn't connected … some info is repeated in multiple places"
- "the actual graph that would make the reader understand the trend quickly is hidden below the scroll"
- "a lot of empty white padding space and bars"
- "stats that dont matter that much (quote aging, open quote count, value rate, count rate)" given prime space

## A. Owner's complaints resolved
- A1 No stat dump: no card or tile group renders more than 6 numeric stats without an accompanying visualization; no dark surface taller than 100px exists (the old 751px slab must not survive in any form).
- A2 One number, one home: each key figure appears exactly once per page outside charts/data tables (chart data labels, drilldown tables, and calculation-walkthrough callouts marked data-viz are exempt).
- A3 Chart-first: the page's primary visualization is fully visible at 1440×900 and is the dominant element after the KPI band.
- A4 Visualizations lead: every entity list (deal tiers, sites, work sources, technicians, economics) renders proportional bars; zero text-only stat lists.
- A5 Space is earned: no near-empty full-width tile rows (e.g. aging 15/0/0 must be a one-line strip); no dead vertical whitespace band taller than 48px between sections; no metric given a tile whose information already lives elsewhere.

## B. Layout skeleton & cross-page consistency
- B1 Same skeleton on every page: page header → KPI band (first tile dark/primary) → primary visualization → secondary cards → tables/drilldowns. (Commissions may insert its Worksheet/Summary tab bar after the band.)
- B2 Grid: 24px page margins, max-width 1560px, 12-col with 16px gaps; KPI band gap 12px.
- B3 KPI tiles: uniform 96px height at ≥1280px, identical padding (14px 16px), label/value/sub structure; primary tile same height, dark gradient, 34px value; other values 26px.
- B4 Cards: 8px radius, 1px --hair border, --sh-card shadow, 16px/20px padding, title 15px/600 with 12.5px muted subtitle; max one footnote line per card.

## C. Type & token discipline
- C1 Inter everywhere; tabular numerals on all numeric displays.
- C2 No new raw hex in component CSS beyond the copied token block (color-mix over tokens is allowed).
- C3 Type scale per brief §3 (KPI label 11px/600 uppercase .08em; value 26px/700; primary 34px; card title 15px/600; footnote/source 12px; table header 11px uppercase).
- C4 Semantic color use: green (--up family) only for good, red (--down family) only for bad/over; neutral data in accent/greys.

## D. Content fidelity (nothing silently dropped — cardinal sin)
- D1 Every item in the brief §4 content-inventory tables is present on its page: quotes (6 KPIs + both delta pills, band footnote, trend chart + 3 toggles + peak/last-year annotations, pipeline stacked bar + end labels + aging strip + as-of footnote, merged deal-size card with 4 tiers × [count-%, quoted $, quote count, value-%] + $10K+ callout, heatmap 4×12 with legend + hatch legend + both footnotes, monthly table 8 cols × 12 months + trailing-12 row + CSV button); jobs (6 KPIs incl. net-negative alert tile, trend + 8 metric chips + dashed-representative footnote, cost bar with 4 segments + legend + gross-profit footnote, work-source 3 rows + classification footnote, labor card with toggle + est/actual bars + over-% + coverage line + variance strip + 3 overruns, sites toggle + 8 rows + remaining-83 row + top-8 footnote, net-negative headline + 6 rows + non-inference disclaimer, completed-jobs table + 3 filters + CSV + pagination); technicians (5 KPIs, no-prior-comparison note, Furtado banner, capacity rows ×11 + capacity tick + legend, efficiency diverging bars + 1.00× line + no-covered-jobs rows + verified-team note, punctuality histogram 4 bins + coverage bar + 67% footnote, scorecard 11 rows + team row, economics 11 rows + Villalta/interim footnote); commissions (5 KPIs, verbatim "Calculated amounts only —" subtitle, rank-boost note, tab bar, toolbar with pool select + efficiency toggle + ±20% slider, leaderboard 9 rows with checkboxes/rank/jobs·allocated/base+boost bar/tier chip/payout incl. three $0 no-July-work rows, calculation walkthrough, summary strip (avg/peak/earning-YTD) + Monthly/Quarterly/Annual toggle + CSV + per-month chart + table with Draft/Current/No-runs-yet pills + draft-runs footnote).
- D2 Verbatim-sensitive strings intact: page source lines, "Calculated amounts only — nothing on this page confirms that a payment was made.", "(example)" qualifiers, "No prior-period comparison yet — timesheet history verification is pending."

## E. Accessibility & robustness
- E1 The objective gate (gate.mjs) is green — authoritative; any gate failure = automatic FAIL.
- E2 Interactive elements are real buttons/links with accessible names; icon-only controls have aria-labels; pure-CSS visualizations carry role="img" + aria-label or adjacent text equivalents.
- E3 At 390px (mobile screenshots): no clipped/overlapping text, no broken rows; wide content scrolls inside its card only.

## F. Craft (the "actually looks designed" bar — Linear-grade restraint)
- F1 Chart annotations legible and non-colliding; axis labels not cramped.
- F2 Bars within one list share one scale; zero/тiny values still show their track; bar+label alignment consistent.
- F3 The four pages read as one product: identical nav, header, tile, chip, pill, table treatments; consistent vertical rhythm.
- F4 No awkward artifacts: empty KPI sub-line gaps, orphaned legends, misaligned baselines, double borders, stray placeholder text.

## G. Desktop composition (added after the owner rejected round-3 output: "random empty page spaces and weird padding … no way this meets the standard of an intelligently laid out professional product". Desktop 1440 is the PRIMARY target; mobile is secondary. Violations here are P0/P1, never P2.)
- G1 Balanced rows: at 1440×900, every multi-card grid row has its card bottom edges aligned within 28px. No grey canvas visible below a card while its row partner continues (no ragged holes). Achieve this by content-matched pairing and distributed internal spacing — NOT by top-packing content and leaving a void at the card bottom (the old disease).
- G2 Intentional interior space: inside any card, no contiguous content-free block taller than 64px between two content blocks or below the last block (footnotes pinned to the card bottom count as content).
- G3 KPI tile discipline: one anatomy for every tile on every page — label row (label left, delta pill(s) right), value at a fixed offset, optional sub-line pinned to the tile bottom. No placeholder/empty sub-lines (`&nbsp;` banned), no two tiles with the pill in different positions, value baselines aligned across the band.
- G4 Padding rhythm: one padding system — cards 16/20, tiles 14/16, section gaps 16, band gap 12; no ad-hoc margins that visibly break the rhythm at 1440.
- G5 The composed page must survive the squint test a picky human designer would apply to a Linear/Stripe-grade dashboard: no region reads as accidentally empty, cramped, or misaligned at 1440×900 and at 1560+ (max container).

## H. Dataviz-skill compliance (the bundled `dataviz` skill's method is binding; its anti-patterns file is part of this rubric — check every chart against it)
- H1 Single axis, always: no chart plots two units on one scale, openly or covertly (a series multiplied onto another unit's axis is a hidden dual axis). Mixed-unit metric picks split into stacked single-axis panels or small multiples.
- H2 Palette is computed, not eyeballed: categorical pairs and the heatmap ramp pass `validate_palette.js` (categorical: lightness band, chroma floor, CVD ΔE, contrast; ordinal: monotone L, step gaps, light-end ≥2:1). Grey is not an identity hue for a data series.
- H3 Mark specs: lines 2px round join; markers ≥8px diameter with a 2px surface ring; bars thin with 4px rounded data-ends; stacked/adjacent fills separated by 2px surface gaps, never borders; gridlines solid hairline, recessive. Reference lines may be dotted (they mean "reference", data series are solid).
- H4 Figures: KPI/stat-tile and hero values use proportional figures (`tabular-nums` only in aligned columns/axes/tables). Text wears text tokens, never the series color (in-fill labels picked white/ink by luminance are the exception).
- H5 Labels: selective direct labels (endpoint/extreme/current), never a number on every point; a legend or chip-legend present for ≥2 series; single-series charts carry no legend box; no label clipped by its mark.
- H6 Status colors (--up/--down/--warn) appear only where they mean good/bad/warning — never as series identity; series colors come from categorical slots (--acc, --series-2).

## Severity
- P0 Critical/blocking: breaks the spec, looks broken or unprofessional, illegible text, broken layout, a banned item present, a required item absent, a behavioral requirement failing. Ships nothing with a P0.
- P1 Major: a required signature element weak/under-executed enough that the goal isn't convincingly met; an AA contrast failure; a real usability or coherence problem. Must be fixed before PASS.
- P2 Minor: polish nit; the goal is met without it. May remain.
