# OMR RSI cycle 10

**Accepted: 6/16.** This cycle tests one Luna engine hypothesis for
`czerny-op821-01`: a printed m6 octave mark read as OCR direction text can be
recovered from its value glyph and measured dashed span. Astra reviewed and
attributed the complete suite before accepting it. No currently passing piece
may go red.

## Hypothesis → layer → diff

The page and OMR preserve an `8va` value (OCR `811a`) and 21 horizontal dashes
above the m6 upper staff. The XML contains no corresponding octave shift.
`TextBuilder` now creates the existing octave-shift interpretation only when
that OCR value has an anchored, interline-scaled dash chain reaching the system
edge. `OctaveShiftInter.createMeasured()` retains actual line geometry for normal
chord linking. Text without dash evidence, detached chains, interior spans, and
existing overlapping shifts are rejected. No pitch-pattern inference is used.

Review rejected an initial TextBuilder-only proposal because the existing factory
uses a fixed short line; the bounded measured-line API resolves that limitation.
An early proposal to reassign the m7 continuation across systems was removed.
Review also caught an unset ALTA/BASSA kind: bounds must exist before staff
assignment derives the kind. These findings and the remaining four m7 octave
errors are retained in [the localization packet](omr-rsi-czerny-localization.md).

Only the two engine classes, their reproducible upstream patch, Docker compilation,
and engine revision change. Parser, scorer, pins, floors, and allowances do not.
`DEPLOYED_ENGINE_GENERATION` remains 15; this is an evaluation image, not deployment.

## Validation

The matching Audiveris 5.11.0 / JDK 25 image is
`cleffy-omr-rsi:svc-16`, SHA256
`8d07fe16f386c7c6374a60a7d03a614d5300fced391e67d389d673fd9ceef000`.
The final shipped jar SHA256 is
`a4919eb53754c48504e458b373bd2692faab20cebcb08e47fe8a01e1f2a3907e`.
The corpus uses the same 16 pinned PDF/reference hashes and unchanged options
(`lyrics=false`, `implicitTuplets=true`, `fingerings=true`), with option hash
`70115b6766485bc3d380ec66f10be4cde4283e4f6031a606a671c9575aa2883f`.
Fresh artifacts use svc-16 cache paths; svc-15 artifacts are preserved.

The full unit suite passes **509/509**; engine compilation, service build and
typecheck pass. The full command was
`CLEFFY_OMR_CONTAINER=cleffy-rsi-omr-16 npm run eval -- bench --force-audiveris`.
All 16 pieces completed and the report was written; the outer wrapper subsequently
returned 143. The complete cached `npm run eval -- bench` recheck returned 1 for
the ten remaining failures and reproduced all piece metrics and artifact hashes.

## Suite delta and attribution

Czerny recovers eight m6 octave pitches: pitch/exact/on-grid **140/152 → 148/152**
(92.10526315789474% → 97.36842105263158%), with zero missing/extra. Its last failing
check clears. The four m7 octave substitutions remain visible. All five previously
passing pieces stay green. The other 14 pieces have identical result rows.

Für Elise on-grid changes by two notes, 851/905 → 853/905, with identical
pitch/onset/missing/extra and gate failures. Both notes are the D5/F5 chord in
reference bar 73: ScoreData durations change 432 → 648 ticks. A separate fresh
run using the original svc-15 jar, identical pinned PDF and original options
reproduces 853/905 and every other svc-16 Für Elise metric. Historical dba73df
also reported 853/905. The control artifacts are preserved separately at
`/tmp/omr-rsi-fur-control-15`, hash
`e83706e7612dce6d49d8ed736db9369f3fc00e356fb929993d38ed801bf36054`.
This is original-engine recognition variance, not an octave-mark improvement.
Three additional short-note duration changes do not alter any gate metric;
they remain part of the artifact audit.

Suite totals: **6/16**, 5,996 reference notes, 119 missing, 161 extra, pitch
97.46497665110073%, exact 95.9472981987992%, on-grid 95.21347565043362%.
The target remains 16/16.

**Verdict: keep.** No currently passing piece went red; ten pieces remain failing.
