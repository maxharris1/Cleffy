# OMR RSI cycle 6

Goal remains **16/16 `playAlongGate` passes**. Starting branch:
`mh/omr-rsi-notes-fixes-c12b`, `dba73df`, PR #41. Astra orchestrated;
three `gpt-5.6-luna` assignments investigated the three isolated bar-length
failures separately. Source edits were serialized by ownership; none of the
initial parser hypotheses justified a parser edit.

The supplied pass-all plan and Astra review were read without modification.
Pitch and printed time only; floors, allowances, pins, and scorer are unchanged.
Every assignment required that no currently passing piece may go red.

## Environment and reproducible baseline

This host initially had neither an OMR container nor cached corpus artifacts.
The first `npm run eval -- bench` failed on the absent `cleffy-local-omr`.
The checked-in Dockerfile successfully built `cleffy-omr-rsi:svc-15`; an
isolated engine-only container, `cleffy-rsi-omr`, now runs Audiveris 5.11.0.
No service was deployed. The engine is therefore available for this loop.

- Image ID: `6a5da8ae3ad1a2d8b8e44316adfef0db1cc703b53b573c37965b91ccacca4559`.
- Patched `audiveris.jar` SHA-256:
  `f7af6a98aac74e97bc867f762e87ff4bc310f212edd9742ab6b233eac565ae2b`.
- Baseline command: `CLEFFY_OMR_CONTAINER=cleffy-rsi-omr npm run eval -- bench`
  from `services/omr-service`. Every PDF and reference passed its existing hash
  check. Empty cache required fresh recognition; no options were changed.
- Unit suite: **498/498**. Build, typecheck, and `check:engine-version` passed.
- All gate checks are populated for all 16 pieces; none is skipped.
- End-of-cycle full cached bench rerun completed (exit 1 for the 11 real
  failures): all 16 piece metrics, failed checks, artifact hashes, and totals
  are identical to the frozen fresh baseline. No parser/eval code changed.
- Fresh full baseline: **5/16**, 5,996 reference notes, 121 missing, 163 extra;
  exact **95.78052034689793%**, onGrid **95.0133422281521%**.

All pitch/exact/missing/extra counts and failure lists reproduce the committed
baseline. The fresh engine has two fewer duration matches in Für Elise
(851/905 instead of 853/905); this moves suite onGrid by -0.03335557038025
percentage points and flips no gate. The previous raw artifacts were unavailable,
so this historical duration delta is **unattributed**, not an implementation
effect. New artifacts, full per-bar results, gates, and ScoreData are frozen in
`/tmp/omr-rsi-baseline/` for subsequent A/B comparisons. The official bench files
record the fresh artifact hashes. Fresh recognition is not byte identity with
the unavailable historical artifacts; subsequent parser cycles reuse this cache.

## Hypothesis → layer → diff → suite delta → verdict

| Named piece / hypothesis | First divergence and responsible layer | Diff | Suite delta / verdict |
| --- | --- | --- | --- |
| `bach-invention-08`: the remaining bar-length failure is a duration/voice interpretation defect | m10 XML drops printed C4 and exports E4 as a quarter instead of an eighth, yielding 1680 rather than 1440 ticks. m34 XML omits a trailing printed rest; padding leaves the honest underfull warning. m19 is metrically full and has a separate missing E4. Engine recognition/export. | Localization packet only | No attributable gain. Parser hypothesis killed: changing explicit durations, adding unseen notes, or hiding the warning would violate the lock. |
| `anna-magdalena-07`: its isolated overfull bar is a duration/voice interpretation defect | m23 prints a 3:2 eighth-note triplet. XML instead exports 6,9,6,12,12 divisions (45) against 36 expected, with a false dot and wrong third pitch. OMR already reports duration 15/16 vs expected 3/4; its surviving tuplet is misplaced in m24. Engine rhythm/symbol recognition. | Localization packet only | No attributable gain. Parser hypothesis killed: no printed triplet survives in m23 XML to interpret. |
| `chopin-prelude-4`: its isolated overfull bar is a duration/voice interpretation defect | m12 prints a bracketed triplet; XML emits nine ordinary eighths without tuplet timing, yielding 2160 rather than 1920 ticks. Engine recognition. | Localization packet only | No attributable gain. Filling the bar with inferred tuplets is prohibited. |

Packets: [Invention 8](omr-rsi-invention8-localization.md),
[Anh. 116](omr-rsi-anh116-localization.md),
[Chopin](omr-rsi-chopin-localization.md).

The five protected passes remain BWV 999, Anh. 114, Anh. 115,
Burgmüller Op. 100/2, and Schumann Op. 68/1. The first three targets remain
failing. Recognition probes must precede any further repair of their XML.

## Remaining queue, from official check IDs

No remaining piece is dismissed as a harness issue:

| Piece | Still failing |
| --- | --- |
| BWV 939 | `no-invented-notes`: four unexplained extras after the existing 12 ornament extras; page sites m2, m3, m8, m15 have ties requiring localization. |
| Czerny 821/1 | `attack-grid`: 140/152 exact. The 12 errors are classified as octave substitutions (8 in m6, 4 in m7), explaining zero residual missing/extra counts. |
| Schumann 68/5 | `bar-length-warning`, `printed-bar-count`, `bar-alignment`, `bar-length`, `repeat-walk`, `notes-present`, `no-invented-notes`, `attack-grid`, `note-length`. Start with m0 at 960 ticks versus the page's three-quarter pickup. |
| Air Anh. 131 | `bar-length-warning`, `printed-bar-count`, `bar-alignment`, `bar-length`, `repeat-walk`, `attack-grid`. The first split is at the first repeat boundary and following short bar. |
| WTC I Prelude 1 | `bar-length-warning`, `bar-length`, `notes-present`, `no-invented-notes`, `attack-grid`; m6, m25, m33–35 remain localized targets. |
| Für Elise | `bar-length-warning`, `bar-length`, `notes-present`, `no-invented-notes`, `attack-grid`; 24/24 remains, with bad lengths at m13, m25, m31. |
| Invention 1 | `notes-present`, `no-invented-notes`, `attack-grid`; exact is **435/458 = 94.97816593886463%**, below 95 despite rounded display. The 23 misses pair with extras at m9–10. |
| Gymnopédie 2 | `bar-length-warning`, `bar-length`, `notes-present`, `attack-grid`, `note-length`; ten overfull bars require XML-first classification. |

Cycle disposition: reject speculative parser changes, preserve the baseline,
and continue with bounded engine and ranked-piece investigations. **Not 16/16.**
