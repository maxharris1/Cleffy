import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';

import { prefersReducedMotion } from '@/lib/motion';
import { Button } from '@/ui/Button';
import { CloseButton } from '@/ui/CloseButton';
import { buttonClassName } from '@/ui/classNames';

import './DemoValueCard.css';

/**
 * The card comes up once the visitor has made this many new marks: enough to
 * have felt the pen, not so many that they are deep in a passage.
 */
export const VALUE_CARD_AFTER_MARKS = 3;

/** A visitor who never draws sees it after this long on the page instead. */
export const VALUE_CARD_FALLBACK_MS = 25_000;

/** The card's small controls are 36px tall: an invisible ring takes them to 44px on touch. */
const HIT_Y = 'pointer-coarse:hit-44-y';

/**
 * Keys aimed at another control or popup belong to it: Escape there closes
 * a menu or the toolbar's style popover, not this card as well.
 */
const keyTargetsOtherControl = (target: EventTarget | null, card: HTMLElement | null): boolean =>
    target instanceof Element &&
    !card?.contains(target) &&
    target.closest(
        'input, textarea, select, button, a, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [role="alertdialog"], [role="menu"]',
    ) !== null;

/**
 * Two hands drawing on one staff at once, the third point made visible: a
 * red wavy line under it and a blue slur over it, each led by its own
 * cursor. Both run left to right, so a wipe can draw them. Each stroke is
 * revealed by a clip that scales out from the left, and its cursor travels
 * with it, so only transform and opacity move (DemoValueCard.css). A few
 * passes, then it rests drawn. Under reduced motion it renders drawn from
 * the start: no animation class at all, and the stylesheet's media query
 * covers a setting flipped while the card is up.
 */
const LiveInkIllustration = ({ animate }: { animate: boolean }) => {
    const clipA = useId();
    const clipB = useId();
    const anim = (which: 'a' | 'b') => (animate ? `demo-value-anim demo-value-anim-${which}` : undefined);
    return (
        <svg viewBox="0 0 96 48" width="96" height="48" aria-hidden="true" className="shrink-0">
            <defs>
                <clipPath id={clipA}>
                    <rect className={anim('a')} data-part="reveal" x="4" y="30" width="38" height="18" />
                </clipPath>
                <clipPath id={clipB}>
                    <rect className={anim('b')} data-part="reveal" x="48" y="0" width="42" height="16" />
                </clipPath>
            </defs>
            <g stroke="#1c1917" strokeOpacity="0.35" strokeWidth="1">
                {[16, 21, 26, 31, 36].map((y) => (
                    <line key={y} x1="2" y1={y} x2="94" y2={y} />
                ))}
            </g>
            <path
                clipPath={`url(#${clipA})`}
                d="M 6 42 C 12 37, 18 37, 24 42 S 36 47, 42 42"
                fill="none"
                stroke="#dc2626"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeOpacity="0.85"
            />
            <path
                clipPath={`url(#${clipB})`}
                d="M 50 11 Q 70 3, 90 11"
                fill="none"
                stroke="#2563eb"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeOpacity="0.85"
            />
            {/* The cursors rest where their strokes end; the animation runs them in from the start. */}
            <g className={anim('a')} data-part="cursor">
                <circle cx="42" cy="42" r="3.5" fill="#dc2626" stroke="white" strokeWidth="1.5" />
            </g>
            <g className={anim('b')} data-part="cursor">
                <circle cx="90" cy="11" r="3.5" fill="#2563eb" stroke="white" strokeWidth="1.5" />
            </g>
        </svg>
    );
};

/**
 * What Cleffy is, for a visitor who arrived from an ad and has just found the
 * pen works. Non-modal and anchored to the bottom (over the toolbar on a
 * phone, centred below the score on wider screens), so the music above stays
 * in view. It never takes focus: it comes up between strokes, and the next
 * stroke should land on the score, not on this card. Escape, ✕ and Keep
 * playing put it away; Start free goes where the header's does.
 */
export const DemoValueCard = ({ signUpTo, onDismiss }: { signUpTo: string; onDismiss: () => void }) => {
    const titleId = useId();
    const cardRef = useRef<HTMLElement>(null);
    // Read once, as it appears: the stylesheet handles a later change.
    const [animate] = useState(() => !prefersReducedMotion());

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (
                event.key !== 'Escape' ||
                event.defaultPrevented ||
                keyTargetsOtherControl(event.target, cardRef.current)
            ) {
                return;
            }
            onDismiss();
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [onDismiss]);

    return (
        <div className="demo-value-dock pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center">
            <section
                ref={cardRef}
                role="dialog"
                aria-modal="false"
                aria-labelledby={titleId}
                data-ui-overlay
                // Opaque, unlike the hint's frosted line: a paragraph of text over
                // engraving, or over the toolbar's icons, does not read.
                className="ui-sheet-pop pointer-events-auto w-full max-w-md rounded-2xl border border-stone-200 bg-white p-4 text-stone-700 shadow-lg"
            >
                <div className="flex items-start gap-3">
                    <LiveInkIllustration animate={animate} />
                    <h2 id={titleId} className="min-w-0 flex-1 font-display text-lg font-semibold text-ink">
                        What Cleffy does
                    </h2>
                    <CloseButton
                        label="Close"
                        iconSize={16}
                        // 44px on every pointer, not only touch (demo-value-close).
                        className="demo-value-close h-8 w-8 text-stone-500 hover:bg-stone-100"
                        onClick={onDismiss}
                    />
                </div>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-snug marker:text-stone-400">
                    <li>Bring any score — upload your own PDF, or find one in IMSLP’s public-domain library.</li>
                    <li>Mark it up, and it’s saved to your library on every device.</li>
                    <li>
                        Share one link, and your teacher, students or bandmates draw with you, live — like Google Docs
                        for sheet music.
                    </li>
                </ul>
                <div className="mt-3 flex items-center justify-end gap-2 pointer-coarse:gap-3">
                    <Button variant="ghost" size="sm" className={HIT_Y} onClick={onDismiss}>
                        Keep playing
                    </Button>
                    <Link to={signUpTo} onClick={onDismiss} className={buttonClassName('primary', 'sm', HIT_Y)}>
                        Start free
                    </Link>
                </div>
            </section>
        </div>
    );
};
