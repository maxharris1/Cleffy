# Bach Invention 1 omitted lower-staff treble clef localization

Status: the m9/m10 23-pair pitch failure is localized to an inline lower-staff
G clef that survives as a free Audiveris SYMBOL candidate but is not promoted
to a `G_CLEF` inter. MusicXML and the Cleffy parser receive no clef to apply;
no parser or scorer fix is justified.

## Printed and reference evidence

The pinned corpus entry is
`services/omr-service/eval/corpus/bach-invention-01.json`, PDF SHA
`9f31743791c689e7e5f5732e8181c49ba9d546f6a3b2d6cd874e6846d31a77a3`.
The matching `/tmp/bach-invention-01-page-1.png` visibly prints a treble clef
in the lower staff during m9, after the opening lower-staff G and before the
remaining m9 notes. The matching `/tmp/bach-invention-01.ly` is explicit:
`voicetwo` begins with `\\clef "bass"` (line 52), has
`g,16[ \\clef "treble" g' f e]` in m9 (line 61), and changes back with
`\\clef "bass"` before m13 (line 65).

The pinned reference MIDI is
`services/omr-service/eval/cache/downloads/bach-invention-01-midi/bach-invention-01.mid`;
its SHA matches the corpus. It has 22 bars and 458 reference attacks. The
frozen ScoreData still shows only staff-1 G at tick 19200 (m11) and F at
21120 (m12) in its clef list; there is no staff-2 G at the m9 boundary.

## First machine divergence

The 300dpi artifact is
`services/omr-service/eval/cache/artifacts/9f31743791c689e7e5f5732e8181c49ba9d546f6a3b2d6cd874e6846d31a77a3-audiveris-5.11.0+svc-15-70115b6766485bc3d380ec66f10be4cde4283e4f6031a606a671c9575aa2883f`.
In `/tmp/inv1-sheet1.xml`, system 5 starts at line 9299 and m9 is measure
`id="9"` at line 9398. Its `<clefs>` contains only the system/header G and
F clefs `227 239` (line 9402); there is no inline lower-staff clef. The
MusicXML m9 and m10 have no clef attribute. The next emitted lower-staff G
appears only in m11 (`/tmp/inv1-omr.xml`, lines 3208–3214), followed by F in
m12 (lines 3832–3837). This is upstream of MusicXML serialization.

The missing symbol is retained in the OMR. The m9 lower staff has a free
`SYMBOL` glyph `5648` at `/tmp/inv1-sheet1.xml` line 54161 with
`left=292, top=2444, width=43, height=114`. It sits between the first lower
m9 head at x240 and the next at x362, exactly where the printed inline G clef
falls. The m9 measure has no clef inter, while m10 also has no clef entry.
The candidate is clef-sized and its staff-free raster shape matches the
recognized page G-clef family: after run-table normalization, its overlap is
about 0.63 with recognized G glyph 226 (w53 x h158) and about 0.25 with the
recognized F glyph 233 (w55 x h64). It remains a free SYMBOL rather than a
`G_CLEF` inter.

The 400dpi comparative artifact also emits no inline G clef in m9/m10; its
final-system XML contains only the header clefs. It is rejected as a fix
signal because it changes raster geometry and does not promote this exact
candidate, so the primary attribution remains the pinned 300dpi candidate.

## Exact score-error accounting

The frozen detailed result `/tmp/omr-rsi-baseline/bach-invention-01.json`
reports the required raw values: 458 reference notes, 472 OMR notes,
`pitchMatch=exact=94.97816593886463`, 23 missing, and 37 extra.

The 23 paired pitch errors are confined to m9 and m10:

* m9: missing `[67,67,65,65,65,65,64,64,64,62,62]`; extra
  `[47,47,45,45,45,45,43,43,43,41,41]`;
* m10: missing `[64,64,64,69,69,67,67,67,67,65,65,65]`; extra
  `[43,43,43,48,48,47,47,47,47,45,45,45]`.

These are the same lower-staff attacks read under bass instead of the
printed treble clef. They do not involve bar length: both bars remain 1920
ticks and all 22 printed bars match.

The other 14 extras are separable. The six printed ornaments are at m1, m2,
m5, m6, m8, and m13 in the source. Their two realized extras each account
for 12 extras: m1 `[72,71]`, m2 `[79,77]`, m5 `[72,71]`, m6 `[71,72]`,
m8 `[66,67]`, and m13 `[60,62]`. The remaining 2 extras are m13 `[74]`
and m19 `[76]`; together with the 23 clef-pair extras these are the 25
unexplained extras reported by the result. This keeps the corpus’s
`expectedExtraNotes=12` allowance tied to the six actual ornament signs.

## Layer attribution and next artifact

The exact upstream class to instrument first is
`app/src/main/java/org/audiveris/omr/sheet/symbol/SymbolsBuilder.java`,
whose `evaluateGlyph` (lines 188–233) classifies free SYMBOL glyphs and
creates inters only for acceptable evaluations. The preceding extraction
seam is `SymbolsFilter.java` (`dispatchPageSymbols`, lines 149–162, and
staff-free glyph processing lines 168–180, 420–467). `InterFactory.java`
already maps `G_CLEF` to `ClefInter` (lines 285–296); no mapping or parser
change is needed when classification succeeds.

Before any implementation, capture the classifier evaluations for glyph
5648, or a saved symbol-stage image and trace, to establish whether the
candidate is rejected by size, clustering, or `Grades.symbolMinGrade`. A
narrow upstream change may be considered only if it promotes this exact
candidate as the m9 lower-staff `G_CLEF`, preserves the six ornament behavior,
and leaves all five currently passing pieces green while root verifies all 16.
Do not infer notes, alter timing, loosen floors or allowances, or modify the
separate WTC m6/m25 blockers.
