# OMR RSI cycle 4

WP6 — the BWV 999 octave-clef whale, resolved at the engine layer. Engine
revision `audiveris-5.11.0+svc-15`: the official 5.11.0 release with one
vendored, reviewable `ClefBuilder` patch (see
`services/omr-service/engine-patches/`). Implementation and verification by an
Opus agent in this session; single-piece runs only.

**PR:** https://github.com/maxharris1/Cleffy/pull/41
**Baseline:** `a2eaae0` — suite onGrid 85.2%, 4/16 pass.

## Hypothesis → layer → delta → verdict

| Hypothesis | Layer | Diff | Measured (single-piece) | Verdict |
| --- | --- | --- | --- | --- |
| Audiveris keys clef candidates by `ClefKind`, so `G_CLEF_8VB` (grade 0.035) can never beat plain `G_CLEF` (0.798) for the `TREBLE` slot; the engraving, not the classifier's confidence, must arbitrate | engine (`ClefBuilder`, patched class injected into the shipped `audiveris.jar` at image build; JDK 25, classes verified with javap) | `promoteOctaveClef()`: an octave clef supersedes the plain reading only when the octave candidate's glyph strictly contains the plain clef's glyph with more ink, the classifier's own `G_CLEF` grade collapses to ≤0.5 of its contained-body grade on the larger glyph, and the extra ink sits beyond the staff on the digit side spanning 0.5–2.5 interlines | bwv999: pitch 15.5→**100.0**, onGrid 0.4→**95.7**, miss/extra 76/76→**0/0**, composite 34.0→89.1; `G_CLEF_8VB` on all 14 staves, `<clef-octave-change>-1</clef-octave-change>` in the export. Still FAIL on exactly the 2 predicted residual bars (`bar-length` 2 of 43, Voice excess 3/16 in mm. 5–6) | attributed |

Controls (fresh engine runs under svc-15): chopin-prelude-4, anna-magdalena-04,
schumann-op68-01 identical to baseline; fur-elise +0.22 pp onGrid, investigated
and cleared — svc-14-rollback vs svc-15 on the same PDF produce **0 differing
MusicXML lines**, while two runs of the *same* image differ identically
(dot-vs-staccato reduction). Unit tests 493/493; app-side 67/67.

## Operational notes

- **The artifact cache is fully invalidated** (`ENGINE_VERSION` keys it): the
  next full bench re-runs Audiveris on every page, ~50 s/page on this host.
  Five pieces are already warm under svc-15.
- **Audiveris is not run-to-run deterministic** on the augmentation-dot /
  staccato reduction: expect ±0.2–0.3 pp onGrid noise on staccato-heavy
  pieces, independent of any code change. Do not read sub-0.5 pp moves as
  signal. (This is why byte-identical artifact caching exists.)
- `cleffy-local-omr` now runs `cleffy-omr:svc-15` (recreated via compose with
  identical config; healthz reports svc-15). Instant rollback:
  `cleffy-omr:svc-14-rollback`.
- A spurious or near-miss octave promotion is self-reporting: the engine log
  prints the measured digit geometry and grade decay per staff — grep
  `octave clef` in the artifact's `audiveris.log`.
- `CURRENT_ENGINE_GENERATION` 14→15 app-side; `DEPLOYED_ENGINE_GENERATION`
  stays 6 until the image actually deploys.

## Expected full-bench outcome (to be attributed against)

- bwv999 onGrid 0.4 → ~95.7 on 509 notes → suite onGrid ≈ 85.2 + ~8.1 ≈
  **~93.3%**; bwv999 stays FAIL (2 wrong-length bars), pass count expected
  4/16 ± engine-jitter on near-floor pieces.
- All other pieces should reproduce within the ±0.2–0.3 pp jitter band; any
  larger move is unexplained and must be investigated against the engine log.
