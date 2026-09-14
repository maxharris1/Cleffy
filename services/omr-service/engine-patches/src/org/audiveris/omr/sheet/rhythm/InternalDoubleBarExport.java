package org.audiveris.omr.sheet.rhythm;

import java.util.ArrayList;
import java.util.List;

/**
 * Timed MusicXML export of a recovered internal double-thin separator.
 * Does not infer the offset from half the meter. Never emits a guessed
 * position when timing is missing or outside the surviving measure.
 */
public final class InternalDoubleBarExport
{
    public static final String NOTE = "NOTE";

    public static final String BACKUP = "BACKUP";

    public static final String FORWARD = "FORWARD";

    public static final String BARLINE = "BARLINE";

    public static final String LEFT = "LEFT";

    public static final String MIDDLE = "MIDDLE";

    public static final String RIGHT = "RIGHT";

    public static final String LIGHT_LIGHT = "light-light";

    private InternalDoubleBarExport ()
    {
    }

    public static final class StreamEvent
    {
        public final String kind;

        public final String location;

        public final String style;

        public final String chordId;

        public final InternalDoubleBarVoices.Time cursor;

        public final InternalDoubleBarVoices.Time duration;

        public StreamEvent (String kind,
                             String location,
                             String style,
                             String chordId,
                             InternalDoubleBarVoices.Time cursor,
                             InternalDoubleBarVoices.Time duration)
        {
            this.kind = kind;
            this.location = location;
            this.style = style;
            this.chordId = chordId;
            this.cursor = cursor;
            this.duration = duration;
        }
    }

    /**
     * True only for a source-verified internal double-thin with a captured
     * fragment time strictly inside the surviving measure.
     */
    public static boolean isTimedInternalSeparator (String style,
                                                          boolean leftRepeat,
                                                          boolean rightRepeat,
                                                          boolean ending,
                                                          InternalDoubleBarVoices.Time time,
                                                          InternalDoubleBarVoices.Time measureDuration)
    {
        if (!InternalDoubleBarEvidence.isInternalDoubleThin(style, leftRepeat, rightRepeat, ending)) {
            return false;
        }
        return isValidSeparatorTime(time, measureDuration);
    }

    public static boolean isValidSeparatorTime (InternalDoubleBarVoices.Time time,
                                                    InternalDoubleBarVoices.Time measureDuration)
    {
        if ((time == null) || !time.isPositive()) {
            return false;
        }
        if (measureDuration == null) {
            return false;
        }
        return time.compareTo(measureDuration) < 0;
    }

    public static String persistTime (InternalDoubleBarVoices.Time time)
    {
        return (time == null) ? null : time.toString();
    }

    public static InternalDoubleBarVoices.Time parseTime (String text)
    {
        if ((text == null) || text.isBlank()) {
            return null;
        }
        final int slash = text.indexOf('/');
        try {
            if (slash <= 0) {
                return new InternalDoubleBarVoices.Time(Integer.parseInt(text.trim()), 1);
            }
            return new InternalDoubleBarVoices.Time(
                    Integer.parseInt(text.substring(0, slash).trim()),
                    Integer.parseInt(text.substring(slash + 1).trim()));
        } catch (RuntimeException ex) {
            return null;
        }
    }

    public static boolean insertBeforeOnset (InternalDoubleBarVoices.Time nextOnset,
                                                   InternalDoubleBarVoices.Time separator,
                                                   boolean alreadyInserted)
    {
        if (alreadyInserted || (separator == null) || (nextOnset == null)) {
            return false;
        }
        return nextOnset.compareTo(separator) >= 0;
    }

    public static boolean insertAfterOnset (InternalDoubleBarVoices.Time cursorAfter,
                                                InternalDoubleBarVoices.Time separator,
                                                boolean alreadyInserted)
    {
        if (alreadyInserted || (separator == null) || (cursorAfter == null)) {
            return false;
        }
        return cursorAfter.compareTo(separator) >= 0;
    }

    public static InternalDoubleBarVoices.Time minus (InternalDoubleBarVoices.Time left,
                                                             InternalDoubleBarVoices.Time right)
    {
        return new InternalDoubleBarVoices.Time(
                (left.num * right.den) - (right.num * left.den),
                left.den * right.den);
    }

    public static int toDivisions (InternalDoubleBarVoices.Time time,
                                      int divisionsPerQuarter)
    {
        if ((time == null) || (divisionsPerQuarter <= 0) || (time.den == 0)) {
            return -1;
        }
        return (time.num * 4 * divisionsPerQuarter) / time.den;
    }

    /**
     * Walk merged voices the way PartwiseBuilder does: backups, forwards,
     * one middle light-light, no per-voice copy, no left duplicate.
     */
    public static List<StreamEvent> exportMeasure (InternalDoubleBarVoices.MergeTables tables,
                                                       InternalDoubleBarVoices.Time separator,
                                                       InternalDoubleBarVoices.Time measureDuration,
                                                       boolean realLeftBoundary)
    {
        final List<StreamEvent> events = new ArrayList<>();
        if ((tables == null) || !tables.ok) {
            return events;
        }
        if (realLeftBoundary) {
            events.add(new StreamEvent(BARLINE, LEFT, "regular", null,
                    new InternalDoubleBarVoices.Time(0, 1), null));
        }
        final InternalDoubleBarVoices.Time stored = parseTime(persistTime(separator));
        final boolean timed = isTimedInternalSeparator(
                "LIGHT_LIGHT", false, false, false, stored, measureDuration);
        InternalDoubleBarVoices.Time cursor = new InternalDoubleBarVoices.Time(0, 1);
        boolean inserted = false;
        boolean firstVoice = true;
        for (String voiceKey : tables.voiceKeys) {
            if (!firstVoice && (cursor.num != 0)) {
                events.add(new StreamEvent(BACKUP, null, null, null, cursor, cursor));
                cursor = new InternalDoubleBarVoices.Time(0, 1);
            }
            firstVoice = false;
            for (InternalDoubleBarVoices.SlotPut put : InternalDoubleBarVoices.putsForVoice(
                    tables, voiceKey)) {
                if (!InternalDoubleBarVoices.BEGIN.equals(put.status)) {
                    continue;
                }
                final InternalDoubleBarVoices.Time onset = slotTime(tables, put.slotId);
                if (timed && insertBeforeOnset(onset, stored, inserted)) {
                    if (cursor.compareTo(stored) < 0) {
                        events.add(new StreamEvent(FORWARD, null, null, null, cursor,
                                minus(stored, cursor)));
                        cursor = stored;
                    }
                    events.add(new StreamEvent(BARLINE, MIDDLE, LIGHT_LIGHT, null, stored, null));
                    inserted = true;
                }
                if (cursor.compareTo(onset) < 0) {
                    events.add(new StreamEvent(FORWARD, null, null, null, cursor,
                            minus(onset, cursor)));
                    cursor = onset;
                }
                events.add(new StreamEvent(NOTE, null, null, put.chordId, onset, put.duration));
                cursor = onset.plus(put.duration);
                if (timed && insertAfterOnset(cursor, stored, inserted)) {
                    events.add(new StreamEvent(BARLINE, MIDDLE, LIGHT_LIGHT, null, stored, null));
                    inserted = true;
                }
            }
        }
        events.add(new StreamEvent(BARLINE, RIGHT, "light-heavy", null, measureDuration, null));
        return events;
    }

    public static int countLocation (List<StreamEvent> events,
                                         String location,
                                         String style)
    {
        int count = 0;
        for (StreamEvent event : events) {
            if (BARLINE.equals(event.kind) && location.equals(event.location)
                    && ((style == null) || style.equals(event.style))) {
                count++;
            }
        }
        return count;
    }

    public static int countNotes (List<StreamEvent> events)
    {
        int count = 0;
        for (StreamEvent event : events) {
            if (NOTE.equals(event.kind)) {
                count++;
            }
        }
        return count;
    }

    public static StreamEvent firstMiddle (List<StreamEvent> events)
    {
        for (StreamEvent event : events) {
            if (MIDDLE.equals(event.location)) {
                return event;
            }
        }
        return null;
    }

    public static StreamEvent note (List<StreamEvent> events,
                                       String chordId)
    {
        for (StreamEvent event : events) {
            if (NOTE.equals(event.kind) && chordId.equals(event.chordId)) {
                return event;
            }
        }
        return null;
    }

    private static InternalDoubleBarVoices.Time slotTime (InternalDoubleBarVoices.MergeTables tables,
                                                               int slotId)
    {
        for (InternalDoubleBarVoices.SlotPlan slot : tables.slots) {
            if (slot.newId == slotId) {
                return slot.time;
            }
        }
        return null;
    }
}
