# Moonlight diagnostic (not a product gate)

Per-bar **pitch-multiset recall** of a ScoreData against the Mutopia Moonlight
edition, aligned by DTW so a merged or split bar costs itself. This is a
follow-along metric: onset, duration, and voice are not scored, so 69/69 is
not “triplets in the right place.”

It is **not** the corpus eval CLI. That lives in `src/eval/` on
`mh/omr-accuracy-eval` (PR #33: `eval`, fetch/hash/manifest, committed corpus
baseline). This tree is a Moonlight-only report used to measure the svc-12
repairs. CI does not run it.

`fixtures/moonlight/boundaries.json` pins each movement to an engraved-index
range (`lo`/`hi`) and marks which movements are gated. On the committed
svc-12 baseline only movement I is gated (69/69). II (10/60) and III (140/201)
are reported and do not fail the process.

```bash
npm run eval:moonlight -- --score score.json    # a ScoreData JSON
npm run eval:moonlight -- --dir audiveris-out/  # build ScoreData from Audiveris .mxl + .omr first
EVAL_DOCUMENT_ID=<uuid> npm run eval:moonlight  # local Postgres; UUID required (no title search)
npm run eval:moonlight -- --score score.json --record-baseline
```

Exit status 1 when a **gated** movement has any bar under the bar (`--gate`,
default 0.9). `--record-baseline` writes `fixtures/moonlight/baseline.json`
regardless of exit status — that file is a changelog, not a green check.

## Fixture: Moonlight Sonata (Beethoven, Op. 27 No. 2)

`fixtures/moonlight/moonlight{1,2,3}.mid` are the three movement MIDIs of the
Mutopia Project edition by Stewart Holmes,
<https://www.mutopiaproject.org/ftp/BeethovenLv/O27/moonlight/>, licensed
Creative Commons Attribution-ShareAlike 2.5. See `fixtures/moonlight/ATTRIBUTION.txt`.
`boundaries.json` gives beats per bar, pickup, engraved `lo`/`hi`, and `gated`.

The PDF Audiveris is run on for the recorded baseline is the same edition's
`moonlight-a4.pdf` (23 pages, LilyPond). It is not vendored here; the 90%
figure cannot be regenerated from this tree without fetching that PDF.

```bash
docker build -t cleffy-omr services/omr-service
docker run --rm -v "$PWD/tmp:/m" --entrypoint /opt/audiveris-root/opt/audiveris/bin/Audiveris cleffy-omr \
    -batch -export -output /m/out \
    -option org.audiveris.omr.sheet.ProcessingSwitches.lyrics=false \
    -option org.audiveris.omr.sheet.ProcessingSwitches.implicitTuplets=true \
    -option org.audiveris.omr.sheet.ProcessingSwitches.fingerings=true \
    -- /m/moonlight-a4.pdf
npm run eval:moonlight -- --dir tmp/out
```
