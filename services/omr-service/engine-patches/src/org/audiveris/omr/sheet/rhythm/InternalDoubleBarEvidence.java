package org.audiveris.omr.sheet.rhythm;

import java.awt.geom.Rectangle2D;
import java.util.List;

/**
 * Source-only predicates for recovering a noncounting internal double barline.
 * No piece name, hash, coordinate constant, corpus or reference MIDI is used.
 */
public final class InternalDoubleBarEvidence
{
    /** Digits sit just above the top staff, not in the title block. */
    private static final double MAX_ABOVE_INTERLINES = 5.5;

    private static final double MAX_BELOW_TOP_INTERLINES = 0.25;

    private static final double MAX_LEFT_OUT_INTERLINES = 6;

    private static final double MAX_LEFT_IN_INTERLINES = 4;

    private InternalDoubleBarEvidence ()
    {
    }

    /**
     * Printed system-start numbers bind one span only when their difference is
     * exactly one less than the otherwise valid raw stack count.
     */
    public static boolean sourceCountAllowsInternal (int startNumber,
                                                      int nextSystemNumber,
                                                      int rawStackCount)
    {
        if ((startNumber < 1) || (nextSystemNumber <= startNumber) || (rawStackCount < 2)) {
            return false;
        }
        return (nextSystemNumber - startNumber) == (rawStackCount - 1);
    }

    /**
     * Both fragments have positive content shorter than the unchanged meter, and
     * the durations sum to that meter. Duration sum alone is never sufficient.
     */
    public static boolean complementaryDurations (int leftNum,
                                                       int leftDen,
                                                       int rightNum,
                                                       int rightDen,
                                                       int meterNum,
                                                       int meterDen)
    {
        if ((leftDen <= 0) || (rightDen <= 0) || (meterDen <= 0)
                || (leftNum <= 0) || (rightNum <= 0) || (meterNum <= 0)) {
            return false;
        }
        final long leftMeter = (long) leftNum * (long) meterDen;
        final long meterLeft = (long) meterNum * (long) leftDen;
        final long rightMeter = (long) rightNum * (long) meterDen;
        final long meterRight = (long) meterNum * (long) rightDen;
        if ((leftMeter >= meterLeft) || (rightMeter >= meterRight)) {
            return false;
        }
        final long sum = ((long) leftNum * rightDen * meterDen)
                + ((long) rightNum * leftDen * meterDen);
        final long meter = (long) meterNum * leftDen * rightDen;
        return sum == meter;
    }

    /** Double-thin only. Repeats, endings and heavy/final styles are excluded. */
    public static boolean isInternalDoubleThin (String style,
                                                   boolean leftRepeat,
                                                   boolean rightRepeat,
                                                   boolean ending)
    {
        return "LIGHT_LIGHT".equals(style) && !leftRepeat && !rightRepeat && !ending;
    }

    /** Outline-clipped ink for a small printed digit, not the clef-sized thresholds. */
    public static boolean digitInkAgrees (int pathPixels,
                                            int inkInside,
                                            int inkInBounds)
    {
        if ((pathPixels < 12) || (inkInside < 6) || (inkInBounds <= 0)) {
            return false;
        }
        return ((inkInside / (double) pathPixels) >= 0.12)
                && ((inkInside / (double) inkInBounds) >= 0.35);
    }

    /**
     * A system-start number sits above the top staff at that system's left edge.
     * Title digits, fingerings on the staff, and other systems do not bind.
     */
    public static boolean numberBindsSystemLeft (Rectangle2D outline,
                                                    double staffLeft,
                                                    double firstLineY,
                                                    double interline)
    {
        if ((outline == null) || (interline <= 0) || (outline.getWidth() <= 0)
                || (outline.getHeight() <= 0)) {
            return false;
        }
        final double cy = outline.getCenterY();
        final double cx = outline.getCenterX();
        if (cy > (firstLineY + (MAX_BELOW_TOP_INTERLINES * interline))) {
            return false;
        }
        if (cy < (firstLineY - (MAX_ABOVE_INTERLINES * interline))) {
            return false;
        }
        if (outline.getMaxY() > (firstLineY + interline)) {
            return false;
        }
        if (cx < (staffLeft - (MAX_LEFT_OUT_INTERLINES * interline))) {
            return false;
        }
        if (cx > (staffLeft + (MAX_LEFT_IN_INTERLINES * interline))) {
            return false;
        }
        return true;
    }

    /**
     * Return the single matching system index, or {@code null} when none or more
     * than one system matches.
     */
    public static Integer uniqueSystemIndex (Rectangle2D outline,
                                              List<SystemGeom> systems)
    {
        if ((outline == null) || (systems == null) || systems.isEmpty()) {
            return null;
        }
        Integer found = null;
        for (SystemGeom system : systems) {
            if (!numberBindsSystemLeft(outline, system.staffLeft, system.firstLineY, system.interline)) {
                continue;
            }
            if (found != null) {
                return null;
            }
            found = system.index;
        }
        return found;
    }

    /** Adjacent-pair index when exactly one candidate is eligible, else {@code -1}. */
    public static int uniqueEligiblePairIndex (boolean[] eligible)
    {
        if (eligible == null) {
            return -1;
        }
        int found = -1;
        int count = 0;
        for (int i = 0; i < eligible.length; i++) {
            if (eligible[i]) {
                count++;
                found = i;
            }
        }
        return (count == 1) ? found : -1;
    }

    /** Geometry used to bind a printed number to one system. */
    public static final class SystemGeom
    {
        public final int index;

        public final double staffLeft;

        public final double firstLineY;

        public final double interline;

        public SystemGeom (int index,
                            double staffLeft,
                            double firstLineY,
                            double interline)
        {
            this.index = index;
            this.staffLeft = staffLeft;
            this.firstLineY = firstLineY;
            this.interline = interline;
        }
    }
}
