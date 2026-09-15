package org.audiveris.omr.sheet.clef;

import org.apache.pdfbox.Loader;
import org.apache.pdfbox.contentstream.PDFStreamEngine;
import org.apache.pdfbox.contentstream.operator.state.Concatenate;
import org.apache.pdfbox.contentstream.operator.state.Restore;
import org.apache.pdfbox.contentstream.operator.state.Save;
import org.apache.pdfbox.contentstream.operator.state.SetGraphicsStateParameters;
import org.apache.pdfbox.contentstream.operator.state.SetMatrix;
import org.apache.pdfbox.contentstream.operator.text.BeginText;
import org.apache.pdfbox.contentstream.operator.text.EndText;
import org.apache.pdfbox.contentstream.operator.text.MoveText;
import org.apache.pdfbox.contentstream.operator.text.MoveTextSetLeading;
import org.apache.pdfbox.contentstream.operator.text.NextLine;
import org.apache.pdfbox.contentstream.operator.text.SetCharSpacing;
import org.apache.pdfbox.contentstream.operator.text.SetFontAndSize;
import org.apache.pdfbox.contentstream.operator.text.SetTextHorizontalScaling;
import org.apache.pdfbox.contentstream.operator.text.SetTextLeading;
import org.apache.pdfbox.contentstream.operator.text.SetTextRenderingMode;
import org.apache.pdfbox.contentstream.operator.text.SetTextRise;
import org.apache.pdfbox.contentstream.operator.text.SetWordSpacing;
import org.apache.pdfbox.contentstream.operator.text.ShowText;
import org.apache.pdfbox.contentstream.operator.text.ShowTextAdjusted;
import org.apache.pdfbox.contentstream.operator.text.ShowTextLine;
import org.apache.pdfbox.contentstream.operator.text.ShowTextLineAndSpace;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.font.PDFont;
import org.apache.pdfbox.pdmodel.font.PDSimpleFont;
import org.apache.pdfbox.pdmodel.font.PDVectorFont;
import org.apache.pdfbox.pdmodel.graphics.state.RenderingMode;
import org.apache.pdfbox.util.Matrix;
import org.apache.pdfbox.util.Vector;

import java.awt.Shape;
import java.awt.geom.AffineTransform;
import java.awt.geom.Path2D;
import java.awt.geom.Rectangle2D;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Recover explicitly named PDF change-clef glyphs ({@code clefs.G_change},
 * {@code clefs.F_change}) from the book's source page.
 * <p>
 * Identity comes from the embedded font encoding and outline. No piece name, character
 * code, font-subset prefix, PDF hash or coordinate rule is used.
 */
public final class PdfClefHints
{
    private static final ConcurrentHashMap<String, List<Hint>> CACHE = new ConcurrentHashMap<>();

    private static final double SHEAR_LIMIT = 1e-3;

    private static final int MIN_INK = 60;

    private static final int MIN_PATH_PIXELS = 200;

    private static final double MIN_FILL = 0.08;

    private static final double MIN_CONTAINED_INK = 0.6;

    private PdfClefHints ()
    {
    }

    /** Named change-clef identities admitted from an embedded music font. */
    public enum Identity
    {
        G_CHANGE,
        F_CHANGE;

        static Identity ofGlyphName (String name)
        {
            if ("clefs.G_change".equals(name)) {
                return G_CHANGE;
            }
            if ("clefs.F_change".equals(name)) {
                return F_CHANGE;
            }
            return null;
        }

        /** Pitch of the staff line this change clef is drawn on. */
        public double clefLinePitch ()
        {
            return switch (this) {
            case G_CHANGE -> 2;
            case F_CHANGE -> -2;
            };
        }
    }

    /** One named, visibly painted change-clef on a page. */
    public static final class Hint
    {
        public final Identity identity;

        public final String glyphName;

        public final String fontName;

        public final Path2D pdfPath;

        public final Rectangle2D pageBox;

        Hint (Identity identity,
              String glyphName,
              String fontName,
              Path2D pdfPath,
              Rectangle2D pageBox)
        {
            this.identity = identity;
            this.glyphName = glyphName;
            this.fontName = fontName;
            this.pdfPath = pdfPath;
            this.pageBox = pageBox;
        }
    }

    /** Outline-clipped ink counts. Bounding-box overlap alone is not agreement. */
    public static final class InkEvidence
    {
        public final int pathPixels;

        public final int inkInside;

        public final int inkInBounds;

        InkEvidence (int pathPixels,
                     int inkInside,
                     int inkInBounds)
        {
            this.pathPixels = pathPixels;
            this.inkInside = inkInside;
            this.inkInBounds = inkInBounds;
        }

        public boolean agrees ()
        {
            return (pathPixels >= MIN_PATH_PIXELS) && (inkInside >= MIN_INK)
                    && ((inkInside / (double) pathPixels) >= MIN_FILL)
                    && (inkInBounds > 0)
                    && ((inkInside / (double) inkInBounds) >= MIN_CONTAINED_INK);
        }

        /** Recognition confidence from PDF/ink fill, not a classifier grade. */
        public double confidence ()
        {
            if (pathPixels <= 0) {
                return 0;
            }
            return Math.min(1.0, (2.0 * inkInside) / pathPixels);
        }
    }

    /** Staff geometry used to require one unambiguous clef-line anchor. */
    public static final class StaffAnchor
    {
        public final int index;

        public final double firstLineY;

        public final double lastLineY;

        public final double clefLineY;

        public final double interline;

        public StaffAnchor (int index,
                            double firstLineY,
                            double lastLineY,
                            double clefLineY,
                            double interline)
        {
            this.index = index;
            this.firstLineY = firstLineY;
            this.lastLineY = lastLineY;
            this.clefLineY = clefLineY;
            this.interline = interline;
        }
    }

    @FunctionalInterface
    public interface PixelSource
    {
        boolean isInk (int x,
                         int y);
    }

    public static Identity identityOf (String glyphName)
    {
        return Identity.ofGlyphName(glyphName);
    }

    /**
     * Scan one PDF page for named change-clef glyphs. Missing source, rotation, or an
     * unsupported transform returns an empty list so the existing header path is unchanged.
     */
    public static List<Hint> scan (Path pdf,
                                    int pageIndex)
    {
        if ((pdf == null) || (pageIndex < 0) || !Files.isRegularFile(pdf)) {
            return List.of();
        }
        final String name = pdf.getFileName().toString().toLowerCase(Locale.ROOT);
        if (!name.endsWith(".pdf")) {
            return List.of();
        }
        final String key;
        try {
            key = pdf.toAbsolutePath().normalize() + "|" + Files.size(pdf) + "|" + pageIndex;
        } catch (IOException ex) {
            return List.of();
        }
        return CACHE.computeIfAbsent(key, ignored -> readPage(pdf, pageIndex));
    }

    public static List<Hint> scanUncached (Path pdf,
                                         int pageIndex)
    {
        return readPage(pdf, pageIndex);
    }

    public static boolean uprightMatrix (Matrix trm)
    {
        if (trm == null) {
            return false;
        }
        return (trm.getScaleX() > 0) && (trm.getScaleY() > 0)
                && (Math.abs(trm.getShearX()) < SHEAR_LIMIT)
                && (Math.abs(trm.getShearY()) < SHEAR_LIMIT);
    }

    public static AffineTransform pdfToSheet (Rectangle2D pageBox,
                                             int sheetWidth,
                                             int sheetHeight)
    {
        if ((pageBox == null) || (pageBox.getWidth() <= 0) || (pageBox.getHeight() <= 0)
                || (sheetWidth <= 0) || (sheetHeight <= 0)) {
            return null;
        }
        final double sx = sheetWidth / pageBox.getWidth();
        final double sy = sheetHeight / pageBox.getHeight();
        return new AffineTransform(
                sx,
                0,
                0,
                -sy,
                -pageBox.getX() * sx,
                (pageBox.getY() + pageBox.getHeight()) * sy);
    }

    public static Path2D toSheetPath (Hint hint,
                                       int sheetWidth,
                                       int sheetHeight)
    {
        if (hint == null) {
            return null;
        }
        final AffineTransform at = pdfToSheet(hint.pageBox, sheetWidth, sheetHeight);
        if (at == null) {
            return null;
        }
        return new Path2D.Double(hint.pdfPath, at);
    }

    public static Rectangle2D toSheetBounds (Rectangle2D pdfBounds,
                                             Rectangle2D pageBox,
                                             int sheetWidth,
                                             int sheetHeight)
    {
        final AffineTransform at = pdfToSheet(pageBox, sheetWidth, sheetHeight);
        if ((at == null) || (pdfBounds == null)) {
            return null;
        }
        return at.createTransformedShape(pdfBounds).getBounds2D();
    }

    public static InkEvidence measureInk (Path2D sheetPath,
                                         PixelSource source)
    {
        if ((sheetPath == null) || (source == null)) {
            return new InkEvidence(0, 0, 0);
        }
        final Rectangle2D box = sheetPath.getBounds2D();
        if ((box.getWidth() < 4) || (box.getHeight() < 8)) {
            return new InkEvidence(0, 0, 0);
        }
        final int x0 = (int) Math.floor(box.getX());
        final int y0 = (int) Math.floor(box.getY());
        final int x1 = (int) Math.ceil(box.getMaxX());
        final int y1 = (int) Math.ceil(box.getMaxY());
        int pathPixels = 0;
        int inkInside = 0;
        int inkInBounds = 0;
        for (int y = y0; y < y1; y++) {
            for (int x = x0; x < x1; x++) {
                final boolean inside = sheetPath.contains(x + 0.5, y + 0.5);
                final boolean ink = source.isInk(x, y);
                if (inside) {
                    pathPixels++;
                    if (ink) {
                        inkInside++;
                    }
                }
                if (ink) {
                    inkInBounds++;
                }
            }
        }
        return new InkEvidence(pathPixels, inkInside, inkInBounds);
    }

    public static boolean coveredByExistingClef (Rectangle2D hint,
                                                  Rectangle2D existingClef)
    {
        if ((hint == null) || (existingClef == null)
                || (hint.getWidth() <= 0) || (existingClef.getWidth() <= 0)) {
            return false;
        }
        return hint.intersects(existingClef);
    }

    /**
     * Return the single staff whose extent and clef-line intersect the outline, or
     * {@code null} when none or more than one staff matches.
     */
    public static Integer uniqueStaff (Rectangle2D outline,
                                       List<StaffAnchor> staves)
    {
        if ((outline == null) || (staves == null) || staves.isEmpty()) {
            return null;
        }
        final double cx = outline.getCenterX();
        final double cy = outline.getCenterY();
        Integer found = null;
        for (StaffAnchor staff : staves) {
            if (staff.interline <= 0) {
                continue;
            }
            final double margin = 2 * staff.interline;
            if ((cy < (staff.firstLineY - margin)) || (cy > (staff.lastLineY + margin))) {
                continue;
            }
            if ((staff.clefLineY < outline.getMinY()) || (staff.clefLineY > outline.getMaxY())) {
                continue;
            }
            if ((cx < (outline.getMinX() - staff.interline))
                    || (cx > (outline.getMaxX() + staff.interline))) {
                continue;
            }
            if (found != null) {
                return null;
            }
            found = staff.index;
        }
        return found;
    }

    private static List<Hint> readPage (Path pdf,
                                        int pageIndex)
    {
        try (PDDocument doc = Loader.loadPDF(pdf.toFile())) {
            if (pageIndex >= doc.getNumberOfPages()) {
                return List.of();
            }
            final PDPage page = doc.getPage(pageIndex);
            if (page.getRotation() != 0) {
                return List.of();
            }
            final Collector engine = new Collector(page);
            engine.processPage(page);
            return Collections.unmodifiableList(engine.hints);
        } catch (Exception ex) {
            return List.of();
        }
    }

    private static final class Collector
            extends PDFStreamEngine
    {
        private final PDPage page;

        private final List<Hint> hints = new ArrayList<>();

        Collector (PDPage page)
        {
            this.page = page;
            addOperator(new BeginText(this));
            addOperator(new EndText(this));
            addOperator(new SetFontAndSize(this));
            addOperator(new ShowText(this));
            addOperator(new ShowTextAdjusted(this));
            addOperator(new ShowTextLine(this));
            addOperator(new ShowTextLineAndSpace(this));
            addOperator(new MoveText(this));
            addOperator(new MoveTextSetLeading(this));
            addOperator(new NextLine(this));
            addOperator(new SetCharSpacing(this));
            addOperator(new SetTextLeading(this));
            addOperator(new SetMatrix(this));
            addOperator(new SetTextRenderingMode(this));
            addOperator(new SetTextRise(this));
            addOperator(new SetWordSpacing(this));
            addOperator(new SetTextHorizontalScaling(this));
            addOperator(new Concatenate(this));
            addOperator(new Save(this));
            addOperator(new Restore(this));
            addOperator(new SetGraphicsStateParameters(this));
        }

        @Override
        protected void showFontGlyph (Matrix trm,
                                       PDFont font,
                                       int code,
                                       Vector displacement)
            throws IOException
        {
            if (!uprightMatrix(trm) || (font == null) || !font.isEmbedded() || font.isVertical()) {
                return;
            }
            if (getGraphicsState().getTextState().getRenderingMode() != RenderingMode.FILL) {
                return;
            }
            if (!(font instanceof PDSimpleFont simple) || (simple.getEncoding() == null)) {
                return;
            }
            if (!(font instanceof PDVectorFont vector)) {
                return;
            }
            final Identity identity = Identity.ofGlyphName(simple.getEncoding().getName(code));
            if (identity == null) {
                return;
            }
            final Shape glyph;
            try {
                glyph = vector.getPath(code);
            } catch (IOException ex) {
                return;
            }
            if ((glyph == null) || glyph.getBounds2D().isEmpty()) {
                return;
            }
            final AffineTransform at = trm.createAffineTransform();
            at.concatenate(font.getFontMatrix().createAffineTransform());
            final Shape pageShape = at.createTransformedShape(glyph);
            if ((pageShape == null) || pageShape.getBounds2D().isEmpty()) {
                return;
            }
            final Shape clip = getGraphicsState().getCurrentClippingPath();
            if (!clipContains(clip, pageShape.getBounds2D(), page.getCropBox())) {
                return;
            }
            final PDRectangle crop = page.getCropBox();
            final Rectangle2D pageBox = new Rectangle2D.Double(
                    crop.getLowerLeftX(),
                    crop.getLowerLeftY(),
                    crop.getWidth(),
                    crop.getHeight());
            hints.add(new Hint(
                    identity,
                    simple.getEncoding().getName(code),
                    font.getName(),
                    new Path2D.Double(pageShape),
                    pageBox));
        }
    }

    /**
     * A full-page clip from PDFBox init is supported. A reduced clip is unsupported.
     */
    public static boolean clipContains (Shape clip,
                                 Rectangle2D glyph,
                                 PDRectangle crop)
    {
        if ((glyph == null) || (crop == null)) {
            return false;
        }
        if (clip == null) {
            return true;
        }
        final Rectangle2D clipBox = clip.getBounds2D();
        final boolean fullPage = (clipBox.getWidth() >= (crop.getWidth() - 1))
                && (clipBox.getHeight() >= (crop.getHeight() - 1));
        if (!fullPage) {
            return false;
        }
        return clip.intersects(glyph);
    }
}
