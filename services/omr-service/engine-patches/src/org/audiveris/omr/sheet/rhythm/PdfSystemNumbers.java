package org.audiveris.omr.sheet.rhythm;

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
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Recover printed system-start measure numbers from visible PDF text.
 * Identity comes from the embedded font encoding or unicode digit, transformed
 * outline and ink. No OCR, piece name, hash or coordinate rule is used.
 */
public final class PdfSystemNumbers
{
    private static final ConcurrentHashMap<String, List<NumberHint>> CACHE =
            new ConcurrentHashMap<>();

    private PdfSystemNumbers ()
    {
    }

    /** One grouped integer painted on the page, with optional trailing period. */
    public static final class NumberHint
    {
        public final int value;

        public final Path2D pdfPath;

        public final Rectangle2D pageBox;

        public final boolean followedByPeriod;

        NumberHint (int value,
                     Path2D pdfPath,
                     Rectangle2D pageBox,
                     boolean followedByPeriod)
        {
            this.value = value;
            this.pdfPath = pdfPath;
            this.pageBox = pageBox;
            this.followedByPeriod = followedByPeriod;
        }
    }

    public static List<NumberHint> scan (Path pdf,
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
            key = pdf.toAbsolutePath().normalize() + "|sysnum|" + Files.size(pdf) + "|" + pageIndex;
        } catch (IOException ex) {
            return List.of();
        }
        return CACHE.computeIfAbsent(key, ignored -> readPage(pdf, pageIndex));
    }

    public static List<NumberHint> scanUncached (Path pdf,
                                                 int pageIndex)
    {
        return readPage(pdf, pageIndex);
    }

    public static Integer digitOf (String glyphName,
                                    String unicode)
    {
        final Integer named = digitOfName(glyphName);
        if (named != null) {
            return named;
        }
        if ((unicode != null) && (unicode.length() == 1)) {
            final char ch = unicode.charAt(0);
            if ((ch >= '0') && (ch <= '9')) {
                return ch - '0';
            }
        }
        return null;
    }

    public static boolean isPeriod (String glyphName,
                                     String unicode)
    {
        if ("period".equals(glyphName)) {
            return true;
        }
        return ".".equals(unicode);
    }

    public static boolean isMusicGlyphName (String glyphName)
    {
        if (glyphName == null) {
            return false;
        }
        return glyphName.startsWith("clefs.")
                || glyphName.startsWith("noteheads.")
                || glyphName.startsWith("rests.")
                || glyphName.startsWith("flags.")
                || glyphName.startsWith("accidentals.")
                || glyphName.startsWith("scripts.")
                || glyphName.startsWith("timesig.")
                || glyphName.startsWith("rests");
    }

    /**
     * Group digits that share a verified text baseline, then form left-to-right
     * decimal integers on that line only. A digit on another line cannot split or
     * join a run. A trailing period marks a title/piece number, which must not be used.
     */
    public static List<NumberHint> groupDigits (List<GlyphHit> digits,
                                                  List<GlyphHit> periods)
    {
        if ((digits == null) || digits.isEmpty()) {
            return List.of();
        }
        final List<NumberHint> numbers = new ArrayList<>();
        for (List<GlyphHit> line : clusterBaselines(digits)) {
            line.sort(Comparator.comparingDouble((GlyphHit g) -> g.bounds.getMinX())
                    .thenComparingDouble(g -> g.bounds.getCenterY())
                    .thenComparingInt(g -> g.value));
            List<GlyphHit> run = new ArrayList<>();
            for (GlyphHit digit : line) {
                if (run.isEmpty()) {
                    run.add(digit);
                    continue;
                }
                final GlyphHit prev = run.get(run.size() - 1);
                if (sameNumberRun(prev, digit)) {
                    run.add(digit);
                } else {
                    numbers.add(toNumber(run, periods));
                    run = new ArrayList<>();
                    run.add(digit);
                }
            }
            if (!run.isEmpty()) {
                numbers.add(toNumber(run, periods));
            }
        }
        numbers.sort(Comparator
                .comparingDouble((NumberHint n) -> n.pdfPath.getBounds2D().getMinY())
                .thenComparingDouble(n -> n.pdfPath.getBounds2D().getMinX())
                .thenComparingInt(n -> n.value));
        return List.copyOf(numbers);
    }

    /**
     * Collect digit and period glyphs without grouping. Used by controls to prove
     * grouping is independent of draw order.
     */
    public static PageGlyphs collectUncached (Path pdf,
                                                 int pageIndex)
    {
        return readGlyphs(pdf, pageIndex);
    }

    public static Path2D toSheetPath (NumberHint hint,
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

    private static boolean sameNumberRun (GlyphHit left,
                                             GlyphHit right)
    {
        if (!sameBaseline(left, right)) {
            return false;
        }
        final Rectangle2D a = left.bounds;
        final Rectangle2D b = right.bounds;
        final double height = Math.max(a.getHeight(), b.getHeight());
        final double gap = b.getMinX() - a.getMaxX();
        if (gap < -0.15 * height) {
            return false;
        }
        return gap <= (0.55 * height);
    }

    /** Existing vertical test from sameNumberRun; not a wider line-join tolerance. */
    private static boolean sameBaseline (GlyphHit left,
                                            GlyphHit right)
    {
        final Rectangle2D a = left.bounds;
        final Rectangle2D b = right.bounds;
        final double height = Math.max(a.getHeight(), b.getHeight());
        if (height <= 0) {
            return false;
        }
        return Math.abs(a.getCenterY() - b.getCenterY()) <= (0.4 * height);
    }

    private static List<List<GlyphHit>> clusterBaselines (List<GlyphHit> digits)
    {
        final int n = digits.size();
        final int[] parent = new int[n];
        for (int i = 0; i < n; i++) {
            parent[i] = i;
        }
        for (int i = 0; i < n; i++) {
            for (int j = i + 1; j < n; j++) {
                if (sameBaseline(digits.get(i), digits.get(j))) {
                    parent[find(parent, j)] = find(parent, i);
                }
            }
        }
        final Map<Integer, List<GlyphHit>> groups = new LinkedHashMap<>();
        for (int i = 0; i < n; i++) {
            groups.computeIfAbsent(find(parent, i), key -> new ArrayList<>()).add(digits.get(i));
        }
        final List<List<GlyphHit>> lines = new ArrayList<>(groups.values());
        lines.sort(Comparator
                .comparingDouble((List<GlyphHit> line) -> lineMin(line, true))
                .thenComparingDouble(line -> lineMin(line, false)));
        return lines;
    }

    private static double lineMin (List<GlyphHit> line,
                                     boolean vertical)
    {
        double min = Double.POSITIVE_INFINITY;
        for (GlyphHit glyph : line) {
            final double value = vertical ? glyph.bounds.getCenterY() : glyph.bounds.getMinX();
            if (value < min) {
                min = value;
            }
        }
        return min;
    }

    private static int find (int[] parent,
                               int index)
    {
        int current = index;
        while (parent[current] != current) {
            parent[current] = parent[parent[current]];
            current = parent[current];
        }
        return current;
    }

    private static NumberHint toNumber (List<GlyphHit> run,
                                           List<GlyphHit> periods)
    {
        int value = 0;
        final Path2D path = new Path2D.Double();
        Rectangle2D box = null;
        for (GlyphHit digit : run) {
            value = (value * 10) + digit.value;
            path.append(digit.pdfPath, false);
            box = (box == null) ? digit.pageBox : box;
        }
        final GlyphHit last = run.get(run.size() - 1);
        final boolean period = hasTrailingPeriod(last, periods);
        return new NumberHint(value, path, box, period);
    }

    private static boolean hasTrailingPeriod (GlyphHit last,
                                                List<GlyphHit> periods)
    {
        if ((periods == null) || periods.isEmpty()) {
            return false;
        }
        final Rectangle2D digit = last.bounds;
        final double height = digit.getHeight();
        for (GlyphHit period : periods) {
            final Rectangle2D p = period.bounds;
            if (Math.abs(p.getCenterY() - digit.getCenterY()) > (0.5 * height)) {
                continue;
            }
            final double gap = p.getMinX() - digit.getMaxX();
            if ((gap >= -0.1 * height) && (gap <= (0.45 * height))) {
                return true;
            }
        }
        return false;
    }

    private static Integer digitOfName (String name)
    {
        if (name == null) {
            return null;
        }
        return switch (name) {
        case "zero" -> 0;
        case "one" -> 1;
        case "two" -> 2;
        case "three" -> 3;
        case "four" -> 4;
        case "five" -> 5;
        case "six" -> 6;
        case "seven" -> 7;
        case "eight" -> 8;
        case "nine" -> 9;
        default -> null;
        };
    }

    private static List<NumberHint> readPage (Path pdf,
                                                int pageIndex)
    {
        final PageGlyphs glyphs = readGlyphs(pdf, pageIndex);
        return groupDigits(glyphs.digits, glyphs.periods);
    }

    private static PageGlyphs readGlyphs (Path pdf,
                                               int pageIndex)
    {
        if ((pdf == null) || (pageIndex < 0) || !Files.isRegularFile(pdf)) {
            return PageGlyphs.EMPTY;
        }
        final String name = pdf.getFileName().toString().toLowerCase(Locale.ROOT);
        if (!name.endsWith(".pdf")) {
            return PageGlyphs.EMPTY;
        }
        try (PDDocument doc = Loader.loadPDF(pdf.toFile())) {
            if (pageIndex >= doc.getNumberOfPages()) {
                return PageGlyphs.EMPTY;
            }
            final PDPage page = doc.getPage(pageIndex);
            if (page.getRotation() != 0) {
                return PageGlyphs.EMPTY;
            }
            final Collector engine = new Collector(page);
            engine.processPage(page);
            return new PageGlyphs(engine.digits, engine.periods);
        } catch (Exception ex) {
            return PageGlyphs.EMPTY;
        }
    }

    public static GlyphHit hit (int value,
                                   Rectangle2D pdfBounds,
                                   Rectangle2D pageBox)
    {
        final Path2D path = new Path2D.Double();
        path.append(pdfBounds, false);
        return new GlyphHit(value, path, pdfBounds, pageBox);
    }

    /** Digits and periods collected from one PDF page, before grouping. */
    public static final class PageGlyphs
    {
        static final PageGlyphs EMPTY = new PageGlyphs(List.of(), List.of());

        public final List<GlyphHit> digits;

        public final List<GlyphHit> periods;

        PageGlyphs (List<GlyphHit> digits,
                     List<GlyphHit> periods)
        {
            this.digits = List.copyOf(digits);
            this.periods = List.copyOf(periods);
        }
    }

    public static final class GlyphHit
    {
        final int value;

        final Path2D pdfPath;

        final Rectangle2D bounds;

        final Rectangle2D pageBox;

        GlyphHit (int value,
                   Path2D pdfPath,
                   Rectangle2D bounds,
                   Rectangle2D pageBox)
        {
            this.value = value;
            this.pdfPath = pdfPath;
            this.bounds = bounds;
            this.pageBox = pageBox;
        }
    }

    private static final class Collector
            extends PDFStreamEngine
    {
        private final PDPage page;

        private final List<GlyphHit> digits = new ArrayList<>();

        private final List<GlyphHit> periods = new ArrayList<>();

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
            final String glyphName = simple.getEncoding().getName(code);
            if (isMusicGlyphName(glyphName)) {
                return;
            }
            String unicode = font.toUnicode(code);
            final Integer digit = digitOf(glyphName, unicode);
            final boolean period = isPeriod(glyphName, unicode);
            if ((digit == null) && !period) {
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
            final GlyphHit hit = new GlyphHit(
                    (digit == null) ? -1 : digit,
                    new Path2D.Double(pageShape),
                    pageShape.getBounds2D(),
                    pageBox);
            if (period) {
                periods.add(hit);
            } else {
                digits.add(hit);
            }
        }
    }
}
