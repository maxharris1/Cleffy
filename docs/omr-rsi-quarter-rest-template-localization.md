# Quarter-rest template localization

**Historical localization and isolated probes.** The locked-split cycle-15
implementer did not execute the engine or reproduce these isolated runs.
The [cycle-15 ledger](omr-rsi-cycle-15.md) identifies the reconstructed candidate,
current standalone checks, and pending official host bench. Results below are
evidence for the hypothesis, not an acceptance source for that candidate.

This packet tests one hypothesis across `bach-air-anh131` m14, `bach-invention-08` m34, and `gymnopedie-2` m25/m30: a printed quarter rest survives binarization as a free `SYMBOL` glyph, but its weak classifier score causes the normal `RestInter` to be deleted. A same-page image template from a strongly classified quarter rest can provide an independent confidence signal while using the existing classifier, `RestInter` factory, and weak-inter cleanup path.

No rest is inferred from duration or voice timing. The omitted symbols are visible ink at the following saved-artifact boxes:

```text
Air m14:       glyph 2877, x1719 y1443 w21 h59, staff 4
Invention m34: glyph 5241, x2228 y1750 w22 h58, staff 7
               glyph 5242, x2228 y1958 w22 h58, staff 8
Gym m25:       glyph 6514, x1778 y1363 w22 h59
Gym m30:       glyph 6232, x757  y1868 w22 h59
```

## Raster evidence

The source XMLs are the saved svc-15 Air/Gym artifacts and the svc-18 Invention artifact. [`compare_masks.py`](/tmp/omr-rsi-quarter-rest-template-probe/compare_masks.py) decodes each vertical run table with its required initial foreground state, then searches translations within three pixels. It reports foreground intersection-over-union and foreground-plus-background agreement over the union canvas. Full output is [`mask-comparison-corrected.txt`](/tmp/omr-rsi-quarter-rest-template-probe/mask-comparison-corrected.txt).

The omitted glyphs match accepted same-page quarter rests at the same staff scale:

```text
Air 2877 -> 2788: 21x59/21x59, shift 0,0, foreground IoU .997877, agreement .999193
Air 2877 -> 2790: 21x59/22x59, shift 1,0,   foreground IoU .884692, agreement .955316
Air 2877 -> 2802: 21x59/22x59, shift 1,0,   foreground IoU .925253, agreement .971495

Inv 5241 -> 5243: 22x58/22x59, shift 0,0, foreground IoU .895582, agreement .959938
Inv 5241 -> 5244: 22x58/22x59, shift 0,0, foreground IoU .848837, agreement .939908

Gym 6514 -> 6451: 22x59/22x59, shift 0,0, foreground IoU .882937, agreement .954545
Gym 6514 -> 6282: 22x59/22x59, shift 1,0, foreground IoU .921212, agreement .971260
Gym 6232 -> 6282: 22x59/22x59, shift 1,0, foreground IoU .948240, agreement .981577
```

The Gym target also matches 6224 at IoU `.882937` and agreement `.954545`; the 6232-to-6451 and 6232-to-6224 matches are IoU `.863095`, agreement `.949153`. The saved SIG grades for these inters are contextual grades after `RestInter` weighting, so they are not used as prototype-strength evidence. The refined probe requires the original classifier result to meet `Grades.validationMinGrade` (the pinned default is `.80`) before a glyph can become a prototype.

Controls remain clearly unlike a quarter rest. For Air target 2877, the best aligned values are:

```text
FLAG_1_DOWN 5668: 22x53, foreground IoU .251724, agreement .681818
DIGIT_3     3308: 16x24, foreground IoU .229287, agreement .677159
DIGIT_4     6483: 23x32, foreground IoU .222222, agreement .683616
COMMON_TIME 143:  36x43, foreground IoU .325193, agreement .771838
REPEAT_DOT  2905:  9x10,  foreground IoU .044834, agreement .604520
```

The flag and digit controls come from other pinned 300-dpi saved pages because these three target pages contain no `FLAG_*` or `DIGIT_*` inter. Same-page unrelated controls are the Air common-time/repeat-dot, Invention sharp (IoU `.394170`, agreement `.680268`) and notehead (IoU `.280702`, agreement `.685824`), and Gym augmentation dot (IoU `.048733`, agreement `.624037`) and notehead (IoU `.271659`, agreement `.688638`). Thus the proposed match is based on the near-identical rest silhouette and dimensions, not a generic dark connected component.

## Refined isolated implementation probe

The temporary source copy is [`SymbolsBuilder.java`](/tmp/omr-rsi-quarter-rest-template-probe/src/org/audiveris/omr/sheet/symbol/SymbolsBuilder.java), compiled only into [`audiveris-template-refined.jar`](/tmp/omr-rsi-quarter-rest-template-probe/audiveris-template-refined.jar), SHA-256:

```text
9473204914937b2244cd9318b7c59586a5e618ea85efc7c64bcc8ce46e8e62b5
```

Before cluster processing, it clears its cache and collects page-wide glyphs whose original `CHECKED` classifier result is `QUARTER_REST` at grade `>= Grades.validationMinGrade` (`.80`). Each candidate and prototype must have an unambiguous staff association, matching staff-specific interline within ten percent, and normalized center ordinate within `.75` interlines. Run-table masks are cached once. Dimension and translation tolerances scale from the smaller staff interline at `.15` interline, rather than fixed pixels. A target already returned by the normal classifier as `QUARTER_REST` can be promoted only when both mask recalls are `>= .90` and IoU is `>= .85`; its new grade is `prototypeGrade * IoU`, so imperfect similarity cannot copy full prototype confidence. The candidate still goes through ordinary `InterFactory` creation and `SigReducer.deleteWeakInters`; no global symbol/contextual floor is changed and no below-gate evaluation is synthesized. Consequently Invention glyph 5242 (`QUARTER_REST=.103955679`) remains below the existing symbol gate `.15` and is not promoted.

The executable controls are [`template-controls.py`](/tmp/omr-rsi-quarter-rest-template-probe/template-controls.py). They verify that a perfect same-glyph mask is rejected by the identity guard, the actual Air mask is rejected when assigned a one-interline wrong staff-relative position, 5242 remains below `.15`, and actual flag/digit masks have IoU below `.5`. The control output is:

```text
same-glyph mask: IoU=1.000000, rejected by identity guard
wrong staff-relative placement: same 21x59 mask family, delta=1.0 IL, rejected
Invention 5242: classifier=.103955679 < symbolMinGrade=.15, rejected
flag: IoU=.251724, rejected; digit3: IoU=.229287, rejected; digit4: IoU=.222222, rejected
```

The refined jar was run end-to-end in `cleffy-omr-rsi:svc-19` with the pinned PDFs and original options (`lyrics=false`, `implicitTuplets=true`, `fingerings=true`). Input PDF SHA-256 values are Air `2421e97393ee1b476897314326409e0ea3e25e3ceb6d4bf215342e709be35af5`, Invention `5323449d08aa5031e974e275f182bebf8f533ecf62e5f9b0c9c36364f4b66469`, and Gym `d23906c422539128fe0e5106a4ebf8ea7f8273a60c3f2dbcf4c7f5f46363acb6`. It produced these target observations:

* Air output [`air-refined-mxl-out/bach-air-anh131.mxl`](/tmp/omr-rsi-quarter-rest-template-probe/air-refined-mxl-out/bach-air-anh131.mxl), SHA-256 `332150eaf312e51231026dc2f78640da011f91162e7ee6cf7ec627fde7f59dfe`, contains the m14 lower voice sequence A2 half, explicit quarter rest, B2 quarter. OMR SHA-256 is `8c67b6d8b8679bf6328763654d520a915aa4fefe0f4052b392ca13d453711d91`.
* Invention output [`inv8-refined-mxl-out/bach-invention-08-let.mxl`](/tmp/omr-rsi-quarter-rest-template-probe/inv8-refined-mxl-out/bach-invention-08-let.mxl), SHA-256 `60c7fc9b062f19f77686e49a8226afd0ab67b8ff05c094452d179517912da6d5`, adds the first upper-staff m34 quarter rest (voice 2, duration 4) while preserving the existing second rest. The lower-staff glyph 5242 remains absent. OMR SHA-256 is `814e993b1e0fbc229eb62a77e9ac4b4e1bc140457c5a58fcd4771f6b2165e942`.
* Gym output [`gym-refined-mxl-out/gymnopedie-2.mxl`](/tmp/omr-rsi-quarter-rest-template-probe/gym-refined-mxl-out/gymnopedie-2.mxl), SHA-256 `b9d0adf088903884ea478deda4b31b06b5ebff292f1876fb7d68d7f81f7366ed`, adds the first quarter rest in both m25 and m30 (staff 1, voice 2, duration 1 quarter) alongside the existing notes. OMR SHA-256 is `1f612580b183f4a38b75c1dff6646e60856a17ae9e825f3a639a7dce4b6be6b7`.

The official comparator was run against each temporary output with `/tmp/omr-rsi-eval-artifacts.mjs`; its result files are under [`official-air`](/tmp/omr-rsi-quarter-rest-template-probe/official-air), [`official-inv8`](/tmp/omr-rsi-quarter-rest-template-probe/official-inv8), and [`official-gym`](/tmp/omr-rsi-quarter-rest-template-probe/official-gym). Air passes exactly (`97/97` notes, `100%` pitch/exact/on-grid, no missing or extra). Invention remains rejected (`596/598` notes, `99.67%` pitch, `98.66%` exact, `97.83%` on-grid, two missing and one overfull bar), because the below-gate lower rest is intentionally retained as a negative. Gym remains rejected (`375/371` notes, `98.65%` pitch, `94.07%` exact, `90.84%` on-grid, four extras, four bar-length failures, and the `95%` exact floor miss); this probe does not claim a Gym pass.

These target XML changes are attributable to measured glyph templates and preserve printed rests through the existing producer path. The strict refinement rejected the intentionally below-gate and wrong-staff controls; no floor exemption or inferred rest is used. These are target-only probe results, not benchmark pass claims. The production source, scorer, parser, defaults, floors, pinned version, and seven-piece regression baseline were left untouched; root owns source review and the full-suite decision.
