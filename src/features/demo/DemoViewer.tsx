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
import { Badge } from '@/ui/Badge';
import { getDb } from '@/sync/db';
import { Button } from '@/ui/Button';
import { CloseButton } from '@/ui/CloseButton';
import { EmptyState } from '@/ui/EmptyState';
import { LoadingText } from '@/ui/Loading';
import { Menu, MenuItem } from '@/ui/Menu';
import { buttonClassName } from '@/ui/classNames';
import { CheckIcon, CloseIcon, MoreVerticalIcon } from '@/ui/icons';

/**
 * After a wipe that failed: is any of the old ink still there for a store to
 * hydrate? The same read the store's hydration makes (rows by doc id). One
 * that cannot read either finds nothing, and neither would the store: a
 * browser that keeps no site data at all fails every wipe, and must still get
 * the demo.
 */
const demoInkRemains = (): Promise<boolean> =>
    getDb()
        .annotations.where('docId')
        .equals(DEMO_DOC_ID)
        .filter((row) => !row.deletedAt)
        .count()
        .then(
            (count) => count > 0,
            () => false,
        );

/**
 * Every stored trace of the demo's ink goes: rows, ops, snapshots, and any
 * ink held in this tab because it could not be written (discarded, not kept
 * for an Export the demo does not have).
 *
 * Rejects only when the delete failed and old ink is still there to show: a
 * visitor must never land on someone's leftover marks, nor watch theirs come
 * back after Start over. A delete that failed with nothing left behind (no
 * site data kept at all) counts as done.
 */
const wipeDemoInk = async (): Promise<void> => {
    try {
        await purgeLocalDocument(DEMO_DOC_ID, { heldInk: 'discard' });
    } catch (err) {
        if (await demoInkRemains()) {
            throw err;
        }
        console.warn('Could not clear the demo’s storage, and no markings are left in it', err);
    }
};

/**
 * preparing: the session rules are still deciding, and maybe wiping, before
 * any store hydrates. clearing: Start over, with the viewport unmounted.
 * Either can be stuck (wipeFailed), the viewport still held back.
 */
type Phase = 'preparing' | 'ready' | 'clearing';

/**
 * Why the keep choice will not hold, when storage refused it. keep: the
 * choice could not be stored, so the next session starts blank. session: the
 * session marker could not be stored either, so even a reload starts blank
 * (unless keep is on).
 */
type StorageRefused = 'keep' | 'session';

const STORAGE_REFUSED_HELP: Record<StorageRefused, string> = {
    keep: 'This browser isn’t keeping site data, so your markings clear when you close it.',
    session: 'This browser isn’t keeping site data, so your markings clear if you reload or leave.',
};

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
    /** The wipe of the current phase failed with old ink still stored: Try again bumps `attempt`. */
    const [wipeFailed, setWipeFailed] = useState(false);
    const [attempt, setAttempt] = useState(0);
    /** A new key mounts a new viewport, whose new store hydrates the (now empty) mirror. */
    const [viewportKey, setViewportKey] = useState(0);
    const [annotationStore, setAnnotationStore] = useState<AnnotationStore | null>(null);
    const [keep, setKeep] = useState(readKeepMarkings);
    const [storageRefused, setStorageRefused] = useState<StorageRefused | null>(null);
    /** The notice that a press of Keep did not stick: the phone's menu closes on it, so the header cannot say so. */
    const [keepRefusedNotice, setKeepRefusedNotice] = useState(false);
    const [confirmingClear, setConfirmingClear] = useState(false);
    const [hintHidden, setHintHidden] = useState(false);
    /** The current store has hydrated: the hint waits for it, so kept ink never flashes it up. */
    const [hydratedStore, setHydratedStore] = useState<AnnotationStore | null>(null);

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
    // delete. A wipe that fails leaves the viewport unmounted, with Try again
    // (the marker stays off, so a reload tries again too).
    useEffect(() => {
        if (phase !== 'preparing') {
            return;
        }
        let cancelled = false;
        startDemoSession(wipeDemoInk).then(
            ({ remembered }) => {
                if (!cancelled) {
                    if (!remembered) {
                        setStorageRefused('session');
                    }
                    setPhase('ready');
                }
            },
            (err: unknown) => {
                console.warn('Could not clear the demo’s earlier markings', err);
                if (!cancelled) {
                    setWipeFailed(true);
                }
            },
        );
        return () => {
            cancelled = true;
        };
    }, [phase, attempt]);

    // Start over: runs once the viewport has unmounted (this effect follows
    // the commit that removed it), so no store is left to write behind the
    // delete. The remount's fresh store hydrates empty, with no undo history.
    // A wipe that fails keeps the viewport unmounted: remounting would only
    // bring the same ink back as though Clear had not been pressed.
    useEffect(() => {
        if (phase !== 'clearing') {
            return;
        }
        let cancelled = false;
        wipeDemoInk().then(
            () => {
                if (!cancelled) {
                    setViewportKey((key) => key + 1);
                    setPhase('ready');
                }
            },
            (err: unknown) => {
                console.warn('Could not clear the demo’s markings', err);
                if (!cancelled) {
                    setWipeFailed(true);
                }
            },
        );
        return () => {
            cancelled = true;
        };
    }, [phase, attempt]);

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

    // The toggle shows what storage holds, not what was pressed: a choice
    // that did not stick leaves it as it was, and says why.
    const toggleKeep = () => {
        const next = !keep;
        if (writeKeepMarkings(next)) {
            setKeep(next);
            setKeepRefusedNotice(false);
            return;
        }
        setKeep(readKeepMarkings());
        setStorageRefused((previous) => previous ?? 'keep');
        setKeepRefusedNotice(true);
    };

    const retryWipe = () => {
        setWipeFailed(false);
        setAttempt((n) => n + 1);
    };

    /** Kept ink is saved, whatever else storage refuses; unkept ink is at storage's mercy. */
    const keepHelp = !keep && storageRefused ? STORAGE_REFUSED_HELP[storageRefused] : KEEP_HELP;

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
                <div className="flex h-full items-center justify-center p-8">
                    {wipeFailed ? (
                        <EmptyState
                            title="Couldn’t clear your markings"
                            body="Your markings are still saved in this browser. Try again to start on a blank score."
                        >
                            {/* Secondary: Start free in the header stays the one primary. */}
                            <Button variant="secondary" onClick={retryWipe}>
                                Try again
                            </Button>
                        </EmptyState>
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
                        className="pointer-coarse:hit-44"
                        disabled={phase !== 'ready'}
                        aria-expanded={confirmingClear}
                        onClick={() => setConfirmingClear(true)}
                    >
                        Start over
                    </Button>
                    <KeepToggle keep={keep} help={keepHelp} onToggle={toggleKeep} />
                    <DemoMenu keep={keep} help={keepHelp} onToggleKeep={toggleKeep} />
                    {/* The one primary: everything else in the demo is ghost or subtle. */}
                    <Link
                        to="/register"
                        className={buttonClassName('primary', 'sm', 'ml-auto pointer-coarse:hit-44 lg:ml-0')}
                    >
                        Start free
                    </Link>
                </ViewerHeader>
            }
            notices={
                <>
                    {confirmingClear ? (
                        <ConfirmClear onClear={startOver} onCancel={() => setConfirmingClear(false)} />
                    ) : null}
                    {keepRefusedNotice && storageRefused ? (
                        <ViewerNotice overlay className="flex-nowrap">
                            <p className="min-w-0 flex-1 leading-snug">{STORAGE_REFUSED_HELP[storageRefused]}</p>
                            <CloseButton
                                label="Dismiss"
                                iconSize={16}
                                className="size-7.5 text-amber-900 hover:bg-amber-100"
                                onClick={() => setKeepRefusedNotice(false)}
                            />
                        </ViewerNotice>
                    ) : null}
                    {/* No Export here: the demo has no export menu to open, and the
                        notice leaves its Export (and Discard) out without one. */}
                    <InkSaveFailedNotice store={annotationStore} />
                </>
            }
            // Not a notice: a notice is fitted around, and the score would jump
            // up under the visitor's first stroke as the hint went.
            overlay={showHint ? <DrawHint onDismiss={() => setHintHidden(true)} /> : null}
        />
    );
};

/** The visible tick of the keep choice, in the header and in the phone menu. */
const KeepBox = ({ keep }: { keep: boolean }) => (
    <span
        aria-hidden="true"
        className={`grid h-4 w-4 shrink-0 place-items-center rounded border transition-colors duration-(--duration-ui) ease-out motion-reduce:transition-none ${
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
const KeepToggle = ({ keep, help, onToggle }: { keep: boolean; help: string; onToggle: () => void }) => {
    const helpId = useId();
    return (
        <>
            <button
                type="button"
                aria-pressed={keep}
                aria-describedby={helpId}
                title={help}
                onClick={onToggle}
                className={buttonClassName('ghost', 'sm', 'max-sm:hidden pointer-coarse:hit-44')}
            >
                <KeepBox keep={keep} />
                Keep my markings
            </button>
            <span id={helpId} className="mr-2 hidden text-xs text-stone-500 lg:inline">
                {help}
            </span>
        </>
    );
};

/**
 * Phones: the keep choice in a small overflow menu, so the header stays two
 * rows. The trigger is 32px wide, so on touch its 44px hit area reaches 6px
 * past each side: the margin keeps that clear of Start over beside it.
 */
const DemoMenu = ({ keep, help, onToggleKeep }: { keep: boolean; help: string; onToggleKeep: () => void }) => (
    <Menu
        label="Demo options"
        triggerContent={<MoreVerticalIcon size={16} />}
        triggerClassName={buttonClassName('ghost', 'sm', 'px-2 pointer-coarse:mx-1 pointer-coarse:hit-44 sm:hidden')}
        popupClassName="w-64"
    >
        <MenuItem onClick={onToggleKeep}>
            <span className="flex items-start gap-2.5">
                <span className="mt-0.5">
                    <KeepBox keep={keep} />
                </span>
                <span>
                    <span className="block">Keep my markings on this device</span>
                    <span className="block text-xs text-stone-500">{help}</span>
                    <span className="sr-only">{keep ? '(on)' : '(off)'}</span>
                </span>
            </span>
        </MenuItem>
    </Menu>
);

/**
 * Start over asks first, inline over the score rather than in a dialog: one
 * sentence and two buttons, Cancel focused so a stray Enter keeps the ink.
 * Escape cancels.
 */
const ConfirmClear = ({ onClear, onCancel }: { onClear: () => void; onCancel: () => void }) => {
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                onCancel();
            }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [onCancel]);
    return (
        <ViewerNotice role="alert" overlay className="flex-nowrap">
            <p className="min-w-0 flex-1 leading-snug">Clear all your markings?</p>
            <Button size="sm" variant="danger" className="shrink-0 pointer-coarse:hit-44" onClick={onClear}>
                Clear
            </Button>
            <Button autoFocus size="sm" variant="ghost" className="shrink-0 pointer-coarse:hit-44" onClick={onCancel}>
                Cancel
            </Button>
        </ViewerNotice>
    );
};

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
        <button
            type="button"
            aria-label="Dismiss"
            title="Dismiss"
            onClick={onDismiss}
            className="relative grid shrink-0 place-items-center rounded-lg p-1.5 text-stone-500 transition-colors hover:bg-ink/5 hover:text-stone-700 pointer-coarse:before:absolute pointer-coarse:before:-inset-2.5"
        >
            <CloseIcon size={14} />
        </button>
    </div>
);
