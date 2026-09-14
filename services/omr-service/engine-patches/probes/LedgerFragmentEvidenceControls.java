package org.audiveris.omr.sheet.symbol;

import javax.imageio.ImageIO;
import java.awt.Rectangle;
import java.awt.image.BufferedImage;
import java.io.File;

/** Standalone controls for the source-ink ledger-fragment predicate. */
public final class LedgerFragmentEvidenceControls
{
    private LedgerFragmentEvidenceControls ()
    {
    }

    public static void main (String[] args)
        throws Exception
    {
        final String fixtureRoot = "engine-patches/probes/fixtures/";
        final File targetFile = (args.length > 0)
                ? new File(args[0])
                : new File(fixtureRoot + "anh116-target.png");
        final BufferedImage target = ImageIO.read(targetFile);
        final boolean targetIsCrop = target.getWidth() == 60 && target.getHeight() == 30;
        final Rectangle targetCandidate = targetIsCrop
                ? new Rectangle(7, 5, 6, 4)
                : new Rectangle(1315, 1589, 6, 4);
        final Rectangle targetHead = targetIsCrop
                ? new Rectangle(14, 2, 25, 20)
                : new Rectangle(1322, 1586, 25, 20);
        final double targetLedgerY = targetIsCrop ? 6.5 : 1590.5;
        require(LedgerFragmentEvidence.isFragment(
                        targetCandidate,
                        targetHead,
                        targetLedgerY,
                        21,
                        pixelSource(target)),
                "saved target source mask");
        require(countInk(target, targetCandidate) == 20,
                "saved target source mask ink count");
        System.out.println("saved target source mask accepted=true");

        checkRealDot(fixtureRoot + "anh114-dot.png", new Rectangle(54, 15, 10, 9), "Anh114", 64);
        checkRealDot(fixtureRoot + "anh115-dot.png", new Rectangle(57, 19, 9, 10), "Anh115", 64);
        checkRealDot(fixtureRoot + "chopin-dot.png", new Rectangle(56, 20, 9, 9), "Chopin", 58);
        checkRealDot(fixtureRoot + "arabesque-dot.png", new Rectangle(49, 16, 7, 8), "Arabesque", 39);

        final Mask translated = new Mask(80, 80);
        translated.horizontalRun(10, 20, 31);
        final Rectangle candidate = new Rectangle(10, 20, 6, 4);
        final Rectangle head = new Rectangle(17, 18, 10, 8);
        final LedgerFragmentEvidence.PixelSource synthetic = translated::isInk;

        require(LedgerFragmentEvidence.isFragment(candidate, head, 20.5, 21, synthetic),
                "synthetic target");

        final Mask moved = translated.shifted(13, 9);
        require(LedgerFragmentEvidence.isFragment(
                        new Rectangle(23, 29, 6, 4),
                        new Rectangle(30, 27, 10, 8),
                        29.5,
                        21,
                        moved::isInk),
                "translated target");

        final LedgerFragmentEvidence.PixelSource actualTarget = pixelSource(target);
        final int targetDx = 17;
        final int targetDy = 11;
        require(LedgerFragmentEvidence.isFragment(
                        new Rectangle(targetCandidate.x + targetDx,
                                targetCandidate.y + targetDy,
                                targetCandidate.width,
                                targetCandidate.height),
                        new Rectangle(targetHead.x + targetDx,
                                targetHead.y + targetDy,
                                targetHead.width,
                                targetHead.height),
                        targetLedgerY + targetDy,
                        21,
                        (x, y) -> actualTarget.isInk(x - targetDx, y - targetDy)),
                "actual translated target");
        require(!LedgerFragmentEvidence.isFragment(
                        targetCandidate,
                        targetHead,
                        targetLedgerY,
                        21,
                        (x, y) -> ((x != 13) || (y < 5) || (y >= 9))
                                && actualTarget.isInk(x, y)),
                "actual target connector gap");

        final Mask gap = translated.copy();
        gap.clear(17, 20);
        require(!LedgerFragmentEvidence.isFragment(candidate, head, 20.5, 21, gap::isInk),
                "one-column gap");

        final Mask detached = new Mask(80, 80);
        detached.horizontalRun(10, 20, 15);
        require(!LedgerFragmentEvidence.isFragment(candidate, head, 20.5, 21, detached::isInk),
                "detached flat dot");

        require(!LedgerFragmentEvidence.isFragment(candidate, head, 28.5, 21, synthetic),
                "wrong ledger ordinate");

        final Mask noRightProtrusion = new Mask(80, 80);
        noRightProtrusion.horizontalRun(10, 20, 26);
        require(!LedgerFragmentEvidence.isFragment(
                        candidate, head, 20.5, 21, noRightProtrusion::isInk),
                "missing opposite protrusion");

        final Mask thickOppositeProtrusion = translated.copy();
        for (int y = 13; y <= 27; y++) {
            thickOppositeProtrusion.set(31, y);
        }
        require(!LedgerFragmentEvidence.isFragment(
                        candidate, head, 20.5, 21, thickOppositeProtrusion::isInk),
                "thick opposite protrusion");

        final Mask round = new Mask(80, 80);
        round.fill(new Rectangle(10, 18, 9, 9));
        require(!LedgerFragmentEvidence.isFragment(
                        new Rectangle(10, 18, 9, 9), head, 20.5, 21, round::isInk),
                "round dot");

        System.out.println("ledger-fragment evidence controls passed");
    }

    private static void checkRealDot (String path,
                                      Rectangle candidate,
                                      String label,
                                      int expectedInk)
        throws Exception
    {
        final BufferedImage image = ImageIO.read(new File(path));
        require(image != null, label + " fixture image");
        require(countInk(image, candidate) == expectedInk, label + " fixture ink count");
        // Deliberately adverse hypothetical placement; the crop contains only original ink.
        // The actual attached head is separately recorded in ledger-dot-provenance.json.
        final Rectangle neighboringHead = new Rectangle(
                candidate.x + candidate.width + 1,
                candidate.y - 2,
                10,
                20);
        final boolean accepted = LedgerFragmentEvidence.isFragment(
                candidate,
                neighboringHead,
                candidate.getCenterY(),
                21,
                pixelSource(image));
        require(!accepted, label + " real detached dot");
        System.out.println(label + " real detached dot accepted=false");
    }

    private static int countInk (BufferedImage image,
                                 Rectangle box)
    {
        int count = 0;
        for (int y = box.y; y < (box.y + box.height); y++) {
            for (int x = box.x; x < (box.x + box.width); x++) {
                if ((image.getRGB(x, y) & 0xff) < 128) {
                    count++;
                }
            }
        }
        return count;
    }

    private static LedgerFragmentEvidence.PixelSource pixelSource (BufferedImage image)
    {
        return (x, y) -> (x >= 0) && (y >= 0)
                && (x < image.getWidth()) && (y < image.getHeight())
                && ((image.getRGB(x, y) & 0xff) < 128);
    }

    private static void require (boolean value,
                                 String label)
    {
        if (!value) {
            throw new AssertionError(label);
        }
    }

    private static final class Mask
    {
        private final int width;
        private final int height;
        private final boolean[][] ink;

        Mask (int width,
              int height)
        {
            this.width = width;
            this.height = height;
            ink = new boolean[height][width];
        }

        void horizontalRun (int xStart,
                            int y,
                            int xStop)
        {
            for (int x = xStart; x <= xStop; x++) {
                ink[y][x] = true;
            }
        }

        void clear (int x,
                    int y)
        {
            ink[y][x] = false;
        }

        void set (int x,
                  int y)
        {
            ink[y][x] = true;
        }

        void fill (Rectangle box)
        {
            for (int y = box.y; y < (box.y + box.height); y++) {
                for (int x = box.x; x < (box.x + box.width); x++) {
                    ink[y][x] = true;
                }
            }
        }

        Mask copy ()
        {
            final Mask copy = new Mask(width, height);
            for (int y = 0; y < height; y++) {
                System.arraycopy(ink[y], 0, copy.ink[y], 0, width);
            }
            return copy;
        }

        Mask shifted (int dx,
                     int dy)
        {
            final Mask shifted = new Mask(width, height);
            for (int y = 0; y < height; y++) {
                for (int x = 0; x < width; x++) {
                    if (ink[y][x] && (x + dx >= 0) && (x + dx < width)
                            && (y + dy >= 0) && (y + dy < height)) {
                        shifted.ink[y + dy][x + dx] = true;
                    }
                }
            }
            return shifted;
        }

        boolean isInk (int x,
                       int y)
        {
            return (x >= 0) && (x < width) && (y >= 0) && (y < height) && ink[y][x];
        }
    }
}
