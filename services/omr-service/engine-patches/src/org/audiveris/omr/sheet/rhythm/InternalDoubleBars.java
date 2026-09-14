package org.audiveris.omr.sheet.rhythm;

import org.audiveris.omr.math.Rational;
import org.audiveris.omr.score.Page;
import org.audiveris.omr.sheet.PartBarline;
import org.audiveris.omr.sheet.Picture;
import org.audiveris.omr.sheet.Sheet;
import org.audiveris.omr.sheet.Staff;
import org.audiveris.omr.sheet.SystemInfo;
import org.audiveris.omr.sheet.clef.PdfClefHints;
import org.audiveris.omr.sig.inter.AbstractChordInter;
import org.audiveris.omr.sig.inter.StaffBarlineInter;
import org.audiveris.omr.sheet.rhythm.SlotVoice.ChordStatus;
import org.audiveris.omr.util.HorizontalSide;

import ij.process.ByteProcessor;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.awt.geom.Path2D;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/**
 * Recover a noncounting internal double-thin barline that Audiveris treated as a
 * logical measure boundary. Requires printed system-number anchors, a unique
 * complementary pair, and double-thin ink on every staff. Does not invent rhythm.
 */
public final class InternalDoubleBars
{
    private static final Logger logger = LoggerFactory.getLogger(InternalDoubleBars.class);

    private InternalDoubleBars ()
    {
    }

    /**
     * After initial rhythm, before {@code MeasureFixer} numbering/export.
     * Missing PDF, ambiguous numbers, or a second eligible pair leave the sheet unchanged.
     */
    public static void repair (Sheet sheet)
    {
        if (sheet == null) {
            return;
        }
        final Path input;
        try {
            input = sheet.getStub().getBook().getInputPath();
        } catch (RuntimeException ex) {
            logger.info("Internal double-bar skipped: no input path ({})", ex.toString());
            return;
        }
        if ((input == null) || !Files.isRegularFile(input)
                || !input.getFileName().toString().toLowerCase().endsWith(".pdf")) {
            logger.info("Internal double-bar skipped: unsupported or raster input");
            return;
        }
        if ((sheet.getSkew() != null) && (Math.abs(sheet.getSkew().getSlope()) > 0.02)) {
            logger.info("Internal double-bar skipped: unsupported sheet skew {}",
                    sheet.getSkew().getSlope());
            return;
        }
        if ((sheet.getWidth() <= 0) || (sheet.getHeight() <= 0)) {
            logger.info("Internal double-bar skipped: missing sheet geometry");
            return;
        }

        final ByteProcessor source = sheet.getPicture().getSource(Picture.SourceKey.NO_STAFF);
        if (source == null) {
            logger.info("Internal double-bar skipped: missing source ink");
            return;
        }
        final PdfClefHints.PixelSource pixels = (x, y) -> (x >= 0) && (y >= 0)
                && (x < source.getWidth()) && (y < source.getHeight())
                && (source.get(x, y) < 128);

        for (Page page : sheet.getPages()) {
            repairPage(sheet, page, input, pixels);
        }
    }

    private static void repairPage (Sheet sheet,
                                      Page page,
                                      Path input,
                                      PdfClefHints.PixelSource pixels)
    {
        final List<SystemInfo> systems = page.getSystems();
        if ((systems == null) || (systems.size() < 2)) {
            logger.info("Internal double-bar skipped: need two numbered systems");
            return;
        }

        final List<PdfSystemNumbers.NumberHint> scanned = PdfSystemNumbers.scan(
                input,
                sheet.getStub().getNumber() - 1);
        if (scanned.isEmpty()) {
            logger.info("Internal double-bar skipped: no PDF digit glyphs page={}",
                    sheet.getStub().getNumber());
            return;
        }

        final List<InternalDoubleBarEvidence.SystemGeom> geoms = new ArrayList<>();
        for (int i = 0; i < systems.size(); i++) {
            final SystemInfo system = systems.get(i);
            final Staff top = system.getFirstStaff();
            if ((top == null) || top.isTablature()) {
                logger.info("Internal double-bar skipped: system {} has no top staff", i);
                return;
            }
            final int left = top.getAbscissa(HorizontalSide.LEFT);
            geoms.add(new InternalDoubleBarEvidence.SystemGeom(
                    i,
                    left,
                    top.getFirstLine().yAt(left),
                    top.getSpecificInterline()));
        }

        final Integer[] bound = new Integer[systems.size()];
        final PdfSystemNumbers.NumberHint[] anchors = new PdfSystemNumbers.NumberHint[systems.size()];
        for (PdfSystemNumbers.NumberHint hint : scanned) {
            if (hint.followedByPeriod || (hint.value < 1)) {
                logger.info("Internal double-bar ignored title/zero number value={} period={}",
                        hint.value,
                        hint.followedByPeriod);
                continue;
            }
            final Path2D sheetPath = PdfSystemNumbers.toSheetPath(
                    hint,
                    sheet.getWidth(),
                    sheet.getHeight());
            if (sheetPath == null) {
                logger.info("Internal double-bar skipped number {}: unsupported transform", hint.value);
                continue;
            }
            final PdfClefHints.InkEvidence ink = PdfClefHints.measureInk(sheetPath, pixels);
            if (!InternalDoubleBarEvidence.digitInkAgrees(
                    ink.pathPixels,
                    ink.inkInside,
                    ink.inkInBounds)) {
                logger.info(
                        "Internal double-bar rejected number {}: ink path={} inside={} bounds={}",
                        hint.value,
                        ink.pathPixels,
                        ink.inkInside,
                        ink.inkInBounds);
                continue;
            }
            logger.info(
                    "Internal double-bar number {} geometry=({},{},{},{}) ink path={} inside={}",
                    hint.value,
                    sheetPath.getBounds2D().getX(),
                    sheetPath.getBounds2D().getY(),
                    sheetPath.getBounds2D().getWidth(),
                    sheetPath.getBounds2D().getHeight(),
                    ink.pathPixels,
                    ink.inkInside);
            final Integer systemIndex = InternalDoubleBarEvidence.uniqueSystemIndex(
                    sheetPath.getBounds2D(),
                    geoms);
            if (systemIndex == null) {
                logger.info("Internal double-bar number {} did not uniquely bind a system",
                        hint.value);
                continue;
            }
            if (bound[systemIndex] != null) {
                logger.info("Internal double-bar skipped: system {} has two printed numbers {} and {}",
                        systemIndex,
                        bound[systemIndex],
                        hint.value);
                bound[systemIndex] = null;
                anchors[systemIndex] = null;
                continue;
            }
            bound[systemIndex] = hint.value;
            anchors[systemIndex] = hint;
        }

        for (int i = 0; i < systems.size() - 1; i++) {
            final Integer start = bound[i];
            final Integer next = bound[i + 1];
            if ((start == null) || (next == null)) {
                logger.info("Internal double-bar skipped system {}: missing printed anchors {} / {}",
                        i,
                        start,
                        next);
                continue;
            }
            recoverSpan(systems.get(i), start, next, anchors[i], anchors[i + 1]);
        }
    }

    private static void recoverSpan (SystemInfo system,
                                        int startNumber,
                                        int nextNumber,
                                        PdfSystemNumbers.NumberHint startHint,
                                        PdfSystemNumbers.NumberHint nextHint)
    {
        final List<MeasureStack> stacks = system.getStacks();
        if ((stacks == null) || stacks.isEmpty()) {
            logger.info("Internal double-bar skipped system {}: no stacks", system.getId());
            return;
        }
        logger.info(
                "Internal double-bar anchors system={} start={} next={} rawStacks={} startBox={} nextBox={}",
                system.getId(),
                startNumber,
                nextNumber,
                stacks.size(),
                startHint.pdfPath.getBounds2D(),
                nextHint.pdfPath.getBounds2D());
        if (!InternalDoubleBarEvidence.sourceCountAllowsInternal(
                startNumber,
                nextNumber,
                stacks.size())) {
            logger.info(
                    "Internal double-bar skipped system {}: printed {}..{} does not allow an internal bar among {} stacks",
                    system.getId(),
                    startNumber,
                    nextNumber,
                    stacks.size());
            return;
        }

        final boolean[] eligible = new boolean[Math.max(0, stacks.size() - 1)];
        for (int i = 0; i < stacks.size() - 1; i++) {
            eligible[i] = isEligiblePair(stacks.get(i), stacks.get(i + 1));
            if (eligible[i]) {
                logger.info(
                        "Internal double-bar candidate pair {}+{} durations {}+{} expected={}",
                        i,
                        i + 1,
                        stacks.get(i).getActualDuration(),
                        stacks.get(i + 1).getActualDuration(),
                        stacks.get(i).getExpectedDuration());
            }
        }
        final int pair = InternalDoubleBarEvidence.uniqueEligiblePairIndex(eligible);
        if (pair < 0) {
            logger.info("Internal double-bar skipped system {}: no unique eligible complementary pair",
                    system.getId());
            return;
        }

        final MeasureStack left = stacks.get(pair);
        final MeasureStack right = stacks.get(pair + 1);
        logger.info(
                "Internal double-bar merging system={} pair {}+{} leftDur={} rightDur={} expected={} separator=LIGHT_LIGHT",
                system.getId(),
                pair,
                pair + 1,
                left.getActualDuration(),
                right.getActualDuration(),
                left.getExpectedDuration());
        mergePair(left, right);
    }

    private static boolean isEligiblePair (MeasureStack left,
                                              MeasureStack right)
    {
        if ((left == null) || (right == null) || (right != left.getNextSibling())) {
            return false;
        }
        if (left.isCautionary() || right.isCautionary() || left.isImplicit() || right.isImplicit()
                || left.isMultiRest() || right.isMultiRest()) {
            return false;
        }
        if (left.isRepeat(HorizontalSide.LEFT) || left.isRepeat(HorizontalSide.RIGHT)
                || right.isRepeat(HorizontalSide.LEFT) || right.isRepeat(HorizontalSide.RIGHT)) {
            return false;
        }
        if (right.getTimeSignature() != null) {
            logger.info("Internal double-bar rejected pair: time signature on right fragment");
            return false;
        }
        for (Measure measure : right.getMeasures()) {
            if (measure.hasKeys()) {
                logger.info("Internal double-bar rejected pair: key signature on right fragment");
                return false;
            }
        }
        for (Measure measure : left.getMeasures()) {
            if (measure.getMidPartBarline() != null) {
                logger.info("Internal double-bar skipped: left already has an internal barline");
                return false;
            }
        }
        if (!hasPositiveContent(left) || !hasPositiveContent(right)) {
            return false;
        }
        final Rational expected = left.getExpectedDuration();
        final Rational leftDur = left.getActualDuration();
        final Rational rightDur = right.getActualDuration();
        if ((expected == null) || (leftDur == null) || (rightDur == null)
                || !expected.equals(right.getExpectedDuration())) {
            return false;
        }
        if ((leftDur.compareTo(Rational.ZERO) <= 0) || (rightDur.compareTo(Rational.ZERO) <= 0)
                || (leftDur.compareTo(expected) >= 0) || (rightDur.compareTo(expected) >= 0)
                || !leftDur.plus(rightDur).equals(expected)) {
            return false;
        }
        if (!voicesInternallyConsistent(left) || !voicesInternallyConsistent(right)) {
            logger.info("Internal double-bar rejected pair: inconsistent recognized rhythm");
            return false;
        }
        return everyStaffHasInternalDoubleThin(left);
    }

    private static boolean hasPositiveContent (MeasureStack stack)
    {
        boolean any = false;
        for (Measure measure : stack.getMeasures()) {
            if (measure.getStandardChords().isEmpty()) {
                return false;
            }
            any = true;
        }
        return any;
    }

    private static boolean voicesInternallyConsistent (MeasureStack stack)
    {
        Rational termination = null;
        boolean sawVoice = false;
        for (Measure measure : stack.getMeasures()) {
            for (Voice voice : measure.getVoices()) {
                final Rational voiceTermination = voice.getTermination();
                if (voiceTermination == null) {
                    continue;
                }
                sawVoice = true;
                if (termination == null) {
                    termination = voiceTermination;
                } else if (!voiceTermination.equals(termination)) {
                    return false;
                }
            }
        }
        return sawVoice || (stack.getActualDuration() != null);
    }

    private static boolean everyStaffHasInternalDoubleThin (MeasureStack left)
    {
        int staffBars = 0;
        final int staffCount = left.getSystem().getStaves().size();
        for (Measure measure : left.getMeasures()) {
            final PartBarline bar = measure.getRightPartBarline();
            if (bar == null) {
                logger.info("Internal double-bar rejected: missing right barline");
                return false;
            }
            final List<StaffBarlineInter> members = bar.getStaffBarlines();
            if ((members == null) || members.isEmpty()) {
                logger.info("Internal double-bar rejected: missing staff barlines");
                return false;
            }
            String style = null;
            for (StaffBarlineInter staffBar : members) {
                final String thisStyle = String.valueOf(staffBar.getStyle());
                if (style == null) {
                    style = thisStyle;
                } else if (!style.equals(thisStyle)) {
                    logger.info("Internal double-bar rejected: conflicting staff bar styles");
                    return false;
                }
                final boolean ending = (staffBar.getEnding(HorizontalSide.LEFT) != null)
                        || (staffBar.getEnding(HorizontalSide.RIGHT) != null);
                if (!InternalDoubleBarEvidence.isInternalDoubleThin(
                        thisStyle,
                        staffBar.isLeftRepeat(),
                        staffBar.isRightRepeat(),
                        ending)) {
                    logger.info("Internal double-bar rejected separator style={}", thisStyle);
                    return false;
                }
                staffBars++;
            }
        }
        if (staffBars != staffCount) {
            logger.info("Internal double-bar rejected: staff barlines {} vs staves {}",
                    staffBars,
                    staffCount);
            return false;
        }
        return true;
    }

    private static void mergePair (MeasureStack left,
                                       MeasureStack right)
    {
        final Rational shift = left.getActualDuration();
        if (shift == null) {
            return;
        }
        for (Measure measure : right.getMeasures()) {
            for (AbstractChordInter chord : measure.getStandardChords()) {
                if (chord.getTimeOffset() != null) {
                    chord.setTimeOffset(chord.getTimeOffset().plus(shift));
                }
            }
        }
        for (Slot slot : right.getSlots()) {
            if (slot.getTimeOffset() != null) {
                slot.setTimeOffset(slot.getTimeOffset().plus(shift));
            }
        }

        left.mergeWithRight(right);

        final List<Slot> slots = left.getSlots();
        slots.sort(Comparator
                .comparing((Slot slot) -> slot.getTimeOffset(),
                        Comparator.nullsLast(Comparator.naturalOrder()))
                .thenComparingInt(Slot::getXOffset));
        int id = 1;
        for (Slot slot : slots) {
            slot.setId(id++);
        }

        for (Measure measure : left.getMeasures()) {
            for (AbstractChordInter chord : measure.getStandardChords()) {
                chord.setMeasure(measure);
            }
            for (Voice voice : measure.getVoices()) {
                voice.setMeasure(measure);
                rebuildVoiceSlots(voice, left);
                voice.checkDuration();
            }
            measure.renameVoices();
        }

        left.getSystem().removeStack(right);
        logger.info("Internal double-bar merged to one logical measure mid=LIGHT_LIGHT actual={}",
                left.getActualDuration());
    }

    private static void rebuildVoiceSlots (Voice voice,
                                              MeasureStack stack)
    {
        for (Slot slot : stack.getSlots()) {
            voice.putSlotInfo(slot, null);
        }
        for (AbstractChordInter chord : voice.getChords()) {
            final Slot slot = chord.getSlot();
            if (slot != null) {
                voice.putSlotInfo(slot, new SlotVoice(chord, ChordStatus.BEGIN));
            }
        }
        voice.completeSlotTable();
    }
}
