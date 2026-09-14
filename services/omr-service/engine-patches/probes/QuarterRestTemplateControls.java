package org.audiveris.omr.sheet.symbol;

import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.nio.file.Files;
import java.nio.file.Path;
import java.io.IOException;

/** Standalone controls for the dependency-free quarter-rest evidence matcher. */
public final class QuarterRestTemplateControls
{
    private static final double SYMBOL_MIN_GRADE = 0.15;
    private static final double VALIDATION_MIN_GRADE = 0.80;
    private static final double MAX_INTERLINE_RATIO = 0.10;
    private static final double MAX_POSITION_INTERLINES = 0.75;
    private static final double MAX_GEOMETRY_INTERLINES = 0.15;
    private static final double MIN_MASK_RECALL = 0.90;
    private static final double MIN_MASK_IOU = 0.85;

    private QuarterRestTemplateControls ()
    {
    }

    public static void main (String[] args)
    {
        if (args.length > 0) {
            runFixtures(Path.of(args[0]));
            return;
        }

        runSyntheticControls();
    }

    private static void runSyntheticControls ()
    {
        final QuarterRestTemplateMatcher.Mask full = mask(4, 8, true);
        final QuarterRestTemplateMatcher.Sample prototype = sample(
                new Object(), 20, 0, VALIDATION_MIN_GRADE, full);

        // A prototype cannot promote itself, even when its mask is a perfect match.
        final QuarterRestTemplateMatcher.Sample same = sample(
                prototype.identity, 20, 0, SYMBOL_MIN_GRADE, full);
        require(find(same, Collections.singletonList(prototype)) == null,
                "same-glyph identity guard");
        System.out.println("same-glyph mask rejected");

        // A geometrically identical glyph at one interline of staff-relative displacement fails.
        final QuarterRestTemplateMatcher.Sample wrongPosition = sample(
                new Object(), 20, 1.0, SYMBOL_MIN_GRADE, full);
        require(find(wrongPosition, Collections.singletonList(prototype)) == null,
                "staff-relative placement guard");
        System.out.println("wrong staff-relative placement rejected");

        // A classifier result below the existing symbol gate is never synthesized or promoted.
        final QuarterRestTemplateMatcher.Sample belowGate = sample(
                new Object(), 20, 0, 0.103955679, full);
        require(find(belowGate, Collections.singletonList(prototype)) == null,
                "below symbol gate");
        System.out.println("below-gate candidate rejected");

        // A near mask passes only when both recalls and IoU clear their independent floors.
        final boolean[] nearPixels = full.pixels.clone();
        nearPixels[0] = false;
        final QuarterRestTemplateMatcher.Sample near = sample(
                new Object(), 20, 0, SYMBOL_MIN_GRADE,
                new QuarterRestTemplateMatcher.Mask(4, 8, nearPixels));
        final QuarterRestTemplateMatcher.Match accepted = find(
                near, Collections.singletonList(prototype));
        require(accepted != null, "positive mask control");
        require(accepted.score.targetRecall >= MIN_MASK_RECALL,
                "target recall floor");
        require(accepted.score.prototypeRecall >= MIN_MASK_RECALL,
                "prototype recall floor");
        require(accepted.score.iou >= MIN_MASK_IOU, "IoU floor");
        System.out.println(String.format(
                "near mask accepted recall=%.6f/%.6f IoU=%.6f grade=%.6f",
                accepted.score.targetRecall,
                accepted.score.prototypeRecall,
                accepted.score.iou,
                accepted.grade));

        final QuarterRestTemplateMatcher.Mask poorMask = mask(4, 8, false);
        final QuarterRestTemplateMatcher.Sample poor = sample(
                new Object(), 20, 0, SYMBOL_MIN_GRADE, poorMask);
        require(find(poor, List.of(prototype)) == null, "poor mask control");
        System.out.println("unrelated mask rejected");

        final QuarterRestTemplateMatcher.Sample weakPrototype = sample(
                new Object(), 20, 0, 0.79, full);
        require(find(near, Collections.singletonList(weakPrototype)) == null,
                "weak prototype gate");
        System.out.println("weak prototype rejected");

        final QuarterRestTemplateMatcher.Sample wrongSize = sample(
                new Object(), 20, 0, SYMBOL_MIN_GRADE, mask(8, 8, true));
        require(find(wrongSize, Collections.singletonList(prototype)) == null,
                "scaled size gate");
        System.out.println("scaled size outside tolerance rejected");

        final QuarterRestTemplateMatcher.Sample shifted = sample(
                new Object(), 20, 0, SYMBOL_MIN_GRADE,
                new QuarterRestTemplateMatcher.Mask(10, 8, shiftedPixels(6)));
        final QuarterRestTemplateMatcher.Sample translationPrototype = sample(
                new Object(), 20, 0, VALIDATION_MIN_GRADE,
                new QuarterRestTemplateMatcher.Mask(10, 8, shiftedPixels(0)));
        final QuarterRestTemplateMatcher.Score shiftedScore =
                QuarterRestTemplateMatcher.compareMasks(shifted.mask, translationPrototype.mask, 3);
        require(shiftedScore.iou < MIN_MASK_IOU, "translation gate");
        require(find(shifted, Collections.singletonList(translationPrototype)) == null,
                "translation tolerance gate");
        System.out.println(String.format("translation outside tolerance rejected IoU=%.6f",
                shiftedScore.iou));

        final QuarterRestTemplateMatcher.Mask nine = mask(3, 3, true);
        final QuarterRestTemplateMatcher.Mask eight = new QuarterRestTemplateMatcher.Mask(
                3, 3, new boolean[] { true, true, true, true, true, true, true, true, false });
        final QuarterRestTemplateMatcher.Sample asymmetric = sample(
                new Object(), 20, 0, SYMBOL_MIN_GRADE, eight);
        final QuarterRestTemplateMatcher.Sample ninePrototype = sample(
                new Object(), 20, 0, VALIDATION_MIN_GRADE, nine);
        final QuarterRestTemplateMatcher.Score asymmetricScore =
                QuarterRestTemplateMatcher.compareMasks(eight, nine, 0);
        require(asymmetricScore.iou >= MIN_MASK_IOU, "asymmetric IoU control");
        require(asymmetricScore.prototypeRecall < MIN_MASK_RECALL,
                "asymmetric recall control");
        require(find(asymmetric, Collections.singletonList(ninePrototype)) == null,
                "asymmetric recall gate");
        System.out.println(String.format(
                "asymmetric recall rejected recall=%.6f IoU=%.6f",
                asymmetricScore.prototypeRecall,
                asymmetricScore.iou));
    }

    /** Run the same gates against the saved vertical run-table fixtures. */
    private static void runFixtures (Path path)
    {
        final Map<String, Fixture> fixtures = readFixtures(path);
        final Fixture airTarget = fixture(fixtures, "air_target");
        final Fixture airPrototype = fixture(fixtures, "air_proto");
        final Fixture inventionTarget = fixture(fixtures, "inv_target_upper");
        final Fixture inventionPrototype = fixture(fixtures, "inv_proto_upper");

        final MatchResult air = matchFixture(airTarget, 0.563631396, airPrototype);
        require(air.match != null, "Air positive fixture");
        require(air.match.score.targetRecall >= MIN_MASK_RECALL, "Air target recall");
        require(air.match.score.prototypeRecall >= MIN_MASK_RECALL, "Air prototype recall");
        require(air.match.score.iou >= MIN_MASK_IOU, "Air IoU");
        System.out.println(String.format(
                "air target=%s prototype=%s recall=%.6f/%.6f IoU=%.6f",
                airTarget.id,
                airPrototype.id,
                air.match.score.targetRecall,
                air.match.score.prototypeRecall,
                air.match.score.iou));

        final MatchResult invention = matchFixture(
                inventionTarget, 0.288493371, inventionPrototype);
        require(invention.match != null, "Invention positive fixture");
        System.out.println(String.format(
                "invention target=%s prototype=%s recall=%.6f/%.6f IoU=%.6f",
                inventionTarget.id,
                inventionPrototype.id,
                invention.match.score.targetRecall,
                invention.match.score.prototypeRecall,
                invention.match.score.iou));

        final Fixture belowGate = fixture(fixtures, "inv_target_lower");
        require(matchFixture(belowGate, 0.103955679, inventionPrototype).match == null,
                "Invention below-gate fixture");
        System.out.println("invention lower below-gate candidate rejected");

        final Fixture wrongPosition = new Fixture(
                airTarget.id + "-wrong-position",
                airTarget.interline,
                airTarget.position + 1.0,
                airTarget.mask);
        require(matchFixture(wrongPosition, 0.563631396, airPrototype).match == null,
                "wrong staff-relative fixture");
        System.out.println("wrong staff-relative fixture rejected");

        for (String controlId : List.of("flag_1_down", "digit_3", "digit_4")) {
            final Fixture control = fixture(fixtures, controlId);
            require(matchFixture(control, 0.30, airPrototype).match == null,
                    controlId + " unrelated fixture");
            final QuarterRestTemplateMatcher.Score score =
                    QuarterRestTemplateMatcher.compareMasks(control.mask, airPrototype.mask, 3);
            require(score.iou < 0.5, controlId + " mask similarity control");
            System.out.println(String.format(
                    "%s unrelated fixture rejected IoU=%.6f", controlId, score.iou));
        }
    }

    private static MatchResult matchFixture (Fixture candidate,
                                             double candidateGrade,
                                             Fixture prototype)
    {
        final QuarterRestTemplateMatcher.Sample target = new QuarterRestTemplateMatcher.Sample(
                candidate.id,
                candidate.interline,
                candidate.position,
                candidateGrade,
                candidate.mask);
        final QuarterRestTemplateMatcher.Sample sample = new QuarterRestTemplateMatcher.Sample(
                prototype.id,
                prototype.interline,
                prototype.position,
                // Deliberately strong control grade; this does not stand in for a saved score.
                0.96,
                prototype.mask);
        return new MatchResult(find(target, Collections.singletonList(sample)));
    }

    private static Map<String, Fixture> readFixtures (Path path)
    {
        final Map<String, Fixture> fixtures = new HashMap<>();

        try {
            for (String line : Files.readAllLines(path)) {
                if (line.isEmpty() || line.startsWith("#") || line.startsWith("record_id\t")) {
                    continue;
                }

                final String[] fields = line.split("\\t", -1);
                if (fields.length < 18) {
                    throw new IllegalArgumentException("Malformed fixture row");
                }

                final String[] rows = fields[17].split("\\|", -1);
                final int width = Integer.parseInt(fields[10]);
                final int height = Integer.parseInt(fields[11]);
                if ((rows.length != height)) {
                    throw new IllegalArgumentException("Fixture height mismatch: " + fields[0]);
                }

                final boolean[] pixels = new boolean[width * height];
                for (int y = 0; y < height; y++) {
                    if (rows[y].length() != width) {
                        throw new IllegalArgumentException("Fixture width mismatch: " + fields[0]);
                    }
                    for (int x = 0; x < width; x++) {
                        pixels[(y * width) + x] = rows[y].charAt(x) == '#';
                    }
                }

                fixtures.put(fields[0], new Fixture(
                        fields[0],
                        (int) Math.round(Double.parseDouble(fields[14])),
                        Double.parseDouble(fields[15]),
                        new QuarterRestTemplateMatcher.Mask(width, height, pixels)));
            }
        } catch (IOException ex) {
            throw new IllegalArgumentException("Cannot read fixtures: " + path, ex);
        }

        return fixtures;
    }

    private static Fixture fixture (Map<String, Fixture> fixtures,
                                    String id)
    {
        final Fixture fixture = fixtures.get(id);
        if (fixture == null) {
            throw new IllegalArgumentException("Missing fixture: " + id);
        }
        return fixture;
    }

    private static final class Fixture
    {
        final String id;
        final int interline;
        final double position;
        final QuarterRestTemplateMatcher.Mask mask;

        Fixture (String id,
                 int interline,
                 double position,
                 QuarterRestTemplateMatcher.Mask mask)
        {
            this.id = id;
            this.interline = interline;
            this.position = position;
            this.mask = mask;
        }
    }

    private static final class MatchResult
    {
        final QuarterRestTemplateMatcher.Match match;

        MatchResult (QuarterRestTemplateMatcher.Match match)
        {
            this.match = match;
        }
    }

    private static QuarterRestTemplateMatcher.Match find (
            QuarterRestTemplateMatcher.Sample candidate,
            List<QuarterRestTemplateMatcher.Sample> prototypes)
    {
        return QuarterRestTemplateMatcher.findMatch(
                candidate,
                prototypes,
                SYMBOL_MIN_GRADE,
                VALIDATION_MIN_GRADE,
                MAX_INTERLINE_RATIO,
                MAX_POSITION_INTERLINES,
                MAX_GEOMETRY_INTERLINES,
                MIN_MASK_RECALL,
                MIN_MASK_IOU);
    }

    private static QuarterRestTemplateMatcher.Sample sample (Object identity,
                                                              int interline,
                                                              double position,
                                                              double grade,
                                                              QuarterRestTemplateMatcher.Mask mask)
    {
        return new QuarterRestTemplateMatcher.Sample(identity, interline, position, grade, mask);
    }

    private static QuarterRestTemplateMatcher.Mask mask (int width,
                                                         int height,
                                                         boolean foreground)
    {
        final boolean[] pixels = new boolean[width * height];

        if (foreground) {
            java.util.Arrays.fill(pixels, true);
        }

        return new QuarterRestTemplateMatcher.Mask(width, height, pixels);
    }

    private static boolean[] shiftedPixels (int startX)
    {
        final boolean[] pixels = new boolean[10 * 8];
        for (int y = 0; y < 8; y++) {
            pixels[(y * 10) + startX] = true;
            pixels[(y * 10) + startX + 1] = true;
        }
        return pixels;
    }

    private static void require (boolean condition,
                                 String name)
    {
        if (!condition) {
            throw new AssertionError(name);
        }
    }
}
