package org.audiveris.omr.sheet.symbol;

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

import org.audiveris.omr.sheet.clef.PdfClefHints;

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
 * Recover explicitly named PDF quarter-rest glyphs ({@code rests.2}) from the
 * book's source page.
 * <p>
 * Identity is the embedded encoding name plus a nonempty outline in a supported
 * music-font family. No piece name, character code, subset prefix, hash or
 * coordinate rule is used. Rasterization samples pixel centers; the mask is
 * not dilated. Staff-line pixels (BINARY ink absent from NO_STAFF) are
 * excluded from both recall directions.
 */
public final class PdfQuarterRestHints
{
    public static final String QUARTER_REST_NAME = "rests.2";

    public static final double MIN_RECALL = 0.90;

    public static final double MIN_IOU = 0.85;

    private static final ConcurrentHashMap<String, List<Hint>> CACHE = new ConcurrentHashMap<>();

    private PdfQuarterRestHints ()
    {
    }

    /** One named, visibly painted quarter rest on a page. */
    public static final class Hint
    {
        public final String glyphName;

        public final String fontName;

        public final Path2D pdfPath;

        public final Rectangle2D pageBox;

        Hint (String glyphName,
              String fontName,
              Path2D pdfPath,
              Rectangle2D pageBox)
        {
            this.glyphName = glyphName;
            this.fontName = fontName;
            this.pdfPath = pdfPath;
            this.pageBox = pageBox;
        }
    }

    /**
     * Bidirectional foreground agreement after excluding staff-line pixels.
     * {@code outlineCount} / {@code glyphCount} ignore those pixels.
     */
    public static final class Agreement
    {
        public final int outlineCount;

        public final int glyphCount;

        public final int both;

        public final int staffLineSkipped;

        public Agreement (int outlineCount,
                           int glyphCount,
                           int both,
                           int staffLineSkipped)
        {
            this.outlineCount = outlineCount;
            this.glyphCount = glyphCount;
            this.both = both;
            this.staffLineSkipped = staffLineSkipped;
        }

        public double recallOutline ()
        {
            return (outlineCount <= 0) ? 0 : (both / (double) outlineCount);
        }

        public double recallGlyph ()
        {
            return (glyphCount <= 0) ? 0 : (both / (double) glyphCount);
        }

        public double iou ()
        {
            final int union = outlineCount + glyphCount - both;
            return (union <= 0) ? 0 : (both / (double) union);
        }

        public boolean agrees ()
        {
            return (outlineCount > 0) && (glyphCount > 0)
                    && (recallOutline() >= MIN_RECALL)
                    && (recallGlyph() >= MIN_RECALL)
                    && (iou() >= MIN_IOU);
        }

        /**
         * Source confidence is the minimum of the two recalls and IoU.
         * It is never clamped to a passing threshold.
         */
        public double confidence ()
        {
            return Math.min(recallOutline(), Math.min(recallGlyph(), iou()));
        }
    }

    public static final class StaffAnchor
    {
        public final int index;

        public final double firstLineY;

        public final double lastLineY;

        public final double interline;

        public StaffAnchor (int index,
                            double firstLineY,
                            double lastLineY,
                            double interline)
        {
            this.index = index;
            this.firstLineY = firstLineY;
            this.lastLineY = lastLineY;
            this.interline = interline;
        }
    }

    public static final class NamedGrade
    {
        public final String shape;

        public final double grade;

        public NamedGrade (String shape,
                            double grade)
        {
            this.shape = shape;
            this.grade = grade;
        }
    }

    @FunctionalInterface
    public interface PixelSource
    {
        boolean isInk (int x,
                         int y);
    }

    public static boolean isQuarterRestName (String glyphName)
    {
        return QUARTER_REST_NAME.equals(glyphName);
    }

    /**
     * LilyPond Emmentaler family after stripping an optional subset prefix.
     * The six-letter prefix itself is never an identity rule.
     */
    public static boolean isSupportedFamily (String fontName)
    {
        if ((fontName == null) || fontName.isBlank()) {
            return false;
        }
        String name = fontName;
        final int plus = name.indexOf('+');
        if ((plus == 6) && name.substring(0, 6).chars().allMatch(c -> (c >= 'A') && (c <= 'Z'))) {
            name = name.substring(7);
        }
        return name.toLowerCase(Locale.ROOT).startsWith("emmentaler");
    }

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

    public static Path2D toSheetPath (Hint hint,
                                       int sheetWidth,
                                       int sheetHeight)
    {
        if (hint == null) {
            return null;
        }
        final AffineTransform at = PdfClefHints.pdfToSheet(hint.pageBox, sheetWidth, sheetHeight);
        if (at == null) {
            return null;
        }
        return new Path2D.Double(hint.pdfPath, at);
    }

    /**
     * Compare the transformed outline to rest-shaped ink. Staff-line pixels are
     * skipped in both directions so staff removal cannot score as a miss.
     */
    public static Agreement measure (Path2D outline,
                                       PixelSource restInk,
                                       PixelSource staffLine)
    {
        if ((outline == null) || (restInk == null)) {
            return new Agreement(0, 0, 0, 0);
        }
        final Rectangle2D box = outline.getBounds2D();
        if ((box.getWidth() < 3) || (box.getHeight() < 6)) {
            return new Agreement(0, 0, 0, 0);
        }
        final int x0 = (int) Math.floor(box.getX());
        final int y0 = (int) Math.floor(box.getY());
        final int x1 = (int) Math.ceil(box.getMaxX());
        final int y1 = (int) Math.ceil(box.getMaxY());
        int outlineCount = 0;
        int glyphCount = 0;
        int both = 0;
        int skipped = 0;
        for (int y = y0; y < y1; y++) {
            for (int x = x0; x < x1; x++) {
                if ((staffLine != null) && staffLine.isInk(x, y)) {
                    skipped++;
                    continue;
                }
                final boolean inOutline = outline.contains(x + 0.5, y + 0.5);
                final boolean inGlyph = restInk.isInk(x, y);
                if (inOutline) {
                    outlineCount++;
                }
                if (inGlyph) {
                    glyphCount++;
                }
                if (inOutline && inGlyph) {
                    both++;
                }
            }
        }
        return new Agreement(outlineCount, glyphCount, both, skipped);
    }

    /**
     * The single glyph whose box uniquely overlaps the outline, or {@code null}
     * when none or more than one candidate overlaps.
     */
    public static Integer uniqueGlyphIndex (Rectangle2D outline,
                                              List<Rectangle2D> glyphs)
    {
        if ((outline == null) || (glyphs == null) || glyphs.isEmpty()
                || (outline.getWidth() <= 0) || (outline.getHeight() <= 0)) {
            return null;
        }
        Integer found = null;
        for (int i = 0; i < glyphs.size(); i++) {
            final Rectangle2D glyph = glyphs.get(i);
            if ((glyph == null) || (glyph.getWidth() <= 0) || (glyph.getHeight() <= 0)) {
                continue;
            }
            if (!boxesOverlap(outline, glyph)) {
                continue;
            }
            if (found != null) {
                return null;
            }
            found = i;
        }
        return found;
    }

    public static Integer uniqueStaff (Rectangle2D outline,
                                           List<StaffAnchor> staves)
    {
        if ((outline == null) || (staves == null) || staves.isEmpty()) {
            return null;
        }
        final double cy = outline.getCenterY();
        final double cx = outline.getCenterX();
        Integer found = null;
        for (StaffAnchor staff : staves) {
            if (staff.interline <= 0) {
                continue;
            }
            final double margin = 0.5 * staff.interline;
            if ((cy < (staff.firstLineY - margin)) || (cy > (staff.lastLineY + margin))) {
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

    /**
     * Reconcile a source quarter-rest grade with raster evaluations. Below-gate
     * PDF evidence is ignored. An existing QUARTER_REST is replaced only when the
     * source grade is higher; other shapes are kept.
     */
    public static List<NamedGrade> mergeQuarterRest (List<NamedGrade> raster,
                                                         NamedGrade pdf,
                                                         double symbolMinGrade)
    {
        final List<NamedGrade> out = new ArrayList<>();
        if (raster != null) {
            for (NamedGrade one : raster) {
                if (one != null) {
                    out.add(one);
                }
            }
        }
        if ((pdf == null) || (pdf.grade < symbolMinGrade) || !"QUARTER_REST".equals(pdf.shape)) {
            return List.copyOf(out);
        }
        boolean replaced = false;
        for (int i = 0; i < out.size(); i++) {
            final NamedGrade one = out.get(i);
            if ("QUARTER_REST".equals(one.shape)) {
                if (pdf.grade > one.grade) {
                    out.set(i, pdf);
                }
                replaced = true;
            }
        }
        if (!replaced) {
            out.add(0, pdf);
        }
        return List.copyOf(out);
    }

    private static boolean boxesOverlap (Rectangle2D outline,
                                            Rectangle2D glyph)
    {
        final Rectangle2D inter = outline.createIntersection(glyph);
        if ((inter.getWidth() <= 0) || (inter.getHeight() <= 0)) {
            return false;
        }
        final double interArea = inter.getWidth() * inter.getHeight();
        final double minArea = Math.min(outline.getWidth() * outline.getHeight(),
                glyph.getWidth() * glyph.getHeight());
        return (minArea > 0) && ((interArea / minArea) >= 0.5);
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
            if (!PdfClefHints.uprightMatrix(trm) || (font == null) || !font.isEmbedded()
                    || font.isVertical()) {
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
            if (!isSupportedFamily(font.getName())) {
                return;
            }
            final String glyphName = simple.getEncoding().getName(code);
            if (!isQuarterRestName(glyphName)) {
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
            if (!PdfClefHints.clipContains(clip, pageShape.getBounds2D(), page.getCropBox())) {
                return;
            }
            final PDRectangle crop = page.getCropBox();
            final Rectangle2D pageBox = new Rectangle2D.Double(
                    crop.getLowerLeftX(),
                    crop.getLowerLeftY(),
                    crop.getWidth(),
                    crop.getHeight());
            hints.add(new Hint(
                    glyphName,
                    font.getName(),
                    new Path2D.Double(pageShape),
                    pageBox));
        }
    }
}
