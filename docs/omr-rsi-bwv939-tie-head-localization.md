# BWV 939 tie-head localization

## Scope and pinned evidence

This packet investigates one engine-layer hypothesis for
`bach-prelude-bwv939`: the upper tie curve at m7--8 is linked to the wrong
member of a two-head chord because `SlurLinker.selectBestHead` tests the lower
edge of a head for an above slur. No parser, scorer, pin, or allowance was
changed. The initial localization was read-only; the bounded isolated engine
experiment is recorded below.

The pinned 300 DPI artifact is

`services/omr-service/eval/cache/artifacts/4439ba40ce7916009c0c46186c1e3c71ec3ff16940926ddc8222f6f23a9f86f3-audiveris-5.11.0+svc-15-70115b6766485bc3d380ec66f10be4cde4283e4f6031a606a671c9575aa2883f/`.

Its `omr-eval-input.omr` SHA-256 is
`d4e15e0b122470e0b5e050d4ffa93a60449ff6efba08efda34ae6ca0e98973ac`.
The source PDF recorded by the artifact metadata has SHA-256
`4439ba40ce7916009c0c46186c1e3c71ec3ff16940926ddc8222f6f23a9f86f3`.
The extracted `sheet#1/sheet#1.xml` SHA-256 is
`36c847e94d6f0ab6aa95fd3943c9ed6f0867b1bb7c1b458995943177d9358d6d`,
with `last-persistent-id="4588"`; its binary page is
`f5e84aa2dfb8d9b27f2f0f653208b67fe971c491c00468dcbc9855a95b69a6ab`.
The trace input and extracted records are preserved under
`/tmp/omr-rsi-bwv939-tie-probe/`.
The review raster `/tmp/omr-rsi-baseline/bwv939-page.png` has SHA-256
`653396e69e11e1cc27f7520cd590eca82ecda73e0023fba2048c3b62142df490`.

The official frozen baseline is 179 reference notes and 195 exported notes,
with 16 extras. Twelve extras are the six printed mordents. The residual four
are the missing tie effects at C3 m2, C3 m3, A4 m8, and F3 m15. This packet
addresses only the A4 m8 effect; the C3 curves are absent from the pinned OMR,
and the F3 curve is also absent there.

## Exact OMR relations

The staff-3 heads in the target chords are present with their geometry and
pitch classifications:

| head | pitch class in OMR | bounds | chord |
|---|---:|---|---:|
| 1443 | C5 (`pitch=-1`) | `x=1668,y=1304,w=24,h=20` | 4254 |
| 1494 | A4 (`pitch=1`) | `x=1668,y=1324,w=24,h=20` | 4254 |
| 1447 | C5 (`pitch=-1`) | `x=1836,y=1304,w=24,h=20` | 4255 |
| 1498 | A4 (`pitch=1`) | `x=1836,y=1324,w=24,h=20` | 4255 |

The target chord records contain both members: 4254 contains heads 1443 and
1494, and 4255 contains 1447 and 1498. The exact curves are:

* curve 4386 (`SLUR_ABOVE`, tie): `(1702.5,1300.3)` to `(1825.5,1300.4)`,
  linked to 1443→1447;
* curve 4389 (`SLUR_ABOVE`, tie): `(1702.5,1320.3)` to `(1825.5,1320.4)`,
  linked to 1443→1447;
* curve 4383 (`SLUR_BELOW`, tie): `(1683,1378)` to `(1828,1378)`, linked to
  1538→1546, the E4 heads in the lower chord.

The page has two visibly separated upper curves at these endpoints. The lower
curve 4383 is already linked to the correct E4 heads. The pinned MusicXML
faithfully serializes the OMR relations: 4389 has C5 stop ties and no A4 stop
tie. This makes the failure an engine head-linking decision before export.

## Candidate trace

The calculation in `/tmp/omr-rsi-bwv939-tie-probe/trace-current.py` follows
the upstream code with main interline 20 and the 0.5-interline target
extension. For each candidate it records the dot-product concavity test and
the Euclidean distance used by `selectBestHead`.

For curve 4389, the left candidates are:

| head | center | current above reference point | current dot | physical-center dot | target distance |
|---|---:|---:|---:|---:|---:|
| 1443 C5 | `(1680,1314)` | lower edge `(1680,1323)` | `+2.718` | `-6.282` | `19.325` |
| 1494 A4 | `(1680,1334)` | lower edge `(1680,1343)` | `+22.718` | `+13.718` | `21.543` |

The right candidates are symmetric:

| head | center | current above reference point | current dot | physical-center dot | target distance |
|---|---:|---:|---:|---:|---:|
| 1447 C5 | `(1848,1314)` | lower edge `(1848,1323)` | `+2.582` | `-6.418` | `19.372` |
| 1498 A4 | `(1848,1334)` | lower edge `(1848,1343)` | `+22.582` | `+13.582` | `21.483` |

Thus the current lower-edge reference admits C5 by only about 2.6--2.7
pixels, and C5 wins on distance. Testing the physical center rejects C5 by
the existing unchanged concavity inequality while retaining A4. It does not
use pitch continuity or copy a relation across a chord.

The same calculation supplies bounded controls. On curve 4386, the physical
center dots for C5 are `+13.718` and `+13.582`, so C5 remains the closest
accepted member (left/right distances `21.543`/`21.483` versus A4
`36.807`/`36.712`). On the below curve 4383, replacing the upper-edge
reference with the center still leaves E4 accepted (center dots `+15.000` on
both sides), and E4 remains closest (distances `13.372` and `20.325`). These
controls bound the change to the concavity reference point and preserve the
existing lower tie selection.

## Source seam and bounded proposal

The first selection seam is
`/tmp/omr-rsi-audiveris-upstream/app/src/main/java/org/audiveris/omr/sheet/curve/SlurLinker.java:606-615`.
The inspected upstream checkout is commit `9e1e55cd2746037d059345881c53e6a6754bffbd9`; the
two relevant source files hash to `d9f92f97b42aad8c3763bdae7db35b272b394b2154014c03b665baaf12fbe797`
(`SlurLinker.java`) and
`317847fd072e85392d3adb961a42f7e0ab2087c7bdd8a6acc96dba8dfdf7e05f`
(`SlurInter.java`).
For an above curve, line 608 constructs
`new Point(center.x, bounds.y + (bounds.height - 1))`; line 610 applies the
concavity dot test, and lines 614--619 choose the smallest center-to-target
distance. Since the target curves are horizontal, the lookup-area center
containment branch is skipped, leaving this reference-point test and distance
comparison as the observed decision.

A bounded engine experiment would replace only the concavity reference point
with the physical head center, retaining the existing area checks, strict dot
inequality, and distance ranking. The negative control is curve 4386, which
must remain C5; curve 4383 must remain E4. The experiment must be scored on
the full protected bench and must be treated as a partial A4 correction;
BWV939 cannot pass until at least two of the three missing C3/C3/F3 tie sites
are also fixed. A parser or downstream tie invention cannot repair this artifact.
If the physical-center rule changes unrelated ties or fails to recover the
A4 relation, this hypothesis is killed.

## Isolated center-reference experiment

The temporary source is `/tmp/omr-rsi-bwv939-tie-probe/SlurLinker.java`, SHA-256
`7dcc10edf5fc91d11d8475ff4692898ed4d5f7f55e42d06c08c49a747f890a58`. It
changes only line 608's concavity reference from the bounds edge to the
existing `Point center`; lookup-area checks, strict concavity inequality, and
target-distance ranking are unchanged. The isolated image was built from
`cleffy-omr-rsi:svc-19` as `cleffy-omr-rsi:bwv939-tie-center`, image digest
`sha256:3b81705dac0c51899a1578a7b5a1bd4b7575224f11415f64c0e5ea768fcef324`.
The patched jar inside it hashes to
`161c3ce4d508db24221d9e985db3face813a7fd3c39d21a80daea541f473e048`.
Build and run logs are `/tmp/omr-rsi-bwv939-tie-build.log` (SHA
`8d8a2005a6f41b68aede4e5edc1da1a0e1ec8f4644d86bc2e57843b2819bdf4f`) and
`/tmp/omr-rsi-bwv939-tie-run.log` (SHA
`a0f5041695ff25fc06f27dc0072ab6a665711bb561732c48301df194ade5411b`).
The isolated image was built with
`docker build --no-cache -f Dockerfile -t cleffy-omr-rsi:bwv939-tie-center .`
from `/tmp/omr-rsi-bwv939-tie-probe`. The export used the validated runtime:
`docker run --rm --name cleffy-rsi-bwv939-tie-center -v /tmp/omr-rsi-bwv939-tie-probe:/probe -v services/omr-service/eval/cache/downloads/bach-prelude-bwv939.pdf:/input.pdf:ro cleffy-omr-rsi:bwv939-tie-center /opt/audiveris-root/opt/audiveris/bin/Audiveris -batch -export -output /probe/engine-center -option org.audiveris.omr.sheet.ProcessingSwitches.lyrics=false -option org.audiveris.omr.sheet.ProcessingSwitches.implicitTuplets=true -option org.audiveris.omr.sheet.ProcessingSwitches.fingerings=true -- /input.pdf`.

The run used the pinned PDF SHA
`4439ba40ce7916009c0c46186c1e3c71ec3ff16940926ddc8222f6f23a9f86f3` and
explicitly supplied `lyrics=false`, `implicitTuplets=true`, and
`fingerings=true`. The resulting OMR and MXL hash to
`4c9dca2499e5f7cefbdfe147094bf2e66a54ff8d82b45862d8d01d72c281ff06` and
`c2ff4ede190fdd82fc787e5bae2ffbfebe2b84b23de0e9d773a732a81c5f271c`.

The three pinned curve controls pass in the exported OMR, with the output IDs
shifted by one: curve 4387 (input 4386) remains linked to C5 heads 1443→1447;
curve 4390 (input 4389) now links to A4 heads 1494→1498; and curve 4384 (input
4383) remains linked to E4 heads 1538→1546. No chord-wide tie copy or pitch
inference was used. The exact relation assertions are in
`/tmp/omr-rsi-bwv939-tie-probe/verify-controls.py`; the run output is
`/tmp/omr-rsi-bwv939-tie-probe/verify-controls.log` (SHA-256
`f3d1acebf428f501f2aa1c96fedd6a45149b23bd2f609459b41a3ca3bc770be5`). The
official artifact command was:

```text
node /tmp/omr-rsi-eval-artifacts.mjs bach-prelude-bwv939 \
  /tmp/omr-rsi-bwv939-tie-probe/engine-center \
  /tmp/omr-rsi-bwv939-tie-probe/check
```

It reports artifact hash `2f7e637867fcd5bfdd56966cd9668f38f5cd2e22a73de57782cdc8a9b0c0663c`,
179 reference notes, 194 OMR notes, 15 extras (down from 16), exact 100%, and
onGrid `95.5307%` (up from `94.9721%`). The four residual unexplained extras
fall to three: the A4 m8 extra is removed, while C3 m2, C3 m3, and F3 m15
remain because their curves are absent from the pinned 300 DPI OMR. All 16
bars remain the correct length and the only failing official check is the
expected no-invented-notes count. This is a partial engine result, not a piece
pass; the protected full-bench run remains the integration gate.
