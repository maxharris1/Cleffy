package org.audiveris.omr.sheet.clef;

import org.apache.pdfbox.util.Matrix;

import java.awt.geom.Path2D;
import java.awt.geom.Rectangle2D;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Standalone identity, geometry and ink controls for PDF change-clef recovery. */
public final class PdfClefHintControls
{
    private PdfClefHintControls ()
    {
    }

    public static void main (String[] args)
            throws Exception
    {
        require(PdfClefHints.identityOf("clefs.G_change") == PdfClefHints.Identity.G_CHANGE,
                "G_change identity");
        require(PdfClefHints.identityOf("clefs.F_change") == PdfClefHints.Identity.F_CHANGE,
                "F_change identity");
        require(PdfClefHints.identityOf("clefs.G") == null, "ordinary G stays on existing path");
        require(PdfClefHints.identityOf("clefs.F") == null, "ordinary F stays on existing path");
        require(PdfClefHints.identityOf("p") == null, "dynamic p is not a change clef");
        require(PdfClefHints.identityOf("five") == null, "arbitrary encoding name");
        System.out.println("identities G_change/F_change only");

        require(PdfClefHints.uprightMatrix(new Matrix(19.92534f, 0, 0, 19.92534f, 120.33424f, 556.5301f)),
                "upright text rendering matrix");
        require(!PdfClefHints.uprightMatrix(new Matrix(0, 19.9f, -19.9f, 0, 120, 556)),
                "rotated matrix unsupported");
        require(!PdfClefHints.uprightMatrix(new Matrix(-19.9f, 0, 0, 19.9f, 120, 556)),
                "reflected matrix unsupported");
        System.out.println("unsupported transforms retain old path");

        final Rectangle2D page = new Rectangle2D.Double(0, 0, 612, 792);
        final Rectangle2D pdf = new Rectangle2D.Double(120.346, 546.018, 10.229, 30.396);
        final Rectangle2D sheet = PdfClefHints.toSheetBounds(pdf, page, 2550, 3300);
        require(sheet != null, "sheet transform");
        require(Math.abs(sheet.getX() - 501.4) < 0.2, "Schumann outline x");
        require(Math.abs(sheet.getY() - 898.3) < 0.2, "Schumann outline y");
        require(Math.abs(sheet.getWidth() - 42.6) < 0.2, "Schumann outline w");
        require(Math.abs(sheet.getHeight() - 126.6) < 0.2, "Schumann outline h");
        System.out.println("named Schumann outline sheet=(%.1f,%.1f,%.1f,%.1f)".formatted(
                sheet.getX(), sheet.getY(), sheet.getWidth(), sheet.getHeight()));

        final Rectangle2D movedPdf = new Rectangle2D.Double(pdf.getX() + 10, pdf.getY() - 5, pdf.getWidth(), pdf.getHeight());
        final Rectangle2D moved = PdfClefHints.toSheetBounds(movedPdf, page, 2550, 3300);
        require(Math.abs(moved.getX() - sheet.getX() - (10 * 2550 / 612.0)) < 0.2, "translated x");
        require(Math.abs(moved.getY() - sheet.getY() - (5 * 3300 / 792.0)) < 0.2, "translated y");
        System.out.println("translated geometry");

        final Path2D outline = rectPath(sheet);
        final Mask ink = new Mask();
        fill(ink, sheet, true);
        require(PdfClefHints.measureInk(outline, ink::isInk).agrees(), "outline-clipped ink agrees");

        final Mask blank = new Mask();
        require(!PdfClefHints.measureInk(outline, blank::isInk).agrees(), "blank ink rejected");

        final Mask p = new Mask();
        fill(p, new Rectangle2D.Double(527, 842, 40, 37), true);
        require(!PdfClefHints.measureInk(outline, p::isInk).agrees(), "dynamic p rejected");
        System.out.println("ink agreement and dynamic p");

        final PdfClefHints.StaffAnchor lower = new PdfClefHints.StaffAnchor(1, 911, 1032, 961, 21);
        final PdfClefHints.StaffAnchor upper = new PdfClefHints.StaffAnchor(0, 700, 820, 760, 21);
        require(Integer.valueOf(1).equals(PdfClefHints.uniqueStaff(sheet, List.of(upper, lower))),
                "unique lower staff");
        require(PdfClefHints.uniqueStaff(sheet, List.of(upper)) == null, "wrong-staff placement");
        require(PdfClefHints.uniqueStaff(sheet, List.of(lower, new PdfClefHints.StaffAnchor(2, 911, 1032, 961, 21))) == null,
                "two matching staves");
        System.out.println("staff uniqueness");

        final Rectangle2D header = new Rectangle2D.Double(314, 911, 58, 75);
        require(!PdfClefHints.coveredByExistingClef(sheet, header), "header F does not cover inline G");
        require(PdfClefHints.coveredByExistingClef(sheet, sheet), "inline duplicate");
        require(PdfClefHints.coveredByExistingClef(sheet, new Rectangle2D.Double(501, 890, 50, 160)),
                "existing octave-sized G/F covers hint");
        System.out.println("existing header/inline/octave coverage");

        if (args.length > 0) {
            final Path pdfPath = Path.of(args[0]);
            require(Files.isRegularFile(pdfPath), "PDF path");
            final List<PdfClefHints.Hint> first = PdfClefHints.scanUncached(pdfPath, 0);
            require(first.size() == 1, "one named change clef on Schumann page 0");
            require(first.get(0).identity == PdfClefHints.Identity.G_CHANGE, "named G_change");
            require(!first.get(0).fontName.contains("piece"), "no piece-name rule");
            final Rectangle2D live = PdfClefHints.toSheetBounds(
                    first.get(0).pdfPath.getBounds2D(),
                    first.get(0).pageBox,
                    2550,
                    3300);
            require(Math.abs(live.getX() - 501.4) < 0.5, "live outline x");
            require(Math.abs(live.getY() - 898.3) < 0.5, "live outline y");
            final List<PdfClefHints.Hint> again = PdfClefHints.scan(pdfPath, 0);
            require(again.size() == first.size(), "duplicate scan is inert");
            require(PdfClefHints.scan(pdfPath, 99).isEmpty(), "missing page keeps old path");
            System.out.println("actual named Schumann glyph font=" + first.get(0).fontName);
        }

        System.out.println("PdfClefHintControls ok");
    }

    private static Path2D rectPath (Rectangle2D box)
    {
        final Path2D path = new Path2D.Double();
        path.append(box, false);
        return path;
    }

    private static void fill (Mask mask,
                               Rectangle2D box,
                               boolean ink)
    {
        if (!ink) {
            return;
        }
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
