//------------------------------------------------------------------------------------------------//
//                                                                                                //
//                                      C l e f B u i l d e r                                     //
//                                                                                                //
//------------------------------------------------------------------------------------------------//
// <editor-fold defaultstate="collapsed" desc="hdr">
//
//  Copyright © Audiveris 2026. All rights reserved.
//
//  This program is free software: you can redistribute it and/or modify it under the terms of the
//  GNU Affero General Public License as published by the Free Software Foundation, either version
//  3 of the License, or (at your option) any later version.
//
//  This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY;
//  without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
//  See the GNU Affero General Public License for more details.
//
//  You should have received a copy of the GNU Affero General Public License along with this
//  program.  If not, see <http://www.gnu.org/licenses/>.
//------------------------------------------------------------------------------------------------//
// </editor-fold>
package org.audiveris.omr.sheet.clef;

import org.audiveris.omr.classifier.Classifier;
import org.audiveris.omr.classifier.Evaluation;
import org.audiveris.omr.classifier.ShapeClassifier;
import org.audiveris.omr.constant.Constant;
import org.audiveris.omr.constant.ConstantSet;
import org.audiveris.omr.glyph.Glyph;
import org.audiveris.omr.glyph.GlyphCluster;
import org.audiveris.omr.glyph.GlyphFactory;
import org.audiveris.omr.glyph.GlyphLink;
import org.audiveris.omr.glyph.Glyphs;
import org.audiveris.omr.glyph.Grades;
import org.audiveris.omr.glyph.Shape;
import static org.audiveris.omr.glyph.Shape.C_CLEF;
import static org.audiveris.omr.glyph.Shape.F_CLEF;
import static org.audiveris.omr.glyph.Shape.G_CLEF;
import static org.audiveris.omr.glyph.Shape.G_CLEF_8VA;
import static org.audiveris.omr.glyph.Shape.G_CLEF_8VB;
import static org.audiveris.omr.glyph.Shape.PERCUSSION_CLEF;
import static org.audiveris.omr.run.Orientation.VERTICAL;
import org.audiveris.omr.run.RunTable;
import org.audiveris.omr.run.RunTableFactory;
import org.audiveris.omr.sheet.Picture;
import org.audiveris.omr.sheet.Scale;
import org.audiveris.omr.sheet.Scale.InterlineScale;
import org.audiveris.omr.sheet.Sheet;
import org.audiveris.omr.sheet.Staff;
import org.audiveris.omr.sheet.SystemInfo;
import org.audiveris.omr.sheet.header.StaffHeader;
import org.audiveris.omr.sig.GradeUtil;
import org.audiveris.omr.sig.SIGraph;
import org.audiveris.omr.sig.inter.ClefInter;
import org.audiveris.omr.sig.inter.ClefInter.ClefKind;
import org.audiveris.omr.sig.inter.Inter;
import org.audiveris.omr.sig.inter.Inters;
import org.audiveris.omr.sig.relation.ClefKeyRelation;
import org.audiveris.omr.sig.relation.Exclusion;
import org.audiveris.omr.ui.symbol.FontSymbol;
import org.audiveris.omr.ui.symbol.MusicFamily;
import org.audiveris.omr.ui.symbol.MusicFont;
import static org.audiveris.omr.util.HorizontalSide.LEFT;
import static org.audiveris.omr.util.HorizontalSide.RIGHT;
import org.audiveris.omr.util.Navigable;
import org.audiveris.omr.util.VerticalSide;

import org.jgrapht.alg.connectivity.ConnectivityInspector;
import org.jgrapht.graph.SimpleGraph;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import ij.process.Blitter;
import ij.process.ByteProcessor;

import java.awt.Point;
import java.awt.Rectangle;
import java.awt.geom.Path2D;
import java.awt.geom.Rectangle2D;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.Collections;
import java.util.EnumMap;
import java.util.EnumSet;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

/**
 * Class <code>ClefBuilder</code> extracts the clef symbol at the beginning of a staff.
 * <p>
 * Retrieving the clef kind (Treble, Bass, Alto or Tenor) is important for checking consistency with
 * potential key signature in the staff.
 *
 * @author Hervé Bitteur
 */
public class ClefBuilder
{
    //~ Static fields/initializers -----------------------------------------------------------------

    private static final Constants constants = new Constants();

    private static final Logger logger = LoggerFactory.getLogger(ClefBuilder.class);

    /**
     * All possible clef symbols at beginning of staff: all but small clefs.
     * Octave bass clefs are reported to be extremely
     * <a href="http://en.wikipedia.org/wiki/Clef#Octave_clefs">rare</a>.
     */
    private static final EnumSet<Shape> HEADER_CLEF_SHAPES = EnumSet.of(
            F_CLEF,
            G_CLEF,
            G_CLEF_8VA,
            G_CLEF_8VB,
            C_CLEF,
            PERCUSSION_CLEF);

    /**
     * All possible clef symbols on a 1-line staff.
     */
    private static final EnumSet<Shape> ONE_LINE_CLEF_SHAPES = EnumSet.of(PERCUSSION_CLEF);

    /**
     * The octave-transposing G clefs.
     * <p>
     * They share {@link ClefKind#TREBLE} with the plain G_CLEF, hence the dedicated handling
     * in {@link #promoteOctaveClef}.
     */
    private static final EnumSet<Shape> OCTAVE_CLEF_SHAPES = EnumSet.of(G_CLEF_8VA, G_CLEF_8VB);

    //~ Instance fields ----------------------------------------------------------------------------

    /** Dedicated staff to analyze. */
    private final Staff staff;

    /** Clef range info. */
    private final StaffHeader.Range range;

    /** The containing system. */
    @Navigable(false)
    private final SystemInfo system;

    /** The related SIG. */
    private final SIGraph sig;

    /** The related sheet. */
    @Navigable(false)
    private final Sheet sheet;

    /** Related scale. */
    private final Scale scale;

    /** Scale-dependent parameters. */
    private final Parameters params;

    /** Outer clef area. */
    private Rectangle outerRect;

    /** Inner clef area. */
    private Rectangle innerRect;

    /** Shape classifier to use. */
    private final Classifier classifier = ShapeClassifier.getInstance();

    //~ Constructors -------------------------------------------------------------------------------

    /**
     * Creates a new ClefBuilder object.
     *
     * @param staff the underlying staff
     */
    public ClefBuilder (Staff staff)
    {
        this.staff = staff;

        system = staff.getSystem();
        sig = system.getSig();
        sheet = system.getSheet();
        scale = sheet.getScale();
        params = new Parameters(scale, staff.getSpecificInterline());

        final StaffHeader header = staff.getHeader();

        if (header.clefRange != null) {
            range = header.clefRange;
        } else {
            header.clefRange = (range = new StaffHeader.Range());
        }
    }

    //~ Methods ------------------------------------------------------------------------------------

    //-----------//
    // findClefs //
    //-----------//
    /**
     * Retrieve the most probable clef(s) at beginning of staff.
     * <p>
     * At this time, we can keep several clef kinds. Final choice may be postponed until key
     * retrieval, unless maximum potential key impact could not modify the selection of best clef.
     */
    public void findClefs ()
    {
        // Define outer & inner lookup areas
        outerRect = getOuterRect();
        innerRect = getInnerRect(outerRect);

        // The user may have inserted an artificial clef
        for (Inter inter : system.getSig().inters(ClefInter.class)) {
            if (outerRect.contains(inter.getCenter())) {
                registerClefs(Arrays.asList((ClefInter) inter));
                logger.info("Using {}", inter);

                return;
            }
        }

        // First attempt, using both outer & inner areas
        Map<ClefKind, ClefInter> bestMap = getBestMap(true);

        if (bestMap.isEmpty()) {
            // Second attempt, focused on inner area only
            bestMap = getBestMap(false);
        }

        // Register the remaining clef candidates
        if (!bestMap.isEmpty()) {
            registerClefs(bestMap.values());
        }
    }

    //------------//
    // getBestMap //
    //------------//
    /**
     * Retrieve the map of best clefs, organized per kind.
     *
     * @param isFirstPass true for first pass only
     * @return the bestMap found
     */
    private Map<ClefKind, ClefInter> getBestMap (boolean isFirstPass)
    {
        List<Glyph> parts = getParts(isFirstPass);

        // Formalize parts relationships in a global graph
        SimpleGraph<Glyph, GlyphLink> graph = Glyphs.buildLinks(parts, params.maxPartGap);
        List<Set<Glyph>> sets = new ConnectivityInspector<>(graph).connectedSets();
        logger.debug("Staff#{} sets: {}", staff.getId(), sets.size());

        // Best inter per clef kind
        Map<ClefKind, ClefInter> bestMap = new EnumMap<>(ClefKind.class);

        // Best octave G clef per octave shape, kept aside from bestMap (see promoteOctaveClef)
        Map<Shape, ClefInter> octaveMap = new EnumMap<>(Shape.class);
        Map<Shape, Double> octavePlainMap = new EnumMap<>(Shape.class);

        for (Set<Glyph> set : sets) {
            // Use only the subgraph for this set
            SimpleGraph<Glyph, GlyphLink> subGraph = GlyphCluster.getSubGraph(set, graph, false);
            ClefAdapter adapter = new ClefAdapter(subGraph, bestMap, octaveMap, octavePlainMap);
            new GlyphCluster(adapter, null).decompose();

            int trials = adapter.trials;
            logger.debug("Staff#{} clef parts:{} trials:{}", staff.getId(), set.size(), trials);
        }

        // Let the engraving promote an octave G clef over the plain one, if warranted
        promoteOctaveClef(bestMap, octaveMap, octavePlainMap);

        // Discard poor candidates as much as possible
        if (bestMap.size() > 1) {
            purgeClefs(bestMap);
        }

        return bestMap;
    }

    //--------------//
    // getInnerRect //
    //--------------//
    /**
     * Report the inner rectangle within the outer rectangle.
     *
     * @param outer provided outer rectangle
     * @return the inner rectangle
     */
    private Rectangle getInnerRect (Rectangle outer)
    {
        // Core rectangle
        Rectangle inner = new Rectangle(outer);
        inner.grow(0, -params.yCoreMargin);
        inner.x += params.xCoreMargin;
        inner.width -= params.xCoreMargin;
        staff.addAttachment("c", inner);

        return inner;
    }

    //--------------//
    // getOuterRect //
    //--------------//
    /**
     * Report the outer rectangle.
     * <p>
     * To cope with overlapping clefs across staves, the roi cannot vertically extend past the
     * middle of gutter with a neighboring staff.
     *
     * @return the outer rectangle
     */
    private Rectangle getOuterRect ()
    {
        final int xMin = range.browseStart;
        final int xMax = range.browseStop;
        final int xMid = (xMin + xMax) / 2;

        // Determine upper limit
        final int staffTop = staff.getFirstLine().yAt(xMid);
        int yMin = Math.max(0, staffTop - params.aboveStaff);

        // Staff above?
        for (Staff st : sheet.getStaffManager().vertNeighbors(staff, VerticalSide.TOP)) {
            if ((st.getAbscissa(LEFT) < xMid) && (st.getAbscissa(RIGHT) > xMid)) {
                final int yLast = st.getLastLine().yAt(xMid);
                yMin = Math.max(yMin, (int) Math.ceil(0.5 * (yLast + staffTop + 1)));
            }
        }

        // Determine lower limit
        final int staffBottom = staff.getLastLine().yAt(xMid);
        int yMax = Math.min(sheet.getHeight() - 1, staffBottom + params.belowStaff);

        // Staff below?
        for (Staff st : sheet.getStaffManager().vertNeighbors(staff, VerticalSide.BOTTOM)) {
            if ((st.getAbscissa(LEFT) < xMid) && (st.getAbscissa(RIGHT) > xMid)) {
                final int yFirst = st.getFirstLine().yAt(xMid);
                yMax = Math.min(yMax, (int) Math.floor(0.5 * ((staffBottom + yFirst) - 1)));
            }
        }

        Rectangle outer = new Rectangle(xMin, yMin, xMax - xMin + 1, yMax - yMin + 1);
        outer.grow(-params.beltMargin, 0);
        staff.addAttachment("C", outer);

        return outer;
    }

    //----------//
    // getParts //
    //----------//
    /**
     * Retrieve all glyph instances that could be part of clef.
     *
     * @param isFirstPass true for first pass
     * @return clef possible parts
     */
    private List<Glyph> getParts (boolean isFirstPass)
    {
        final Rectangle rect = isFirstPass ? outerRect : innerRect;

        // Grab pixels out of staff-free source
        ByteProcessor source = sheet.getPicture().getSource(Picture.SourceKey.NO_STAFF);
        ByteProcessor buf = new ByteProcessor(rect.width, rect.height);
        buf.copyBits(source, -rect.x, -rect.y, Blitter.COPY);

        // Extract parts
        RunTable runTable = new RunTableFactory(VERTICAL).createTable(buf);
        List<Glyph> parts = GlyphFactory.buildGlyphs(runTable, rect.getLocation());

        // Keep only interesting parts
        purgeParts(parts, isFirstPass);

        system.registerGlyphs(parts, null);
        logger.debug("{} parts: {}", this, parts.size());

        return parts;
    }

    //-------------------//
    // promoteOctaveClef //
    //-------------------//
    /**
     * Let an octave G clef supersede the plain G clef when the engraving warrants it.
     * <p>
     * <code>ClefInter.kindOf()</code> maps G_CLEF, G_CLEF_8VA and G_CLEF_8VB onto the single
     * <code>ClefKind.TREBLE</code>, so the kind-keyed <code>bestMap</code> can hold only one of
     * them, and it keeps the highest-graded one. On a staff engraved with an octave clef,
     * <code>GlyphCluster</code> produces both the clef body alone (read G_CLEF, cleanly, around
     * 0.8) and the body plus the octave digit (read G_CLEF_8VB, weakly, around 0.05 - the octave
     * shapes are rare in the training set). The plain reading therefore wins on every page of
     * every score, and the whole staff is transcribed an octave too high.
     * <p>
     * The classifier's own confidence cannot arbitrate that, so what arbitrates here is the
     * engraving: ink that the plain clef reading cannot account for, sitting exactly where an
     * octave digit is engraved. An octave candidate supersedes the plain clef only if all of:
     * <ol>
     * <li><b>Same clef body plus extra ink.</b> Its glyph strictly contains the plain candidate's
     * glyph and carries strictly more weight - one reading is the other plus something.
     * <li><b>The plain reading cannot explain that extra ink.</b> The classifier's G_CLEF grade
     * for the larger glyph must have collapsed to at most <code>maxPlainClefDecay</code> of the
     * grade it gave the contained clef body. A plain G clef with a stray speck attached still
     * reads as a fine G clef; a clef with a digit under it does not.
     * <li><b>The extra ink is placed and sized like an octave digit.</b> It lies beyond the staff
     * (below the bottom line for 8VB, above the top line for 8VA) and spans between
     * <code>minOctaveDigitHeight</code> and <code>maxOctaveDigitHeight</code> interlines.
     * <li><b>The classifier does offer the octave reading</b> for that larger glyph, above the
     * usual <code>Grades.clefMinGrade</code> acceptance floor.
     * </ol>
     * A header engraved as a bare G clef yields no containing glyph at all, condition 1 fails
     * immediately, and the stock selection stands untouched.
     *
     * @param bestMap       the best clef per kind, updated in place
     * @param octaveMap     the best octave clef candidate per octave shape
     * @param octavePlainMap the plain G clef grade on the very glyph behind each octaveMap entry
     */
    private void promoteOctaveClef (Map<ClefKind, ClefInter> bestMap,
                                    Map<Shape, ClefInter> octaveMap,
                                    Map<Shape, Double> octavePlainMap)
    {
        if (octaveMap.isEmpty()) {
            return;
        }

        final ClefInter plain = bestMap.get(ClefKind.TREBLE);

        if ((plain == null) || (plain.getShape() != G_CLEF) || (plain.getGlyph() == null)) {
            return;
        }

        final Glyph plainGlyph = plain.getGlyph();
        final Rectangle plainBox = plainGlyph.getBounds();
        final int xMid = plainBox.x + (plainBox.width / 2);
        ClefInter best = null;
        String bestReason = null;

        for (ClefInter octave : octaveMap.values()) {
            final Glyph glyph = octave.getGlyph();

            if (glyph == null) {
                continue;
            }

            final Shape shape = octave.getShape();
            final Rectangle box = glyph.getBounds();
            final String reason = octaveRejection(shape, box, glyph, plain, plainGlyph, xMid,
                                                  octavePlainMap.getOrDefault(shape, 0.0));

            if (reason != null) {
                logger.info(
                        "Staff#{} octave clef {} grade:{} not retained over {} grade:{} - {}",
                        staff.getId(),
                        shape,
                        String.format("%.3f", octave.getGrade()),
                        plain.getShape(),
                        String.format("%.3f", plain.getGrade()),
                        reason);
                continue;
            }

            if ((best == null) || (best.getGrade() < octave.getGrade())) {
                best = octave;
                bestReason = String.format(
                        "digit %d px beyond staff, plain grade decays %.3f -> %.3f",
                        (shape == G_CLEF_8VB)
                                ? ((box.y + box.height) - (plainBox.y + plainBox.height))
                                : (plainBox.y - box.y),
                        plain.getGrade(),
                        octavePlainMap.getOrDefault(shape, 0.0));
            }
        }

        if (best != null) {
            logger.info(
                    "Staff#{} octave clef {} grade:{} supersedes {} grade:{} ({})",
                    staff.getId(),
                    best.getShape(),
                    String.format("%.3f", best.getGrade()),
                    plain.getShape(),
                    String.format("%.3f", plain.getGrade()),
                    bestReason);
            bestMap.put(ClefKind.TREBLE, best);
        }
    }

    //-----------------//
    // octaveRejection //
    //-----------------//
    /**
     * Check one octave clef candidate against the plain clef it would supersede.
     *
     * @param shape      the octave shape at stake
     * @param box        bounds of the octave candidate glyph
     * @param glyph      the octave candidate glyph
     * @param plain      the plain clef candidate
     * @param plainGlyph the plain clef glyph
     * @param xMid       mid abscissa of the plain clef, to read the staff lines at
     * @param plainHere  plain G clef grade on the octave candidate glyph
     * @return null if the candidate is acceptable, else why it is not
     */
    private String octaveRejection (Shape shape,
                                    Rectangle box,
                                    Glyph glyph,
                                    ClefInter plain,
                                    Glyph plainGlyph,
                                    int xMid,
                                    double plainHere)
    {
        final Rectangle plainBox = plainGlyph.getBounds();

        // 1. The very same clef body, plus extra ink
        if (!box.contains(plainBox) || (glyph.getWeight() <= plainGlyph.getWeight())) {
            return "glyph does not strictly contain the plain clef glyph";
        }

        // 2. The plain reading must have collapsed on that larger glyph
        if (plainHere > (params.maxPlainClefDecay * plain.getGrade())) {
            return String.format(
                    "plain clef still reads %.3f on the larger glyph (max %.3f)",
                    plainHere,
                    params.maxPlainClefDecay * plain.getGrade());
        }

        // 3. Extra ink beyond the staff, on the side where the octave digit is engraved
        final int digit;

        if (shape == G_CLEF_8VB) {
            digit = (box.y + box.height) - (plainBox.y + plainBox.height);

            if ((digit <= 0) || ((plainBox.y + plainBox.height) < staff.getLastLine().yAt(xMid))) {
                return "no extra ink below the plain clef and beyond the staff";
            }
        } else {
            digit = plainBox.y - box.y;

            if ((digit <= 0) || (plainBox.y > staff.getFirstLine().yAt(xMid))) {
                return "no extra ink above the plain clef and beyond the staff";
            }
        }

        // 4. Sized like an octave digit
        if ((digit < params.minOctaveDigitHeight) || (digit > params.maxOctaveDigitHeight)) {
            return String.format(
                    "extra ink %d px is not digit-sized (%d..%d px)",
                    digit,
                    params.minOctaveDigitHeight,
                    params.maxOctaveDigitHeight);
        }

        return null;
    }

    //------------//
    // purgeClefs //
    //------------//
    private void purgeClefs (Map<ClefKind, ClefInter> bestMap)
    {
        final double maxContrib = ClefKeyRelation.maxContributionForClef();
        final List<ClefInter> inters = new ArrayList<>(bestMap.values());
        Collections.sort(inters, Inters.byReverseGrade);

        interLoop:
        for (int i = 0; i < inters.size(); i++) {
            final double grade = inters.get(i).getGrade();

            for (int j = i + 1; j < inters.size(); j++) {
                final ClefInter other = inters.get(j);
                final double maxOtherCtx = GradeUtil.contextual(other.getGrade(), maxContrib);

                if (grade > maxOtherCtx) {
                    // Cut here since, whatever the key, no other clef can beat the best clef
                    for (ClefInter poor : inters.subList(j, inters.size())) {
                        logger.debug("Staff#{} discarding poor {}", staff.getId(), poor);
                        bestMap.remove(poor.getKind());
                    }

                    return;
                }
            }
        }
    }

    //------------//
    // purgeParts //
    //------------//
    /**
     * Purge the population of parts candidates as much as possible, since the cost
     * of their later combinations is exponential.
     *
     * @param parts       the collection to purge
     * @param isFirstPass true for first pass
     */
    private void purgeParts (List<Glyph> parts,
                             boolean isFirstPass)
    {
        for (Iterator<Glyph> it = parts.iterator(); it.hasNext();) {
            final Glyph part = it.next();

            if ((part.getWeight() < params.minPartWeight) //
                    || (isFirstPass && !part.getBounds().intersects(innerRect))) {
                it.remove();
            }
        }

        if (parts.size() > params.maxPartCount) {
            Collections.sort(parts, Glyphs.byReverseWeight);
            parts.retainAll(parts.subList(0, params.maxPartCount));
        }
    }

    //---------------//
    // registerClefs //
    //---------------//
    /**
     * Register the clefs into SIG and update staff clef abscissa stop.
     *
     * @param clefSet collection of remaining candidates
     */
    private void registerClefs (Collection<ClefInter> clefSet)
    {
        // Sort clefs by decreasing grade
        final List<ClefInter> clefList = new ArrayList<>(clefSet);
        Collections.sort(clefList, Inters.byReverseGrade);

        for (int idx = 0; idx < clefList.size(); idx++) {
            final ClefInter inter = clefList.get(idx);

            // Unerased staff line chunks may shift the symbol in abscissa,
            // so use glyph centroid for a better positioning
            // For inter bounds, use font-based symbol bounds rather than glyph bounds
            //TODO: we could also check histogram right after clef end, looking for a low point?
            Rectangle clefBox = inter.getSymbolBounds(staff.getSpecificInterline());

            if (inter.getGlyph() != null) {
                final Shape shape = inter.getShape();
                final int size = MusicFont.getPointSize(sheet.getInterline());
                final MusicFamily family = sheet.getStub().getMusicFamily();
                final FontSymbol fs = shape.getFontSymbolByInterline(family, size);

                Point symbolCentroid = fs.symbol.getCentroid(clefBox);
                Point glyphCentroid = inter.getGlyph().getCentroid();
                int dx = glyphCentroid.x - symbolCentroid.x;
                int dy = glyphCentroid.y - symbolCentroid.y;
                logger.debug("Centroid translation dx:{} dy:{}", dx, dy);
                clefBox.translate(dx, 0);
                inter.setBounds(clefBox); // Force theoretical bounds as inter bounds!
                sig.addVertex(inter);
            }

            inter.setStaff(staff);

            if (idx == 0) {
                // Case of best clef
                Rectangle box = (inter.getGlyph() != null) ? inter.getGlyph().getBounds()
                        .intersection(clefBox) : clefBox;
                int end = (box.x + box.width) - 1;
                staff.setClefStop(end);
            }
        }

        sig.insertExclusions(clefList, Exclusion.ExclusionCause.OVERLAP);
    }

    //------------//
    // selectClef //
    //------------//
    /**
     * Make the final selection of best clef for this staff header.
     */
    private void selectClef ()
    {
        List<ClefInter> clefs = staff.getCompetingClefs(range.getStop());

        if (!clefs.isEmpty()) {
            for (Inter clef : clefs) {
                sig.computeContextualGrade(clef);
            }

            Collections.sort(clefs, Inters.byReverseBestGrade);

            // Pickup the first one as header clef
            ClefInter bestClef = clefs.get(0);

            if (bestClef.getGlyph() != null) {
                bestClef.setGlyph(sheet.getGlyphIndex().registerOriginal(bestClef.getGlyph()));
            }

            staff.getHeader().clef = bestClef;

            // Delete the other clef candidates
            for (Inter other : clefs.subList(1, clefs.size())) {
                other.remove();
            }
        }
    }

    //----------------//
    // setBrowseStart //
    //----------------//
    /**
     * Set the start abscissa for browsing.
     *
     * @param browseStart precise browse beginning abscissa (generally right after left bar line).
     */
    public void setBrowseStart (int browseStart)
    {
        range.browseStart = browseStart;
        range.browseStop = browseStart + params.maxClefEnd;
    }

    //----------//
    // toString //
    //----------//
    @Override
    public String toString ()
    {
        return "ClefBuilder#" + staff.getId();
    }

    //-------------//
    // ClefAdapter //
    //-------------//
    /**
     * Handles the integration between glyph clustering class and clef environment.
     * <p>
     * For each clef kind, we keep the best result found if any.
     */
    private class ClefAdapter
            extends GlyphCluster.AbstractAdapter
    {
        /** Best inter per clef kind. */
        private final Map<ClefKind, ClefInter> bestMap;

        /** Best inter per octave G clef shape. */
        private final Map<Shape, ClefInter> octaveMap;

        /** Plain G clef grade on the very glyph that yielded the octaveMap entry. */
        private final Map<Shape, Double> octavePlainMap;

        ClefAdapter (SimpleGraph<Glyph, GlyphLink> graph,
                     Map<ClefKind, ClefInter> bestMap,
                     Map<Shape, ClefInter> octaveMap,
                     Map<Shape, Double> octavePlainMap)
        {
            super(graph);
            this.bestMap = bestMap;
            this.octaveMap = octaveMap;
            this.octavePlainMap = octavePlainMap;
        }

        @Override
        public void evaluateGlyph (Glyph glyph,
                                   Set<Glyph> parts)
        {
            trials++;

            if (glyph.getId() == 0) {
                glyph = system.registerGlyph(glyph, null);
            }

            logger.debug("ClefAdapter evaluateGlyph on {}", glyph);

            // Octave G clefs are rare shapes: for one and the same glyph the classifier ranks
            // them below the plain G_CLEF, so a deeper sequence is requested here. The extra
            // evaluations feed octaveMap ONLY - the plain selection below still sees exactly the
            // first params.maxEvalRank evaluations, which the classifier returns in the very same
            // order whatever the requested count.
            final int evalRank = Math.max(params.maxEvalRank, params.maxOctaveEvalRank);
            Evaluation[] evals = classifier.evaluate(
                    glyph,
                    staff.getSpecificInterline(),
                    evalRank,
                    Grades.clefMinGrade / Grades.intrinsicRatio,
                    null);

            // Grade the classifier gives the PLAIN G clef on this very same glyph
            double plainHere = 0;

            for (Evaluation eval : evals) {
                if (eval.shape == G_CLEF) {
                    plainHere = Grades.intrinsicRatio * eval.grade;
                    break;
                }
            }

            // Allowed clefs shapes
            final EnumSet clefShapes = staff.isDrum() ? ONE_LINE_CLEF_SHAPES : HEADER_CLEF_SHAPES;
            for (int i = 0; i < evals.length; i++) {
                final Evaluation eval = evals[i];
                final Shape shape = eval.shape;

                if (clefShapes.contains(shape)) {
                    final double grade = Grades.intrinsicRatio * eval.grade;

                    if (OCTAVE_CLEF_SHAPES.contains(shape)) {
                        final ClefInter bestOctave = octaveMap.get(shape);

                        if ((bestOctave == null) || (bestOctave.getGrade() < grade)) {
                            final ClefInter octave = ClefInter.createValid(
                                    glyph,
                                    shape,
                                    grade,
                                    staff);

                            if (octave != null) {
                                octaveMap.put(shape, octave);
                                octavePlainMap.put(shape, plainHere);
                            }
                        }
                    }

                    if (i >= params.maxEvalRank) {
                        continue; // Beyond standard rank: octave probe only
                    }

                    ClefKind kind = ClefInter.kindOf(glyph.getCenter2D(), shape, staff);
                    ClefInter bestInter = bestMap.get(kind);

                    if ((bestInter == null) || (bestInter.getGrade() < grade)) {
                        bestMap.put(kind, ClefInter.createValid(glyph, shape, grade, staff));
                    }
                }
            }
        }

        @Override
        public boolean isTooLarge (Rectangle bounds)
        {
            return bounds.height > params.maxGlyphHeight;
        }

        @Override
        public boolean isTooLight (int weight)
        {
            return weight < params.minGlyphWeight;
        }
    }

    //-----------------------//
    // installPdfChangeClefs //
    //-----------------------//
    /**
     * After header selection, register missing inline G/F change clefs named in the
     * source PDF. Does not update {@code staff.setClefStop} or reopen header competition.
     */
    private static void installPdfChangeClefs (SystemInfo system)
    {
        final Sheet sheet = system.getSheet();
        final java.nio.file.Path input;
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
            logger.info("PDF change-clef skipped: unsupported sheet skew {}",
                    sheet.getSkew().getSlope());
            return;
        }
        if ((sheet.getWidth() <= 0) || (sheet.getHeight() <= 0)) {
            return;
        }

        final List<PdfClefHints.Hint> hints = PdfClefHints.scan(
                input,
                sheet.getStub().getNumber() - 1);
        if (hints.isEmpty()) {
            return;
        }

        final ByteProcessor source = sheet.getPicture().getSource(Picture.SourceKey.NO_STAFF);
        if (source == null) {
            return;
        }
        final PdfClefHints.PixelSource pixels = (x, y) -> (x >= 0) && (y >= 0)
                && (x < source.getWidth()) && (y < source.getHeight())
                && (source.get(x, y) < 128);

        for (PdfClefHints.Hint hint : hints) {
            final Path2D sheetPath = PdfClefHints.toSheetPath(
                    hint,
                    sheet.getWidth(),
                    sheet.getHeight());
            if (sheetPath == null) {
                continue;
            }
            final Rectangle2D outline = sheetPath.getBounds2D();
            final PdfClefHints.InkEvidence ink = PdfClefHints.measureInk(sheetPath, pixels);
            if (!ink.agrees()) {
                logger.info("PDF change-clef {} rejected: ink path={} inside={} bounds={} font={}",
                        hint.glyphName,
                        ink.pathPixels,
                        ink.inkInside,
                        ink.inkInBounds,
                        hint.fontName);
                continue;
            }

            final List<PdfClefHints.StaffAnchor> anchors = new ArrayList<>();
            final List<Staff> staves = sheet.getStaffManager().getStaves();
            for (int i = 0; i < staves.size(); i++) {
                final Staff staff = staves.get(i);
                if (staff.isTablature() || staff.isOneLineStaff() || (staff.getLineCount() != 5)) {
                    continue;
                }
                final double x = outline.getCenterX();
                anchors.add(new PdfClefHints.StaffAnchor(
                        i,
                        staff.getFirstLine().yAt(x),
                        staff.getLastLine().yAt(x),
                        staff.pitchToOrdinate(x, hint.identity.clefLinePitch()),
                        staff.getSpecificInterline()));
            }
            final Integer staffIndex = PdfClefHints.uniqueStaff(outline, anchors);
            if (staffIndex == null) {
                logger.info("PDF change-clef {} rejected: no unique staff at {}",
                        hint.glyphName,
                        outline);
                continue;
            }
            final Staff staff = staves.get(staffIndex);
            if (staff.getSystem() != system) {
                continue;
            }

            if (coveredByExistingClef(system, staff, outline)) {
                logger.info("PDF change-clef {} rejected: existing clef covers {} staff#{}",
                        hint.glyphName,
                        outline,
                        staff.getId());
                continue;
            }

            final Glyph glyph = glyphFromOutline(system, sheetPath, source);
            if (glyph == null) {
                logger.info("PDF change-clef {} rejected: empty outline-clipped glyph {}",
                        hint.glyphName,
                        outline);
                continue;
            }

            final double grade = Grades.intrinsicRatio * ink.confidence();
            final Shape shape = shapeOf(hint.identity);
            final ClefInter clef = ClefInter.createValid(glyph, shape, grade, staff);
            if (clef == null) {
                continue;
            }
            clef.setStaff(staff);
            system.getSig().addVertex(clef);
            logger.info(
                    "PDF change-clef {} accepted staff#{} box=({},{},{},{}) ink={}/{} font={}",
                    hint.glyphName,
                    staff.getId(),
                    Math.round(outline.getX()),
                    Math.round(outline.getY()),
                    Math.round(outline.getWidth()),
                    Math.round(outline.getHeight()),
                    ink.inkInside,
                    ink.pathPixels,
                    hint.fontName);
        }
    }

    private static Shape shapeOf (PdfClefHints.Identity identity)
    {
        return switch (identity) {
        case G_CHANGE -> G_CLEF;
        case F_CHANGE -> F_CLEF;
        };
    }

    private static boolean coveredByExistingClef (SystemInfo system,
                                                    Staff staff,
                                                    Rectangle2D outline)
    {
        for (Inter inter : system.getSig().inters(ClefInter.class)) {
            if (inter.getStaff() != staff) {
                continue;
            }
            final Rectangle bounds = inter.getBounds();
            if ((bounds != null) && PdfClefHints.coveredByExistingClef(outline, bounds)) {
                return true;
            }
        }
        return false;
    }

    private static Glyph glyphFromOutline (SystemInfo system,
                                              Path2D sheetPath,
                                              ByteProcessor source)
    {
        final Rectangle box = sheetPath.getBounds();
        if ((box.width < 4) || (box.height < 8)) {
            return null;
        }
        box.x = Math.max(0, box.x);
        box.y = Math.max(0, box.y);
        if (box.x >= source.getWidth() || box.y >= source.getHeight()) {
            return null;
        }
        box.width = Math.min(box.width, source.getWidth() - box.x);
        box.height = Math.min(box.height, source.getHeight() - box.y);
        if ((box.width < 4) || (box.height < 8)) {
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

    //~ Inner Classes ------------------------------------------------------------------------------

    //--------//
    // Column //
    //--------//
    /**
     * Manages the system consistency for a column of ClefBuilder instances.
     */
    public static class Column
    {
        private final SystemInfo system;

        /** Map of clef builders. (one per staff) */
        private final Map<Staff, ClefBuilder> builders = new TreeMap<>(Staff.byId);

        /**
         * Create a Column.
         *
         * @param system the containing system
         */
        public Column (SystemInfo system)
        {
            this.system = system;
        }

        //---------------//
        // retrieveClefs //
        //---------------//
        /**
         * Retrieve the column of staves candidate clefs.
         *
         * @return the ending abscissa offset of clefs column WRT measure start
         */
        public int retrieveClefs ()
        {
            // Retrieve staff Header clefs
            int maxClefOffset = 0;

            for (Staff staff : system.getStaves()) {
                if (staff.isTablature()) {
                    continue;
                }

                int measureStart = staff.getHeaderStart();

                // Retrieve staff clef
                ClefBuilder builder = new ClefBuilder(staff);
                builder.setBrowseStart(measureStart);
                builders.put(staff, builder);
                builder.findClefs();

                final Integer clefStop = staff.getClefStop();

                if (clefStop != null) {
                    maxClefOffset = Math.max(maxClefOffset, clefStop - measureStart);
                } else if (!staff.isOneLineStaff()) {
                    logger.warn("Staff#{} no recognized header clef.", staff.getId());
                }
            }

            // Push StaffHeader
            return maxClefOffset;
        }

        //-------------//
        // selectClefs //
        //-------------//
        /**
         * Make final clef selection for each staff.
         */
        public void selectClefs ()
        {
            for (ClefBuilder builder : builders.values()) {
                builder.selectClef();
            }

            installPdfChangeClefs(system);
        }
    }

    //-----------//
    // Constants //
    //-----------//
    private static class Constants
            extends ConstantSet
    {
        private final Scale.Fraction maxClefEnd = new Scale.Fraction(
                4.5,
                "Maximum x distance from measure start to end of clef");

        private final Scale.Fraction aboveStaff = new Scale.Fraction(
                3.0,
                "Top of lookup area above stave");

        private final Scale.Fraction belowStaff = new Scale.Fraction(
                3.25,
                "Bottom of lookup area below stave");

        private final Scale.Fraction beltMargin = new Scale.Fraction(
                0.15,
                "White margin within raw rectangle");

        private final Scale.Fraction xCoreMargin = new Scale.Fraction(
                0.2,
                "Horizontal margin around core rectangle");

        private final Scale.Fraction yCoreMargin = new Scale.Fraction(
                0.5,
                "Vertical margin around core rectangle");

        private final Constant.Integer maxPartCount = new Constant.Integer(
                "Glyphs",
                8,
                "Maximum number of parts considered for a clef");

        private final Scale.AreaFraction minPartWeight = new Scale.AreaFraction(
                0.01,
                "Minimum weight for a glyph part");

        private final Scale.Fraction maxPartGap = new Scale.Fraction(
                0.75,
                "Maximum distance between two parts of a single clef symbol");

        private final Scale.Fraction maxGlyphHeight = new Scale.Fraction(
                9.0,
                "Maximum height for clef glyph");

        private final Scale.AreaFraction minGlyphWeight = new Scale.AreaFraction(
                1.0,
                "Minimum weight for clef glyph");

        private final Constant.Integer maxEvalRank = new Constant.Integer(
                "none",
                3,
                "Maximum acceptable rank in clef evaluation");

        private final Constant.Integer maxOctaveEvalRank = new Constant.Integer(
                "none",
                12,
                "Maximum acceptable rank in clef evaluation for an octave G clef");

        private final Constant.Ratio maxPlainClefDecay = new Constant.Ratio(
                0.5,
                "Maximum plain clef grade on the octave glyph, as a ratio of the plain clef grade");

        private final Scale.Fraction minOctaveDigitHeight = new Scale.Fraction(
                0.5,
                "Minimum height of the octave digit beyond the plain clef");

        private final Scale.Fraction maxOctaveDigitHeight = new Scale.Fraction(
                2.5,
                "Maximum height of the octave digit beyond the plain clef");
    }

    //------------//
    // Parameters //
    //------------//
    private static class Parameters
    {
        final int maxPartCount;

        final int maxEvalRank;

        final int maxOctaveEvalRank;

        final double maxPlainClefDecay;

        // Sheet scale dependent
        //----------------------

        final int maxClefEnd;

        final int beltMargin;

        final int xCoreMargin; // staff?

        final int yCoreMargin; // staff?

        // Staff scale dependent
        //----------------------

        final int aboveStaff;

        final int belowStaff;

        final int minPartWeight;

        final double maxPartGap;

        final double maxGlyphHeight;

        final int minGlyphWeight;

        final int minOctaveDigitHeight;

        final int maxOctaveDigitHeight;

        Parameters (Scale scale,
                    int staffSpecific)
        {
            maxPartCount = constants.maxPartCount.getValue();
            maxEvalRank = constants.maxEvalRank.getValue();
            maxOctaveEvalRank = constants.maxOctaveEvalRank.getValue();
            maxPlainClefDecay = constants.maxPlainClefDecay.getValue();

            {
                // Use sheet large interline scale
                final InterlineScale large = scale.getInterlineScale();
                maxClefEnd = large.toPixels(constants.maxClefEnd);
                beltMargin = large.toPixels(constants.beltMargin);
                xCoreMargin = large.toPixels(constants.xCoreMargin);
                yCoreMargin = large.toPixels(constants.yCoreMargin);
            }

            {
                // Use staff specific interline value
                final InterlineScale specific = scale.getInterlineScale(staffSpecific);
                aboveStaff = specific.toPixels(constants.aboveStaff);
                belowStaff = specific.toPixels(constants.belowStaff);
                minPartWeight = specific.toPixels(constants.minPartWeight);
                maxPartGap = specific.toPixelsDouble(constants.maxPartGap);
                maxGlyphHeight = specific.toPixelsDouble(constants.maxGlyphHeight);
                minGlyphWeight = specific.toPixels(constants.minGlyphWeight);
                minOctaveDigitHeight = specific.toPixels(constants.minOctaveDigitHeight);
                maxOctaveDigitHeight = specific.toPixels(constants.maxOctaveDigitHeight);
            }
        }
    }
}
