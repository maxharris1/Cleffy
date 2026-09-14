# Air (`bach-air-anh131`) implicit tuplet localization

This is a bounded engine option experiment against the frozen svc-15 packet:

- page: `/tmp/omr-rsi-baseline/air-page.png`
- report: `/tmp/omr-rsi-baseline/bach-air-anh131.json`
- raw OMR: `services/omr-service/eval/cache/artifacts/2421e97393ee1b476897314326409e0ea3e25e3ceb6d4bf215342e709be35af5-audiveris-5.11.0+svc-15-70115b6766485bc3d380ec66f10be4cde4283e4f6031a606a671c9575aa2883f/omr-eval-input.omr`
- emitted MusicXML: `/tmp/air-mxl/omr-eval-input.xml`
- edition source: `/tmp/omr-rsi-baseline/air.ly`

The page's ordinary m14 beamed group has no printed tuplet numeral or bracket. The raw OMR nevertheless records `sheet#1/sheet#1.xml` stack 14 as `expected="1" duration="3/4"` with `<tuplets>3014</tuplets>`, and its inter is `<tuplet shape="TUPLET_THREE" implicit="true">`. MusicXML m14 consequently emits `time-modification` 3:2 on the first four upper-staff notes (durations 8, 4, 4, and 8); the final upper-staff quarter is duration 12 with no time modification. The emitted `<tuplet>` start/stop is not present on the page. This is direct evidence of an invented implicit 3:2 interpretation at the engine boundary.

The source edition's upper voice is ordinary quarter/eighth notation in this passage; it supplies no `\\tuplet` command for the group. The lower voice is also ordinary 4/4 material. The raw OMR and emitted MusicXML extent for m14 is 1440 ticks, but `buildScoreData` regrids that measure to 1920 `dTicks`; 1440 is not the ScoreData duration. The initial baseline's incomplete-measure warning came from the printed m8 and m16 fragments. Cycle 9 preserves the malformed m14 tuplet warning while retaining the explicit fragment handling. The proposed single change is therefore the generic Audiveris switch:

```text
org.audiveris.omr.sheet.ProcessingSwitches.implicitTuplets=false
```

With this switch, the engine should retain the printed quarter/eighth durations in ordinary groups while leaving explicitly recognized printed tuplets eligible for recognition. The tested change was in the live default argv in `services/omr-service/src/audiveris.ts`; its argv contract is covered by `services/omr-service/src/audiveris.test.ts`. No parser rhythm repair, pitch correction, corpus pin, floor, or allowance is part of this hypothesis.

The experiment is accepted only if m14 recovers its printed duration and notes, explicit printed tuplets in the protected corpus remain intact, and every currently passing piece stays green. A remaining underfull warning in a genuinely incomplete printed measure must remain visible.

## Cycle 11 verdict: reject the global switch

The full fresh 16-piece run used the unchanged svc-16 jar and candidate wrapper
revision svc-17 with `implicitTuplets=false`. Air recovers its printed m14
quarter/eighth durations and passes at exact/on-grid 95/97. However, protected
BWV 999 loses four notes and turns red; WTC loses 33 additional notes, and Für
Elise loses three notes and gains three bad-length bars. The option also controls
voice mapping, not merely tuplet creation: `MeasureRhythm.SlotMapper.mapRookies`
changes its handling of chords whose active-voice ending conflicts with slot time.
The global change and candidate version were reverted. No pass is retained from
this experiment. A narrower engine hypothesis must preserve voice recovery while
rejecting the unsupported m14 tuplet; it cannot infer durations just to fill a bar.
See [cycle 11](omr-rsi-cycle-11.md) for the complete failure and restored baseline.
