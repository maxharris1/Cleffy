package org.audiveris.omr.sheet.rhythm;

import org.apache.pdfbox.util.Matrix;
import org.audiveris.omr.sheet.clef.PdfClefHints;

import java.awt.geom.Path2D;
import java.awt.geom.Rectangle2D;
import java.nio.file.Files;
import java.nio.file.Path;
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
        final List<PdfSystemNumbers.NumberHint> grouped = PdfSystemNumbers.groupDigits(
                List.of(
                        PdfSystemNumbers.hit(1, new Rectangle2D.Double(22.8, 403.4, 4.2, 8.2), pageBox),
                        PdfSystemNumbers.hit(0, new Rectangle2D.Double(27.2, 403.4, 5.2, 8.2), pageBox)),
                List.of());
        require(grouped.size() == 1 && grouped.get(0).value == 10 && !grouped.get(0).followedByPeriod,
                "grouped 10");
        final List<PdfSystemNumbers.NumberHint> titled = PdfSystemNumbers.groupDigits(
                List.of(PdfSystemNumbers.hit(5, new Rectangle2D.Double(40, 700, 5, 8), pageBox)),
                List.of(PdfSystemNumbers.hit(-1, new Rectangle2D.Double(45.2, 700, 2, 2), pageBox)));
        require(titled.size() == 1 && titled.get(0).followedByPeriod, "title 5. trailing period");
        System.out.println("grouped integers and title period");

        if (args.length > 0) {
            final Path pdfPath = Path.of(args[0]);
            require(Files.isRegularFile(pdfPath), "PDF path");
            final List<PdfSystemNumbers.NumberHint> first = PdfSystemNumbers.scanUncached(pdfPath, 0);
            require(!first.isEmpty(), "visible PDF digits");
            boolean sawFive = false;
            boolean sawTen = false;
            for (PdfSystemNumbers.NumberHint hint : first) {
                if ((hint.value == 5) && !hint.followedByPeriod) {
                    sawFive = true;
                }
                if ((hint.value == 10) && !hint.followedByPeriod) {
                    sawTen = true;
                }
            }
            require(sawFive, "printed 5 without period");
            require(sawTen, "printed 10");
            final List<PdfSystemNumbers.NumberHint> again = PdfSystemNumbers.scan(pdfPath, 0);
            require(again.size() == first.size(), "duplicate scan is inert");
            require(PdfSystemNumbers.scan(pdfPath, 99).isEmpty(), "missing page keeps old path");
            System.out.println("actual Schumann PDF numbers count=" + first.size());
        }

        System.out.println("InternalDoubleBarControls ok");
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
