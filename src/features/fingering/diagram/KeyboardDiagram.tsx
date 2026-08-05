import {
    BLACK_KEY_H,
    HAND_COLORS,
    HAND_LABELS,
    layoutKeyboard,
    snapRange,
    WHITE_KEY_H,
    type KeyRect,
} from '@/features/fingering/diagram/keyboardLayout';
import { midiToName, type Finger, type Hand } from '@/features/fingering/model';

export interface PressedKey {
    midi: number;
    finger: Finger | null;
    hand: Hand;
}

export interface KeyboardDiagramProps {
    /** Keys down right now (one merged step, both hands). */
    pressed: readonly PressedKey[];
    /** Fixed display range; derived from `pressed` when omitted. */
    range?: { min: number; max: number };
    /** Present in note-entry mode — taps report the tapped key's midi. */
    onKeyTap?: (midi: number) => void;
    className?: string;
    /** Spell key names by this signature (labels + accessibility). */
    keySignature?: number;
}

/**
 * The shared fingering visual: a top-down piano keyboard with pressed keys
 * tinted per hand and a finger-number badge on each. Pure — every populator
 * (page annotations, manual entry, suggestion engine) renders through here.
 */
export const KeyboardDiagram = ({ pressed, range, onKeyTap, className, keySignature = 0 }: KeyboardDiagramProps) => {
    const derived =
        range ??
        (pressed.length > 0
            ? snapRange(Math.min(...pressed.map((p) => p.midi)), Math.max(...pressed.map((p) => p.midi)))
            : { min: 60, max: 72 });
    const geometry = layoutKeyboard(derived.min, derived.max);
    const pressedBy = new Map(pressed.map((p) => [p.midi, p]));
    const whites = geometry.keys.filter((k) => !k.isBlack);
    const blacks = geometry.keys.filter((k) => k.isBlack);

    return (
        <svg
            viewBox={`0 0 ${geometry.width} ${geometry.height}`}
            className={className}
            role="img"
            aria-label="Piano keyboard fingering diagram"
        >
            {whites.map((key) => (
                <Key
                    key={key.midi}
                    keyRect={key}
                    pressed={pressedBy.get(key.midi)}
                    onKeyTap={onKeyTap}
                    keySignature={keySignature}
                />
            ))}
            {blacks.map((key) => (
                <Key
                    key={key.midi}
                    keyRect={key}
                    pressed={pressedBy.get(key.midi)}
                    onKeyTap={onKeyTap}
                    keySignature={keySignature}
                />
            ))}
        </svg>
    );
};

const Key = ({
    keyRect,
    pressed,
    onKeyTap,
    keySignature,
}: {
    keyRect: KeyRect;
    pressed: PressedKey | undefined;
    onKeyTap?: (midi: number) => void;
    keySignature: number;
}) => {
    const { midi, isBlack, x, w, h } = keyRect;
    const color = pressed ? HAND_COLORS[pressed.hand] : null;
    const name = midiToName(midi, keySignature);
    const badgeY = isBlack ? BLACK_KEY_H - 12 : WHITE_KEY_H - 15;
    const interactive = onKeyTap !== undefined;

    return (
        <g
            {...(interactive
                ? {
                      role: 'button',
                      tabIndex: 0,
                      'aria-label': pressed ? `${name}, ${HAND_LABELS[pressed.hand]}` : name,
                      onClick: () => onKeyTap(midi),
                      onKeyDown: (e: React.KeyboardEvent) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              onKeyTap(midi);
                          }
                      },
                      style: { cursor: 'pointer' },
                  }
                : { 'aria-label': pressed ? `${name}, finger ${pressed.finger ?? 'unmarked'}` : undefined })}
            data-midi={midi}
        >
            <rect
                x={x}
                y={0}
                width={w}
                height={h}
                rx={isBlack ? 1.5 : 2}
                fill={isBlack ? (color ?? '#292524') : '#ffffff'}
                stroke="#a8a29e"
                strokeWidth={isBlack ? 0.5 : 1}
            />
            {!isBlack && color ? (
                <rect x={x} y={0} width={w} height={h} rx={2} fill={color} fillOpacity={0.22} />
            ) : null}
            {pressed ? (
                <>
                    <circle cx={x + w / 2} cy={badgeY} r={isBlack ? 6 : 8} fill={color ?? '#292524'} />
                    <text
                        x={x + w / 2}
                        y={badgeY}
                        textAnchor="middle"
                        dominantBaseline="central"
                        fontSize={isBlack ? 8 : 10}
                        fontWeight={600}
                        fill="#ffffff"
                        style={{ pointerEvents: 'none', userSelect: 'none' }}
                    >
                        {pressed.finger ?? '?'}
                    </text>
                </>
            ) : null}
        </g>
    );
};
