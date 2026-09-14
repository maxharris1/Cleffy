# OMR RSI cycle 3

WP5 — the Für Elise volta whale. The change set was authored by a peer session
in this worktree; this ledger records its independent adversarial verification
(Opus agent, single-piece runs from cache only) before commit.
Pitch and printed time only.

**PR:** https://github.com/maxharris1/Cleffy/pull/41
**Baseline:** `e0b54d9` — suite onGrid 75.7%, 4/16 pass.

## Hypothesis → layer → delta → verdict

| Hypothesis | Layer | Diff | Measured (single-piece) | Verdict |
| --- | --- | --- | --- | --- |
| Für Elise's first `\repeat volta` borrows an eighth: the first ending is a printed 2/8 bar completed by the anacrusis on the retake; the straight-through reference MIDI therefore runs an eighth out of phase with the engraved barlines from bar 9 on, and the scorer's uniform bar grid pairs two thirds of the notes at wrong onsets | scorer pin model (`manifest.ts` `partialBars`, `midiRef.ts` walked grid) + corpus (engraved convention: printedBars 106, performedBars 127, partialBars [{bar:8, quarters:1}]) | walk the reference grid over declared engraved short bars | pitch 72.2→95.8, exact 31.9→94.6, onGrid 30.5→**94.0**, miss/extra 192/192→24/24; printed-bar-count, bar-alignment now pass | attributed |
| The short first-ending bar is short BY DESIGN (Gould): rhythmRepair must not pad it, and the repeat must retake from the anacrusis | parser (`rhythmRepair.ts` `completesAnacrusis` exemption; `musicxml.ts` `pad` plumbing; `buildScoreData.ts` predicate; `repeats.ts` retake-from-bar-0) | exempt + retake when: real anacrusis, bar short by exactly it, carries `:|`, no `|:` anywhere before | performed bars 127 = pin; repeat-walk passes honestly (was passing at 126 via offsetting defects) | attributed |
| Für Elise's 2 invented holds are stray inter-system glyphs Audiveris bound as breath/caesura articulations | parser (`musicxml.ts` `breathOf`: drop a breath-mark/caesura whose `default-y` > 40 tenths above the top staff line; marks without `default-y` trusted) | one-sided geometric filter | holds 2→0; no-invented-hold passes. Swept all cached artifacts: fur-elise is the ONLY corpus piece with any breath/caesura element, so the filter is provably inert elsewhere | attributed |

Verification detail: the `.ly` (sha `828a7bd1…`) and the 600-dpi rendered page both
show the narrow 2/8 first-ending bar (`a'4` over `a,16 e a r`) and the full-width
second ending with an invisible `\bar ""` — the pin is read off the engraving,
not the parser. Controls all byte-identical: anna-magdalena-04/05/07,
burgmüller (repeat-walk still active at 55), schumann-op68-05, bwv939,
chopin-prelude-4 (onGrid 97.3 held). Unit suite 493/493.

## Standing concerns (recorded, not blocking)

- **`completesAnacrusis` false-positive surface.** schumann-op68-05 already has
  `m0` misread (960 ticks vs the printed 1440) *and* a bar padded by exactly 960
  — only the absence of any `:|` in that piece keeps both rules from firing. If
  a future piece misreads its pickup and repeats its opening section, the rule
  could suppress a legitimate repair and double-play a wrong-length anacrusis.
  Tightening candidate: also require the bar to sit under a volta ending.
- **Two pickup detectors disagree** (inherited): `rhythmRepair.anacrusisTicks`
  uses `isPickup` (implicit/number-0) while `buildScoreData` uses `n === 0`. A
  score where they diverge gets the repair exemption without the retake.
- **`partialBars` is unfalsifiable by the scorer** — page-derived by
  construction, verified manually here. The manifest docstring ("read off the
  ENGRAVING, never the parser's output") is the whole guard; any future entry
  needs the same independent page check.
- Für Elise still FAILs the gate by 0.4 exact points (94.6 vs 95.0) with
  24 miss / 24 extra (7 allowed) and the pre-existing bar-length pair (3 of 106,
  underfull+overfull warnings). Next headroom on this piece: the residual 24/24
  and 3 wrong-length bars.

## Full-bench outcome (orchestrator run at `3f63cc9`, no --force-audiveris)

**Suite onGrid 75.7% → 85.2%, pass 4/16 (unchanged).** Für Elise landed exactly
at the single-piece prediction (95.8 / 94.6 / 94.0, 24 miss / 24 extra) and no
other piece moved a digit. Suite missing 365→197, extra 407→239. Fully
attributed — no unexplained deltas.

## Expected full-bench outcome (to be attributed against)

- fur-elise-mutopia: 9 → 5 failing checks, onGrid 30.5 → 94.0 on 905 notes
  → suite onGrid ≈ 75.7 + ~9.6 ≈ **~85.3%**; pass count stays 4/16 (Für Elise
  misses attack-grid by 0.4).
- No other piece moves. No `--force-audiveris` (option vector and artifacts
  unchanged).
