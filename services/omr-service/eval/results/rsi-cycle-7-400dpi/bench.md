# OMR play-along benchmark

engine: audiveris-5.11.0+svc-15  audiveris: - Version:      5.11.0
audiveris options: `-option org.audiveris.omr.image.ImageLoading.pdfResolution=400 -option org.audiveris.omr.sheet.ProcessingSwitches.lyrics=false -option org.audiveris.omr.sheet.ProcessingSwitches.implicitTuplets=true -option org.audiveris.omr.sheet.ProcessingSwitches.fingerings=true`
generated: 2026-09-14T14:29:38.948Z
gate floors: exact ≥ 95.0%, onGrid ≥ 90.0%, 1 missed/extra note allowed per 16 printed bars

**Play-along score 78.7%** · 4/16 pieces pass the gate

Rates are weighted by reference notes, not by piece. A piece whose `meters`
check failed could not bind a tick slice, so its rates are void rather than
measured — read its failure list, not its percentages.

| Piece | Pages | Ref notes | Pitch | +Onset | +Length | Miss | Extra | Composite | Gate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Czerny — 160 Eight-Measure Exercises, Op. 821 No. 1 | 1 | 152 | 92.1% | 88.8% | 88.8% | 0 | 0 | 84.6 | FAIL |
| Bach — Little Prelude in C, BWV 939 | 1 | 179 | 100.0% | 100.0% | 96.1% | 0 | 14 | 100.0 | FAIL |
| Bach (attrib.) — Air in F, BWV Anh. 131 | 1 | 97 | 97.9% | 97.9% | 97.9% | 2 | 2 | 84.7 | FAIL |
| Bach — Invention 1 in C, BWV 772 | 2 | 458 | 95.0% | 95.0% | 93.9% | 23 | 36 | 96.2 | FAIL |
| Bach — Invention 8 in F, BWV 779 | 2 | 598 | 99.8% | 99.5% | 98.7% | 1 | 1 | 99.8 | FAIL |
| Bach — Prelude in D minor, BWV 999 | 2 | 509 | 100.0% | 100.0% | 100.0% | 0 | 0 | 90.0 | pass |
| Bach — WTC I Prelude 1 in C, BWV 846 | 2 | 549 | 95.8% | 68.9% | 65.6% | 19 | 14 | 81.6 | FAIL |
| Petzold / Bach — Menuet in G, BWV Anh. 114 | 1 | 204 | 99.5% | 99.5% | 96.6% | 1 | 10 | 89.6 | pass |
| Bach — Menuet in G minor, BWV Anh. 115 | 1 | 199 | 100.0% | 100.0% | 97.5% | 0 | 12 | 90.0 | pass |
| Bach — Menuet in G, BWV Anh. 116 | 1 | 310 | 99.0% | 97.4% | 97.1% | 3 | 2 | 99.0 | FAIL |
| Burgmüller — 25 Études faciles, Op. 100 No. 2 (Arabesque) | 1 | 283 | 100.0% | 100.0% | 100.0% | 0 | 0 | 90.0 | pass |
| Schumann — Album für die Jugend, Op. 68 No. 1 (Mélodie) | 1 | 303 | 100.0% | 100.0% | 100.0% | 0 | 0 | 100.0 | FAIL |
| Schumann — Album für die Jugend, Op. 68 No. 5 (Stückchen) | 1 | 279 | 85.3% | 82.8% | 82.8% | 39 | 39 | 74.8 | FAIL |
| Satie — Gymnopédie No. 2 | 2 | 371 | 97.0% | 94.3% | 93.8% | 11 | 4 | 87.2 | FAIL |
| Beethoven — Für Elise, WoO 59 (Mutopia typeset) | 3 | 905 | 94.4% | 69.4% | 62.8% | 36 | 20 | 77.1 | FAIL |
| Chopin — Prelude in E minor, Op. 28 No. 4 | 1 | 600 | 0.0% | 0.0% | 0.0% | 600 | 0 | 13.8 | FAIL |
| **suite** | | **5996** | **87.2%** | **80.5%** | **78.7%** | **735** | **154** | | **4/16** |

## Czerny — 160 Eight-Measure Exercises, Op. 821 No. 1 — 2 failed check(s)

- No. 1: attack-grid (exact 88.8% vs floor 95.0%)
- No. 1: note-length (onGrid 88.8% vs floor 90.0%)

## Bach — Little Prelude in C, BWV 939 — 1 failed check(s)

- Praeludium: no-invented-notes (14 extra (12 explained by printed ornaments), 1 allowed)

## Bach (attrib.) — Air in F, BWV Anh. 131 — 5 failed check(s)

- bach-air-anh131: bar-length-warning (measure_underfull)
- Air: printed-bar-count (17 printed bars read)
- Air: bar-alignment (17 scored bars vs 16 reference bars)
- Air: bar-length (1 of 17 bars are not the printed length)
- Air: repeat-walk (25 performed bars)

## Bach — Invention 1 in C, BWV 772 — 3 failed check(s)

- Invention 1: notes-present (23 missing, 2 allowed)
- Invention 1: no-invented-notes (36 extra (12 explained by printed ornaments), 2 allowed)
- Invention 1: attack-grid (exact 95.0% vs floor 95.0%)

## Bach — Invention 8 in F, BWV 779 — 2 failed check(s)

- bach-invention-08: bar-length-warning (measure_overfull)
- Invention 8: bar-length (2 of 34 bars are not the printed length)

## Bach — WTC I Prelude 1 in C, BWV 846 — 6 failed check(s)

- wtk1-prelude1: bar-length-warning (measure_overfull)
- Praeludium I: bar-length (12 of 35 bars are not the printed length)
- Praeludium I: notes-present (19 missing, 3 allowed)
- Praeludium I: no-invented-notes (14 extra, 3 allowed)
- Praeludium I: attack-grid (exact 68.9% vs floor 95.0%)
- Praeludium I: note-length (onGrid 65.6% vs floor 90.0%)

## Bach — Menuet in G, BWV Anh. 116 — 2 failed check(s)

- anna-magdalena-07: bar-length-warning (measure_overfull)
- Menuet: bar-length (1 of 40 bars are not the printed length)

## Schumann — Album für die Jugend, Op. 68 No. 1 (Mélodie) — 1 failed check(s)

- Melodie: no-invented-hold (4 hold(s) in the slice)

## Schumann — Album für die Jugend, Op. 68 No. 5 (Stückchen) — 9 failed check(s)

- schumann-op68-05: bar-length-warning (measure_underfull)
- Stuckchen: printed-bar-count (26 printed bars read)
- Stuckchen: bar-alignment (26 scored bars vs 25 reference bars)
- Stuckchen: bar-length (1 of 26 bars are not the printed length)
- Stuckchen: repeat-walk (26 performed bars)
- Stuckchen: notes-present (39 missing, 2 allowed)
- Stuckchen: no-invented-notes (39 extra, 2 allowed)
- Stuckchen: attack-grid (exact 82.8% vs floor 95.0%)
- Stuckchen: note-length (onGrid 82.8% vs floor 90.0%)

## Satie — Gymnopédie No. 2 — 4 failed check(s)

- gymnopedie-2: bar-length-warning (measure_overfull)
- Gymnopedie 2: bar-length (2 of 65 bars are not the printed length)
- Gymnopedie 2: notes-present (11 missing, 5 allowed)
- Gymnopedie 2: attack-grid (exact 94.3% vs floor 95.0%)

## Beethoven — Für Elise, WoO 59 (Mutopia typeset) — 8 failed check(s)

- fur-elise-mutopia: bar-length-warning (measure_underfull + measure_overfull)
- Poco moto: bar-length (47 of 106 bars are not the printed length)
- Poco moto: no-invented-hold (11 hold(s) in the slice)
- Poco moto: repeat-walk (126 performed bars)
- Poco moto: notes-present (36 missing, 7 allowed)
- Poco moto: no-invented-notes (20 extra, 7 allowed)
- Poco moto: attack-grid (exact 69.4% vs floor 95.0%)
- Poco moto: note-length (onGrid 62.8% vs floor 90.0%)

## Chopin — Prelude in E minor, Op. 28 No. 4 — 9 failed check(s)

- chopin-prelude-4: meters (a movement never bound a matching meter — its rates are void, not measured)
- chopin-prelude-4: bar-length-warning (measure_overfull)
- Largo: printed-bar-count (0 printed bars read)
- Largo: bar-alignment (0 scored bars vs 26 reference bars)
- Largo: repeat-walk (0 performed bars)
- Largo: notes-present (600 missing, 1 allowed)
- Largo: no-skipped-passage (longest unplaced reference run is 26 bar(s))
- Largo: attack-grid (exact 0.0% vs floor 95.0%)
- Largo: note-length (onGrid 0.0% vs floor 90.0%)
