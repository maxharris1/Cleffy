# OMR accuracy eval

Gates a transcription against a reference edition, bar by bar: every engraved
bar must have at least 90% of the reference's notes present at the right pitch
(pitch multisets per bar, aligned by DTW so a merged or split bar costs itself
and not everything after it).

```bash
npm run eval:moonlight                          # newest ready "moonlight" analysis in local Postgres
npm run eval:moonlight -- --score score.json    # a ScoreData JSON
npm run eval:moonlight -- --dir audiveris-out/  # build ScoreData from Audiveris .mxl + .omr first
npm run eval:moonlight -- --record-baseline     # store the result as fixtures/moonlight/baseline.json
```

Exit status 1 when any bar is under the gate. `--gate 0.8` changes the bar.

## Fixture: Moonlight Sonata (Beethoven, Op. 27 No. 2)

`fixtures/moonlight/moonlight{1,2,3}.mid` are the three movement MIDIs of the
Mutopia Project edition by Stewart Holmes,
<https://www.mutopiaproject.org/ftp/BeethovenLv/O27/moonlight/>, licensed
Creative Commons Attribution-ShareAlike 2.5. `boundaries.json` gives each
movement's beats per bar and pickup; `lo`/`hi` may pin a movement to an
engraved-measure index range when the printed numbers do not restart between
movements.

The PDF Audiveris is run on for the recorded baseline is the same edition's
`moonlight-a4.pdf` (23 pages, LilyPond). To regenerate the artifacts with the
service's Docker image:

```bash
docker build -t cleffy-omr services/omr-service
docker run --rm -v "$PWD/tmp:/m" --entrypoint /opt/audiveris-root/opt/audiveris/bin/Audiveris cleffy-omr \
    -batch -export -output /m/out -option Book.Lyrics=false -- /m/moonlight-a4.pdf
npm run eval:moonlight -- --dir tmp/out
```
