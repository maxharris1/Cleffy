package org.audiveris.omr.sheet.clef;

import org.apache.pdfbox.Loader;
import org.apache.pdfbox.contentstream.PDFGraphicsStreamEngine;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.graphics.image.PDImage;
import org.apache.pdfbox.pdmodel.graphics.state.PDGraphicsState;
import org.apache.pdfbox.util.Matrix;

import org.audiveris.omr.glyph.Glyph;
import org.audiveris.omr.sheet.Picture;
import org.audiveris.omr.sheet.Sheet;
import org.audiveris.omr.sheet.symbol.PdfQuarterRestHints;
import org.audiveris.omr.sig.SIGraph;
import org.audiveris.omr.sig.inter.AbstractBeamInter;
import org.audiveris.omr.sig.inter.ClefInter;
import org.audiveris.omr.sig.inter.Inter;
import org.audiveris.omr.sig.inter.StemInter;

import ij.process.ByteProcessor;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.awt.BasicStroke;
import java.awt.Point;
import java.awt.Rectangle;
import java.awt.Shape;
import java.awt.geom.AffineTransform;
import java.awt.geom.Area;
import java.awt.geom.Path2D;
import java.awt.geom.Point2D;
import java.awt.geom.Rectangle2D;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Named PDF change-clefs may share printed ink with a real beam. When both
 * objects are independently proven from the source page, they coexist and
 * foundation overlap exclusion must not delete one of them.
 */
public final class PdfClefBeamCrossings
{
    private static final Logger logger = LoggerFactory.getLogger(PdfClefBeamCrossings.class);

    private static final Map<ClefInter, PdfClefHints.Hint> NAMED_CLEFS = new ConcurrentHashMap<>();

    private static final ConcurrentHashMap<String, List<PaintedPath>> PATH_CACHE =
            new ConcurrentHashMap<>();

    private PdfClefBeamCrossings ()
    {
    }

    public static void rememberNamedClef (ClefInter clef,
                                             PdfClefHints.Hint hint)
    {
        if ((clef == null) || (hint == null) || (hint.identity == null)) {
            return;
        }
        NAMED_CLEFS.put(clef, hint);
    }

    /**
     * True only for a remembered named G/F change and an ordinary recognized
     * beam whose source paints independently meet the locked ink minima and
     * whose paths explain the crossing.
     */
    public static boolean coexist (Inter one,
                                     Inter two)
    {
        if ((one == null) || (two == null)) {
            return false;
        }
        final Pair pair = pairOf(one, two);
        if (pair == null) {
            return false;
        }
        try {
            return prove(pair.clef, pair.beam, pair.hint);
        } catch (RuntimeException ex) {
            logger.info("PDF clef/beam coexist skipped: {}", ex.toString());
            return false;
        }
    }

    private static Pair pairOf (Inter one,
                                   Inter two)
    {
        final ClefInter clef;
        final Inter beam;
        if (one instanceof ClefInter c && isOrdinaryBeam(two)) {
            clef = c;
            beam = two;
        } else if (two instanceof ClefInter c && isOrdinaryBeam(one)) {
            clef = c;
            beam = one;
        } else {
            return null;
        }
        final PdfClefHints.Hint hint = NAMED_CLEFS.get(clef);
        if ((hint == null) || (clef.getGlyph() == null) || (beam.getGlyph() == null)) {
            return null;
        }
        return new Pair(clef, beam, hint);
    }

    private static boolean isOrdinaryBeam (Inter inter)
    {
        return (inter instanceof AbstractBeamInter beam) && !beam.isHook();
    }

    private static boolean prove (ClefInter clef,
                                    Inter beam,
                                    PdfClefHints.Hint hint)
    {
        final SIGraph sig = clef.getSig();
        if ((sig == null) || (beam.getSig() != sig) || (sig.getSystem() == null)) {
            return false;
        }
        final Sheet sheet = sig.getSystem().getSheet();
        if (sheet == null) {
            return false;
        }
        final Path input;
        try {
            input = sheet.getStub().getBook().getInputPath();
        } catch (RuntimeException ex) {
            return false;
        }
        if ((input == null) || !Files.isRegularFile(input)
                || !input.getFileName().toString().toLowerCase().endsWith(".pdf")) {
            return false;
        }
        if ((sheet.getSkew() != null) && (Math.abs(sheet.getSkew().getSlope()) > 0.02)) {
            return false;
        }
        final Integer dpiValue = PdfQuarterRestHints.effectivePdfDpi();
        if (dpiValue == null) {
            logger.info("PDF clef/beam coexist skipped: missing ImageLoading.pdfResolution");
            return false;
        }
        final float dpi = dpiValue.floatValue();
        final ByteProcessor noStaff = sheet.getPicture().getSource(Picture.SourceKey.NO_STAFF);
        final ByteProcessor binary = sheet.getPicture().getSource(Picture.SourceKey.BINARY);
        if ((noStaff == null) || (binary == null)
                || (binary.getWidth() != sheet.getWidth())
                || (binary.getHeight() != sheet.getHeight())) {
            return false;
        }
        final AffineTransform at = PdfQuarterRestHints.loaderPdfToSheet(
                hint.pageBox,
                dpi,
                sheet.getWidth(),
                sheet.getHeight());
        if (at == null) {
            logger.info("PDF clef/beam coexist skipped: loader canvas mismatch dpi={} sheet={}x{}",
                    dpi,
                    sheet.getWidth(),
                    sheet.getHeight());
            return false;
        }
        final Path2D clefOutline = new Path2D.Double(hint.pdfPath, at);
        final PdfQuarterRestHints.PixelSource staffLine = staffLineOf(binary, noStaff);
        final PdfQuarterRestHints.Agreement clefAg = PdfQuarterRestHints.measure(
                clefOutline,
                glyphInk(clef.getGlyph()),
                staffLine,
                clef.getGlyph().getBounds());
        logger.info(
                "PDF clef/beam clef proof {} glyph#{} outline={} glyphInk={} both={} skip={} recallO={} recallG={} iou={} dpi={}",
                hint.glyphName,
                clef.getGlyph().getId(),
                clefAg.outlineCount,
                clefAg.glyphCount,
                clefAg.both,
                clefAg.staffLineSkipped,
                clefAg.recallOutline(),
                clefAg.recallGlyph(),
                clefAg.iou(),
                dpi);
        if (!clefAg.agrees()) {
            return false;
        }

        final List<PaintedPath> paints = scanPaints(
                input,
                sheet.getStub().getNumber() - 1,
                hint.pageBox);
        final PaintedPath beamPaint = uniqueBeamPaint(
                paints,
                at,
                beam.getGlyph(),
                clef.getGlyph());
        if (beamPaint == null) {
            logger.info("PDF clef/beam coexist skipped: no unique beam paint for glyph#{}",
                    beam.getGlyph().getId());
            return false;
        }
        final Path2D beamOutline = new Path2D.Double(beamPaint.pagePath, at);
        final PdfQuarterRestHints.Agreement beamAg = PdfQuarterRestHints.measure(
                beamOutline,
                glyphInk(beam.getGlyph()),
                staffLine,
                beam.getGlyph().getBounds());
        logger.info(
                "PDF clef/beam beam proof glyph#{} outline={} glyphInk={} both={} skip={} recallO={} recallG={} iou={}",
                beam.getGlyph().getId(),
                beamAg.outlineCount,
                beamAg.glyphCount,
                beamAg.both,
                beamAg.staffLineSkipped,
                beamAg.recallOutline(),
                beamAg.recallGlyph(),
                beamAg.iou());
        if (!beamAg.agrees()) {
            return false;
        }
        if (!stemsOutsideClef(beam, clef.getBounds())) {
            logger.info("PDF clef/beam coexist skipped: beam glyph#{} lacks stems outside clef",
                    beam.getGlyph().getId());
            return false;
        }
        if (!pathsCross(clefOutline, beamOutline)) {
            logger.info("PDF clef/beam coexist skipped: source paths do not cross");
            return false;
        }
        logger.info(
                "PDF clef/beam coexist {} vs {} clefBox={} beamBox={}",
                clef,
                beam,
                clef.getBounds(),
                beam.getBounds());
        return true;
    }

    private static boolean stemsOutsideClef (Inter beam,
                                                Rectangle clefBox)
    {
        if (!(beam instanceof AbstractBeamInter abstractBeam) || (clefBox == null)) {
            return false;
        }
        int outside = 0;
        for (StemInter stem : abstractBeam.getStems()) {
            if (stem == null) {
                continue;
            }
            final Point center = stem.getCenter();
            if ((center != null) && !clefBox.contains(center)) {
                outside++;
            }
        }
        return outside >= 2;
    }

    private static boolean pathsCross (Path2D clefOutline,
                                          Path2D beamOutline)
    {
        if ((clefOutline == null) || (beamOutline == null)) {
            return false;
        }
        final Rectangle2D a = clefOutline.getBounds2D();
        final Rectangle2D b = beamOutline.getBounds2D();
        if (!a.intersects(b)) {
            return false;
        }
        final Rectangle2D inter = a.createIntersection(b);
        final int x0 = (int) Math.floor(inter.getX());
        final int y0 = (int) Math.floor(inter.getY());
        final int x1 = (int) Math.ceil(inter.getMaxX());
        final int y1 = (int) Math.ceil(inter.getMaxY());
        for (int y = y0; y < y1; y++) {
            for (int x = x0; x < x1; x++) {
                if (clefOutline.contains(x + 0.5, y + 0.5)
                        && beamOutline.contains(x + 0.5, y + 0.5)) {
                    return true;
                }
            }
        }
        return false;
    }

    private static PaintedPath uniqueBeamPaint (List<PaintedPath> paints,
                                                AffineTransform at,
                                                Glyph beamGlyph,
                                                Glyph clefGlyph)
    {
        if ((paints == null) || (beamGlyph == null)) {
            return null;
        }
        PaintedPath found = null;
        for (PaintedPath paint : paints) {
            final Path2D sheetPath = new Path2D.Double(paint.pagePath, at);
            final Rectangle2D outline = sheetPath.getBounds2D();
            if (!isBeamLike(outline)) {
                continue;
            }
            if ((clefGlyph != null)
                    && boxesOverlap(outline, clefGlyph.getBounds())
                    && !boxesOverlap(outline, beamGlyph.getBounds())) {
                continue;
            }
            if (!boxesOverlap(outline, beamGlyph.getBounds())) {
                continue;
            }
            if (found != null) {
                return null;
            }
            found = paint;
        }
        return found;
    }

    public static boolean isBeamLike (Rectangle2D box)
    {
        if ((box == null) || (box.getWidth() < 40) || (box.getHeight() < 6)) {
            return false;
        }
        return box.getWidth() >= (3 * box.getHeight());
    }

    private static boolean boxesOverlap (Rectangle2D outline,
                                           Rectangle glyph)
    {
        if ((outline == null) || (glyph == null) || (glyph.width <= 0) || (glyph.height <= 0)) {
            return false;
        }
        final Rectangle2D inter = outline.createIntersection(glyph);
        if ((inter.getWidth() <= 0) || (inter.getHeight() <= 0)) {
            return false;
        }
        final double interArea = inter.getWidth() * inter.getHeight();
        final double minArea = Math.min(outline.getWidth() * outline.getHeight(),
                glyph.getWidth() * glyph.getHeight());
        return (minArea > 0) && ((interArea / minArea) >= 0.5);
    }

    private static PdfQuarterRestHints.PixelSource glyphInk (Glyph glyph)
    {
        return (x, y) -> glyph.contains(new Point(x, y));
    }

    private static PdfQuarterRestHints.PixelSource staffLineOf (ByteProcessor binary,
                                                                ByteProcessor noStaff)
    {
        return (x, y) -> {
            if ((x < 0) || (y < 0) || (x >= binary.getWidth()) || (y >= binary.getHeight())) {
                return false;
            }
            final boolean bin = binary.get(x, y) < 128;
            final boolean ns = (x < noStaff.getWidth()) && (y < noStaff.getHeight())
                    && (noStaff.get(x, y) < 128);
            return bin && !ns;
        };
    }

    private static List<PaintedPath> scanPaints (Path pdf,
                                                   int pageIndex,
                                                   Rectangle2D pageBox)
    {
        if ((pdf == null) || (pageIndex < 0) || (pageBox == null) || !Files.isRegularFile(pdf)) {
            return List.of();
        }
        final String key;
        try {
            key = pdf.toAbsolutePath().normalize() + "|" + Files.size(pdf) + "|" + pageIndex;
        } catch (IOException ex) {
            return List.of();
        }
        return PATH_CACHE.computeIfAbsent(key, ignored -> readPaints(pdf, pageIndex, pageBox));
    }

    private static List<PaintedPath> readPaints (Path pdf,
                                                    int pageIndex,
                                                    Rectangle2D pageBox)
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
            return List.copyOf(engine.merged());
        } catch (Exception ex) {
            return List.of();
        }
    }

    private static final class Pair
    {
        final ClefInter clef;

        final Inter beam;

        final PdfClefHints.Hint hint;

        Pair (ClefInter clef,
              Inter beam,
              PdfClefHints.Hint hint)
        {
            this.clef = clef;
            this.beam = beam;
            this.hint = hint;
        }
    }

    static final class PaintedPath
    {
        final Path2D pagePath;

        PaintedPath (Path2D pagePath)
        {
            this.pagePath = pagePath;
        }
    }

    private static final class Collector
            extends PDFGraphicsStreamEngine
    {
        private final PDPage page;

        private final Path2D linePath = new Path2D.Double();

        private final Map<String, Path2D> merged = new LinkedHashMap<>();

        Collector (PDPage page)
        {
            super(page);
            this.page = page;
        }

        List<PaintedPath> merged ()
        {
            final List<PaintedPath> out = new ArrayList<>();
            for (Path2D path : merged.values()) {
                out.add(new PaintedPath(path));
            }
            return out;
        }

        @Override
        public void appendRectangle (Point2D p0,
                                      Point2D p1,
                                      Point2D p2,
                                      Point2D p3)
            throws IOException
        {
            linePath.moveTo(p0.getX(), p0.getY());
            linePath.lineTo(p1.getX(), p1.getY());
            linePath.lineTo(p2.getX(), p2.getY());
            linePath.lineTo(p3.getX(), p3.getY());
            linePath.closePath();
        }

        @Override
        public void drawImage (PDImage pdImage)
        {
        }

        @Override
        public void clip (int windingRule)
        {
            linePath.reset();
        }

        @Override
        public void moveTo (float x,
                             float y)
        {
            linePath.moveTo(x, y);
        }

        @Override
        public void lineTo (float x,
                             float y)
        {
            linePath.lineTo(x, y);
        }

        @Override
        public void curveTo (float x1,
                               float y1,
                               float x2,
                               float y2,
                               float x3,
                               float y3)
        {
            linePath.curveTo(x1, y1, x2, y2, x3, y3);
        }

        @Override
        public Point2D getCurrentPoint ()
        {
            return linePath.getCurrentPoint();
        }

        @Override
        public void closePath ()
        {
            linePath.closePath();
        }

        @Override
        public void endPath ()
        {
            linePath.reset();
        }

        @Override
        public void strokePath ()
            throws IOException
        {
            emit(true, false);
        }

        @Override
        public void fillPath (int windingRule)
            throws IOException
        {
            emit(false, true);
        }

        @Override
        public void fillAndStrokePath (int windingRule)
            throws IOException
        {
            emit(true, true);
        }

        @Override
        public void shadingFill (COSName shadingName)
        {
            linePath.reset();
        }

        private void emit (boolean stroke,
                              boolean fill)
            throws IOException
        {
            final Path2D raw = new Path2D.Double(linePath);
            linePath.reset();
            if (raw.getBounds2D().isEmpty()) {
                return;
            }
            final Matrix ctm = getGraphicsState().getCurrentTransformationMatrix();
            if (!PdfClefHints.uprightMatrix(ctm)) {
                return;
            }
            final PDGraphicsState gs = getGraphicsState();
            Shape painted = null;
            if (fill) {
                painted = raw;
            }
            if (stroke) {
                final float userWidth = gs.getLineWidth();
                final float pageWidth = userWidth * Math.abs(ctm.getScalingFactorX());
                if (pageWidth > 0) {
                    final int cap = capOf(gs);
                    final int join = joinOf(gs);
                    final BasicStroke bs = new BasicStroke(pageWidth, cap, join);
                    final Shape stroked = bs.createStrokedShape(raw);
                    painted = (painted == null) ? stroked : union(painted, stroked);
                }
            }
            if (painted == null) {
                return;
            }
            final Shape clip = getGraphicsState().getCurrentClippingPath();
            if (!PdfClefHints.clipContains(clip, painted.getBounds2D(), page.getCropBox())) {
                return;
            }
            final Path2D pagePath = new Path2D.Double(painted);
            final Rectangle2D box = pagePath.getBounds2D();
            final String key = Math.round(box.getX() * 2) + "|" + Math.round(box.getY() * 2)
                    + "|" + Math.round(box.getWidth() * 2) + "|" + Math.round(box.getHeight() * 2);
            merged.merge(key, pagePath, PdfClefBeamCrossings::unionPath);
        }

        private static int capOf (PDGraphicsState gs)
        {
            return switch (gs.getLineCap()) {
            case 0 -> BasicStroke.CAP_BUTT;
            case 1 -> BasicStroke.CAP_ROUND;
            case 2 -> BasicStroke.CAP_SQUARE;
            default -> BasicStroke.CAP_BUTT;
            };
        }

        private static int joinOf (PDGraphicsState gs)
        {
            return switch (gs.getLineJoin()) {
            case 0 -> BasicStroke.JOIN_MITER;
            case 1 -> BasicStroke.JOIN_ROUND;
            case 2 -> BasicStroke.JOIN_BEVEL;
            default -> BasicStroke.JOIN_MITER;
            };
        }
    }

    private static Path2D unionPath (Path2D a,
                                       Path2D b)
    {
        return new Path2D.Double(union(a, b));
    }

    private static Shape union (Shape a,
                                  Shape b)
    {
        final Area area = new Area(a);
        area.add(new Area(b));
        return area;
    }
}
