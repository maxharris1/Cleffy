# OMR RSI cycle 5

WP8 — WTC I Prelude 1 bar structure, via a new engraving-derived bar regrid.
Implemented and verified by an Opus agent in this session; single-piece runs
only, all 16 pieces individually checked. Pitch and printed time only.

**PR:** https://github.com/maxharris1/Cleffy/pull/41
**Baseline:** `6e5dcd8` — suite onGrid 93.4%, 4/16 pass, engine svc-15.

## Hypothesis → layer → delta → verdict

| Hypothesis | Layer | Diff | Measured (single-piece) | Verdict |
| --- | --- | --- | --- | --- |
| wtk1's 7 wrong bars: Audiveris threads the sustained bass, inner line, and upper line into one MusicXML `<voice>` sequentially, so onsets inherit the whole length of the voice they were glued onto; rhythmRepair then padded the damage further. But the PAGE is unambiguous: heads at one `default-x` sound together, right of it sounds later | engine (voice threading) + parser | **`barRegrid.ts`** (new): when a bar's onsets contradict the engraving, re-derive them from it — same-column heads sound together; within ONE printed voice (cut at stem-direction flips) each symbol starts where the last ended; nothing sounds past the barline and the bar is full. Applied ONLY when lower and upper bounds meet at every column and the bar fills exactly; otherwise left alone. Ties made contiguous. `musicxml.ts` carries `default-x`/`stem` on raw events; runs after meter reconciliation, before repair. New warning `bar_regridded` | wtk1: exact 81.6→94.4, onGrid 79.6→**94.0**, bar-length 7→2 of 35 (m25 engine over-read, m33 clef-glyph chord remain); note-length now passes | attributed |
| A repair candidate must never push a voice past the barline (the cycle-2 extent guard's fact, applied to the RESULT of an edit) | parser (`rhythmRepair.ts`) | refuse a candidate when `extentAfter > expected` | this is what turned wtk1 m1's 3360 into 4800 | attributed |
| bwv999's 2 residual overfull bars (mm. 5–6, Voice excess 3/16) are the same mis-threading class | engine + regrid | none beyond the above | bwv999: 100/95.7/95.7 → **100/100/100, 0 bad bars, gate FLIPS to pass** | attributed (unpredicted before the run — confirm in full bench) |

Verification: unit suite 498/498 (5 new regrid tests incl. refusal cases);
tsc + eslint clean. All 16 pieces run individually under svc-15: wtk1 and
bwv999 as above, **the other 14 byte-identical to HEAD** in rates and failure
lists. Projected suite: exact 94.2→~95.7, onGrid 93.4→**~95.1**, pass 4/16→**5/16**.

## Remaining wtk1 headroom (all engine-level, recorded for a future engine cycle)

- The last system's mid-system treble-clef return (printed end of m33) is never
  read — m34/35 resolve in bass clef, every pitch a 13th low: 13 miss + 13
  extra. Same class as the cycle-4 `ClefBuilder` fix (clef recognition).
- 4 undetected 16th noteheads in m6 (the 4 other missing notes).
- m33: a cautionary treble clef glyph read as an F2+D3 chord (the extra note).
- m25: inner dotted-eighth over-read as a quarter (1 bad bar).

## Standing notes

- The regrid runs on every piece; corpus blast radius measured (14/16
  byte-identical). Its accept condition is deliberately total: bounds must
  meet at every column AND fill the bar exactly, else no change.
- `remapMarks` (directions inside a regridded bar) has unit coverage only — no
  corpus piece prints a dynamic/pedal inside a regridded bar.

## Expected full-bench outcome (to be attributed against)

- wtk1 onGrid 79.6→~94.0 (+1.3 suite pts), bwv999 →100/100/100 pass.
- Suite onGrid ≈ **95.1%**, pass **5/16**. No other piece moves beyond the
  known ±0.2–0.3 pp engine jitter. No --force-audiveris (artifacts cached
  under svc-15; parser-only change).
