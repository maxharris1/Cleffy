//------------------------------------------------------------------------------------------------//
//                                                                                                //
//                            Q u a r t e r R e s t T e m p l a t e M a t c h e r               //
//                                                                                                //
//------------------------------------------------------------------------------------------------//
package org.audiveris.omr.sheet.symbol;

import java.util.List;

/**
 * Pure geometry and run-mask matcher for quarter-rest template evidence.
 * <p>
 * This class deliberately has no Audiveris dependencies, so the exact gate can be exercised by
 * standalone controls as well as by {@link SymbolsBuilder}.
 */
public final class QuarterRestTemplateMatcher
{
    private QuarterRestTemplateMatcher ()
    {
    }

    /** A glyph mask in local bounding-box coordinates. */
    public static final class Mask
    {
        public final int width;
        public final int height;
        public final boolean[] pixels;

        public Mask (int width,
                     int height,
                     boolean[] pixels)
        {
            if ((width < 1) || (height < 1) || (pixels.length != width * height)) {
                throw new IllegalArgumentException("Invalid mask dimensions");
            }

            this.width = width;
            this.height = height;
            this.pixels = pixels.clone();
        }
    }

    /** A candidate or prototype and its staff-normalized metadata. */
    public static final class Sample
    {
        public final Object identity;
        public final int interline;
        public final double staffPosition;
        public final double grade;
        public final Mask mask;

        public Sample (Object identity,
                       int interline,
                       double staffPosition,
                       double grade,
                       Mask mask)
        {
            this.identity = identity;
            this.interline = interline;
            this.staffPosition = staffPosition;
            this.grade = grade;
            this.mask = mask;
        }
    }

    /** Best accepted match and its promoted grade. */
    public static final class Match
    {
        public final Sample prototype;
        public final Score score;
        public final double grade;

        private Match (Sample prototype,
                       Score score)
        {
            this.prototype = prototype;
            this.score = score;
            this.grade = prototype.grade * score.iou;
        }
    }

    /** Foreground recalls in both directions and foreground IoU. */
    public static final class Score
    {
        public final double targetRecall;
        public final double prototypeRecall;
        public final double iou;

        private Score (double targetRecall,
                       double prototypeRecall,
                       double iou)
        {
            this.targetRecall = targetRecall;
            this.prototypeRecall = prototypeRecall;
            this.iou = iou;
        }
    }

    /**
     * Find the highest-IoU independent prototype satisfying every fixed evidence gate.
     *
     * @param candidate         already classifier-evaluated candidate
     * @param prototypes        frozen same-page prototype snapshot
     * @param symbolMinGrade    existing candidate symbol gate
     * @param validationMinGrade minimum original prototype grade
     * @param maxInterlineRatio maximum relative staff-scale difference
     * @param maxPositionInterlines maximum staff-relative position delta
     * @param maxGeometryInterlines maximum dimension and translation delta in interlines
     * @param minMaskRecall     minimum foreground recall in each direction
     * @param minMaskIoU        minimum foreground intersection-over-union
     * @return best match, or null if no prototype passes
     */
    public static Match findMatch (Sample candidate,
                                   List<Sample> prototypes,
                                   double symbolMinGrade,
                                   double validationMinGrade,
                                   double maxInterlineRatio,
                                   double maxPositionInterlines,
                                   double maxGeometryInterlines,
                                   double minMaskRecall,
                                   double minMaskIoU)
    {
        if ((candidate.grade < symbolMinGrade) || prototypes.isEmpty()) {
            return null;
        }

        final double minInterline = candidate.interline;
        Match best = null;
        double bestIoU = 0;

        for (Sample prototype : prototypes) {
            if ((candidate.identity == prototype.identity)
                        || (prototype.grade < validationMinGrade)) {
                continue;
            }

            final double smallerInterline = Math.min(minInterline, prototype.interline);
            final double largerInterline = Math.max(minInterline, prototype.interline);

            if ((largerInterline - smallerInterline) > (smallerInterline * maxInterlineRatio)) {
                continue;
            }

            if (Math.abs(candidate.staffPosition - prototype.staffPosition)
                        > maxPositionInterlines) {
                continue;
            }

            final double tolerance = smallerInterline * maxGeometryInterlines;

            if ((Math.abs(candidate.mask.width - prototype.mask.width) > tolerance)
                        || (Math.abs(candidate.mask.height - prototype.mask.height) > tolerance)) {
                continue;
            }

            final Score score = compareMasks(
                    candidate.mask,
                    prototype.mask,
                    (int) Math.floor(tolerance));

            if ((score.targetRecall >= minMaskRecall)
                        && (score.prototypeRecall >= minMaskRecall)
                        && (score.iou >= minMaskIoU)
                        && (score.iou > bestIoU)) {
                best = new Match(prototype, score);
                bestIoU = score.iou;
            }
        }

        return best;
    }

    /** Compare foreground masks over all integer translations within the given tolerance. */
    public static Score compareMasks (Mask target,
                                      Mask prototype,
                                      int translationTolerance)
    {
        int targetWeight = 0;
        int prototypeWeight = 0;

        for (boolean pixel : target.pixels) {
            if (pixel) {
                targetWeight++;
            }
        }

        for (boolean pixel : prototype.pixels) {
            if (pixel) {
                prototypeWeight++;
            }
        }

        if ((targetWeight == 0) || (prototypeWeight == 0)) {
            return new Score(0, 0, 0);
        }

        Score best = new Score(0, 0, 0);

        for (int dy = -translationTolerance; dy <= translationTolerance; dy++) {
            for (int dx = -translationTolerance; dx <= translationTolerance; dx++) {
                int intersection = 0;

                for (int y = 0; y < target.height; y++) {
                    for (int x = 0; x < target.width; x++) {
                        if (!target.pixels[(y * target.width) + x]) {
                            continue;
                        }

                        final int px = x - dx;
                        final int py = y - dy;

                        if ((px >= 0) && (px < prototype.width)
                                    && (py >= 0) && (py < prototype.height)
                                    && prototype.pixels[(py * prototype.width) + px]) {
                            intersection++;
                        }
                    }
                }

                final int union = targetWeight + prototypeWeight - intersection;
                final Score score = new Score(
                        intersection / (double) targetWeight,
                        intersection / (double) prototypeWeight,
                        intersection / (double) union);

                if (score.iou > best.iou) {
                    best = score;
                }
            }
        }

        return best;
    }
}
