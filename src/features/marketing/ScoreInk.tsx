import { useId, type CSSProperties } from 'react';

/**
 * The opening of Für Elise (public/marketing/fur-elise-opening.png, a crop of
 * the /try score) with live ink drawn over it: a teacher's red circle and
 * note, a student's blue note and a yellow highlight. The hero and both
 * device frames on the landing page draw it; only the hero carries presence
 * chips.
 *
 * The overlay shares the image's 1455 x 720 box, so the marks stay on their
 * notes at any size. Strokes draw by dash offset; the two notes are revealed
 * by a clip that scales out from the left, so only transform and opacity
 * move. Nothing moves until an ancestor has .is-inview (and the caller holds
 * that until the handwriting face has loaded); under reduced motion every
 * mark is already drawn (landing.css).
 */

const SCORE_IMAGE_SRC = '/marketing/fur-elise-opening.png';

/** Seconds into the sequence, for the hero; the device frames run it again on their own clock. */
const SEQUENCE = {
    davisChip: 0.5,
    circle: 0.6,
    dontRush: 1.7,
    leoChip: 2.6,
    singThis: 2.7,
    highlight: 3.4,
} as const;

const at = (start: number, offset: number, duration?: number): CSSProperties =>
    ({
        '--d': `${(start + offset).toFixed(2)}s`,
        ...(duration === undefined ? {} : { '--dur': `${duration}s` }),
    }) as CSSProperties;

/**
 * The circle's stroke, in the 1455-wide box: thin in the hero, as the ad work
 * asked, and heavier the smaller the frame so it does not vanish.
 */
const CIRCLE_STROKE = {
    hero: '[stroke-width:6] sm:[stroke-width:4.5]',
    tablet: '[stroke-width:6] lg:[stroke-width:4.5]',
    phone: '[stroke-width:7] lg:[stroke-width:6]',
} as const;

export type ScoreInkSize = keyof typeof CIRCLE_STROKE;

const Chip = ({
    initials,
    name,
    color,
    left,
    top,
    delay,
}: {
    initials: string;
    name: string;
    color: string;
    left: string;
    top: string;
    delay: number;
}) => (
    <div className="hero-chip absolute flex items-center gap-1.5" style={{ left, top, ...at(delay, 0) }}>
        <span
            className="flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-semibold text-white ring-2 ring-white"
            style={{ backgroundColor: color }}
        >
            {initials}
        </span>
        <span className="whitespace-nowrap rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-stone-700 shadow-sm">
            {name}
        </span>
    </div>
);

export const ScoreInk = ({
    alt,
    size,
    offset = 0,
    chips = false,
}: {
    alt: string;
    size: ScoreInkSize;
    /** Seconds added to every start: the phone frame lags the tablet, which is what reads as "live". */
    offset?: number;
    chips?: boolean;
}) => {
    const clipId = useId();
    const dontRushClip = `${clipId}-dont-rush`;
    const singThisClip = `${clipId}-sing-this`;
    return (
        <div className="relative">
            <img src={SCORE_IMAGE_SRC} width={1455} height={720} alt={alt} className="block h-auto w-full" />
            <svg viewBox="0 0 1455 720" aria-hidden="true" className="absolute inset-0 h-full w-full">
                <defs>
                    <clipPath id={dontRushClip}>
                        <rect
                            className="ink-write"
                            style={at(SEQUENCE.dontRush, offset, 0.7)}
                            x={104}
                            y={330}
                            width={330}
                            height={110}
                        />
                    </clipPath>
                    <clipPath id={singThisClip}>
                        <rect
                            className="ink-write"
                            style={at(SEQUENCE.singThis, offset, 0.6)}
                            x={822}
                            y={360}
                            width={240}
                            height={80}
                        />
                    </clipPath>
                </defs>
                <path
                    className="hero-ink"
                    style={at(SEQUENCE.highlight, offset, 0.7)}
                    pathLength={100}
                    d="M 800 505 L 1060 505"
                    fill="none"
                    stroke="#eab308"
                    strokeWidth={80}
                    opacity={0.3}
                />
                <path
                    className={`hero-ink ${CIRCLE_STROKE[size]}`}
                    style={at(SEQUENCE.circle, offset, 0.9)}
                    pathLength={100}
                    d="M 118 150 C 100 70, 430 60, 448 128 C 462 190, 180 212, 120 176 C 96 160, 130 104, 210 92"
                    fill="none"
                    stroke="#dc2626"
                    strokeLinecap="round"
                />
                <g clipPath={`url(#${dontRushClip})`}>
                    <text
                        x={120}
                        y={408}
                        fill="#dc2626"
                        fontSize={58}
                        fontWeight={500}
                        transform="rotate(-3 120 408)"
                        className="font-hand"
                    >
                        don’t rush!
                    </text>
                </g>
                <g clipPath={`url(#${singThisClip})`}>
                    <text x={835} y={418} fill="#2563eb" fontSize={54} fontWeight={500} className="font-hand">
                        sing this
                    </text>
                </g>
            </svg>
            {chips ? (
                // The image's alt already says who is marking it; the chips only show it.
                <div aria-hidden="true" className="hidden sm:block">
                    <Chip
                        initials="MD"
                        name="Ms. Davis"
                        color="#dc2626"
                        left="1.5%"
                        top="2%"
                        delay={SEQUENCE.davisChip}
                    />
                    <Chip initials="L" name="Leo" color="#2563eb" left="73%" top="50%" delay={SEQUENCE.leoChip} />
                </div>
            ) : null}
        </div>
    );
};
