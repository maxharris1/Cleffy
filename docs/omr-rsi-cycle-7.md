# OMR RSI cycle 7

**Verdict: reject and revert the 400-dpi option experiment. Goal remains 16/16;
accepted baseline remains 5/16.** No scorer, pin, floor, or allowance changed.

Baseline: cycle 6 (`2dcd61d`), fresh svc-15 recognition at the existing
300-dpi default. All subsequent comparisons use its frozen, hash-checked
PDF/reference inputs. Astra orchestrated; Luna implemented the experimental
option in `src/audiveris.ts` and its option-vector test in
`src/audiveris.test.ts`. Astra did not implement the first source change.

## Hypothesis → layer → diff → suite delta → verdict

One hypothesis, named pieces `bach-invention-08`, `anna-magdalena-07`, and
`chopin-prelude-4`: rendering their pinned vector PDFs at 400 dpi could recover
the small printed heads/rests/tuplet symbols absent from 300-dpi recognition.
The layer was Audiveris input rasterization, via
`org.audiveris.omr.image.ImageLoading.pdfResolution=400` in the shared option
vector. Upstream `ImageLoading.java` confirms the original 300-dpi default.

This was a probe, not a proven aliasing diagnosis. Invention 8's m10 binary
image already contains crisp C4 ink; Luna's separate beam-link hypothesis was
killed because there is no C4 head/ledger object to link. The lost C4's first
divergence is ledger/head recognition, not a broken surviving beam relation.

Kill criteria: no target symbol/bar improvement; any currently passing piece
going red; invented timing/symbols; or gains that cannot be attributed to page
recognition. **The protected-pass criterion fired.**

| Observation | Attribution / consequence |
| --- | --- |
| Schumann 68/1: pass → **FAIL**, four holds vs the existing printed allowance | Invented holds violate the product lock. Sufficient on its own to reject the option. |
| Invention 8: m10 becomes 1440 ticks; m34 underfull warning disappears; m11 and m33 become 1680 ticks | The resolution change replaces the original structural damage with other overfull bars. Still fails. C4 is read as D4 at m10, not correctly recovered. |
| Anh. 116: exact 96.4516% → 97.4194%, same one overfull bar and warning | No complete target pass. |
| Chopin: movement meter cannot bind; zero scored bars | Its displayed zero note rates are consequences of failed meter binding, not evidence that Audiveris detected zero notes. No pass. |
| BWV 939: extras 16 → 14 | Page/OMR/XML comparison locates recovery of the A4 and F3 ties. C3 attacks in m2/m3 remain unexplained, and the piece still fails. |
| Air: exact 92.7835% → 97.9381% | Structural/pin/repeat failures remain; no pass. |
| WTC and Für Elise: exact 94.3534% → 68.8525% and 94.5856% → 69.3923% | Additional substantial regressions; no reason to keep this global option. |

Full probe: **4/16**, exact **80.47031354236158%**, onGrid
**78.65243495663776%**, 735 missing, 154 extra. The missing total includes
the invalid Chopin movement slice above. These are rejected-experiment results,
not the accepted branch's quality. All 16 rows and their failed check IDs are
retained in [the rejected report](../services/omr-service/eval/results/rsi-cycle-7-400dpi/bench.json)
and [its readable version](../services/omr-service/eval/results/rsi-cycle-7-400dpi/bench.md).

Validation: 29/29 focused Audiveris tests; full unit suite 498/498; build,
typecheck, and engine-version check passed before unrelated subsequent source
work. Root ran `CLEFFY_OMR_CONTAINER=cleffy-rsi-omr npm run eval -- bench
--force-audiveris` over all 16 pinned inputs. It wrote the complete report;
the command wrapper later returned 143. The full cached recheck completed with
exit 1 and reproduced all 16 piece rows (including artifact hashes) and all
totals exactly. The source option and corresponding test change
were reverted by exact path. The original 300-dpi artifacts remain intact under
their original options cache key.

## Parallel, isolated localization assignments

Each was one named-piece hypothesis and required that no current pass go red:

- [BWV 939](omr-rsi-bwv939-localization.md): investigate missing/misassigned
  engraved ties, not ornament allowances. Upper C3 curves are absent before XML;
  no rule was implemented that invents ties for an entire chord.
- [Czerny 821/1](omr-rsi-czerny-localization.md): the 12 wrong notes are octave
  substitutions at the printed ottava (8 in m6, 4 in m7). The 300-dpi OCR word
  is `811a`; no corresponding upper-staff octave-shift is exported. Zero residual
  missing/extra counts are explained by the official scorer's octave category.
  A proposed OCR-plus-dash recognition rule requires independent surviving
  geometry before implementation; text alone is insufficient.
- [Schumann 68/5](omr-rsi-schumann5-localization.md): the source's three-quarter
  pickup includes a leading invisible `s4`; the OMR/XML starts the first notes
  at zero and carries only two quarters. The first divergence precedes Cleffy.
  No generic pickup padding or downstream shift was applied.

The next parser experiment concerns Air's repeat traversal. It is separate
from this resolution probe, uses the frozen 300-dpi cache, and requires an
independent, page-supported traversal before acceptance. Its unit tests alone
cannot establish what the page means.
