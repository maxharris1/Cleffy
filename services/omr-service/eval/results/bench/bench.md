# OMR play-along benchmark

engine: audiveris-5.11.0+svc-15  audiveris: - Version:      5.11.0
audiveris options: `-option org.audiveris.omr.sheet.ProcessingSwitches.lyrics=false -option org.audiveris.omr.sheet.ProcessingSwitches.implicitTuplets=true -option org.audiveris.omr.sheet.ProcessingSwitches.fingerings=true`
generated: 2026-09-14T15:04:10.141Z
gate floors: exact ≥ 95.0%, onGrid ≥ 90.0%, 1 missed/extra note allowed per 16 printed bars

**Play-along score 95.0%** · 5/16 pieces pass the gate

Rates are weighted by reference notes, not by piece. A piece whose `meters`
check failed could not bind a tick slice, so its rates are void rather than
measured — read its failure list, not its percentages.

| Piece | Pages | Ref notes | Pitch | +Onset | +Length | Miss | Extra | Composite | Gate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Czerny — 160 Eight-Measure Exercises, Op. 821 No. 1 | 1 | 152 | 92.1% | 92.1% | 92.1% | 0 | 0 | 85.3 | FAIL |
| Bach — Little Prelude in C, BWV 939 | 1 | 179 | 100.0% | 100.0% | 95.0% | 0 | 16 | 100.0 | FAIL |
| Bach (attrib.) — Air in F, BWV Anh. 131 | 1 | 97 | 100.0% | 94.8% | 93.8% | 0 | 0 | 89.0 | FAIL |
| Bach — Invention 1 in C, BWV 772 | 2 | 458 | 95.0% | 95.0% | 94.1% | 23 | 37 | 96.2 | FAIL |
| Bach — Invention 8 in F, BWV 779 | 2 | 598 | 99.7% | 98.7% | 97.8% | 2 | 0 | 99.5 | FAIL |
| Bach — Prelude in D minor, BWV 999 | 2 | 509 | 100.0% | 100.0% | 100.0% | 0 | 0 | 90.0 | pass |
| Bach — WTC I Prelude 1 in C, BWV 846 | 2 | 549 | 96.2% | 94.4% | 94.0% | 17 | 14 | 86.9 | FAIL |
| Petzold / Bach — Menuet in G, BWV Anh. 114 | 1 | 204 | 99.5% | 99.5% | 96.6% | 1 | 10 | 89.6 | pass |
| Bach — Menuet in G minor, BWV Anh. 115 | 1 | 199 | 100.0% | 100.0% | 97.5% | 0 | 12 | 90.0 | pass |
| Bach — Menuet in G, BWV Anh. 116 | 1 | 310 | 99.0% | 96.5% | 95.8% | 3 | 2 | 98.8 | FAIL |
| Burgmüller — 25 Études faciles, Op. 100 No. 2 (Arabesque) | 1 | 283 | 100.0% | 100.0% | 100.0% | 0 | 0 | 90.0 | pass |
| Schumann — Album für die Jugend, Op. 68 No. 1 (Mélodie) | 1 | 303 | 100.0% | 100.0% | 99.7% | 0 | 2 | 100.0 | pass |
| Schumann — Album für die Jugend, Op. 68 No. 5 (Stückchen) | 1 | 279 | 85.3% | 82.8% | 82.8% | 39 | 39 | 74.8 | FAIL |
| Satie — Gymnopédie No. 2 | 2 | 371 | 96.5% | 86.3% | 85.7% | 8 | 4 | 85.0 | FAIL |
| Beethoven — Für Elise, WoO 59 (Mutopia typeset) | 3 | 905 | 95.8% | 94.6% | 94.0% | 24 | 24 | 86.6 | FAIL |
| Chopin — Prelude in E minor, Op. 28 No. 4 | 1 | 600 | 99.0% | 98.0% | 97.3% | 2 | 1 | 95.4 | FAIL |
| **suite** | | **5996** | **97.3%** | **95.8%** | **95.0%** | **119** | **161** | | **5/16** |

## Czerny — 160 Eight-Measure Exercises, Op. 821 No. 1 — 1 failed check(s)

- No. 1: attack-grid (exact 92.1% vs floor 95.0%)

## Bach — Little Prelude in C, BWV 939 — 1 failed check(s)

- Praeludium: no-invented-notes (16 extra (12 explained by printed ornaments), 1 allowed)

## Bach (attrib.) — Air in F, BWV Anh. 131 — 2 failed check(s)

- bach-air-anh131: bar-length-warning (measure_underfull)
- Air: attack-grid (exact 94.8% vs floor 95.0%)

## Bach — Invention 1 in C, BWV 772 — 3 failed check(s)

- Invention 1: notes-present (23 missing, 2 allowed)
- Invention 1: no-invented-notes (37 extra (12 explained by printed ornaments), 2 allowed)
- Invention 1: attack-grid (exact 95.0% vs floor 95.0%)

## Bach — Invention 8 in F, BWV 779 — 2 failed check(s)

- bach-invention-08: bar-length-warning (measure_underfull + measure_overfull)
- Invention 8: bar-length (1 of 34 bars are not the printed length)

## Bach — WTC I Prelude 1 in C, BWV 846 — 5 failed check(s)

- wtk1-prelude1: bar-length-warning (measure_overfull)
- Praeludium I: bar-length (2 of 35 bars are not the printed length)
- Praeludium I: notes-present (17 missing, 3 allowed)
- Praeludium I: no-invented-notes (14 extra, 3 allowed)
- Praeludium I: attack-grid (exact 94.4% vs floor 95.0%)

## Bach — Menuet in G, BWV Anh. 116 — 2 failed check(s)

- anna-magdalena-07: bar-length-warning (measure_overfull)
- Menuet: bar-length (1 of 40 bars are not the printed length)

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

## Satie — Gymnopédie No. 2 — 5 failed check(s)

- gymnopedie-2: bar-length-warning (measure_overfull)
- Gymnopedie 2: bar-length (10 of 65 bars are not the printed length)
- Gymnopedie 2: notes-present (8 missing, 5 allowed)
- Gymnopedie 2: attack-grid (exact 86.3% vs floor 95.0%)
- Gymnopedie 2: note-length (onGrid 85.7% vs floor 90.0%)

## Beethoven — Für Elise, WoO 59 (Mutopia typeset) — 5 failed check(s)

- fur-elise-mutopia: bar-length-warning (measure_underfull + measure_overfull)
- Poco moto: bar-length (4 of 106 bars are not the printed length)
- Poco moto: notes-present (24 missing, 7 allowed)
- Poco moto: no-invented-notes (24 extra, 7 allowed)
- Poco moto: attack-grid (exact 94.6% vs floor 95.0%)

## Chopin — Prelude in E minor, Op. 28 No. 4 — 2 failed check(s)

- chopin-prelude-4: bar-length-warning (measure_overfull)
- Largo: bar-length (1 of 26 bars are not the printed length)
