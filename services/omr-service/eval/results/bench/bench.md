# OMR play-along benchmark

engine: audiveris-5.11.0+svc-14  audiveris: - Version:      5.11.0
audiveris options: `-option org.audiveris.omr.sheet.ProcessingSwitches.lyrics=false -option org.audiveris.omr.sheet.ProcessingSwitches.implicitTuplets=true -option org.audiveris.omr.sheet.ProcessingSwitches.fingerings=true`
generated: 2026-09-12T18:14:46.457Z
gate floors: exact ≥ 95.0%, onGrid ≥ 90.0%, 1 missed/extra note allowed per 16 printed bars

**Play-along score 70.3%** · 2/16 pieces pass the gate

Rates are weighted by reference notes, not by piece. A piece whose `meters`
check failed could not bind a tick slice, so its rates are void rather than
measured — read its failure list, not its percentages.

| Piece | Pages | Ref notes | Pitch | +Onset | +Length | Miss | Extra | Composite | Gate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Czerny — 160 Eight-Measure Exercises, Op. 821 No. 1 | 1 | 152 | 92.1% | 92.1% | 92.1% | 0 | 0 | 85.3 | FAIL |
| Bach — Little Prelude in C, BWV 939 | 1 | 179 | 100.0% | 100.0% | 95.0% | 0 | 16 | 100.0 | FAIL |
| Bach (attrib.) — Air in F, BWV Anh. 131 | 1 | 97 | 97.9% | 92.8% | 91.8% | 2 | 2 | 83.7 | FAIL |
| Bach — Invention 1 in C, BWV 772 | 2 | 458 | 95.0% | 95.0% | 94.1% | 23 | 37 | 96.2 | FAIL |
| Bach — Invention 8 in F, BWV 779 | 2 | 598 | 99.7% | 98.7% | 97.8% | 2 | 0 | 99.5 | FAIL |
| Bach — Prelude in D minor, BWV 999 | 2 | 509 | 15.5% | 0.4% | 0.4% | 76 | 76 | 34.0 | FAIL |
| Bach — WTC I Prelude 1 in C, BWV 846 | 2 | 549 | 96.2% | 81.6% | 79.6% | 17 | 14 | 84.3 | FAIL |
| Petzold / Bach — Menuet in G, BWV Anh. 114 | 1 | 204 | 99.5% | 99.5% | 96.6% | 1 | 10 | 89.6 | pass |
| Bach — Menuet in G minor, BWV Anh. 115 | 1 | 199 | 100.0% | 100.0% | 97.5% | 0 | 12 | 90.0 | pass |
| Bach — Menuet in G, BWV Anh. 116 | 1 | 310 | 99.0% | 96.5% | 95.8% | 3 | 2 | 98.8 | FAIL |
| Burgmüller — 25 Études faciles, Op. 100 No. 2 (Arabesque) | 1 | 283 | 100.0% | 100.0% | 100.0% | 0 | 0 | 90.0 | FAIL |
| Schumann — Album für die Jugend, Op. 68 No. 1 (Mélodie) | 1 | 303 | 100.0% | 100.0% | 99.7% | 0 | 4 | 100.0 | FAIL |
| Schumann — Album für die Jugend, Op. 68 No. 5 (Stückchen) | 1 | 279 | 85.3% | 82.8% | 82.8% | 39 | 39 | 74.8 | FAIL |
| Satie — Gymnopédie No. 2 | 2 | 371 | 0.0% | 0.0% | 0.0% | 371 | 0 | 13.8 | FAIL |
| Beethoven — Für Elise, WoO 59 (Mutopia typeset) | 3 | 905 | 72.2% | 31.9% | 30.5% | 192 | 192 | 61.8 | FAIL |
| Chopin — Prelude in E minor, Op. 28 No. 4 | 1 | 600 | 99.0% | 98.0% | 97.0% | 2 | 1 | 95.4 | FAIL |
| **suite** | | **5996** | **80.6%** | **71.4%** | **70.3%** | **728** | **405** | | **2/16** |

## Czerny — 160 Eight-Measure Exercises, Op. 821 No. 1 — 1 failed check(s)

- No. 1: attack-grid (exact 92.1% vs floor 95.0%)

## Bach — Little Prelude in C, BWV 939 — 1 failed check(s)

- Praeludium: no-invented-notes (16 extra (12 explained by printed ornaments), 1 allowed)

## Bach (attrib.) — Air in F, BWV Anh. 131 — 6 failed check(s)

- bach-air-anh131: bar-length-warning (measure_underfull)
- Air: printed-bar-count (17 printed bars read)
- Air: bar-alignment (17 scored bars vs 16 reference bars)
- Air: bar-length (1 of 17 bars are not the printed length)
- Air: repeat-walk (25 performed bars)
- Air: attack-grid (exact 92.8% vs floor 95.0%)

## Bach — Invention 1 in C, BWV 772 — 3 failed check(s)

- Invention 1: notes-present (23 missing, 2 allowed)
- Invention 1: no-invented-notes (37 extra (12 explained by printed ornaments), 2 allowed)
- Invention 1: attack-grid (exact 95.0% vs floor 95.0%)

## Bach — Invention 8 in F, BWV 779 — 2 failed check(s)

- bach-invention-08: bar-length-warning (measure_underfull + measure_overfull)
- Invention 8: bar-length (2 of 34 bars are not the printed length)

## Bach — Prelude in D minor, BWV 999 — 6 failed check(s)

- bach-prelude-bwv999: bar-length-warning (measure_overfull)
- Prelude: bar-length (12 of 43 bars are not the printed length)
- Prelude: notes-present (76 missing, 3 allowed)
- Prelude: no-invented-notes (76 extra, 3 allowed)
- Prelude: attack-grid (exact 0.4% vs floor 95.0%)
- Prelude: note-length (onGrid 0.4% vs floor 90.0%)

## Bach — WTC I Prelude 1 in C, BWV 846 — 6 failed check(s)

- wtk1-prelude1: bar-length-warning (measure_underfull + measure_overfull)
- Praeludium I: bar-length (11 of 35 bars are not the printed length)
- Praeludium I: notes-present (17 missing, 3 allowed)
- Praeludium I: no-invented-notes (14 extra, 3 allowed)
- Praeludium I: attack-grid (exact 81.6% vs floor 95.0%)
- Praeludium I: note-length (onGrid 79.6% vs floor 90.0%)

## Bach — Menuet in G, BWV Anh. 116 — 2 failed check(s)

- anna-magdalena-07: bar-length-warning (measure_overfull)
- Menuet: bar-length (1 of 40 bars are not the printed length)

## Burgmüller — 25 Études faciles, Op. 100 No. 2 (Arabesque) — 1 failed check(s)

- Arabesque: no-invented-hold (3 hold(s) in the slice)

## Schumann — Album für die Jugend, Op. 68 No. 1 (Mélodie) — 1 failed check(s)

- Melodie: no-invented-notes (4 extra, 2 allowed)

## Schumann — Album für die Jugend, Op. 68 No. 5 (Stückchen) — 10 failed check(s)

- schumann-op68-05: bar-length-warning (measure_underfull)
- Stuckchen: printed-bar-count (26 printed bars read)
- Stuckchen: bar-alignment (26 scored bars vs 25 reference bars)
- Stuckchen: bar-length (1 of 26 bars are not the printed length)
- Stuckchen: no-invented-hold (2 hold(s) in the slice)
- Stuckchen: repeat-walk (26 performed bars)
- Stuckchen: notes-present (39 missing, 2 allowed)
- Stuckchen: no-invented-notes (39 extra, 2 allowed)
- Stuckchen: attack-grid (exact 82.8% vs floor 95.0%)
- Stuckchen: note-length (onGrid 82.8% vs floor 90.0%)

## Satie — Gymnopédie No. 2 — 9 failed check(s)

- gymnopedie-2: meters (a movement never bound a matching meter — its rates are void, not measured)
- gymnopedie-2: bar-length-warning (measure_underfull + measure_overfull)
- Gymnopedie 2: printed-bar-count (0 printed bars read)
- Gymnopedie 2: bar-alignment (0 scored bars vs 65 reference bars)
- Gymnopedie 2: repeat-walk (0 performed bars)
- Gymnopedie 2: notes-present (371 missing, 1 allowed)
- Gymnopedie 2: no-skipped-passage (longest unplaced reference run is 65 bar(s))
- Gymnopedie 2: attack-grid (exact 0.0% vs floor 95.0%)
- Gymnopedie 2: note-length (onGrid 0.0% vs floor 90.0%)

## Beethoven — Für Elise, WoO 59 (Mutopia typeset) — 9 failed check(s)

- fur-elise-mutopia: bar-length-warning (measure_underfull + measure_overfull)
- Poco moto: printed-bar-count (106 printed bars read)
- Poco moto: bar-alignment (106 scored bars vs 105 reference bars)
- Poco moto: bar-length (3 of 106 bars are not the printed length)
- Poco moto: no-invented-hold (2 hold(s) in the slice)
- Poco moto: notes-present (192 missing, 7 allowed)
- Poco moto: no-invented-notes (192 extra, 7 allowed)
- Poco moto: attack-grid (exact 31.9% vs floor 95.0%)
- Poco moto: note-length (onGrid 30.5% vs floor 90.0%)

## Chopin — Prelude in E minor, Op. 28 No. 4 — 3 failed check(s)

- chopin-prelude-4: bar-length-warning (measure_overfull)
- Largo: bar-length (3 of 26 bars are not the printed length)
- Largo: no-invented-hold (7 hold(s) in the slice)
