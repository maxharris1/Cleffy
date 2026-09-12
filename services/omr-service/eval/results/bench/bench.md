# OMR play-along benchmark

engine: audiveris-5.11.0+svc-14  audiveris: - Version:      5.11.0
audiveris options: `-option org.audiveris.omr.sheet.ProcessingSwitches.lyrics=false -option org.audiveris.omr.sheet.ProcessingSwitches.implicitTuplets=true -option org.audiveris.omr.sheet.ProcessingSwitches.fingerings=true`
generated: 2026-09-12T17:43:54.262Z
gate floors: exact ≥ 95.0%, onGrid ≥ 90.0%, 1 missed/extra note allowed per 16 printed bars

**Play-along score 72.0%** · 2/6 pieces pass the gate

| Piece | Pages | Ref notes | Pitch | +Onset | +Length | Miss | Extra | Composite | Gate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Bach — WTC I Prelude 1 in C, BWV 846 | 2 | 549 | 96.2% | 81.6% | 79.6% | 17 | 14 | 84.3 | FAIL |
| Petzold / Bach — Menuet in G, BWV Anh. 114 | 1 | 204 | 99.5% | 99.5% | 96.6% | 1 | 10 | 89.6 | pass |
| Bach — Menuet in G minor, BWV Anh. 115 | 1 | 199 | 100.0% | 100.0% | 97.5% | 0 | 12 | 90.0 | pass |
| Schumann — Album für die Jugend, Op. 68 No. 1 (Mélodie) | 1 | 303 | 100.0% | 100.0% | 99.7% | 0 | 4 | 100.0 | FAIL |
| Beethoven — Für Elise, WoO 59 (Mutopia typeset) | 3 | 905 | 72.2% | 31.9% | 30.5% | 192 | 192 | 61.8 | FAIL |
| Chopin — Prelude in E minor, Op. 28 No. 4 | 1 | 600 | 99.0% | 98.0% | 97.0% | 2 | 1 | 95.4 | FAIL |
| **suite** | | **2760** | **89.9%** | **73.6%** | **72.0%** | **212** | **233** | | **2/6** |

## Bach — WTC I Prelude 1 in C, BWV 846 — 6 failed check(s)

- wtk1-prelude1: bar-length-warning (measure_underfull + measure_overfull)
- Praeludium I: bar-length (11 of 35 bars are not the printed length)
- Praeludium I: notes-present (17 missing, 3 allowed)
- Praeludium I: no-invented-notes (14 extra, 3 allowed)
- Praeludium I: attack-grid (exact 81.6% vs floor 95.0%)
- Praeludium I: note-length (onGrid 79.6% vs floor 90.0%)

## Schumann — Album für die Jugend, Op. 68 No. 1 (Mélodie) — 1 failed check(s)

- Melodie: no-invented-notes (4 extra, 2 allowed)

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
