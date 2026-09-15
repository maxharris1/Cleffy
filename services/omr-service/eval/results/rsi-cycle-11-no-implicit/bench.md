# OMR play-along benchmark

engine: audiveris-5.11.0+svc-17  audiveris: - Version:      5.11.0
audiveris options: `-option org.audiveris.omr.sheet.ProcessingSwitches.lyrics=false -option org.audiveris.omr.sheet.ProcessingSwitches.implicitTuplets=false -option org.audiveris.omr.sheet.ProcessingSwitches.fingerings=true`
generated: 2026-09-14T15:32:42.210Z
gate floors: exact ≥ 95.0%, onGrid ≥ 90.0%, 1 missed/extra note allowed per 16 printed bars

**Play-along score 94.3%** · 6/16 pieces pass the gate

Rates are weighted by reference notes, not by piece. A piece whose `meters`
check failed could not bind a tick slice, so its rates are void rather than
measured — read its failure list, not its percentages.

| Piece | Pages | Ref notes | Pitch | +Onset | +Length | Miss | Extra | Composite | Gate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Czerny — 160 Eight-Measure Exercises, Op. 821 No. 1 | 1 | 152 | 97.4% | 97.4% | 97.4% | 0 | 0 | 88.4 | pass |
| Bach — Little Prelude in C, BWV 939 | 1 | 179 | 100.0% | 100.0% | 95.0% | 0 | 16 | 100.0 | FAIL |
| Bach (attrib.) — Air in F, BWV Anh. 131 | 1 | 97 | 100.0% | 97.9% | 97.9% | 0 | 0 | 89.6 | pass |
| Bach — Invention 1 in C, BWV 772 | 2 | 458 | 95.0% | 95.0% | 94.1% | 23 | 37 | 96.2 | FAIL |
| Bach — Invention 8 in F, BWV 779 | 2 | 598 | 99.7% | 99.3% | 98.5% | 2 | 0 | 99.7 | FAIL |
| Bach — Prelude in D minor, BWV 999 | 2 | 509 | 99.2% | 99.2% | 99.2% | 4 | 0 | 89.4 | FAIL |
| Bach — WTC I Prelude 1 in C, BWV 846 | 2 | 549 | 90.2% | 88.5% | 88.0% | 50 | 14 | 82.4 | FAIL |
| Petzold / Bach — Menuet in G, BWV Anh. 114 | 1 | 204 | 99.5% | 99.5% | 96.6% | 1 | 10 | 89.6 | pass |
| Bach — Menuet in G minor, BWV Anh. 115 | 1 | 199 | 100.0% | 100.0% | 97.5% | 0 | 12 | 90.0 | pass |
| Bach — Menuet in G, BWV Anh. 116 | 1 | 310 | 99.0% | 96.5% | 95.8% | 3 | 2 | 98.8 | FAIL |
| Burgmüller — 25 Études faciles, Op. 100 No. 2 (Arabesque) | 1 | 283 | 100.0% | 100.0% | 100.0% | 0 | 0 | 90.0 | pass |
| Schumann — Album für die Jugend, Op. 68 No. 1 (Mélodie) | 1 | 303 | 100.0% | 100.0% | 99.7% | 0 | 2 | 100.0 | pass |
| Schumann — Album für die Jugend, Op. 68 No. 5 (Stückchen) | 1 | 279 | 85.3% | 82.8% | 82.8% | 39 | 39 | 74.8 | FAIL |
| Satie — Gymnopédie No. 2 | 2 | 371 | 96.5% | 86.3% | 85.7% | 8 | 4 | 85.0 | FAIL |
| Beethoven — Für Elise, WoO 59 (Mutopia typeset) | 3 | 905 | 95.5% | 92.5% | 91.3% | 27 | 24 | 86.0 | FAIL |
| Chopin — Prelude in E minor, Op. 28 No. 4 | 1 | 600 | 99.0% | 98.0% | 97.3% | 2 | 1 | 95.4 | FAIL |
| **suite** | | **5996** | **96.8%** | **95.1%** | **94.3%** | **159** | **161** | | **6/16** |

## Bach — Little Prelude in C, BWV 939 — 1 failed check(s)

- Praeludium: no-invented-notes (16 extra (12 explained by printed ornaments), 1 allowed)

## Bach — Invention 1 in C, BWV 772 — 3 failed check(s)

- Invention 1: notes-present (23 missing, 2 allowed)
- Invention 1: no-invented-notes (37 extra (12 explained by printed ornaments), 2 allowed)
- Invention 1: attack-grid (exact 95.0% vs floor 95.0%)

## Bach — Invention 8 in F, BWV 779 — 2 failed check(s)

- bach-invention-08: bar-length-warning (measure_underfull + measure_overfull)
- Invention 8: bar-length (1 of 34 bars are not the printed length)

## Bach — Prelude in D minor, BWV 999 — 1 failed check(s)

- Prelude: notes-present (4 missing, 3 allowed)

## Bach — WTC I Prelude 1 in C, BWV 846 — 6 failed check(s)

- wtk1-prelude1: bar-length-warning (measure_overfull)
- Praeludium I: bar-length (1 of 35 bars are not the printed length)
- Praeludium I: notes-present (50 missing, 3 allowed)
- Praeludium I: no-invented-notes (14 extra, 3 allowed)
- Praeludium I: attack-grid (exact 88.5% vs floor 95.0%)
- Praeludium I: note-length (onGrid 88.0% vs floor 90.0%)

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
- Poco moto: bar-length (7 of 106 bars are not the printed length)
- Poco moto: notes-present (27 missing, 7 allowed)
- Poco moto: no-invented-notes (24 extra, 7 allowed)
- Poco moto: attack-grid (exact 92.5% vs floor 95.0%)

## Chopin — Prelude in E minor, Op. 28 No. 4 — 2 failed check(s)

- chopin-prelude-4: bar-length-warning (measure_overfull)
- Largo: bar-length (1 of 26 bars are not the printed length)
