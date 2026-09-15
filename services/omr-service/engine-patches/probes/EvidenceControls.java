package org.audiveris.omr.sheet.ledger;

import ij.process.ByteProcessor;

import javax.imageio.ImageIO;
import java.awt.Rectangle;
import java.io.File;

public class EvidenceControls
{
    public static void main (String[] args)
        throws Exception
    {
        final ByteProcessor binary = new ByteProcessor(ImageIO.read(new File(args[0])));
        final double il = 21;
        final Object[][] controls = {
                {"printed-ledger-head", new Rectangle(462, 1936, 41, 4), 20.01},
                {"short-horizontal-dash", new Rectangle(421, 1932, 22, 3), 21.0},
                {"clef-loop-ink", new Rectangle(130, 1938, 41, 4), 21.0},
                {"title-text-stroke", new Rectangle(1042, 186, 41, 4), 21.0},
        };

        for (Object[] control : controls) {
            final boolean accepted = LedgersPostAnalysis.hasAttachedHeadStemInk(
                    binary, (Rectangle) control[1], il, (double) control[2]);
            boolean expected = control[0].equals("printed-ledger-head");
            if (accepted != expected) throw new AssertionError(control[0]);
            System.out.println(control[0] + " accepted=" + accepted + " box=" + control[1]);
        }
        final ByteProcessor noStem = (ByteProcessor) binary.duplicate();
        for (int y = 1918; y <= 1936; y++) {
            for (int x = 489; x <= 497; x++) noStem.set(x, y, 255);
        }
        final boolean detached = LedgersPostAnalysis.hasAttachedHeadStemInk(noStem,
                new Rectangle(462, 1936, 41, 4), il, 20.01);
        if (detached) throw new AssertionError("stem-erased control accepted");
        System.out.println("stem-erased accepted=" + detached);
    }
}
