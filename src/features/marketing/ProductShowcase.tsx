import type { ReactNode } from 'react';

/**
 * The landing showcase: two static vignettes of what practice looks like in
 * Cleffy — a playhead over a score with transport controls, and a fingering
 * keyboard. Nothing here imports the real playback, fingering or billing code;
 * the glyphs are hand-drawn inline SVG, the same way HeroDemo fakes the viewer
 * toolbar. Purely decorative — none of it is interactive.
 */

const STAFF_TOP = 18;
const STAFF_LINES = [0, 9, 18, 27, 36];
/** Barlines of the excerpt; the second measure (84–160) is the looping one. */
const BARLINES = [84, 160, 236];

const Note = ({ x, y, hollow = false }: { x: number; y: number; hollow?: boolean }) => (
    <g>
        <ellipse
            cx={x}
            cy={y}
            rx={4.2}
            ry={3.1}
            transform={`rotate(-18 ${x} ${y})`}
            fill={hollow ? 'none' : '#1c1917'}
            stroke="#1c1917"
            strokeWidth={hollow ? 1.4 : 0}
        />
        <line x1={x + 3.9} y1={y - 1} x2={x + 3.9} y2={y - 22} stroke="#1c1917" strokeWidth="1.2" />
    </g>
);

const ScoreExcerpt = () => (
    <svg viewBox="0 0 320 72" className="w-full" aria-hidden="true">
        {/* The bar Cleffy is looping, with the playhead sitting inside it. */}
        <rect x={84} y={8} width={76} height={56} fill="rgb(67 56 202 / 0.1)" rx={2} />

        <g stroke="#1c1917" strokeOpacity="0.5" strokeWidth="1">
            {STAFF_LINES.map((dy) => (
                <line key={dy} x1={8} y1={STAFF_TOP + dy} x2={312} y2={STAFF_TOP + dy} />
            ))}
            {BARLINES.map((x) => (
                <line key={x} x1={x} y1={STAFF_TOP} x2={x} y2={STAFF_TOP + 36} />
            ))}
            <line x1={9} y1={STAFF_TOP} x2={9} y2={STAFF_TOP + 36} strokeWidth="2.5" />
            <line x1={311} y1={STAFF_TOP} x2={311} y2={STAFF_TOP + 36} />
        </g>

        <Note x={26} y={STAFF_TOP + 27} />
        <Note x={56} y={STAFF_TOP + 22.5} />
        <Note x={100} y={STAFF_TOP + 18} />
        <Note x={132} y={STAFF_TOP + 13.5} />
        <Note x={178} y={STAFF_TOP + 18} />
        <Note x={210} y={STAFF_TOP + 22.5} />
        <Note x={254} y={STAFF_TOP + 13.5} />
        <Note x={286} y={STAFF_TOP + 9} hollow />

        <line x1={116} y1={6} x2={116} y2={66} stroke="#4338ca" strokeWidth="2" strokeLinecap="round" />
    </svg>
);

const PlayGlyph = () => (
    <svg viewBox="0 0 24 24" className="h-4 w-4 translate-x-[1px]" fill="currentColor" aria-hidden="true">
        <path d="M8 5.5v13l11-6.5z" />
    </svg>
);

const ChevronGlyph = ({ back = false }: { back?: boolean }) => (
    <svg
        viewBox="0 0 24 24"
        className="h-4 w-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        aria-hidden="true"
    >
        <path strokeLinecap="round" strokeLinejoin="round" d={back ? 'M14.5 6 9 12l5.5 6' : 'M9.5 6 15 12l-5.5 6'} />
    </svg>
);

const MutedGlyph = () => (
    <svg
        viewBox="0 0 24 24"
        className="h-3.5 w-3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        aria-hidden="true"
    >
        <path strokeLinecap="round" strokeLinejoin="round" d="M11 5.5 6.5 9.5H4v5h2.5L11 18.5v-13z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="m15 9.5 4.5 5m0-5-4.5 5" />
    </svg>
);

const LoopGlyph = () => (
    <svg
        viewBox="0 0 24 24"
        className="h-3.5 w-3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        aria-hidden="true"
    >
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 9h11a2.5 2.5 0 0 1 2.5 2.5v1" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M18 15H7a2.5 2.5 0 0 1-2.5-2.5v-1" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M8.5 6.5 6 9l2.5 2.5M15.5 12.5 18 15l-2.5 2.5" />
    </svg>
);

/** A still frame of the transport bar — spans, so nothing here is focusable. */
const TransportHint = () => (
    <div className="mt-4 flex flex-wrap items-center gap-1.5">
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-accent text-white shadow-sm">
            <PlayGlyph />
        </span>
        <span className="flex h-8 w-8 items-center justify-center rounded-lg text-stone-600">
            <ChevronGlyph back />
        </span>
        <span className="text-sm tabular-nums text-stone-700">m. 12 / 48</span>
        <span className="flex h-8 w-8 items-center justify-center rounded-lg text-stone-600">
            <ChevronGlyph />
        </span>
        <span className="text-sm text-stone-500">
            ♩= <span className="tabular-nums text-stone-700">72</span>
        </span>
        <span className="flex h-8 items-center gap-1 rounded-full border border-stone-200 px-2.5 text-xs font-medium text-stone-600">
            <MutedGlyph />
            LH
        </span>
        <span className="flex h-8 items-center gap-1 rounded-full border border-accent bg-accent-soft px-2.5 text-xs font-medium text-accent">
            <LoopGlyph />
            m. 5–8
        </span>
    </div>
);

/** White keys whose left edge carries a black key — none follows E or B. */
const BLACK_BEFORE = [1, 2, 4, 5, 6, 8, 9, 11, 12, 13];
const WHITE_KEYS = 15;

/* Hand colors mirror HAND_COLORS in src/features/fingering/diagram/keyboardLayout.ts
   (RH indigo, LH green) — keep in sync. */
const PRESSED = [
    { whiteIndex: 0, finger: 5, color: '#16a34a' },
    { whiteIndex: 2, finger: 3, color: '#16a34a' },
    { whiteIndex: 4, finger: 1, color: '#16a34a' },
    { whiteIndex: 7, finger: 1, color: '#4338ca' },
    { whiteIndex: 9, finger: 3, color: '#4338ca' },
    { whiteIndex: 11, finger: 5, color: '#4338ca' },
] as const;

const KeyboardDiagram = () => (
    <svg viewBox="0 0 360 96" className="w-full" aria-hidden="true">
        {Array.from({ length: WHITE_KEYS }, (_, i) => (
            <rect
                key={`w${i}`}
                x={i * 24}
                y={0}
                width={24}
                height={96}
                rx={2}
                fill="#ffffff"
                stroke="#a8a29e"
                strokeWidth={1}
            />
        ))}
        {PRESSED.map((key) => (
            <rect
                key={`p${key.whiteIndex}`}
                x={key.whiteIndex * 24}
                y={0}
                width={24}
                height={96}
                rx={2}
                fill={key.color}
                fillOpacity={0.22}
            />
        ))}
        {BLACK_BEFORE.map((i) => (
            <rect key={`b${i}`} x={i * 24 - 7} y={0} width={14} height={58} rx={1.5} fill="#292524" />
        ))}
        {PRESSED.map((key) => (
            <g key={`f${key.whiteIndex}`}>
                <circle cx={key.whiteIndex * 24 + 12} cy={81} r={8} fill={key.color} />
                <text
                    x={key.whiteIndex * 24 + 12}
                    y={81}
                    fontSize={10}
                    fontWeight={600}
                    fill="#fff"
                    textAnchor="middle"
                    dominantBaseline="central"
                >
                    {key.finger}
                </text>
            </g>
        ))}
    </svg>
);

const VignetteCard = ({
    title,
    body,
    visualLabel,
    children,
}: {
    title: string;
    body: string;
    visualLabel: string;
    children: ReactNode;
}) => (
    <div className="overflow-hidden rounded-2xl border border-stone-200 bg-white/95 shadow-xl">
        <div role="img" aria-label={visualLabel} className="border-b border-stone-100 px-5 pb-4 pt-5">
            {children}
        </div>
        <div className="px-5 py-4">
            <h3 className="font-medium text-stone-800">{title}</h3>
            <p className="mt-1 text-sm leading-relaxed text-stone-600">{body}</p>
        </div>
    </div>
);

export const ProductShowcase = () => (
    <section aria-labelledby="showcase-title" className="border-t border-line py-14 lg:py-16">
        <p className="text-xs font-medium uppercase tracking-[0.08em] text-stone-500">Practice tools</p>
        <h2 id="showcase-title" className="mt-2 font-display text-2xl font-semibold tracking-tight text-ink">
            More than markings
        </h2>

        <div className="mt-8 grid gap-6 lg:grid-cols-2">
            <VignetteCard
                title="Practice one hand at a time"
                body="Mute a hand and play it yourself while Cleffy plays the other — with a live playhead on the score, tempo control, and a loop for the hard bars."
                visualLabel="A score excerpt with a playhead, above playback controls: play, measure stepper, tempo, left hand muted, loop on bars 5 to 8"
            >
                <ScoreExcerpt />
                <TransportHint />
            </VignetteCard>

            <VignetteCard
                title="Fingering, read from the score"
                body="Cleffy reads the fingering numbers printed on the page and shows them on a keyboard, colored by hand."
                visualLabel="A piano keyboard diagram with numbered finger badges: left hand in green, right hand in indigo"
            >
                <KeyboardDiagram />
            </VignetteCard>
        </div>

        <p className="mt-6 text-center text-sm text-stone-500">
            Made for iPad and Apple Pencil — annotate with the Pencil, practice at the piano.
        </p>
    </section>
);
