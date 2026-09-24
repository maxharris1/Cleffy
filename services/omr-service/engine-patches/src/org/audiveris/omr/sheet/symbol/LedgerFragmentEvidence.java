//------------------------------------------------------------------------------------------------//
//                                                                                                //
//                              L e d g e r F r a g m e n t E v i d e n c e                     //
//                                                                                                //
//------------------------------------------------------------------------------------------------//
package org.audiveris.omr.sheet.symbol;

import java.awt.Rectangle;

/** Dependency-free source-ink checks for a dot candidate which may be ledger ink. */
public final class LedgerFragmentEvidence
{
    private LedgerFragmentEvidence ()
    {
    }

    /** A source accessor, returning false outside the image, independent of engine classes. */
    @FunctionalInterface
    public interface PixelSource
    {
        boolean isInk (int x,
                       int y);
    }

    /**
     * Check whether a small candidate is a horizontal ledger fragment entering a neighboring
     * head. The source mask must supply the original binary pixels.
     *
     * @param candidate candidate glyph bounds
     * @param neighboringHead bounds of a distinct recognized head on the right
     * @param ledgerY expected ledger ordinate at the candidate center abscissa
     * @param interline staff interline in pixels
     * @param source source-ink accessor
     * @return true only when geometry and source ink agree
     */
    public static boolean isFragment (Rectangle candidate,
                                      Rectangle neighboringHead,
                                      double ledgerY,
                                      double interline,
                                      PixelSource source)
    {
        if ((candidate == null) || (neighboringHead == null) || (source == null)
                || !Double.isFinite(interline) || !Double.isFinite(ledgerY)
                || (interline <= 0) || (neighboringHead.width <= 0)
                || (neighboringHead.height <= 0)) {
            return false;
        }

        if ((candidate.width < 3) || (candidate.height < 2)
                || (candidate.width > (interline / 2))
                || (candidate.height > (interline / 3))
                || (candidate.width < candidate.height)) {
            return false;
        }

        final double centerY = candidate.getCenterY();
        if (Math.abs(centerY - ledgerY) > Math.max(2, interline * 0.3)) {
            return false;
        }

        final int gap = neighboringHead.x - (candidate.x + candidate.width);
        final int maxGap = Math.max(1, (int) Math.floor(interline / 10));
        if ((gap < 0) || (gap > maxGap)
                || !verticalOverlap(candidate, neighboringHead)
                || (Math.abs(neighboringHead.getCenterY() - centerY) > (interline * 0.5))) {
            return false;
        }

        // Require a complete source run from the left edge of the candidate through the head and
        // beyond its right edge.  The ink must protrude on both sides of the head; a detached dot
        // or a stroke that merely touches the head is insufficient.
        final int runStart = candidate.x;
        final int headRight = neighboringHead.x + neighboringHead.width - 1;
        final int protrusion = Math.max(2, (int) Math.floor(interline / 4));
        final int runStop = headRight + protrusion;
        final int maxThickness = Math.max(2, (int) Math.ceil(interline / 3));
        for (int y = candidate.y; y < (candidate.y + candidate.height); y++) {
            if (hasInkRun(source, runStart, runStop, y)
                    && isThinStroke(source, runStart, y, maxThickness)
                    && isThinStroke(source, runStart + 1, y, maxThickness)
                    && isThinStroke(source, runStop - 1, y, maxThickness)
                    && isThinStroke(source, runStop, y, maxThickness)) {
                return true;
            }
        }

        return false;
    }

    private static boolean hasInkRun (PixelSource source,
                                      int xStart,
                                      int xStop,
                                      int y)
    {
        for (int x = xStart; x <= xStop; x++) {
            if (!source.isInk(x, y)) {
                return false;
            }
        }

        return true;
    }

    /** Require the opposite protrusion to be a thin stroke, rather than another solid symbol. */
    private static boolean isThinStroke (PixelSource source,
                                         int x,
                                         int y,
                                         int maxThickness)
    {
        int thickness = 1;
        for (int dy = 1; dy <= maxThickness && source.isInk(x, y - dy); dy++) {
            if (++thickness > maxThickness) {
                return false;
            }
        }
        for (int dy = 1; dy <= maxThickness && source.isInk(x, y + dy); dy++) {
            if (++thickness > maxThickness) {
                return false;
            }
        }
        return true;
    }

    private static boolean verticalOverlap (Rectangle one,
                                            Rectangle two)
    {
        return (one.y < (two.y + two.height)) && (two.y < (one.y + one.height));
    }
}
