package org.audiveris.omr.sheet.rhythm;

import org.apache.pdfbox.util.Matrix;
import org.audiveris.omr.sheet.clef.PdfClefHints;

import java.awt.geom.Path2D;
import java.awt.geom.Rectangle2D;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Standalone source/geometry/ink controls for internal double-bar recovery.
 * These checks do not establish a suite pass.
 */
public final class InternalDoubleBarControls
{
    private InternalDoubleBarControls ()
    {
    }

    public static void main (String[] args)
            throws Exception
    {
        checkMergedVoiceTables();

        require(InternalDoubleBarEvidence.sourceCountAllowsInternal(5, 10, 6),
                "Schumann printed 5..10 vs six stacks");
        require(!InternalDoubleBarEvidence.sourceCountAllowsInternal(5, 11, 6),
                "changing the following anchor so both fragments count");
        require(!InternalDoubleBarEvidence.sourceCountAllowsInternal(5, 10, 5),
                "printed count matching raw stacks");
        require(!InternalDoubleBarEvidence.sourceCountAllowsInternal(8, 10, 2),
                "genuine numbered short-bar pair stays two measures");
        require(!InternalDoubleBarEvidence.sourceCountAllowsInternal(5, 10, 1),
                "need two stacks");
        System.out.println("printed anchors vs raw count");

        require(InternalDoubleBarEvidence.complementaryDurations(1, 2, 1, 2, 1, 1),
                "two halves of 4/4");
        require(!InternalDoubleBarEvidence.complementaryDurations(1, 1, 1, 1, 1, 1),
                "ordinary full bars around a double");
        require(!InternalDoubleBarEvidence.complementaryDurations(0, 1, 1, 1, 1, 1),
                "empty left fragment");
        require(InternalDoubleBarEvidence.complementaryDurations(1, 2, 1, 2, 1, 1)
                        && !InternalDoubleBarEvidence.sourceCountAllowsInternal(5, 11, 6),
                "duration sum cannot override contrary source numbers");
        System.out.println("complementary durations are not enough alone");

        require(InternalDoubleBarEvidence.isInternalDoubleThin("LIGHT_LIGHT", false, false, false),
                "double-thin separator");
        require(!InternalDoubleBarEvidence.isInternalDoubleThin("LIGHT_HEAVY", false, false, false),
                "Schumann final light-heavy");
        require(!InternalDoubleBarEvidence.isInternalDoubleThin("LIGHT_LIGHT", false, true, false),
                "Air right repeat");
        require(!InternalDoubleBarEvidence.isInternalDoubleThin("LIGHT_LIGHT", true, false, false),
                "left repeat");
        require(!InternalDoubleBarEvidence.isInternalDoubleThin("LIGHT_LIGHT", false, false, true),
                "ending");
        require(!InternalDoubleBarEvidence.isInternalDoubleThin("HEAVY_LIGHT", false, false, false),
                "heavy-light");
        System.out.println("separator styles");

        require(InternalDoubleBarEvidence.uniqueEligiblePairIndex(
                new boolean[] {false, true, false, false, false}) == 1,
                "unique complementary pair");
        require(InternalDoubleBarEvidence.uniqueEligiblePairIndex(
                new boolean[] {true, false, true}) == -1,
                "two eligible pairs");
        require(InternalDoubleBarEvidence.uniqueEligiblePairIndex(new boolean[] {false, false}) == -1,
                "no eligible pair");
        System.out.println("unique pair selection");

        require(PdfSystemNumbers.digitOf("five", null) == Integer.valueOf(5), "encoding five");
        require(PdfSystemNumbers.digitOf("one", null) == Integer.valueOf(1), "encoding one");
        require(PdfSystemNumbers.digitOf("zero", null) == Integer.valueOf(0), "encoding zero");
        require(PdfSystemNumbers.digitOf(null, "5") == Integer.valueOf(5), "unicode five");
        require(PdfSystemNumbers.digitOf("clefs.G_change", "5") == null
                        || PdfSystemNumbers.isMusicGlyphName("clefs.G_change"),
                "music glyph name rejected");
        require(PdfSystemNumbers.isMusicGlyphName("clefs.G_change"), "change-clef is not a number");
        require(PdfSystemNumbers.isMusicGlyphName("noteheads.s2"), "notehead is not a number");
        require(PdfSystemNumbers.digitOf("p", "p") == null, "dynamic p");
        require(PdfSystemNumbers.isPeriod("period", null), "period name");
        require(PdfClefHints.identityOf("five") == null, "clef helper still ignores digits");
        System.out.println("digit identity without OCR");

        require(PdfClefHints.uprightMatrix(new Matrix(10, 0, 0, 10, 27.57f, 508.4f)),
                "upright number matrix");
        require(!PdfClefHints.uprightMatrix(new Matrix(0, 10, -10, 0, 27, 508)),
                "rotated number unsupported");
        System.out.println("unsupported transforms skip recovery");

        final Rectangle2D page = new Rectangle2D.Double(0, 0, 612, 792);
        // pdftotext top-left (27.57,275.40)-(32.40,283.60) → PDF y = 792 - yTop.
        final Rectangle2D fivePdf = new Rectangle2D.Double(27.569155, 792 - 283.599141,
                32.403551 - 27.569155, 283.599141 - 275.399796);
        final Rectangle2D fiveSheet = PdfClefHints.toSheetBounds(fivePdf, page, 2550, 3300);
        require(fiveSheet != null, "printed 5 sheet transform");
        final Rectangle2D tenPdf = new Rectangle2D.Double(22.807046, 792 - 388.579351,
                32.403480 - 22.807046, 388.579351 - 380.380006);
        final Rectangle2D tenSheet = PdfClefHints.toSheetBounds(tenPdf, page, 2550, 3300);
        require(tenSheet != null, "printed 10 sheet transform");
        require(Math.abs(fiveSheet.getX() - (27.569155 * 2550 / 612.0)) < 0.5, "translated 5 x");
        require(Math.abs(tenSheet.getX() - (22.807046 * 2550 / 612.0)) < 0.5, "translated 10 x");
        System.out.println("Schumann printed 5/10 sheet geometry");

        final double interline = 21;
        final InternalDoubleBarEvidence.SystemGeom system2 =
                new InternalDoubleBarEvidence.SystemGeom(1, fiveSheet.getCenterX(),
                        fiveSheet.getMaxY() + (2 * interline), interline);
        final InternalDoubleBarEvidence.SystemGeom system3 =
                new InternalDoubleBarEvidence.SystemGeom(2, tenSheet.getCenterX(),
                        tenSheet.getMaxY() + (2 * interline), interline);
        require(Integer.valueOf(1).equals(InternalDoubleBarEvidence.uniqueSystemIndex(
                fiveSheet, List.of(system2, system3))), "5 binds system 2");
        require(Integer.valueOf(2).equals(InternalDoubleBarEvidence.uniqueSystemIndex(
                tenSheet, List.of(system2, system3))), "10 binds system 3");

        final Rectangle2D title = new Rectangle2D.Double(120, 80, 18, 22);
        require(InternalDoubleBarEvidence.uniqueSystemIndex(title, List.of(system2, system3)) == null,
                "title digit");
        final Rectangle2D fingering = new Rectangle2D.Double(
                system2.staffLeft + (8 * interline),
                system2.firstLineY + (2 * interline),
                10,
                12);
        require(InternalDoubleBarEvidence.uniqueSystemIndex(fingering, List.of(system2, system3)) == null,
                "fingering digit on the staff");
        final Rectangle2D wrongStaff = new Rectangle2D.Double(
                system3.staffLeft,
                system2.firstLineY - (2 * interline),
                14,
                16);
        require(InternalDoubleBarEvidence.uniqueSystemIndex(wrongStaff, List.of(system2)) == null,
                "wrong-staff anchor");
        require(InternalDoubleBarEvidence.uniqueSystemIndex(fiveSheet, List.of(system2, system2)) == null,
                "ambiguous duplicate system geometry");
        System.out.println("system-left uniqueness, title, fingering, wrong staff");

        final Path2D outline = rectPath(fiveSheet);
        final Mask ink = new Mask();
        fill(ink, fiveSheet);
        final PdfClefHints.InkEvidence agrees = PdfClefHints.measureInk(outline, ink::isInk);
        require(InternalDoubleBarEvidence.digitInkAgrees(
                agrees.pathPixels, agrees.inkInside, agrees.inkInBounds),
                "printed number ink");
        final Mask blank = new Mask();
        final PdfClefHints.InkEvidence blankInk = PdfClefHints.measureInk(outline, blank::isInk);
        require(!InternalDoubleBarEvidence.digitInkAgrees(
                blankInk.pathPixels, blankInk.inkInside, blankInk.inkInBounds),
                "blank number ink");
        final Mask other = new Mask();
        fill(other, new Rectangle2D.Double(fiveSheet.getX() + 80, fiveSheet.getY(), 20, 20));
        final PdfClefHints.InkEvidence wrongInk = PdfClefHints.measureInk(outline, other::isInk);
        require(!InternalDoubleBarEvidence.digitInkAgrees(
                wrongInk.pathPixels, wrongInk.inkInside, wrongInk.inkInBounds),
                "wrong-place ink");
        System.out.println("digit ink agreement");

        final Rectangle2D pageBox = new Rectangle2D.Double(0, 0, 612, 792);
        final PdfSystemNumbers.GlyphHit one = PdfSystemNumbers.hit(
                1, new Rectangle2D.Double(22.8, 403.4, 4.2, 8.2), pageBox);
        final PdfSystemNumbers.GlyphHit zero = PdfSystemNumbers.hit(
                0, new Rectangle2D.Double(27.2, 403.4, 5.2, 8.2), pageBox);
        final PdfSystemNumbers.GlyphHit otherLine = PdfSystemNumbers.hit(
                3, new Rectangle2D.Double(25.0, 508.0, 4.8, 8.0), pageBox);
        final List<PdfSystemNumbers.NumberHint> grouped = PdfSystemNumbers.groupDigits(
                List.of(one, zero), List.of());
        require(grouped.size() == 1 && grouped.get(0).value == 10 && !grouped.get(0).followedByPeriod,
                "grouped 10");
        final List<PdfSystemNumbers.NumberHint> interleaved = PdfSystemNumbers.groupDigits(
                List.of(otherLine, zero, one), List.of());
        require(valuesOf(interleaved).equals(List.of(3, 10))
                        || valuesOf(interleaved).equals(List.of(10, 3)),
                "other baseline does not split 10");
        require(!valuesOf(interleaved).contains(1) && !valuesOf(interleaved).contains(0),
                "no independent 1/0 after cross-line interleave");
        final List<PdfSystemNumbers.NumberHint> equalX = PdfSystemNumbers.groupDigits(
                List.of(
                        PdfSystemNumbers.hit(1, new Rectangle2D.Double(22.8, 403.4, 4.2, 8.2), pageBox),
                        PdfSystemNumbers.hit(5, new Rectangle2D.Double(22.8, 508.0, 4.8, 8.0), pageBox)),
                List.of());
        require(valuesOf(equalX).contains(1) && valuesOf(equalX).contains(5)
                        && !valuesOf(equalX).contains(15) && !valuesOf(equalX).contains(51),
                "equal x on different baselines stay separate");
        final List<PdfSystemNumbers.NumberHint> distant = PdfSystemNumbers.groupDigits(
                List.of(
                        PdfSystemNumbers.hit(1, new Rectangle2D.Double(22.8, 403.4, 4.2, 8.2), pageBox),
                        PdfSystemNumbers.hit(0, new Rectangle2D.Double(80.0, 403.4, 5.2, 8.2), pageBox)),
                List.of());
        require(valuesOf(distant).contains(1) && valuesOf(distant).contains(0)
                        && !valuesOf(distant).contains(10),
                "distant digits on one line stay separate");
        final List<PdfSystemNumbers.NumberHint> missingZero = PdfSystemNumbers.groupDigits(
                List.of(one), List.of());
        require(missingZero.size() == 1 && missingZero.get(0).value == 1,
                "missing 0 is not a truncated 10");
        final List<PdfSystemNumbers.NumberHint> titled = PdfSystemNumbers.groupDigits(
                List.of(PdfSystemNumbers.hit(5, new Rectangle2D.Double(40, 700, 5, 8), pageBox)),
                List.of(PdfSystemNumbers.hit(-1, new Rectangle2D.Double(45.2, 700, 2, 2), pageBox)));
        require(titled.size() == 1 && titled.get(0).followedByPeriod, "title 5. trailing period");
        require(PdfSystemNumbers.scan(Path.of("not-a-pdf.txt"), 0).isEmpty(),
                "unsupported input keeps old path");
        System.out.println("grouped integers, cross-line, missing member, title period");

        final Path pdfPath = wholePdf(args);
        require(Files.isRegularFile(pdfPath), "whole pinned Schumann PDF");
        final PdfSystemNumbers.PageGlyphs glyphs = PdfSystemNumbers.collectUncached(pdfPath, 0);
        require(!glyphs.digits.isEmpty(), "visible PDF digits");
        final List<PdfSystemNumbers.GlyphHit> shuffled = new ArrayList<>(glyphs.digits);
        java.util.Collections.shuffle(shuffled, new java.util.Random(1));
        final List<PdfSystemNumbers.NumberHint> fromShuffle =
                PdfSystemNumbers.groupDigits(shuffled, glyphs.periods);
        final List<PdfSystemNumbers.NumberHint> first = PdfSystemNumbers.scanUncached(pdfPath, 0);
        require(valuesOf(fromShuffle).equals(valuesOf(first)), "shuffled draw order");
        require(countValue(first, 10, false) == 1, "one complete 10");
        require(countValue(first, 5, false) >= 1, "printed 5 without period");
        require(countValue(first, 15, false) == 1, "one complete 15");
        require(countValue(first, 20, false) == 1, "one complete 20");
        require(countValue(first, 0, false) == 0, "no independent 0");
        final PdfSystemNumbers.NumberHint ten = findValue(first, 10);
        require(ten != null, "printed 10 hint");
        final Path2D tenPath = PdfSystemNumbers.toSheetPath(ten, 2550, 3300);
        require(tenPath != null, "10 sheet outline");
        final PdfSystemNumbers.NumberHint five = findValue(first, 5);
        require(five != null, "printed 5 hint");
        final Path2D fivePath = PdfSystemNumbers.toSheetPath(five, 2550, 3300);
        final PdfSystemNumbers.NumberHint fifteen = findValue(first, 15);
        final PdfSystemNumbers.NumberHint twenty = findValue(first, 20);
        require(fifteen != null && twenty != null, "printed 15 and 20");
        final Path2D fifteenPath = PdfSystemNumbers.toSheetPath(fifteen, 2550, 3300);
        final Path2D twentyPath = PdfSystemNumbers.toSheetPath(twenty, 2550, 3300);
        require(fivePath != null && fifteenPath != null && twentyPath != null, "5/15/20 outlines");
        final double interlineLive = 21;
        final List<InternalDoubleBarEvidence.SystemGeom> systems = List.of(
                geom(1, fivePath.getBounds2D(), interlineLive),
                geom(2, tenPath.getBounds2D(), interlineLive),
                geom(3, fifteenPath.getBounds2D(), interlineLive),
                geom(4, twentyPath.getBounds2D(), interlineLive));
        require(Integer.valueOf(2).equals(InternalDoubleBarEvidence.uniqueSystemIndex(
                tenPath.getBounds2D(), systems)),
                "complete 10 binds system 3");
        require(Integer.valueOf(1).equals(InternalDoubleBarEvidence.uniqueSystemIndex(
                fivePath.getBounds2D(), systems)),
                "complete 5 binds system 2");
        require(Integer.valueOf(3).equals(InternalDoubleBarEvidence.uniqueSystemIndex(
                fifteenPath.getBounds2D(), systems)),
                "complete 15 binds system 4");
        require(Integer.valueOf(4).equals(InternalDoubleBarEvidence.uniqueSystemIndex(
                twentyPath.getBounds2D(), systems)),
                "complete 20 binds system 5");
        for (PdfSystemNumbers.NumberHint hint : first) {
            if (hint.followedByPeriod || ((hint.value != 1) && (hint.value != 0))) {
                continue;
            }
            final Path2D path = PdfSystemNumbers.toSheetPath(hint, 2550, 3300);
            require(path != null, "stray digit outline");
            require(!Integer.valueOf(2).equals(InternalDoubleBarEvidence.uniqueSystemIndex(
                    path.getBounds2D(), systems)),
                    "no independent 1/0 at system 3");
        }
        require(InternalDoubleBarEvidence.sourceCountAllowsInternal(5, 10, 6),
                "restored 5→10 still allows six stacks");
        require(!InternalDoubleBarEvidence.sourceCountAllowsInternal(5, 11, 6),
                "following anchor 11 still blocks merge");
        final Mask tenInk = new Mask();
        fill(tenInk, tenPath.getBounds2D());
        final PdfClefHints.InkEvidence tenEvidence = PdfClefHints.measureInk(tenPath, tenInk::isInk);
        require(InternalDoubleBarEvidence.digitInkAgrees(
                tenEvidence.pathPixels, tenEvidence.inkInside, tenEvidence.inkInBounds),
                "10 outline has ink");
        final Mask blankTen = new Mask();
        final PdfClefHints.InkEvidence blankTenInk = PdfClefHints.measureInk(tenPath, blankTen::isInk);
        require(!InternalDoubleBarEvidence.digitInkAgrees(
                blankTenInk.pathPixels, blankTenInk.inkInside, blankTenInk.inkInBounds),
                "blank 10 ink");
        final List<PdfSystemNumbers.NumberHint> again = PdfSystemNumbers.scan(pdfPath, 0);
        require(again.size() == first.size(), "duplicate scan is inert");
        require(PdfSystemNumbers.scan(pdfPath, 99).isEmpty(), "missing page keeps old path");
        System.out.println("whole pinned PDF 5/10/15/20 grouping and binding");

        System.out.println("InternalDoubleBarControls ok");
    }

    /**
     * Overlapping fragment slot IDs, three left voices and two right voices.
     * Rebuilds the same tables InternalDoubleBars applies; never stores a null
     * slot record. Fixture offsets are not production constants.
     */
    private static void checkMergedVoiceTables ()
    {
        final InternalDoubleBarVoices.Time quarter = new InternalDoubleBarVoices.Time(1, 4);
        final InternalDoubleBarVoices.Time eighth = new InternalDoubleBarVoices.Time(1, 8);
        final InternalDoubleBarVoices.Time half = new InternalDoubleBarVoices.Time(1, 2);
        final InternalDoubleBarVoices.Time zero = new InternalDoubleBarVoices.Time(0, 1);

        final List<InternalDoubleBarVoices.SlotCapture> leftSlots = List.of(
                slot("L-S0-1", 1, zero, 10, false),
                slot("L-S1-2", 2, quarter, 40, false));
        final List<InternalDoubleBarVoices.SlotCapture> rightSlots = List.of(
                slot("R-S0-1", 1, zero, 80, true),
                slot("R-S1-2", 2, eighth, 100, true),
                slot("R-S2-3", 3, quarter, 120, true),
                slot("R-S3-4", 4, new InternalDoubleBarVoices.Time(3, 8), 140, true));
        require(leftSlots.get(0).originalId == rightSlots.get(0).originalId,
                "overlapping pre-merge slot id 1");
        require(leftSlots.get(1).originalId == rightSlots.get(1).originalId,
                "overlapping pre-merge slot id 2");

        final List<InternalDoubleBarVoices.ChordCapture> leftChords = List.of(
                chord("U-D5", "U-L", "M0", "L-S0-1", zero, quarter, false),
                chord("U-C5a", "U-L", "M0", "L-S1-2", quarter, quarter, false),
                chord("L-F4", "L-mov", "M1", "L-S0-1", zero, quarter, false),
                chord("L-E4", "L-mov", "M1", "L-S1-2", quarter, quarter, false),
                chord("L-C4", "L-sim", "M1", "L-S0-1", zero, half, false));
        final List<InternalDoubleBarVoices.ChordCapture> rightChords = List.of(
                chord("U-B4", "U-R", "M0", "R-S0-1", zero, quarter, true),
                chord("U-C5b", "U-R", "M0", "R-S2-3", quarter, quarter, true),
                chord("L-G3", "L-R", "M1", "R-S0-1", zero, eighth, true),
                chord("L-G4a", "L-R", "M1", "R-S1-2", eighth, eighth, true),
                chord("L-A3", "L-R", "M1", "R-S2-3", quarter, eighth, true),
                chord("L-G4b", "L-R", "M1", "R-S3-4", new InternalDoubleBarVoices.Time(3, 8),
                        eighth, true));
        require(leftChords.size() == 5 && rightChords.size() == 4,
                "three left voices / two right voices");

        final InternalDoubleBarVoices.MergeTables tables = InternalDoubleBarVoices.rebuild(
                leftSlots, rightSlots, leftChords, rightChords, half);
        require(tables.ok, "rebuild overlapping fragment tables");
        require(tables.slots.size() == 6, "renumbered slots 1..6");
        require(InternalDoubleBarVoices.beginCount(tables.puts) == 9,
                "every original chord is one onset");
        for (InternalDoubleBarVoices.SlotPut put : tables.puts) {
            require((put.chordId != null) && (put.status != null),
                    "no null slot record");
        }
        require(tables.voiceKeys.size() == 5, "left and right voices stay distinct");

        require(slotTime(tables, 1).equals(zero) && slotTime(tables, 2).equals(quarter),
                "left onsets unchanged");
        require(slotTime(tables, 3).equals(half), "right first onset + 1/2");
        require(slotTime(tables, 4).equals(new InternalDoubleBarVoices.Time(5, 8)),
                "right eighth at 2.5 quarters");
        require(slotTime(tables, 5).equals(new InternalDoubleBarVoices.Time(3, 4)),
                "right quarter at 3");
        require(slotTime(tables, 6).equals(new InternalDoubleBarVoices.Time(7, 8)),
                "right last eighth at 3.5");

        require(hasPut(tables, "U-L", 1, "U-D5", InternalDoubleBarVoices.BEGIN), "upper D5 BEGIN");
        require(hasPut(tables, "U-L", 2, "U-C5a", InternalDoubleBarVoices.BEGIN), "upper C5 BEGIN");
        require(hasPut(tables, "L-mov", 1, "L-F4", InternalDoubleBarVoices.BEGIN), "lower F4 BEGIN");
        require(hasPut(tables, "L-mov", 2, "L-E4", InternalDoubleBarVoices.BEGIN), "lower E4 BEGIN");
        require(hasPut(tables, "L-sim", 1, "L-C4", InternalDoubleBarVoices.BEGIN), "C4 half BEGIN");
        require(hasPut(tables, "L-sim", 2, "L-C4", InternalDoubleBarVoices.CONTINUE),
                "C4 half CONTINUE through second left onset");
        require(!hasStatusAt(tables, "L-sim", 3, InternalDoubleBarVoices.CONTINUE),
                "no invented C4 continuation into the right fragment");
        require(hasPut(tables, "U-R", 3, "U-B4", InternalDoubleBarVoices.BEGIN),
                "voice entering only on the right");
        require(hasPut(tables, "U-R", 5, "U-C5b", InternalDoubleBarVoices.BEGIN), "right upper C5");
        require(!hasStatusAt(tables, "U-R", 1, InternalDoubleBarVoices.BEGIN),
                "right voice is not keyed by leftover slot id 1");
        require(!hasStatusAt(tables, "U-R", 2, InternalDoubleBarVoices.BEGIN),
                "right voice is not keyed by leftover slot id 2");
        require(hasPut(tables, "L-R", 3, "L-G3", InternalDoubleBarVoices.BEGIN), "lower G3");
        require(hasPut(tables, "L-R", 4, "L-G4a", InternalDoubleBarVoices.BEGIN), "lower G4 eighth");
        require(hasPut(tables, "L-R", 5, "L-A3", InternalDoubleBarVoices.BEGIN), "lower A3");
        require(hasPut(tables, "L-R", 6, "L-G4b", InternalDoubleBarVoices.BEGIN), "lower last G4");
        System.out.println("merged voice/slot tables from overlapping fragment ids");

        final List<InternalDoubleBarVoices.SlotCapture> mergedSlots = new ArrayList<>();
        for (InternalDoubleBarVoices.SlotPlan plan : tables.slots) {
            mergedSlots.add(new InternalDoubleBarVoices.SlotCapture(
                    plan.key, plan.newId, plan.time, plan.xOffset, false));
        }
        final List<InternalDoubleBarVoices.ChordCapture> mergedChords = new ArrayList<>();
        for (InternalDoubleBarVoices.SlotPut put : tables.puts) {
            if (!InternalDoubleBarVoices.BEGIN.equals(put.status)) {
                continue;
            }
            mergedChords.add(new InternalDoubleBarVoices.ChordCapture(
                    put.chordId, put.voiceKey, put.measureKey, slotKey(tables, put.slotId),
                    slotTime(tables, put.slotId), durationOf(put.chordId, leftChords, rightChords),
                    false));
        }
        final InternalDoubleBarVoices.MergeTables again =
                InternalDoubleBarVoices.tablesFromOnsets(mergedSlots, mergedChords);
        require(again.ok && (again.puts.size() == tables.puts.size()),
                "second table rebuild is inert");
        require(InternalDoubleBarVoices.beginCount(again.puts) == 9,
                "second application keeps one onset per chord");
        System.out.println("second application of voice-table rebuild");

        final InternalDoubleBarVoices.MergeTables missing = InternalDoubleBarVoices.rebuild(
                leftSlots, rightSlots,
                List.of(new InternalDoubleBarVoices.ChordCapture(
                        "bad", "U-L", "M0", "L-S0-1", null, quarter, false)),
                rightChords, half);
        require(!missing.ok, "unsupported missing timing does not merge");
        require(InternalDoubleBarVoices.rebuild(
                leftSlots, List.of(), leftChords, rightChords, half).ok == false,
                "empty right fragment is not a partial merge");
        System.out.println("unsupported missing timing");
    }

    private static InternalDoubleBarVoices.SlotCapture slot (String key,
                                                               int originalId,
                                                               InternalDoubleBarVoices.Time time,
                                                               int xOffset,
                                                               boolean fromRight)
    {
        return new InternalDoubleBarVoices.SlotCapture(key, originalId, time, xOffset, fromRight);
    }

    private static InternalDoubleBarVoices.ChordCapture chord (String chordId,
                                                                  String voiceKey,
                                                                  String measureKey,
                                                                  String slotKey,
                                                                  InternalDoubleBarVoices.Time time,
                                                                  InternalDoubleBarVoices.Time duration,
                                                                  boolean fromRight)
    {
        return new InternalDoubleBarVoices.ChordCapture(
                chordId, voiceKey, measureKey, slotKey, time, duration, fromRight);
    }

    private static InternalDoubleBarVoices.Time slotTime (InternalDoubleBarVoices.MergeTables tables,
                                                               int slotId)
    {
        for (InternalDoubleBarVoices.SlotPlan slot : tables.slots) {
            if (slot.newId == slotId) {
                return slot.time;
            }
        }
        throw new AssertionError("slot " + slotId);
    }

    private static String slotKey (InternalDoubleBarVoices.MergeTables tables,
                                      int slotId)
    {
        for (InternalDoubleBarVoices.SlotPlan slot : tables.slots) {
            if (slot.newId == slotId) {
                return slot.key;
            }
        }
        throw new AssertionError("slot key " + slotId);
    }

    private static InternalDoubleBarVoices.Time durationOf (String chordId,
                                                                List<InternalDoubleBarVoices.ChordCapture> left,
                                                                List<InternalDoubleBarVoices.ChordCapture> right)
    {
        for (InternalDoubleBarVoices.ChordCapture chord : left) {
            if (chord.chordId.equals(chordId)) {
                return chord.duration;
            }
        }
        for (InternalDoubleBarVoices.ChordCapture chord : right) {
            if (chord.chordId.equals(chordId)) {
                return chord.duration;
            }
        }
        throw new AssertionError("duration " + chordId);
    }

    private static boolean hasPut (InternalDoubleBarVoices.MergeTables tables,
                                     String voiceKey,
                                     int slotId,
                                     String chordId,
                                     String status)
    {
        for (InternalDoubleBarVoices.SlotPut put : tables.puts) {
            if (voiceKey.equals(put.voiceKey) && (put.slotId == slotId)
                    && chordId.equals(put.chordId) && status.equals(put.status)) {
                return true;
            }
        }
        return false;
    }

    private static boolean hasStatusAt (InternalDoubleBarVoices.MergeTables tables,
                                            String voiceKey,
                                            int slotId,
                                            String status)
    {
        for (InternalDoubleBarVoices.SlotPut put : tables.puts) {
            if (voiceKey.equals(put.voiceKey) && (put.slotId == slotId)
                    && status.equals(put.status)) {
                return true;
            }
        }
        return false;
    }

    private static Path wholePdf (String[] args)
    {
        if ((args != null) && (args.length > 0)) {
            return Path.of(args[0]);
        }
        final Path[] candidates = {
            Path.of("services/omr-service/eval/cache/downloads/schumann-op68-05.pdf"),
            Path.of("eval/cache/downloads/schumann-op68-05.pdf"),
            Path.of("/tmp/omr-rsi-pdf-clef/schumann-op68-05.pdf")
        };
        for (Path candidate : candidates) {
            if (Files.isRegularFile(candidate)) {
                return candidate;
            }
        }
        return Path.of("services/omr-service/eval/cache/downloads/schumann-op68-05.pdf");
    }

    private static List<Integer> valuesOf (List<PdfSystemNumbers.NumberHint> hints)
    {
        final List<Integer> values = new ArrayList<>();
        for (PdfSystemNumbers.NumberHint hint : hints) {
            if (!hint.followedByPeriod) {
                values.add(hint.value);
            }
        }
        return values;
    }

    private static int countValue (List<PdfSystemNumbers.NumberHint> hints,
                                     int value,
                                     boolean period)
    {
        int count = 0;
        for (PdfSystemNumbers.NumberHint hint : hints) {
            if ((hint.value == value) && (hint.followedByPeriod == period)) {
                count++;
            }
        }
        return count;
    }

    private static PdfSystemNumbers.NumberHint findValue (List<PdfSystemNumbers.NumberHint> hints,
                                                              int value)
    {
        PdfSystemNumbers.NumberHint found = null;
        for (PdfSystemNumbers.NumberHint hint : hints) {
            if (hint.followedByPeriod || (hint.value != value)) {
                continue;
            }
            if ((found == null)
                    || (hint.pdfPath.getBounds2D().getMinX() < found.pdfPath.getBounds2D().getMinX())) {
                found = hint;
            }
        }
        return found;
    }

    private static InternalDoubleBarEvidence.SystemGeom geom (int index,
                                                                  Rectangle2D outline,
                                                                  double interline)
    {
        return new InternalDoubleBarEvidence.SystemGeom(
                index,
                outline.getCenterX(),
                outline.getMaxY() + (2 * interline),
                interline);
    }

    private static Path2D rectPath (Rectangle2D box)
    {
        final Path2D path = new Path2D.Double();
        path.append(box, false);
        return path;
    }

    private static void fill (Mask mask,
                               Rectangle2D box)
    {
        final int x0 = (int) Math.floor(box.getX());
        final int y0 = (int) Math.floor(box.getY());
        final int x1 = (int) Math.ceil(box.getMaxX());
        final int y1 = (int) Math.ceil(box.getMaxY());
        for (int y = y0; y < y1; y++) {
            for (int x = x0; x < x1; x++) {
                mask.mark(x, y);
            }
        }
    }

    private static void require (boolean ok,
                                  String label)
    {
        if (!ok) {
            throw new AssertionError(label);
        }
        System.out.println("ok " + label);
    }

    private static final class Mask
    {
        private final Set<Long> ink = new HashSet<>();

        void mark (int x,
                    int y)
        {
            ink.add((((long) y) << 32) | (x & 0xffffffffL));
        }

        boolean isInk (int x,
                          int y)
        {
            return ink.contains((((long) y) << 32) | (x & 0xffffffffL));
        }
    }
}
