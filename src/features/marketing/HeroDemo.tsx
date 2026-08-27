import type { CSSProperties } from 'react';

import { useInViewOnce } from '@/features/marketing/useInViewOnce';

/**
 * The landing hero demos the product: an engraved score page that annotates
 * itself — ink strokes draw in (SVG pathLength dash animation, CSS-only) and
 * presence chips pop up, using the app's real visual language. Under
 * prefers-reduced-motion the finished state renders immediately (see
 * .hero-ink / .hero-chip in index.css). No viewer code is imported here.
 */

const S1 = 140;
const S2 = 270;
const S3 = 400;

const at = (d: string, dur?: string): CSSProperties =>
    ({ '--d': d, ...(dur ? { '--dur': dur } : {}) }) as CSSProperties;

const Staff = ({ y }: { y: number }) => (
    <g stroke="#1c1917" strokeOpacity="0.5" strokeWidth="1">
        {[0, 9, 18, 27, 36].map((dy) => (
            <line key={dy} x1={56} y1={y + dy} x2={704} y2={y + dy} />
        ))}
        {[218, 380, 542].map((x) => (
            <line key={x} x1={x} y1={y} x2={x} y2={y + 36} />
        ))}
        <line x1={57.5} y1={y} x2={57.5} y2={y + 36} strokeWidth="3" />
        <line x1={703} y1={y} x2={703} y2={y + 36} />
    </g>
);

const Note = ({ x, y, up = true, hollow = false }: { x: number; y: number; up?: boolean; hollow?: boolean }) => (
    <g>
        <ellipse
            cx={x}
            cy={y}
            rx={5}
            ry={3.6}
            transform={`rotate(-18 ${x} ${y})`}
            fill={hollow ? 'none' : '#1c1917'}
            stroke="#1c1917"
            strokeWidth={hollow ? 1.6 : 0}
        />
        {up ? (
            <line x1={x + 4.6} y1={y - 1} x2={x + 4.6} y2={y - 30} stroke="#1c1917" strokeWidth="1.4" />
        ) : (
            <line x1={x - 4.6} y1={y + 1} x2={x - 4.6} y2={y + 30} stroke="#1c1917" strokeWidth="1.4" />
        )}
    </g>
);

const Beam = ({ x1, y1, x2, y2 }: { x1: number; y1: number; x2: number; y2: number }) => (
    <line x1={x1 + 4.6} y1={y1 - 30} x2={x2 + 4.6} y2={y2 - 30} stroke="#1c1917" strokeWidth="3.5" />
);

const Whole = ({ x, y }: { x: number; y: number }) => (
    <ellipse cx={x} cy={y} rx={5.6} ry={3.8} fill="none" stroke="#1c1917" strokeWidth="1.8" />
);

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
    delay: string;
}) => (
    <div className="hero-chip absolute flex items-center gap-1.5" style={{ left, top, ...at(delay) }}>
        <span
            className="flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-semibold text-white ring-2 ring-white"
            style={{ backgroundColor: color }}
        >
            {initials}
        </span>
        <span className="whitespace-nowrap rounded-full bg-white/95 px-2 py-0.5 text-[10px] font-medium text-stone-700 shadow-sm">
            {name}
        </span>
    </div>
);

export const HeroDemo = () => {
    const { ref, inView } = useInViewOnce<HTMLDivElement>();
    return (
        <div
            ref={ref}
            role="img"
            aria-label="A score page being annotated live: Ms. Torres circles a phrase in red while Alex draws a blue slur and highlights a passage"
            className={`landing-demo-frame relative mx-auto w-full max-w-xl overflow-hidden rounded-[4px] bg-white lg:max-w-none${inView ? ' is-inview' : ''}`}
        >
            <svg viewBox="0 0 760 540" className="block h-auto w-full" aria-hidden="true">
                {/* Engraved page */}
                <text
                    x={56}
                    y={68}
                    fontSize={26}
                    fontStyle="italic"
                    fill="#1c1917"
                    style={{ fontFamily: "'Bodoni Moda Variable', ui-serif, Georgia, serif" }}
                >
                    Adagio cantabile
                </text>
                <line x1={56} y1={86} x2={704} y2={86} stroke="#1c1917" strokeOpacity="0.4" strokeWidth="0.75" />

                <Staff y={S1} />
                <Staff y={S2} />
                <Staff y={S3} />

                {/* System 1 */}
                <Note x={90} y={S1 + 27} />
                <Note x={132} y={S1 + 22.5} />
                <Note x={174} y={S1 + 18} />
                <Note x={240} y={S1 + 18} />
                <Note x={272} y={S1 + 13.5} />
                <Beam x1={240} y1={S1 + 18} x2={272} y2={S1 + 13.5} />
                <Note x={322} y={S1 + 9} />
                <path
                    d={`M 90 ${S1 + 34} Q 205 ${S1 + 52} 322 ${S1 + 17}`}
                    fill="none"
                    stroke="#1c1917"
                    strokeWidth="1.2"
                />
                <Note x={404} y={S1 + 13.5} />
                <Note x={438} y={S1 + 9} />
                <Beam x1={404} y1={S1 + 13.5} x2={438} y2={S1 + 9} />
                <Note x={476} y={S1 + 13.5} />
                <Note x={508} y={S1 + 18} />
                <Whole x={590} y={S1 + 18} />

                {/* System 2 */}
                <Note x={92} y={S2 + 22.5} />
                <Note x={128} y={S2 + 18} />
                <Note x={164} y={S2 + 13.5} />
                <Beam x1={128} y1={S2 + 18} x2={164} y2={S2 + 13.5} />
                <Note x={250} y={S2 + 9} />
                <Note x={290} y={S2 + 13.5} />
                <Note x={330} y={S2 + 18} />
                <Note x={410} y={S2 + 22.5} up={false} />
                <Note x={452} y={S2 + 27} up={false} />
                <Whole x={600} y={S2 + 13.5} />

                {/* System 3 */}
                <Note x={94} y={S3 + 18} />
                <Note x={140} y={S3 + 13.5} />
                <Note x={230} y={S3 + 18} hollow />
                <Note x={330} y={S3 + 22.5} />
                <Note x={420} y={S3 + 18} hollow />
                <Whole x={600} y={S3 + 22.5} />
                <line x1={698} y1={S3} x2={698} y2={S3 + 36} stroke="#1c1917" strokeOpacity="0.6" strokeWidth="1" />
                <line x1={703} y1={S3} x2={703} y2={S3 + 36} stroke="#1c1917" strokeWidth="3.5" />

                {/* Live ink — draws itself */}
                <path
                    className="hero-ink"
                    style={at('0.6s')}
                    pathLength={100}
                    d={`M 398 ${S1 - 8} C 424 ${S1 - 22}, 506 ${S1 - 20}, 522 ${S1 + 2} C 534 ${S1 + 22}, 508 ${S1 + 42}, 458 ${S1 + 42} C 412 ${S1 + 42}, 386 ${S1 + 24}, 400 ${S1 - 4}`}
                    fill="none"
                    stroke="#dc2626"
                    strokeWidth="3.5"
                    strokeLinecap="round"
                    strokeOpacity="0.85"
                />
                <path
                    className="hero-ink"
                    style={at('1.9s', '1.1s')}
                    pathLength={100}
                    d={`M 90 ${S2 - 10} C 160 ${S2 - 38}, 265 ${S2 - 38}, 335 ${S2 - 8}`}
                    fill="none"
                    stroke="#2563eb"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeOpacity="0.85"
                />
                <line
                    className="hero-ink"
                    style={at('3.1s', '0.7s')}
                    pathLength={100}
                    x1={548}
                    y1={S2 + 18}
                    x2={698}
                    y2={S2 + 18}
                    stroke="#eab308"
                    strokeWidth="42"
                    strokeOpacity="0.32"
                />
            </svg>

            {/* Presence chips — match PresenceBar's initials-circle language */}
            <Chip initials="MT" name="Ms. Torres" color="#dc2626" left="60%" top="8%" delay="0.5s" />
            <Chip initials="AJ" name="Alex" color="#2563eb" left="10%" top="39.5%" delay="1.8s" />

            {/* Static toolbar hint, pattern-copied from the real viewer toolbar */}
            <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-2xl border border-stone-200 bg-white/95 px-2.5 py-1.5 shadow-lg">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent-soft text-accent">
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.75">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15.5 4.5 19.5 8.5 9 19H5v-4L15.5 4.5z" />
                    </svg>
                </span>
                <span className="flex h-7 w-7 items-center justify-center rounded-lg text-stone-600">
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.75">
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M5 19h14M8 15l-2 2v2h4l7-7-4-4-5 5zM15 8l2-2 3 3-2 2"
                        />
                    </svg>
                </span>
                <span className="mx-0.5 h-4 w-px bg-stone-200" />
                <span
                    className="h-3.5 w-3.5 rounded-full ring-2 ring-accent ring-offset-1"
                    style={{ backgroundColor: '#1f2937' }}
                />
                <span className="h-3.5 w-3.5 rounded-full" style={{ backgroundColor: '#dc2626' }} />
                <span className="h-3.5 w-3.5 rounded-full" style={{ backgroundColor: '#2563eb' }} />
            </div>
        </div>
    );
};
