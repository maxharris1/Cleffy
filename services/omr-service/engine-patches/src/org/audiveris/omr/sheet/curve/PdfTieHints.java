package org.audiveris.omr.sheet.curve;

import org.apache.pdfbox.Loader;
import org.apache.pdfbox.contentstream.PDFGraphicsStreamEngine;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.graphics.image.PDImage;
import org.apache.pdfbox.pdmodel.graphics.state.PDGraphicsState;
import org.apache.pdfbox.util.Matrix;

import org.audiveris.omr.glyph.Glyph;
import org.audiveris.omr.glyph.GlyphFactory;
import static org.audiveris.omr.run.Orientation.VERTICAL;
import org.audiveris.omr.run.RunTable;
import org.audiveris.omr.run.RunTableFactory;
import org.audiveris.omr.sheet.Picture;
import org.audiveris.omr.sheet.Sheet;
import org.audiveris.omr.sheet.Staff;
import org.audiveris.omr.sheet.SystemInfo;
import org.audiveris.omr.sheet.clef.PdfClefHints;
import org.audiveris.omr.sheet.symbol.PdfQuarterRestHints;
import org.audiveris.omr.sig.SIGraph;
import org.audiveris.omr.sig.inter.HeadChordInter;
import org.audiveris.omr.sig.inter.HeadInter;
import org.audiveris.omr.sig.inter.Inter;
import org.audiveris.omr.sig.inter.SlurInter;
import org.audiveris.omr.sig.relation.SlurHeadRelation;
import org.audiveris.omr.util.HorizontalSide;
import static org.audiveris.omr.util.HorizontalSide.LEFT;
import static org.audiveris.omr.util.HorizontalSide.RIGHT;

import ij.process.ByteProcessor;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.awt.Point;
import java.awt.Rectangle;
import java.awt.Shape;
import java.awt.geom.AffineTransform;
import java.awt.geom.Path2D;
import java.awt.geom.PathIterator;
import java.awt.geom.Point2D;
import java.awt.geom.Rectangle2D;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Recover a painted PDF tie curve that the raster CURVES pass did not own.
 * <p>
 * Identity is a visible filled single-arc banana path whose endpoints bind
 * two already recognized heads of the same staff step and octave. No piece
 * name, filename, hash, bar, coordinate, glyph ID or pitch selector is used.
 * Ink minima are the accepted quarter-rest floors.
 */
public final class PdfTieHints
{
    private static final Logger logger = LoggerFactory.getLogger(PdfTieHints.class);

    private static final ConcurrentHashMap<String, List<Hint>> CACHE = new ConcurrentHashMap<>();

    private static final int SAMPLE_COUNT = 24;

    private PdfTieHints ()
    {
    }

    /** One filled banana curve painted on the source page. */
    public static final class Hint
    {
        public final Path2D pagePath;

        public final Rectangle2D pageBox;

        Hint (Path2D pagePath,
              Rectangle2D pageBox)
        {
            this.pagePath = pagePath;
            this.pageBox = pageBox;
        }
    }

    /**
     * After raster slurs are built, supply an ordinary tie for each source
     * curve that the skeleton pass did not already own.
     */
    public static void install (Sheet sheet,
                                List<SlurInter> pageSlurs)
    {
        if (sheet == null) {
            return;
        }
        try {
            installBody(sheet, pageSlurs);
        } catch (RuntimeException ex) {
            logger.info("PDF tie hints skipped: {}", ex.toString());
        }
    }

    private static void installBody (Sheet sheet,
                                       List<SlurInter> pageSlurs)
    {
        final Path input;
        try {
            input = sheet.getStub().getBook().getInputPath();
        } catch (RuntimeException ex) {
            return;
        }
        if ((input == null) || !Files.isRegularFile(input)
                || !input.getFileName().toString().toLowerCase().endsWith(".pdf")) {
            return;
        }
        if ((sheet.getSkew() != null) && (Math.abs(sheet.getSkew().getSlope()) > 0.02)) {
            logger.info("PDF tie hints skipped: unsupported sheet skew {}",
                    sheet.getSkew().getSlope());
            return;
        }
        final Integer dpiValue = PdfQuarterRestHints.effectivePdfDpi();
        if (dpiValue == null) {
            logger.info("PDF tie hints skipped: missing ImageLoading.pdfResolution");
            return;
        }
        final float dpi = dpiValue.floatValue();
        final ByteProcessor noStaff = sheet.getPicture().getSource(Picture.SourceKey.NO_STAFF);
        final ByteProcessor binary = sheet.getPicture().getSource(Picture.SourceKey.BINARY);
        if ((noStaff == null) || (binary == null)
                || (binary.getWidth() != sheet.getWidth())
                || (binary.getHeight() != sheet.getHeight())) {
            return;
        }

        final List<Hint> hints = scan(input, sheet.getStub().getNumber() - 1);
        if (hints.isEmpty()) {
            return;
        }

        final List<HeadInter> heads = liveHeads(sheet);
        if (heads.isEmpty()) {
            return;
        }

        final PdfQuarterRestHints.PixelSource staffLine = staffLineOf(binary, noStaff);
        final double interline = sheet.getScale().getInterline();
        final double maxHeadDist = 2.0 * interline;

        for (Hint hint : hints) {
            final AffineTransform at = PdfQuarterRestHints.loaderPdfToSheet(
                    hint.pageBox,
                    dpi,
                    sheet.getWidth(),
                    sheet.getHeight());
            if (at == null) {
                logger.info("PDF tie hint skipped: loader canvas mismatch dpi={} sheet={}x{}",
                        dpi,
                        sheet.getWidth(),
                        sheet.getHeight());
                continue;
            }
            final Path2D outline = new Path2D.Double(hint.pagePath, at);
            final Rectangle2D box = outline.getBounds2D();
            if ((box.getWidth() < (2 * interline)) || (box.getHeight() < 2)
                    || (box.getWidth() < (3 * box.getHeight()))) {
                continue;
            }

            final Point2D leftEnd = extrema(outline, true);
            final Point2D rightEnd = extrema(outline, false);
            if ((leftEnd == null) || (rightEnd == null)
                    || (rightEnd.getX() - leftEnd.getX() < interline)) {
                continue;
            }

            if (rasterOwnsInk(sheet, outline, interline)) {
                logger.info(
                        "PDF tie hint skipped: raster slur already owns ink box=({},{},{},{})",
                        Math.round(box.getX()),
                        Math.round(box.getY()),
                        Math.round(box.getWidth()),
                        Math.round(box.getHeight()));
                continue;
            }

            final HeadInter leftHead = nearestHead(heads, leftEnd, maxHeadDist);
            final HeadInter rightHead = nearestHead(heads, rightEnd, maxHeadDist);
            if ((leftHead == null) || (rightHead == null)) {
                logger.info(
                        "PDF tie hint skipped: unbound endpoint left={} right={} box=({},{},{},{})",
                        leftHead != null ? leftHead.getId() : 0,
                        rightHead != null ? rightHead.getId() : 0,
                        Math.round(box.getX()),
                        Math.round(box.getY()),
                        Math.round(box.getWidth()),
                        Math.round(box.getHeight()));
                continue;
            }
            if (leftHead == rightHead) {
                continue;
            }
            if ((leftHead.getStaff() == null) || (leftHead.getStaff() != rightHead.getStaff())) {
                continue;
            }
            if (leftHead.getStaff().getSystem() != rightHead.getStaff().getSystem()) {
                continue;
            }
            if (!samePitch(leftHead, rightHead)) {
                logger.info(
                        "PDF tie hint skipped: different-pitch paint is a slur heads#{}-#{}",
                        leftHead.getId(),
                        rightHead.getId());
                continue;
            }
            if (hasInterveningPitch(heads, leftHead, rightHead)) {
                logger.info(
                        "PDF tie hint skipped: intervening same-pitch head between #{} and #{}",
                        leftHead.getId(),
                        rightHead.getId());
                continue;
            }
            if (alreadyTied(sheet, leftHead, rightHead)) {
                logger.info(
                        "PDF tie hint skipped: heads#{}-#{} already tied",
                        leftHead.getId(),
                        rightHead.getId());
                continue;
            }

            final Set<Integer> glyphPixels = coveredComponents(noStaff, outline);
            final Rectangle2D glyphBounds = boundsOf(glyphPixels, noStaff.getWidth());
            final PdfQuarterRestHints.PixelSource glyphInk = packedInk(
                    glyphPixels,
                    noStaff.getWidth());
            final PdfQuarterRestHints.Agreement ag = PdfQuarterRestHints.measure(
                    outline,
                    glyphInk,
                    staffLine,
                    glyphBounds);
            logger.info(
                    "PDF tie hint ink outline={} glyphInk={} both={} skip={} recallO={} recallG={} iou={} conf={} dpi={} heads#{}-#{}",
                    ag.outlineCount,
                    ag.glyphCount,
                    ag.both,
                    ag.staffLineSkipped,
                    ag.recallOutline(),
                    ag.recallGlyph(),
                    ag.iou(),
                    ag.confidence(),
                    dpi,
                    leftHead.getId(),
                    rightHead.getId());
            if (!ag.agrees()) {
                logger.info(
                        "PDF tie hint refused: ink minima recallO={} recallG={} iou={} (need {}/{})",
                        ag.recallOutline(),
                        ag.recallGlyph(),
                        ag.iou(),
                        PdfQuarterRestHints.MIN_RECALL,
                        PdfQuarterRestHints.MIN_IOU);
                continue;
            }

            final List<Point> points = midlinePoints(outline);
            if (points.size() < 3) {
                logger.info("PDF tie hint refused: ordinary curve sampling failed");
                continue;
            }
            final CircleModel model = CircleModel.createValid(
                    points.get(0),
                    points.get(points.size() / 2),
                    points.get(points.size() - 1));
            if (model == null) {
                logger.info("PDF tie hint refused: ordinary circle model missing");
                continue;
            }
            final SlurInfo info = new SlurInfo(
                    0,
                    null,
                    null,
                    points,
                    model,
                    Collections.emptyList(),
                    points.size());
            info.setModel(model);
            if (info.getCurve() == null) {
                logger.info("PDF tie hint refused: ordinary Bézier missing");
                continue;
            }

            final SystemInfo system = leftHead.getStaff().getSystem();
            final double maxRun = 0.25 * interline;
            Glyph glyph = info.retrieveGlyph(sheet, maxRun, 0.75);
            if (glyph == null) {
                glyph = glyphFromOutline(system, outline, noStaff);
                if (glyph != null) {
                    info.setGlyph(glyph);
                }
            }
            if (glyph == null) {
                logger.info("PDF tie hint refused: ordinary glyph missing");
                continue;
            }

            final double conf = ag.confidence();
            final SlurInter.Impacts impacts = new SlurInter.Impacts(conf, conf, conf, conf, conf);
            if (impacts.getGrade() < SlurInter.getMinGrade()) {
                logger.info("PDF tie hint refused: ordinary grade {} below min",
                        impacts.getGrade());
                continue;
            }

            final SlurInter slur = new SlurInter(info, impacts);
            final SIGraph sig = system.getSig();
            sig.addVertex(slur);
            sig.addEdge(slur, leftHead, new SlurHeadRelation(LEFT));
            sig.addEdge(slur, rightHead, new SlurHeadRelation(RIGHT));
            slur.setStaff(leftHead.getStaff());
            slur.checkStaffTie(sig.inters(HeadChordInter.class));
            if (!slur.isTie()) {
                logger.info(
                        "PDF tie hint refused: ordinary checkStaffTie did not classify heads#{}-#{}",
                        leftHead.getId(),
                        rightHead.getId());
                slur.remove();
                continue;
            }
            if (pageSlurs != null) {
                pageSlurs.add(slur);
            }
            logger.info(
                    "PDF tie hint accepted heads#{}-#{} staff#{} glyph#{} recallO={} recallG={} iou={} conf={} tie={}",
                    leftHead.getId(),
                    rightHead.getId(),
                    leftHead.getStaff().getId(),
                    glyph.getId(),
                    ag.recallOutline(),
                    ag.recallGlyph(),
                    ag.iou(),
                    conf,
                    slur.isTie());
        }
    }

    public static List<Hint> scan (Path pdf,
                                    int pageIndex)
    {
        if ((pdf == null) || (pageIndex < 0) || !Files.isRegularFile(pdf)) {
            return List.of();
        }
        final String name = pdf.getFileName().toString().toLowerCase();
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
            final PDRectangle crop = page.getCropBox();
            if (crop == null) {
                return List.of();
            }
            final Rectangle2D pageBox = new Rectangle2D.Double(
                    crop.getLowerLeftX(),
                    crop.getLowerLeftY(),
                    crop.getWidth(),
                    crop.getHeight());
            final Collector engine = new Collector(page, pageBox);
            engine.processPage(page);
            return List.copyOf(engine.hints);
        } catch (Exception ex) {
            return List.of();
        }
    }

    private static List<HeadInter> liveHeads (Sheet sheet)
    {
        final List<HeadInter> heads = new ArrayList<>();
        for (SystemInfo system : sheet.getSystems()) {
            for (Inter inter : system.getSig().inters(HeadInter.class)) {
                if ((inter instanceof HeadInter head) && !head.isRemoved()
                        && (head.getStaff() != null) && (head.getCenter() != null)) {
                    heads.add(head);
                }
            }
        }
        return heads;
    }

    private static HeadInter nearestHead (List<HeadInter> heads,
                                          Point2D end,
                                          double maxDist)
    {
        HeadInter best = null;
        double bestDist = maxDist;
        HeadInter second = null;
        double secondDist = Double.POSITIVE_INFINITY;
        for (HeadInter head : heads) {
            final Point center = head.getCenter();
            final double dist = end.distance(center.x, center.y);
            if (dist > maxDist) {
                continue;
            }
            if (dist < bestDist) {
                second = best;
                secondDist = bestDist;
                best = head;
                bestDist = dist;
            } else if (dist < secondDist) {
                second = head;
                secondDist = dist;
            }
        }
        if ((best != null) && (second != null) && ((secondDist - bestDist) < 1.0)) {
            return null;
        }
        return best;
    }

    private static boolean samePitch (HeadInter a,
                                      HeadInter b)
    {
        if ((a.getStep() == null) || (b.getStep() == null)) {
            return false;
        }
        return (a.getStep() == b.getStep()) && (a.getOctave() == b.getOctave());
    }

    private static boolean hasInterveningPitch (List<HeadInter> heads,
                                                  HeadInter left,
                                                  HeadInter right)
    {
        final int x0 = Math.min(left.getCenter().x, right.getCenter().x);
        final int x1 = Math.max(left.getCenter().x, right.getCenter().x);
        for (HeadInter head : heads) {
            if ((head == left) || (head == right) || (head.getStaff() != left.getStaff())) {
                continue;
            }
            if (!samePitch(head, left)) {
                continue;
            }
            final int x = head.getCenter().x;
            if ((x > x0) && (x < x1)) {
                return true;
            }
        }
        return false;
    }

    private static boolean alreadyTied (Sheet sheet,
                                          HeadInter left,
                                          HeadInter right)
    {
        for (SystemInfo system : sheet.getSystems()) {
            for (Inter inter : system.getSig().inters(SlurInter.class)) {
                if (!(inter instanceof SlurInter slur) || slur.isRemoved()) {
                    continue;
                }
                final HeadInter h1 = slur.getHead(LEFT);
                final HeadInter h2 = slur.getHead(RIGHT);
                if (((h1 == left) && (h2 == right)) || ((h1 == right) && (h2 == left))) {
                    return true;
                }
            }
        }
        return false;
    }

    private static boolean rasterOwnsInk (Sheet sheet,
                                            Path2D outline,
                                            double interline)
    {
        final Rectangle2D box = outline.getBounds2D();
        final double midY = box.getCenterY();
        for (SystemInfo system : sheet.getSystems()) {
            for (Inter inter : system.getSig().inters(SlurInter.class)) {
                if (!(inter instanceof SlurInter slur) || slur.isRemoved()) {
                    continue;
                }
                final Rectangle bounds = slur.getBounds();
                if ((bounds == null) || !box.intersects(bounds)) {
                    continue;
                }
                final double slurY;
                if (slur.getCurve() != null) {
                    slurY = 0.5 * (slur.getCurve().getY1() + slur.getCurve().getY2());
                } else {
                    slurY = bounds.getCenterY();
                }
                final double xOverlap = Math.min(box.getMaxX(), bounds.getMaxX())
                        - Math.max(box.getMinX(), bounds.getX());
                if ((xOverlap > (0.5 * Math.min(box.getWidth(), bounds.getWidth())))
                        && (Math.abs(slurY - midY) < interline)) {
                    return true;
                }
            }
        }
        return false;
    }

    private static Point2D extrema (Path2D path,
                                      boolean left)
    {
        final PathIterator pi = path.getPathIterator(null);
        final double[] coords = new double[6];
        Point2D best = null;
        while (!pi.isDone()) {
            final int kind = pi.currentSegment(coords);
            final int n = switch (kind) {
            case PathIterator.SEG_MOVETO, PathIterator.SEG_LINETO -> 1;
            case PathIterator.SEG_QUADTO -> 2;
            case PathIterator.SEG_CUBICTO -> 3;
            default -> 0;
            };
            for (int i = 0; i < n; i++) {
                final Point2D p = new Point2D.Double(coords[i * 2], coords[i * 2 + 1]);
                if (best == null) {
                    best = p;
                } else if (left && (p.getX() < best.getX())) {
                    best = p;
                } else if (!left && (p.getX() > best.getX())) {
                    best = p;
                }
            }
            pi.next();
        }
        return best;
    }

    private static List<Point> midlinePoints (Path2D outline)
    {
        final List<double[]> cubics = new ArrayList<>();
        final PathIterator pi = outline.getPathIterator(null);
        final double[] coords = new double[6];
        double cx = 0;
        double cy = 0;
        while (!pi.isDone()) {
            final int kind = pi.currentSegment(coords);
            switch (kind) {
            case PathIterator.SEG_MOVETO, PathIterator.SEG_LINETO -> {
                cx = coords[0];
                cy = coords[1];
            }
            case PathIterator.SEG_CUBICTO -> {
                cubics.add(new double[] {
                        cx, cy, coords[0], coords[1], coords[2], coords[3], coords[4], coords[5]});
                cx = coords[4];
                cy = coords[5];
            }
            default -> {
            }
            }
            pi.next();
        }
        if (cubics.size() < 2) {
            return List.of();
        }
        final double[] a = cubics.get(0);
        final double[] b = cubics.get(cubics.size() - 1);
        final List<Point> points = new ArrayList<>();
        for (int i = 0; i <= SAMPLE_COUNT; i++) {
            final double t = i / (double) SAMPLE_COUNT;
            final double[] p1 = bezier(a, t);
            final double[] p2 = bezier(b, 1.0 - t);
            points.add(new Point(
                    (int) Math.round((p1[0] + p2[0]) / 2.0),
                    (int) Math.round((p1[1] + p2[1]) / 2.0)));
        }
        if (points.get(0).x > points.get(points.size() - 1).x) {
            Collections.reverse(points);
        }
        return points;
    }

    private static double[] bezier (double[] c,
                                    double t)
    {
        final double u = 1.0 - t;
        final double x = (u * u * u * c[0]) + (3 * u * u * t * c[2])
                + (3 * u * t * t * c[4]) + (t * t * t * c[6]);
        final double y = (u * u * u * c[1]) + (3 * u * u * t * c[3])
                + (3 * u * t * t * c[5]) + (t * t * t * c[7]);
        return new double[] {x, y};
    }

    private static Set<Integer> coveredComponents (ByteProcessor noStaff,
                                                   Path2D outline)
    {
        final int width = noStaff.getWidth();
        final int height = noStaff.getHeight();
        final Rectangle2D box = outline.getBounds2D();
        final int x0 = Math.max(0, (int) Math.floor(box.getX()) - 2);
        final int y0 = Math.max(0, (int) Math.floor(box.getY()) - 2);
        final int x1 = Math.min(width, (int) Math.ceil(box.getMaxX()) + 2);
        final int y1 = Math.min(height, (int) Math.ceil(box.getMaxY()) + 2);
        final boolean[] seen = new boolean[width * height];
        final Set<Integer> keep = new HashSet<>();
        for (int y = y0; y < y1; y++) {
            for (int x = x0; x < x1; x++) {
                if (seen[y * width + x] || (noStaff.get(x, y) >= 128)) {
                    continue;
                }
                if (!outline.contains(x + 0.5, y + 0.5)) {
                    continue;
                }
                flood(noStaff, outline, seen, keep, x, y, width, height);
            }
        }
        return keep;
    }

    private static void flood (ByteProcessor noStaff,
                               Path2D outline,
                               boolean[] seen,
                               Set<Integer> keep,
                               int startX,
                               int startY,
                               int width,
                               int height)
    {
        final ArrayDeque<Point> dq = new ArrayDeque<>();
        final List<Integer> component = new ArrayList<>();
        boolean covered = false;
        dq.add(new Point(startX, startY));
        seen[startY * width + startX] = true;
        while (!dq.isEmpty()) {
            final Point p = dq.removeFirst();
            component.add(p.y * width + p.x);
            if (outline.contains(p.x + 0.5, p.y + 0.5)) {
                covered = true;
            }
            offer(noStaff, seen, dq, p.x - 1, p.y, width, height);
            offer(noStaff, seen, dq, p.x + 1, p.y, width, height);
            offer(noStaff, seen, dq, p.x, p.y - 1, width, height);
            offer(noStaff, seen, dq, p.x, p.y + 1, width, height);
        }
        if (covered) {
            keep.addAll(component);
        }
    }

    private static void offer (ByteProcessor noStaff,
                               boolean[] seen,
                               ArrayDeque<Point> dq,
                               int x,
                               int y,
                               int width,
                               int height)
    {
        if ((x < 0) || (y < 0) || (x >= width) || (y >= height)) {
            return;
        }
        final int idx = y * width + x;
        if (seen[idx] || (noStaff.get(x, y) >= 128)) {
            return;
        }
        seen[idx] = true;
        dq.add(new Point(x, y));
    }

    private static Rectangle2D boundsOf (Set<Integer> pixels,
                                         int width)
    {
        if ((pixels == null) || pixels.isEmpty()) {
            return null;
        }
        int minX = Integer.MAX_VALUE;
        int minY = Integer.MAX_VALUE;
        int maxX = Integer.MIN_VALUE;
        int maxY = Integer.MIN_VALUE;
        for (int packed : pixels) {
            final int x = packed % width;
            final int y = packed / width;
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
        }
        return new Rectangle2D.Double(minX, minY, (maxX - minX) + 1, (maxY - minY) + 1);
    }

    private static PdfQuarterRestHints.PixelSource packedInk (Set<Integer> pixels,
                                                               int width)
    {
        return (x, y) -> pixels.contains(y * width + x);
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

    private static Glyph glyphFromOutline (SystemInfo system,
                                           Path2D sheetPath,
                                           ByteProcessor source)
    {
        final Rectangle box = sheetPath.getBounds();
        if ((box.width < 4) || (box.height < 2)) {
            return null;
        }
        box.x = Math.max(0, box.x);
        box.y = Math.max(0, box.y);
        if ((box.x >= source.getWidth()) || (box.y >= source.getHeight())) {
            return null;
        }
        box.width = Math.min(box.width, source.getWidth() - box.x);
        box.height = Math.min(box.height, source.getHeight() - box.y);
        if ((box.width < 4) || (box.height < 2)) {
            return null;
        }
        final ByteProcessor buf = new ByteProcessor(box.width, box.height);
        for (int y = 0; y < box.height; y++) {
            for (int x = 0; x < box.width; x++) {
                final int sx = box.x + x;
                final int sy = box.y + y;
                final boolean inside = sheetPath.contains(sx + 0.5, sy + 0.5);
                final boolean ink = (sx >= 0) && (sy >= 0)
                        && (sx < source.getWidth()) && (sy < source.getHeight())
                        && (source.get(sx, sy) < 128);
                buf.set(x, y, (inside && ink) ? 0 : 255);
            }
        }
        final RunTable runTable = new RunTableFactory(VERTICAL).createTable(buf);
        final List<Glyph> parts = GlyphFactory.buildGlyphs(runTable, box.getLocation());
        if (parts.isEmpty()) {
            return null;
        }
        final Glyph glyph = (parts.size() == 1) ? parts.get(0) : GlyphFactory.buildGlyph(parts);
        return system.registerGlyph(glyph, null);
    }

    private static boolean isBanana (Path2D path)
    {
        final Rectangle2D box = path.getBounds2D();
        if ((box.getWidth() < 10) || (box.getHeight() < 0.4)
                || (box.getWidth() < (3 * box.getHeight()))) {
            return false;
        }
        final PathIterator pi = path.getPathIterator(null);
        final double[] coords = new double[6];
        int cubics = 0;
        int lines = 0;
        while (!pi.isDone()) {
            final int kind = pi.currentSegment(coords);
            switch (kind) {
            case PathIterator.SEG_CUBICTO -> cubics++;
            case PathIterator.SEG_LINETO -> lines++;
            case PathIterator.SEG_QUADTO, PathIterator.SEG_MOVETO, PathIterator.SEG_CLOSE -> {
            }
            default -> {
                return false;
            }
            }
            pi.next();
        }
        return (cubics >= 2) && (cubics <= 4) && (lines <= 2);
    }

    private static final class Collector
            extends PDFGraphicsStreamEngine
    {
        private final PDPage page;

        private final Rectangle2D pageBox;

        private final Path2D linePath = new Path2D.Double();

        private final List<Hint> hints = new ArrayList<>();

        Collector (PDPage page,
                   Rectangle2D pageBox)
        {
            super(page);
            this.page = page;
            this.pageBox = pageBox;
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
            linePath.reset();
        }

        @Override
        public void fillPath (int windingRule)
            throws IOException
        {
            emit();
        }

        @Override
        public void fillAndStrokePath (int windingRule)
            throws IOException
        {
            emit();
        }

        @Override
        public void shadingFill (COSName shadingName)
        {
            linePath.reset();
        }

        private void emit ()
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
            if (gs == null) {
                return;
            }
            final Shape clip = gs.getCurrentClippingPath();
            if (!PdfClefHints.clipContains(clip, raw.getBounds2D(), page.getCropBox())) {
                return;
            }
            if (!isBanana(raw)) {
                return;
            }
            hints.add(new Hint(raw, pageBox));
        }
    }
}
