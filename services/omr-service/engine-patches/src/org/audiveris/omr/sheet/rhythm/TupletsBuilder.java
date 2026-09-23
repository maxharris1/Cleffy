//------------------------------------------------------------------------------------------------//
//                                                                                                //
//                                   T u p l e t s B u i l d e r                                  //
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
package org.audiveris.omr.sheet.rhythm;

import org.audiveris.omr.glyph.Glyph;
import org.audiveris.omr.glyph.GlyphGroup;
import org.audiveris.omr.glyph.Shape;
import org.audiveris.omr.math.GeoUtil;
import org.audiveris.omr.math.Rational;
import org.audiveris.omr.sheet.Staff;
import org.audiveris.omr.sheet.SystemInfo;
import org.audiveris.omr.sig.SIGraph;
import org.audiveris.omr.sig.inter.AbstractBeamInter;
import org.audiveris.omr.sig.inter.AbstractChordInter;
import org.audiveris.omr.sig.inter.Inters;
import org.audiveris.omr.sig.inter.StemInter;
import org.audiveris.omr.sig.inter.TupletInter;
import org.audiveris.omr.sig.relation.ChordTupletRelation;
import org.audiveris.omr.sig.relation.Link;
import org.audiveris.omr.sig.relation.Relation;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.awt.Point;
import java.awt.Rectangle;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.SortedSet;
import java.util.TreeSet;

/**
 * Class <code>TupletsBuilder</code> tries to connect every tuplet symbol in a measure stack
 * to its embraced chords.
 *
 * @author Hervé Bitteur
 */
public class TupletsBuilder
{
    //~ Static fields/initializers -----------------------------------------------------------------

    private static final Logger logger = LoggerFactory.getLogger(TupletsBuilder.class);

    //~ Instance fields ----------------------------------------------------------------------------

    /** The dedicated measure stack. */
    private final MeasureStack stack;

    //~ Constructors -------------------------------------------------------------------------------

    /**
     * Creates a new <code>TupletsBuilder</code> object.
     *
     * @param stack the dedicated stack
     */
    public TupletsBuilder (MeasureStack stack)
    {
        this.stack = stack;
    }

    //~ Methods ------------------------------------------------------------------------------------

    //-----------------//
    // getChordsAround //
    //-----------------//
    /**
     * Report the list of AbstractChordInter instances (rests & heads) in the
     * neighborhood of the specified Inter.
     * <p>
     * Neighborhood is limited horizontally by the measure sides and vertically by the staves above
     * and below.
     *
     * @param tuplet the inter of interest
     * @return the list of neighbors, sorted by euclidean distance to tuplet sign
     */
    private List<AbstractChordInter> getChordsAround (TupletInter tuplet)
    {
        final List<AbstractChordInter> chords = new ArrayList<>();
        final Point tupletCenter = tuplet.getCenter();

        if (stack == null) {
            return chords;
        }

        final List<Staff> stavesAround = stack.getSystem().getStavesAround(tupletCenter);
        logger.trace("{} around:{}", tuplet, stavesAround);

        for (AbstractChordInter chord : stack.getStandardChords()) {
            final List<Staff> chordStaves = new ArrayList<>(chord.getStaves());
            chordStaves.retainAll(stavesAround);

            if (!chordStaves.isEmpty()) {
                chords.add(chord);
            }
        }

        Collections.sort(chords, new ByEuclidean(tupletCenter));
        logger.trace("Chords: {}", Inters.ids(chords));

        return chords;
    }

    //------------------//
    // linkStackTuplets //
    //------------------//
    /**
     * Try to link all tuplet signs in stack.
     * <p>
     * A tuplet sign embraces a specific number of notes (heads / rests).
     * <p>
     * Its neighborhood is limited in its part, vertically to staff above and staff below and
     * horizontally to its containing measure stack.
     */
    public void linkStackTuplets ()
    {
        final Set<TupletInter> tuplets = stack.getTuplets();

        for (TupletInter tuplet : tuplets) {
            if (tuplet.isVip()) {
                logger.info("VIP linkStackTuplets for {}", tuplet);
            }

            // Purge existing tuplet-chord relations, except manual ones if any
            final SIGraph sig = stack.getSystem().getSig();
            final Set<Relation> rels = sig.getRelations(tuplet, ChordTupletRelation.class);

            for (Relation rel : rels) {
                if (!rel.isManual()) {
                    sig.removeEdge(rel);
                }
            }

            final Collection<Link> links = lookupLinks(tuplet);

            for (Link link : links) {
                link.applyTo(tuplet);
            }

            if (!tuplet.isManual() && !sig.hasRelation(tuplet, ChordTupletRelation.class)) {
                tuplet.remove();
            }
        }
    }

    //-------------//
    // lookupLinks //
    //-------------//
    /**
     * Look up for tuplet relevant chords.
     *
     * @param tuplet the tuplet sign
     * @return the collection of links found, perhaps empty
     */
    public Collection<Link> lookupLinks (TupletInter tuplet)
    {
        // Try to link tuplet with proper chords found in measure stack
        // (just staff above and staff below)
        List<AbstractChordInter> chordcandidates = getChordsAround(tuplet);

        // Now, get the properly embraced chords
        SortedSet<AbstractChordInter> chords = getEmbracedChords(tuplet, chordcandidates);

        if (chords == null) {
            return Collections.emptySet();
        }

        logger.trace("{} connectable to {}", tuplet, chords);

        List<Link> links = new ArrayList<>();

        for (AbstractChordInter chord : chords) {
            links.add(new Link(chord, new ChordTupletRelation(tuplet.getShape()), false));
        }

        return links;
    }

    //~ Static Methods -----------------------------------------------------------------------------

    //---------------//
    // expectedCount //
    //---------------//
    /**
     * Report the number of basic items governed by the tuplet.
     * A given chord may represent several basic items (chords of base duration)
     *
     * @param shape the tuplet shape
     * @return 3 or 6
     */
    private static int expectedCount (Shape shape)
    {
        return switch (shape) {
            case TUPLET_THREE -> 3;
            case TUPLET_SIX -> 6;
            default -> {
                logger.error("Incorrect tuplet shape {}", shape);
                yield 0;
            }
        };
    }

    //------------------------//
    // filterChordsOnAbscissa //
    //------------------------//
    /**
     * If two chords overlap horizontally, discard the one with higher vertical distance
     * from the tuplet sign.
     *
     * @param tuplet     underlying tuplet sign
     * @param candidates the chords candidates, ordered by euclidean distance to sign
     */
    private static void filterChordsOnAbscissa (TupletInter tuplet,
                                                List<AbstractChordInter> candidates)
    {
        final Point pt = tuplet.getCenter();

        for (int idx1 = 0; idx1 < candidates.size(); idx1++) {
            final AbstractChordInter ch1 = candidates.get(idx1);
            final Rectangle b1 = ch1.getBounds();
            final Point p1 = ch1.getCenter();

            for (int idx2 = idx1 + 1; idx2 < candidates.size(); idx2++) {
                final AbstractChordInter ch2 = candidates.get(idx2);
                final Rectangle b2 = ch2.getBounds();

                if (GeoUtil.xOverlap(b1, b2) > 0) {
                    // Discard ch1 or ch2, based on y-distance
                    final Point p2 = ch2.getCenter();
                    final int d1 = Math.abs(p1.y - pt.y);
                    final int d2 = Math.abs(p2.y - pt.y);

                    if (d1 < d2) {
                        candidates.remove(ch2);
                        idx2--;
                    } else {
                        candidates.remove(ch1);
                        idx1--;
                        break;
                    }
                }
            }
        }
    }

    //-------------------//
    // getEmbracedChords //
    //-------------------//
    /**
     * Report the proper collection of chords that are embraced by the tuplet.
     *
     * @param tuplet     underlying tuplet sign
     * @param candidates the chords candidates, ordered by euclidean distance to sign
     * @return the set of embraced chords, ordered from left to right, or null if retrieval failed
     */
    public static SortedSet<AbstractChordInter> getEmbracedChords (TupletInter tuplet,
                                                                   List<AbstractChordInter> candidates)
    {
        logger.trace("{} getEmbracedChords", tuplet);

        filterChordsOnAbscissa(tuplet, candidates);

        /*
         * A beam can contain more items than a printed tuplet sign embraces.  If
         * the actual symbol graph still contains both bracket halves, use their
         * measured ink to limit the chord anchors.  An absent or ambiguous pair
         * leaves the historical path untouched.
         */
        final Rectangle bracketSpan = findBracketSpan(tuplet, candidates);
        if (bracketSpan != null) {
            final int expected = expectedCount(tuplet.getShape());
            candidates.removeIf(chord -> !containsX(bracketSpan, chord.getTailLocation().x));

            if (candidates.size() != expected) {
                return null;
            }
        }

        // We consider each candidate in turn, with its duration
        // in order to determine the duration base of the tuplet
        final TupletCollector collector = new TupletCollector(
                tuplet, bracketSpan,
                new TreeSet<>(Inters.byFullAbscissa));
        final Staff targetStaff = getTargetStaff(candidates);

        for (AbstractChordInter chord : candidates) {
            // We assume that chords with 2 staves have their tuplet sign above...
            Staff staff = chord.getTopStaff();

            // Check that all chords are on the same staff
            if (staff != targetStaff) {
                continue;
            }

            collector.include(chord);

            // Check we have collected the exact amount of time
            // TODO: Test is questionable for non-reliable candidates
            if (collector.isNotOk()) {
                logger.debug("{} {}", tuplet, collector.getStatusMessage());

                return null;
            } else if (collector.isOk()) {
                if (logger.isDebugEnabled()) {
                    collector.dump();
                }

                return collector.getChords(); // Normal exit
            }
        }

        // Candidates are exhausted, we lack chords
        logger.debug("{} {}", tuplet, collector.getStatusMessage());

        return null;
    }

    //--------------------//
    // findBracketSpan   //
    //--------------------//
    /**
     * Find one unambiguous pair of horizontal bracket halves around the sign.
     * Geometry is expressed in interline units and ink occupancy is checked so
     * that arbitrary nearby symbol glyphs cannot act as a bracket.
     */
    private static Rectangle findBracketSpan (TupletInter tuplet,
                                              List<AbstractChordInter> candidates)
    {
        if (tuplet.getSig() == null || candidates.isEmpty()) {
            return null;
        }

        final SystemInfo system = tuplet.getSig().getSystem();
        final Glyph sign = tuplet.getGlyph();

        if (system == null || sign == null) {
            return null;
        }

        final int il = system.getSheet().getInterline();
        final Rectangle signBox = sign.getBounds();
        final List<Glyph> left = new ArrayList<>();
        final List<Glyph> right = new ArrayList<>();

        for (Glyph glyph : system.getGroupedGlyphs(GlyphGroup.SYMBOL)) {
            if (glyph == sign) {
                continue;
            }

            final Rectangle box = glyph.getBounds();
            final int gapLeft = signBox.x - (box.x + box.width);
            final int gapRight = box.x - (signBox.x + signBox.width);
            final int yDelta = Math.abs(box.y + (box.height / 2)
                    - signBox.y - (signBox.height / 2));

            if (yDelta > il) {
                continue;
            }

            if ((gapLeft >= 0) && (gapLeft <= (2 * il))
                    && isBracketHalf(glyph, il, true)) {
                left.add(glyph);
            } else if ((gapRight >= 0) && (gapRight <= (2 * il))
                    && isBracketHalf(glyph, il, false)) {
                right.add(glyph);
            }
        }

        if ((left.size() != 1) || (right.size() != 1)) {
            return null;
        }

        final Rectangle leftBox = left.get(0).getBounds();
        final Rectangle rightBox = right.get(0).getBounds();

        // Both halves must describe one bracket, rather than two unrelated
        // horizontal marks at similar heights.  Their top strokes and hooks
        // are measured in the same interline-scaled coordinate frame.
        final int leftTop = leftBox.y + topStrokeRow(left.get(0), il);
        final int rightTop = rightBox.y + topStrokeRow(right.get(0), il);
        if (Math.abs(leftTop - rightTop)
                > Math.max(1, il / 4)) {
            return null;
        }

        final Rectangle span = new Rectangle(leftBox.x, leftBox.y,
                rightBox.x + rightBox.width - leftBox.x,
                Math.max(leftBox.y + leftBox.height, rightBox.y + rightBox.height)
                        - Math.min(leftBox.y, rightBox.y));

        // The bracket must cover at least the sign and one staff-local chord.
        if (!span.intersects(signBox)) {
            return null;
        }

        final Staff targetStaff = getTargetStaff(candidates);
        int chordCount = 0;
        for (AbstractChordInter chord : candidates) {
            if (containsX(span, chord.getTailLocation().x)
                    && (targetStaff != chord.getTopStaff())) {
                // A second staff in the same measured span makes the pair
                // ambiguous. Leave the historical candidate path intact.
                return null;
            }
            if ((targetStaff == chord.getTopStaff())
                    && containsX(span, chord.getTailLocation().x)) {
                chordCount++;
            }
        }

        return (chordCount == expectedCount(tuplet.getShape())) ? span : null;
    }

    private static boolean containsX (Rectangle span,
                                     int x)
    {
        return (x >= span.x) && (x <= (span.x + span.width));
    }

    //-----------------//
    // isBracketHalf  //
    //-----------------//
    /**
     * Check measured dimensions and ink for one horizontal bracket half.
     *
     * @param leftHalf true for the left half, whose hook must be on its outer
     *                  (left) edge; false for the right half
     */
    private static boolean isBracketHalf (Glyph glyph,
                                          int il,
                                          boolean leftHalf)
    {
        final Rectangle box = glyph.getBounds();

        if ((box.width < il) || (box.width > (3 * il))
                || (box.height < (il / 2)) || (box.height > (2 * il))) {
            return false;
        }

        final int top = topStrokeRow(glyph, il);
        if (top < 0) {
            return false;
        }

        // A bracket half has a continuous, long horizontal stroke near its
        // top.  Requiring a run (rather than total row ink) excludes dotted
        // text and fragmented nearby symbols.
        final int outerColumns = Math.max(1, Math.min(box.width, il / 3));
        final int innerStart = leftHalf ? outerColumns : 0;
        final int innerEnd = leftHalf ? box.width : box.width - outerColumns;
        int outerHookInk = 0;
        int innerHookInk = 0;

        for (int dx = 0; dx < box.width; dx++) {
            int columnInk = 0;
            for (int dy = 0; dy < box.height; dy++) {
                if (glyph.contains(new Point(box.x + dx, box.y + dy))) {
                    columnInk++;
                }
            }

            if ((leftHalf && dx < outerColumns) || (!leftHalf && dx >= box.width - outerColumns)) {
                outerHookInk = Math.max(outerHookInk, columnInk);
            }
            if (dx >= innerStart && dx < innerEnd) {
                innerHookInk = Math.max(innerHookInk, columnInk);
            }
        }

        // The long vertical run must be on the outer edge.  The inner edge
        // may contain a short hook, but cannot be the primary upright.
        return (outerHookInk * 2 >= box.height)
                && (innerHookInk * 2 < box.height)
                && (outerHookInk > innerHookInk);
    }

    /** Return the first top-near row containing a long contiguous ink run. */
    private static int topStrokeRow (Glyph glyph,
                                     int il)
    {
        final Rectangle box = glyph.getBounds();
        final int maxTop = Math.min(box.height - 1, Math.max(il, box.height / 2));
        final int minimumRun = Math.max(2, Math.min(box.width, Math.max(il, box.width / 2)));

        for (int dy = 0; dy <= maxTop; dy++) {
            int run = 0;
            for (int dx = 0; dx < box.width; dx++) {
                if (glyph.contains(new Point(box.x + dx, box.y + dy))) {
                    run++;
                    if (run >= minimumRun) {
                        return dy;
                    }
                } else {
                    run = 0;
                }
            }
        }

        return -1;
    }

    //----------------//
    // getTargetStaff //
    //----------------//
    /**
     * Report the staff of first head-based chord among the sorted candidates
     *
     * @param candidates candidates ordered by distance from tuplet
     * @return the target staff
     */
    private static Staff getTargetStaff (List<AbstractChordInter> candidates)
    {
        for (AbstractChordInter chord : candidates) {
            if (!chord.isRest()) {
                return chord.getTopStaff();
            }
        }

        return null;
    }

    //~ Inner Classes ------------------------------------------------------------------------------

    //-------------//
    // ByEuclidean //
    //-------------//
    private static class ByEuclidean
            implements Comparator<AbstractChordInter>
    {
        /** The location of the tuplet sign */
        private final Point signPoint;

        ByEuclidean (Point signPoint)
        {
            this.signPoint = signPoint;
        }

        /** Compare their euclidean distance from the signPoint reference */
        @Override
        public int compare (AbstractChordInter c1,
                            AbstractChordInter c2)
        {
            double dx1 = GeoUtil.ptDistanceSq(c1.getBounds(), signPoint.x, signPoint.y);
            double dx2 = GeoUtil.ptDistanceSq(c2.getBounds(), signPoint.x, signPoint.y);

            return Double.compare(dx1, dx2);
        }
    }

    //-----------------//
    // TupletCollector //
    //-----------------//
    private static class TupletCollector
    {
        /** Underlying sign. */
        private final TupletInter tuplet;

        /** Optional measured bracket span, used to trim beam siblings. */
        private final Rectangle bracketSpan;

        /** The maximum number of base items expected. (TODO: this is not always true) */
        private final int expectedCount;

        /** The chords collected so far. */
        private final SortedSet<AbstractChordInter> chords;

        /** The base duration as identified so far. */
        private Rational base = Rational.MAX_VALUE;

        /** The total duration expected (using the known base). */
        private Rational expectedTotal = Rational.MAX_VALUE;

        /** The total duration so far. */
        private Rational total = Rational.ZERO;

        /** Current status. */
        private Status status;

        TupletCollector (TupletInter tuplet,
                         Rectangle bracketSpan,
                         SortedSet<AbstractChordInter> chords)
        {
            this.tuplet = tuplet;
            this.bracketSpan = bracketSpan;
            expectedCount = expectedCount(tuplet.getShape());
            this.chords = chords;
        }

        /** Include a chord into the collection */
        private void doInclude (AbstractChordInter chord)
        {
            if (chords.add(chord)) {
                Rational sansTuplet = chord.getDurationSansTuplet();
                total = total.plus(sansTuplet);

                // If this is a shorter chord, let's update the base
                // TODO: this is not always true.
                if (sansTuplet.compareTo(base) < 0) {
                    base = sansTuplet;
                    expectedTotal = base.times(expectedCount);
                }
            }
        }

        public void dump ()
        {
            StringBuilder sb = new StringBuilder();

            sb.append(tuplet);

            sb.append(" ").append(status);

            sb.append(" Base:").append(base);

            sb.append(" ExpectedTotal:").append(expectedTotal);

            sb.append(" Total:").append(total);

            for (AbstractChordInter chord : chords) {
                sb.append("\n").append(chord);
            }

            logger.info(sb.toString());
        }

        /**
         * Retrieve all chords linked via the smallest beam to the provided chord.
         * <p>
         * We have to check position of tuplet with respect to chord
         * If tuplet is closer to chord tail side (thus beam) we use siblings
         * Otherwise, tuplet is closer to head and we don't propagate to beam siblings
         *
         * @param chord the provided chord
         * @return all sibling chords, including the chord provided
         */
        protected Set<AbstractChordInter> getBeamSiblings (AbstractChordInter chord)
        {
            final Set<AbstractChordInter> set = new LinkedHashSet<>();
            set.add(chord);

            final StemInter stem = chord.getStem();

            if (stem != null) {
                final Point center = tuplet.getCenter();
                final Point tail = chord.getTailLocation();
                final Point head = chord.getHeadLocation();

                if (center.distanceSq(tail) < center.distanceSq(head)) {
                    // Pick up the smallest beam, if any, connected to this stem
                    int smallestWidth = Integer.MAX_VALUE;
                    AbstractBeamInter smallestBeam = null;

                    for (AbstractBeamInter beam : stem.getBeams()) {
                        int width = beam.getBounds().width;

                        if (width < smallestWidth) {
                            smallestWidth = width;
                            smallestBeam = beam;
                        }
                    }

                    if (smallestBeam != null) {
                        for (StemInter s : smallestBeam.getStems()) {
                            for (AbstractChordInter sibling : s.getChords()) {
                                if ((bracketSpan == null)
                                        || containsX(bracketSpan, sibling.getTailLocation().x)) {
                                    set.add(sibling);
                                }
                            }
                        }
                    }
                }
            }

            return set;
        }

        public SortedSet<AbstractChordInter> getChords ()
        {
            return chords;
        }

        public String getStatusMessage ()
        {
            StringBuilder sb = new StringBuilder();
            sb.append(status).append(" sequence in ").append(tuplet.getShape()).append(": ").append(
                    total);

            if (expectedTotal != Rational.MAX_VALUE) {
                sb.append(" vs ").append(expectedTotal);
            }

            return sb.toString();
        }

        public Rational getTotal ()
        {
            return total;
        }

        /** Include the provided chord into the collection */
        public void include (AbstractChordInter chord)
        {
            if (!chords.contains(chord)) {
                // Chord together with its beam-siblings
                // (only if tuplet is on beam side of the stems)
                Set<AbstractChordInter> siblings = getBeamSiblings(chord);

                for (AbstractChordInter ch : siblings) {
                    doInclude(ch);
                }

                // Check count and duration
                // TODO: this is not always true, and thus should be refined!
                if (chords.size() > expectedCount) {
                    status = Status.TOO_MANY;
                } else if (total.compareTo(expectedTotal) > 0) {
                    status = Status.TOO_LONG;
                } else if (total.equals(expectedTotal)) {
                    // Check tuplet sign is within chords abscissae
                    if (isWithinChordsAbscissaRange()) {
                        status = Status.OK;
                    } else {
                        status = Status.OUTSIDE;
                    }
                }
            }
        }

        public boolean isNotOk ()
        {
            return (status != null) && (status != Status.OK);
        }

        public boolean isOk ()
        {
            return status == Status.OK;
        }

        /** Check whether the tuplet sign lies between the chords abscissae. */
        private boolean isWithinChordsAbscissaRange ()
        {
            int signX = tuplet.getCenter().x;

            return (signX >= chords.first().getTailLocation().x) && (signX <= chords.last()
                    .getTailLocation().x);
        }

        /** Describe the current status of the tuplet collector */
        public enum Status
        {
            TOO_SHORT,
            OK,
            TOO_LONG,
            TOO_MANY,
            OUTSIDE;
        }
    }
}
