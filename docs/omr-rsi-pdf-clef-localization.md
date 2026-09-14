# OMR RSI PDF clef metadata localization

## Hypothesis

The four named pieces `schumann-op68-05`, `bach-invention-01`, `wtk1-prelude1`, and
`fur-elise-mutopia` use vector music fonts whose PDF content identifies inline clefs
before Audiveris raster recognition. A generic upstream consumer of that identity and
the transformed glyph outline could recover a missing G/F change clef without using
pitches, reference MIDI, piece names, or score coordinates.

This packet is an evidence and seam proposal. It does not change the engine, parser,
gates, floors, allowances, or cache pins. The invariant for a future experiment is
that no currently passing piece may go red.

## Pinned source and extraction

The probe used the pinned PDFs and SHA-256 values below:

| piece | PDF SHA-256 | font encoding evidence |
| --- | --- | --- |
| `bach-invention-01` | `9f31743791c689e7e5f5732e8181c49ba9d546f6a3b2d6cd874e6846d31a77a3` | Emmentaler-20: `clefs.G` code 3, `clefs.F` code 5, `clefs.G_change` code 13, `clefs.F_change` code 15 |
| `fur-elise-mutopia` | `c5b64f7ad614e8737ed4710e8b7ebeb8359e85c64935767b9e49bfd164b3eba4` | Emmentaler-20: `clefs.G` code 10, `clefs.F` code 9, `clefs.G_change` code 15, `clefs.F_change` code 14 |
| `schumann-op68-05` | `8f56f70d597a838d23590ed5bbc9ecf10b21e77f07620019cdc2d06b931f7c17` | Emmentaler-20: `clefs.G` code 4, `clefs.F` code 3, `clefs.G_change` code 5 |
| `wtk1-prelude1` | `0bc884049d69e9d3ec24b133467d8b8bfc0335e169a16cfd1075b329e7278449` | Emmentaler-20: `clefs.G` code 7, `clefs.F` code 6, `clefs.G_change` code 16, `clefs.F_change` code 11 |

The temporary PDFBox 3.0.6 probe is `/tmp/omr-rsi-pdf-clef-probe/PdfTextGlyphProbe.java`.
It uses `PDFTextStripper.processTextPosition`, `PDSimpleFont.getEncoding().getName(code)`,
`PDVectorFont.getPath(code)`, the text matrix concatenated with the font matrix, and
PDF bottom-left to 300 DPI top-left conversion. All four PDFs are Letter pages
(612 x 792 points), so the conversion factor is `300/72` and the sheet Y coordinate
is `(792 - (pathY + pathHeight)) * 300/72`.

The relevant `G_change` outline and exact cycle-10 `svc-16` OMR symbol positions are:

| piece | PDF outline converted to 300 DPI `(x,y,w,h)` | exact OMR artifact evidence |
| --- | --- | --- |
| Schumann | `(501.4,898.3,42.6,126.6)` | glyph 6606 `(501,898,43,143)` plus glyph 6607 `(504,1004,13,19)`; glyph 6608 `(527,842,40,37)` is the nearby dynamic `p` and is excluded |
| Bach | `(292.3,2431.3,42.6,126.7)` | `sheet#1` glyph 5635 starts `(292,2444)` with a 43-pixel run-table width and 114-pixel height |
| Fur Elise | `(856.8,1785.7,42.8,124.5)` | `sheet#1` glyph 6124 starts `(857,1786)` with a 42-pixel run-table width and 99-pixel height |
| WTK | `(1135.5,2613.7,42.8,126.6)` | `sheet#2` symbol 6786 starts `(1146,2614)`; the surrounding symbol fragments show the raster recognition is split, so the outline is useful as the grouping anchor |

The Schumann match is independently visible in the exact BINARY crop: the vector
outline starts at the same pixel as the printed inline lower-staff G-clef ink. The
other three matches have the same page-coordinate agreement in their exact OMR
BINARY/XML artifacts. Existing OMR headers in these artifacts contain ordinary
`G_CLEF`/`F_CLEF` interpretations at the left system edge; the listed candidates are
later inline positions and do not identify a header replacement.

## First responsible seam and proposed narrow implementation

Audiveris rasterizes and closes the PDF in its private `ImageLoading.PdfboxLoader`.
By `HEADERS`, `ClefBuilder.findClefs()` only sees the sheet pixels, so the font name
has otherwise been discarded. The smallest generic engine-only seam is:

1. Add a helper under `services/omr-service/engine-patches/src/org/audiveris/omr/sheet/clef/`
   (proposed `PdfClefHints.java`) that opens the input path obtained from the book,
   selects the sheet page, and returns named G/F glyph outlines in sheet coordinates.
2. Call it from the patched `ClefBuilder.findClefs()` before its raster `getBestMap`
   attempts. Create a normal `ClefInter` only when the named outline overlaps surviving
   staff-free pixels, has an unambiguous staff association, and is not already covered
   by an existing clef interpretation.
3. Map only the font’s G/F clef identities to the corresponding ordinary clef shape
   for a missing inline candidate. Preserve an existing `G_CLEF_8VA`, `G_CLEF_8VB`,
   `F_CLEF_8VA`, or `F_CLEF_8VB` interpretation whenever the candidate overlaps that
   clef family. A plain `/clefs.G` or `/clefs.G_change` hint must never erase or
   downgrade an octave-clef interpretation. Unknown fonts, raster inputs, missing
   source paths, ambiguous transforms, and ambiguous staff matches fall through to
   the existing classifier.

`ClefBuilder.java` is the proposed primary integration file because it already owns
staff association, duplicate header protection, `ClefInter` construction, and runs
in `HEADERS` before `HEADS`. This is a proposal only; no production source was edited
for this packet. A future implementation must first compile against the exact
Audiveris/PDFBox bundle and add negative checks for an existing octave clef and for a
header glyph whose same-staff clef is already present.

## Kill criteria and limits

This hypothesis is killed if the input path is unavailable when `HEADERS` runs, the
font encoding or page transform is ambiguous, the outline does not overlap actual
ink, staff assignment is ambiguous, or implementation requires pitch/reference-MIDI
inference, piece coordinates, or a broad raster promotion. It is also killed if any
currently passing piece regresses. No engine run or official bench was performed by
this localization task; parent owns the serialized build and full 16-piece gate.

## Temporary implementation probe

A temporary candidate was implemented under `/tmp/omr-rsi-pdf-clef-probe/candidate-src/` and
compiled against the accepted `svc-18` Audiveris jar with Java 25. The candidate hooks
`ClefBuilder.Column.selectClefs()` after header selection and before `HEADS`; its helper caches
one PDFBox page scan per source/page/size, requires a unique staff center, and clips the
`NO_STAFF` pixels to the transformed PDF outline before constructing the candidate glyph.
The tracked engine source was restored after the probe; no production helper or Dockerfile
change remains in the working tree.

Using the exact three play-along options, temporary artifact localization reported:

| piece | named clefs added | exact | missing / extra | remaining gate result |
| --- | ---: | ---: | ---: | --- |
| `schumann-op68-05` | 1 | 94.62% | 5 / 5 | fails 1 bar plus 5-note allowance |
| `wtk1-prelude1` | 2 | 97.45% | 4 / 0 | fails 1 bar plus 4-note allowance |
| `fur-elise-mutopia` | 11 | 96.57% | 6 / 4 | fails 2 bars |
| `bach-invention-01` | 2 | 94.98% | 23 / 37 | neutral on this piece |

The candidate artifacts and scorer outputs are retained under
`/tmp/omr-rsi-pdf-clef-probe/`; parent owns the full-suite regression decision. These are
isolated probes, not a claim that the 16-piece gate passes.
