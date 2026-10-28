import { useCallback, useEffect, useId, useState } from 'react';
import { Link } from 'react-router';

import { DEMO_DOC_ID, DEMO_TITLE } from '@/features/demo/demoScore';
import { readKeepMarkings, startDemoSession, writeKeepMarkings } from '@/features/demo/demoSession';
import { purgeLocalDocument } from '@/features/library/documentsService';
import { InkSaveFailedNotice } from '@/features/viewer/InkSaveFailedNotice';
import { LocalViewerFrame } from '@/features/viewer/LocalViewerFrame';
import { ViewerHeader } from '@/features/viewer/ViewerHeader';
import { ViewerNotice } from '@/features/viewer/ViewerNotice';
import { useViewerStore } from '@/state/store';
import type { AnnotationStore } from '@/sync/annotationStore';
import { getDb } from '@/sync/db';
import { Badge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { LoadingText } from '@/ui/Loading';
import { Menu, MenuItem } from '@/ui/Menu';
import { buttonClassName } from '@/ui/classNames';
import { CheckIcon, CloseIcon, MoreVerticalIcon } from '@/ui/icons';

/**
 * Every stored trace of the demo's ink goes: rows, ops, snapshots, and any
 * ink held in this tab because it could not be written (discarded, not kept
 * for an Export the demo does not have).
 *
 * Rejects only when the old ink is still there to be shown. A database that
 * cannot be read at all (some private modes) has no old ink either — its
 * store would hydrate nothing — so that visitor still gets a blank demo
 * rather than one that never opens.
 */
const wipeDemoInk = async (): Promise<void> => {
    try {
        await purgeLocalDocument(DEMO_DOC_ID, { heldInk: 'discard' });
    } catch (err) {
        const left = await getDb()
            .annotations.where('docId')
            .equals(DEMO_DOC_ID)
            .count()
            .catch(() => 0);
        if (left > 0) {
            throw err;
        }
        console.warn('Could not clear the demo’s stored data; none of its ink is left to show', err);
    }
};

/**
 * preparing: the session rules are still deciding, and maybe wiping, before
 * any store hydrates. clearing: Start over, with the viewport unmounted.
 * blocked: a new session whose wipe failed with the old ink still stored; the
 * viewport stays down rather than open on someone's leftover marks.
 */
type Phase = 'preparing' | 'ready' | 'clearing' | 'blocked';

/** The header's small controls are 36px tall: an invisible ring takes them to 44px on touch. */
const HIT_Y = 'pointer-coarse:hit-44-y';

/**
 * The /try demo: the local viewer on a bundled score, a sandbox per browser
 * session (demoSession), and a way on to sign-up. Nothing here talks to the
 * server: DEMO_DOC_ID is a local id, so the viewport starts no sync.
 *
 * What the local viewer has and this leaves out, on purpose: Export, lesson
 * history, smart import and re-opening a file. An ad visitor has two seconds
 * of attention, and those are all doors out of the demo.
 */
export const DemoViewer = ({ bytes }: { bytes: ArrayBuffer }) => {
    const [phase, setPhase] = useState<Phase>('preparing');
    /** A new key mounts a new viewport, whose new store hydrates the (now empty) mirror. */
    const [viewportKey, setViewportKey] = useState(0);
    const [annotationStore, setAnnotationStore] = useState<AnnotationStore | null>(null);
    const [keep, setKeep] = useState(readKeepMarkings);
    /** Keep was asked for and the browser would not store it. */
    const [keepRefused, setKeepRefused] = useState(false);
    const [confirmingClear, setConfirmingClear] = useState(false);
    /** The last Clear failed: the strip stays up and says so. */
    const [clearFailed, setClearFailed] = useState(false);
    const [hintHidden, setHintHidden] = useState(false);
    /** The current store has hydrated: the hint waits for it, so kept ink never flashes it up. */
    const [hydratedStore, setHydratedStore] = useState<AnnotationStore | null>(null);
    const confirmId = useId();

    // Most ad traffic is a phone with no stylus. With finger drawing off (the
    // app's default) a first swipe pans, and the demo looks broken. On while
    // the demo is up; whatever it was comes back on the way out, so the rest
    // of the app is unaffected. The toolbar toggle stays for Pencil users.
    useEffect(() => {
        const { fingerDraws: previous, setFingerDraws } = useViewerStore.getState();
        setFingerDraws(true);
        return () => setFingerDraws(previous);
    }, []);

    // The wipe has to finish before the viewport mounts: its store hydrates
    // from Dexie as soon as it does, and would paint the old ink and race the
    // delete. A failed wipe keeps it down (blocked, with Try again); the
    // session marker stays off, so a reload tries again too.
    useEffect(() => {
        if (phase !== 'preparing') {
            return;
        }
        let cancelled = false;
        startDemoSession(wipeDemoInk).then(
            () => {
                if (!cancelled) {
                    setPhase('ready');
                }
            },
            (err: unknown) => {
                console.warn('Could not clear the demo’s earlier markings', err);
                if (!cancelled) {
                    setPhase('blocked');
                }
            },
        );
        return () => {
            cancelled = true;
        };
    }, [phase]);

    // Start over: runs once the viewport has unmounted (this effect follows
    // the commit that removed it), so no store is left to write behind the
    // delete. The remount's fresh store hydrates empty, with no undo history.
    // A failed clear remounts on what is left, with the strip saying so.
    useEffect(() => {
        if (phase !== 'clearing') {
            return;
        }
        let cancelled = false;
        const remount = (failed: boolean) => {
            if (cancelled) {
                return;
            }
            setClearFailed(failed);
            setConfirmingClear(failed);
            setViewportKey((key) => key + 1);
            setPhase('ready');
        };
        wipeDemoInk().then(
            () => remount(false),
            (err: unknown) => {
                console.warn('Could not clear the demo’s markings', err);
                remount(true);
            },
        );
        return () => {
            cancelled = true;
        };
    }, [phase]);

    const onStoreReady = useCallback((store: AnnotationStore) => setAnnotationStore(store), []);

    // The hint goes with the first committed stroke (or if the visitor kept
    // ink from an earlier session), and stays gone for this visit.
    useEffect(() => {
        if (!annotationStore || hintHidden) {
            return;
        }
        let cancelled = false;
        const check = () => {
            if (annotationStore.annotatedPages().length > 0) {
                setHintHidden(true);
            }
        };
        const unsubscribe = annotationStore.subscribe(check);
        annotationStore
            .load()
            .catch(() => undefined)
            .then(() => {
                if (!cancelled) {
                    check();
                    setHydratedStore(annotationStore);
                }
            });
        return () => {
            cancelled = true;
            unsubscribe();
        };
    }, [annotationStore, hintHidden]);

    const startOver = () => {
        setConfirmingClear(false);
        setAnnotationStore(null);
        setHydratedStore(null);
        setPhase('clearing');
    };

    const cancelClear = useCallback(() => {
        setConfirmingClear(false);
        setClearFailed(false);
    }, []);

    // The toggle shows what the browser actually kept, never only what was
    // asked: a refused write leaves it off, and says why.
    const toggleKeep = () => {
        const next = !keep;
        const stuck = writeKeepMarkings(next);
        setKeep(readKeepMarkings());
        setKeepRefused(next && !stuck);
    };

    const showHint =
        !hintHidden &&
        !confirmingClear &&
        phase === 'ready' &&
        annotationStore !== null &&
        hydratedStore === annotationStore;

    return (
        <LocalViewerFrame
            docId={DEMO_DOC_ID}
            bytes={bytes}
            onStoreReady={onStoreReady}
            viewportKey={viewportKey}
            showViewport={phase === 'ready'}
            placeholder={
                <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
                    {phase === 'blocked' ? (
                        <>
                            <p role="alert" className="max-w-sm text-sm leading-relaxed text-stone-600">
                                Couldn’t clear the markings from an earlier visit, so the demo hasn’t opened.
                            </p>
                            <Button onClick={() => setPhase('preparing')}>Try again</Button>
                        </>
                    ) : (
                        <LoadingText>{phase === 'clearing' ? 'Clearing your markings…' : 'Loading demo…'}</LoadingText>
                    )}
                </div>
            }
            header={
                <ViewerHeader backTo="/" backLabel="Back to home" title={DEMO_TITLE}>
                    <Badge tone="accent">Demo</Badge>
                    <Button
                        variant="ghost"
                        size="sm"
                        className={HIT_Y}
                        disabled={phase !== 'ready'}
                        aria-expanded={confirmingClear}
                        aria-controls={confirmingClear ? confirmId : undefined}
                        onClick={() => setConfirmingClear(true)}
                    >
                        Start over
                    </Button>
                    <KeepToggle keep={keep} onToggle={toggleKeep} />
                    <DemoMenu keep={keep} onToggleKeep={toggleKeep} />
                    {/* The one primary: everything else in the demo is ghost or subtle. */}
                    <Link to="/register" className={buttonClassName('primary', 'sm', `ml-auto lg:ml-0 ${HIT_Y}`)}>
                        Start free
                    </Link>
                </ViewerHeader>
            }
            notices={
                <>
                    {confirmingClear ? (
                        <ConfirmClear id={confirmId} failed={clearFailed} onClear={startOver} onCancel={cancelClear} />
                    ) : null}
                    {keepRefused ? <KeepRefusedNotice onDismiss={() => setKeepRefused(false)} /> : null}
                    {/* No Export here: the demo has no export menu to open, and the
                        notice leaves its Export (and Discard) out without one, and
                        words its copy to match. */}
                    <InkSaveFailedNotice store={annotationStore} />
                </>
            }
            // Not a notice: a notice is fitted around, and the score would jump
            // up under the visitor's first stroke as the hint went.
            overlay={showHint ? <DrawHint onDismiss={() => setHintHidden(true)} /> : null}
        />
    );
};

/** The visible tick of the keep choice, in the header and in the phone menu. Changes in place, unanimated. */
const KeepBox = ({ keep }: { keep: boolean }) => (
    <span
        aria-hidden="true"
        className={`grid h-4 w-4 shrink-0 place-items-center rounded border ${
            keep ? 'border-accent bg-accent text-white' : 'border-stone-400 bg-white'
        }`}
    >
        {keep ? <CheckIcon size={12} /> : null}
    </span>
);

const KEEP_HELP = 'Saved in this browser only.';

/**
 * From `sm`, where the header has room for it; below, it lives in DemoMenu.
 * max-sm:hidden rather than hidden + sm:inline-flex: the button's own
 * inline-flex would win over a plain `hidden`.
 */
const KeepToggle = ({ keep, onToggle }: { keep: boolean; onToggle: () => void }) => {
    const helpId = useId();
    return (
        <>
            <button
                type="button"
                aria-pressed={keep}
                aria-describedby={helpId}
                title={KEEP_HELP}
                onClick={onToggle}
                className={buttonClassName('ghost', 'sm', `max-sm:hidden ${HIT_Y}`)}
            >
                <KeepBox keep={keep} />
                Keep my markings
            </button>
            <span id={helpId} className="mr-2 hidden text-xs text-stone-500 lg:inline">
                {KEEP_HELP}
            </span>
        </>
    );
};

/** Phones: the keep choice in a small overflow menu, so the header stays two rows. */
const DemoMenu = ({ keep, onToggleKeep }: { keep: boolean; onToggleKeep: () => void }) => (
    <Menu
        label="Demo options"
        triggerContent={<MoreVerticalIcon size={16} />}
        triggerClassName={buttonClassName('ghost', 'sm', 'px-2 sm:hidden pointer-coarse:hit-44')}
        popupClassName="w-64"
    >
        <MenuItem onClick={onToggleKeep}>
            <span className="flex items-start gap-2.5">
                <span className="mt-0.5">
                    <KeepBox keep={keep} />
                </span>
                <span>
                    <span className="block">Keep my markings on this device</span>
                    <span className="block text-xs text-stone-500">{KEEP_HELP}</span>
                    <span className="sr-only">{keep ? '(on)' : '(off)'}</span>
                </span>
            </span>
        </MenuItem>
    </Menu>
);

/** An × that sits small in its card and takes a 44px press on touch (an invisible ring). */
const DismissButton = ({ onDismiss }: { onDismiss: () => void }) => (
    <button
        type="button"
        aria-label="Dismiss"
        title="Dismiss"
        onClick={onDismiss}
        className="relative grid shrink-0 place-items-center rounded-lg p-1.5 hover:bg-ink/5 pointer-coarse:before:absolute pointer-coarse:before:-inset-2.5"
    >
        <CloseIcon size={14} />
    </button>
);

/**
 * Start over asks first, inline over the score rather than in a dialog: one
 * sentence and two buttons, Cancel focused so a stray Enter keeps the ink.
 * Escape cancels, and goes no further (the viewport's keys skip a handled
 * event). A clear that failed keeps the strip up, saying so.
 */
const ConfirmClear = ({
    id,
    failed,
    onClear,
    onCancel,
}: {
    id: string;
    failed: boolean;
    onClear: () => void;
    onCancel: () => void;
}) => {
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                onCancel();
            }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [onCancel]);
    return (
        <ViewerNotice role="alert" overlay className="flex-nowrap">
            <p id={id} className="min-w-0 flex-1 leading-snug">
                {failed ? 'Couldn’t clear your markings. Try again?' : 'Clear all your markings?'}
            </p>
            <Button size="sm" variant="danger" className={`shrink-0 ${HIT_Y}`} onClick={onClear}>
                Clear
            </Button>
            <Button autoFocus size="sm" variant="ghost" className={`shrink-0 ${HIT_Y}`} onClick={onCancel}>
                Cancel
            </Button>
        </ViewerNotice>
    );
};

/** Keep was asked for and the browser would not store it: the toggle stays off, and this says why. */
const KeepRefusedNotice = ({ onDismiss }: { onDismiss: () => void }) => (
    <ViewerNotice>
        <p className="min-w-0 flex-1 leading-snug">
            This browser isn’t keeping site data, so your markings clear when you close it.
        </p>
        <DismissButton onDismiss={onDismiss} />
    </ViewerNotice>
);

/**
 * First-run hint over the score. Neutral, not the amber of a notice: it is an
 * invitation, not a problem. Enters with a short rise (demo-hint, index.css;
 * a plain fade under reduced motion) and simply goes.
 */
const DrawHint = ({ onDismiss }: { onDismiss: () => void }) => (
    <div
        role="status"
        data-ui-overlay
        className="demo-hint pointer-events-auto mx-auto flex w-fit max-w-full items-center gap-1 rounded-xl border border-stone-200 bg-white/95 py-1 pl-3 pr-1 text-sm text-stone-700 shadow-lg"
    >
        <p className="min-w-0">Draw anywhere — Pencil, finger or mouse.</p>
        <DismissButton onDismiss={onDismiss} />
    </div>
);
