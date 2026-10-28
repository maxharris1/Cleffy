import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';

import { DEMO_DOC_ID, DEMO_TITLE } from '@/features/demo/demoScore';
import {
    readKeepMarkings,
    readValueCardDismissed,
    startDemoSession,
    writeKeepMarkings,
    writeValueCardDismissed,
} from '@/features/demo/demoSession';
import { DemoValueCard, VALUE_CARD_AFTER_MARKS, VALUE_CARD_FALLBACK_MS } from '@/features/demo/DemoValueCard';
import { purgeLocalDocument } from '@/features/library/documentsService';
import { InkSaveFailedNotice } from '@/features/viewer/InkSaveFailedNotice';
import { LocalViewerFrame } from '@/features/viewer/LocalViewerFrame';
import { ViewerHeader } from '@/features/viewer/ViewerHeader';
import { ViewerNotice } from '@/features/viewer/ViewerNotice';
import { useToolbarPopupOpen } from '@/features/viewer/toolbar/toolbarPopup';
import { useViewerStore } from '@/state/store';
import type { AnnotationStore } from '@/sync/annotationStore';
import { getDb } from '@/sync/db';
import { Badge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { CloseButton } from '@/ui/CloseButton';
import { EmptyState } from '@/ui/EmptyState';
import { LoadingText } from '@/ui/Loading';
import { Menu, MenuItem } from '@/ui/Menu';
import { buttonClassName } from '@/ui/classNames';
import { CheckIcon, CloseIcon, MoreVerticalIcon } from '@/ui/icons';

/**
 * After a wipe that failed: is any of the old ink still there for a store to
 * hydrate? The same read the store's hydration makes (rows by doc id).
 * Rejects when the read itself fails (async, so a throw from getDb() or the
 * query chain rejects too): a read that failed has not shown nothing is left,
 * nor that anything is.
 */
const demoInkRemains = async (): Promise<boolean> =>
    (await getDb()
        .annotations.where('docId')
        .equals(DEMO_DOC_ID)
        .filter((row) => !row.deletedAt)
        .count()) > 0;

/**
 * A wipe that failed, and what the check after it found. remains: the read
 * worked and found ink. unknown: the read failed too, so nothing is known
 * either way (a browser refusing IndexedDB outright lands here). The delete's
 * own error is the cause.
 */
class DemoWipeFailedError extends Error {
    constructor(
        readonly inkState: 'remains' | 'unknown',
        options: { cause: unknown },
    ) {
        super('Could not clear the demo’s markings', options);
        this.name = 'DemoWipeFailedError';
    }
}

/**
 * Every stored trace of the demo's ink goes: rows, ops, snapshots, and any
 * ink held in this tab because it could not be written (discarded, not kept
 * for an Export the demo does not have).
 *
 * Rejects with a DemoWipeFailedError, the delete's own error as its cause,
 * when the delete failed and old ink may still be there to show: a visitor
 * must never land on someone's leftover marks, nor watch theirs come back
 * after Start over. Only a delete that failed and a read that then worked and
 * found nothing (a browser that keeps no site data but can read its empty
 * store) counts as done. A read that fails too rejects as well ('unknown'),
 * so a browser where IndexedDB fails outright gets Try again rather than the
 * demo: failing closed wins.
 */
const wipeDemoInk = async (): Promise<void> => {
    try {
        await purgeLocalDocument(DEMO_DOC_ID, { heldInk: 'discard' });
    } catch (err) {
        const remains = await demoInkRemains().catch(() => null);
        if (remains !== false) {
            throw new DemoWipeFailedError(remains ? 'remains' : 'unknown', { cause: err });
        }
        console.warn('Could not clear the demo’s storage, and no markings are left in it', err);
    }
};

/** Which copy a failed wipe gets: only a check that found ink may say it is still saved. */
const wipeFailure = (err: unknown): WipeFailure => (err instanceof DemoWipeFailedError ? err.inkState : 'unknown');

/**
 * preparing: the session rules are still deciding, and maybe wiping, before
 * any store hydrates. clearing: Start over, with the viewport unmounted.
 * Either can be stuck (wipeFailed), the viewport still held back.
 */
type Phase = 'preparing' | 'ready' | 'clearing';

type WipeFailure = DemoWipeFailedError['inkState'];

/**
 * Why the keep choice will not hold, when storage refused it. keep: the
 * choice could not be stored, so the next session starts blank. session: the
 * session marker could not be stored either, so even a reload starts blank
 * (unless keep is on).
 */
type StorageRefused = 'keep' | 'session';

/** The header's small controls are 36px tall: an invisible ring takes them to 44px on touch. */
const HIT_Y = 'pointer-coarse:hit-44-y';

/** Where Start free goes, from the header and from the value card alike. */
const SIGN_UP_TO = '/register';

const WIPE_FAILED_BODY: Record<WipeFailure, string> = {
    remains: 'Your markings are still saved in this browser. Try again to start on a blank score.',
    unknown: 'This browser isn’t letting the demo use its storage right now. Try again, or come back in a minute.',
};

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
    /** The wipe of the current phase failed, with old ink still stored or unknown: Try again bumps `attempt`. */
    const [wipeFailed, setWipeFailed] = useState<WipeFailure | null>(null);
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
    const confirmId = useId();
    /** The value card has earned its moment (marks made, or time spent); it shows once nothing else needs the screen. */
    const [valueCardDue, setValueCardDue] = useState(false);
    const [valueCardDismissed, setValueCardDismissed] = useState(readValueCardDismissed);
    /** The visitor has been on the page VALUE_CARD_FALLBACK_MS: the card is due if they have made no marks. */
    const [fallbackReached, setFallbackReached] = useState(false);
    /**
     * Ids of the marks made on this visit, across Start over's remounts: a
     * set, so an undo and redo of the same stroke counts once. Only marks
     * created since the demo opened count, so ink kept from an earlier
     * session (or an erased mark that undo brings back) does not.
     */
    const newMarks = useRef(new Set<string>());
    const [openedAt] = useState(Date.now);
    const toolbarPopupOpen = useToolbarPopupOpen();

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
                    setWipeFailed(wipeFailure(err));
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
                    setWipeFailed(wipeFailure(err));
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

    // The value card comes up after the visitor's first few marks: they have
    // found the pen works, so now is when "and it does this with your own
    // scores" lands. Marks are told apart by when they were made, not by a
    // snapshot of what the store held: a snapshot taken as hydration settles
    // could swallow a stroke committed in the same moment.
    //
    // A visitor who never draws still hears what Cleffy is, after a while
    // on the page. One who has started drawing gets it at the mark count
    // instead, rather than mid-phrase. "Started" is read from the store's
    // live marks when the time comes, not from the last notification: a
    // stroke is live at pointer-up, but the store only notifies once its
    // write has landed, and a write still pending at the deadline must not
    // look like a visitor who never drew.
    useEffect(() => {
        if (!annotationStore || valueCardDue || valueCardDismissed) {
            return;
        }
        const count = () => {
            for (const annotation of annotationStore.liveAnnotations()) {
                if (Date.parse(annotation.createdAt) >= openedAt) {
                    newMarks.current.add(annotation.id);
                }
            }
            if (newMarks.current.size >= VALUE_CARD_AFTER_MARKS || (fallbackReached && newMarks.current.size === 0)) {
                setValueCardDue(true);
            }
        };
        count();
        return annotationStore.subscribe(count);
    }, [annotationStore, valueCardDue, valueCardDismissed, fallbackReached, openedAt]);

    useEffect(() => {
        if (fallbackReached || valueCardDue || valueCardDismissed) {
            return;
        }
        const timer = setTimeout(() => setFallbackReached(true), VALUE_CARD_FALLBACK_MS);
        return () => clearTimeout(timer);
    }, [fallbackReached, valueCardDue, valueCardDismissed]);

    const dismissValueCard = useCallback(() => {
        setValueCardDismissed(true);
        writeValueCardDismissed();
    }, []);

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

    const cancelClear = useCallback(() => setConfirmingClear(false), []);

    const retryWipe = () => {
        setWipeFailed(null);
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

    // Never over a failed wipe, a clear in progress, the Start over question
    // (which owns Escape while it asks) or an open toolbar popup (on a phone
    // the colour and size popover opens into the card's spot): it waits, and
    // comes back. Stepping aside is not a dismissal.
    const showValueCard =
        valueCardDue &&
        !valueCardDismissed &&
        phase === 'ready' &&
        wipeFailed === null &&
        !confirmingClear &&
        !toolbarPopupOpen;

    return (
        <>
            <LocalViewerFrame
                docId={DEMO_DOC_ID}
                bytes={bytes}
                onStoreReady={onStoreReady}
                viewportKey={viewportKey}
                showViewport={phase === 'ready'}
                placeholder={
                    <div className="flex h-full items-center justify-center p-8">
                        {wipeFailed ? (
                            <EmptyState title="Couldn’t clear your markings" body={WIPE_FAILED_BODY[wipeFailed]}>
                                {/* Secondary: Start free in the header stays the one primary. */}
                                <Button variant="secondary" onClick={retryWipe}>
                                    Try again
                                </Button>
                            </EmptyState>
                        ) : (
                            <LoadingText>
                                {phase === 'clearing' ? 'Clearing your markings…' : 'Loading demo…'}
                            </LoadingText>
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
                        <KeepToggle keep={keep} help={keepHelp} onToggle={toggleKeep} />
                        <DemoMenu keep={keep} help={keepHelp} onToggleKeep={toggleKeep} />
                        {/* The one primary: everything else in the demo is ghost or subtle. */}
                        <Link to={SIGN_UP_TO} className={buttonClassName('primary', 'sm', `ml-auto lg:ml-0 ${HIT_Y}`)}>
                            Start free
                        </Link>
                    </ViewerHeader>
                }
                notices={
                    <>
                        {confirmingClear ? (
                            <ConfirmClear id={confirmId} onClear={startOver} onCancel={cancelClear} />
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
                        notice leaves its Export (and Discard) out without one, and
                        words its copy to match. */}
                        <InkSaveFailedNotice store={annotationStore} />
                    </>
                }
                // Not a notice: a notice is fitted around, and the score would jump
                // up under the visitor's first stroke as the hint went.
                overlay={showHint ? <DrawHint onDismiss={() => setHintHidden(true)} /> : null}
            />
            {showValueCard ? <DemoValueCard signUpTo={SIGN_UP_TO} onDismiss={dismissValueCard} /> : null}
        </>
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
                className={buttonClassName('ghost', 'sm', `max-sm:hidden ${HIT_Y}`)}
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
 * Escape cancels, and goes no further (the viewport's keys skip a handled
 * event).
 */
const ConfirmClear = ({ id, onClear, onCancel }: { id: string; onClear: () => void; onCancel: () => void }) => {
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
                Clear all your markings?
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
            className="relative grid shrink-0 place-items-center rounded-lg p-1.5 text-stone-500 hover:bg-ink/5 hover:text-stone-700 pointer-coarse:before:absolute pointer-coarse:before:-inset-2.5"
        >
            <CloseIcon size={14} />
        </button>
    </div>
);
