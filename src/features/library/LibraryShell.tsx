import { Suspense, lazy, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate } from 'react-router';

import { initialsOf } from '@/features/account/initials';
import { RequireRegistered } from '@/features/auth/AuthGates';
import { displayNameOf, signOut } from '@/features/auth/session';
import { useGuardedSignOut } from '@/features/auth/useGuardedSignOut';
import { recordImportStatus, shouldOfferImport } from '@/features/import/importPromptService';
import { LEGAL_ENTITY } from '@/features/legal/legalEntity';
import { UPLOAD_ACCEPT } from '@/features/import/prepareUpload';
import { isImslpImportCancelled, type ImslpDownloadStage } from '@/features/imslp/imslpApi';
import { importDocumentFromImslp, loadDocumentBytes, uploadDocument } from '@/features/library/documentsService';
import {
    fetchLibraryBootstrap,
    recentLibraryBootstrap,
    prependCachedLibraryDocument,
    readCachedLibraryList,
    type LibraryListSnapshot,
} from '@/features/library/libraryBootstrap';
import { features } from '@/lib/features';
import { prefersReducedMotion } from '@/lib/motion';
import { isSupabaseConfigured } from '@/lib/supabase';
import type { DocumentRow, EffectiveTier } from '@/types/database';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import { PlanBadge } from '@/features/billing/PlanBadge';
import { clearCachedEntitlements, isUnlimited } from '@/features/billing/entitlementsService';
import {
    cloudScoreCapReached,
    cloudScoresLimitError,
    isLimitReachedError,
    parseLooseLimitError,
    type LimitReachedError,
} from '@/features/billing/limitErrors';
import { ownSubscriptionOf } from '@/features/billing/planStatus';
import { useEntitlements } from '@/features/billing/useEntitlements';
import { buttonClassName } from '@/ui/classNames';
import { ChevronDownIcon, UploadIcon } from '@/ui/icons';
import { Menu, MenuItem, MenuSeparator } from '@/ui/Menu';
import { ProgressBar } from '@/ui/ProgressBar';
import { SwapLabel } from '@/ui/SwapLabel';
import { toast } from '@/ui/toast';

/** The legal documents, as the account menu's last row lists them. */
const LEGAL_MENU_LINKS = [
    { to: '/privacy', label: 'Privacy' },
    { to: '/terms', label: 'Terms' },
    { to: '/refunds', label: 'Refunds' },
    { to: '/copyright', label: 'Copyright' },
] as const;

// Lazy for the same reason as the account route: pricing copy is rarely needed.
const PricingDialog = lazy(() =>
    import('@/features/billing/PricingDialog').then((m) => ({ default: m.PricingDialog })),
);

export type LibraryOutletContext = {
    userId: string;
    uploadPct: number | null;
    uploading: boolean;
    onUpload: (file: File) => Promise<void>;
    onImportImslp: (
        filename: string,
        workTitle: string,
        acceptedDisclaimer: boolean,
        onStage?: (stage: ImslpDownloadStage) => void,
        /**
         * Aborted when the user cancels a queued import or leaves the page. A
         * queued import then stops (ImslpImportCancelledError); one already
         * sent finishes and lands in the library, without navigating.
         */
        signal?: AbortSignal,
    ) => Promise<{ ok: true } | { ok: false; openUrl: string; message: string }>;
    /** The finished upload's bar is fading out, just before the viewer opens. */
    uploadFading?: boolean;
    clearUploadError: () => void;
    /** Set when the server refused for quota reasons rather than a real failure. */
    uploadLimit: LimitReachedError | null;
    /**
     * The limit to explain on the page: the server's refusal if there was one,
     * else the owned-score cap the account is already at. The upload button is
     * greyed out at the cap, so a page that waited for a refusal would leave a
     * disabled button with no reason and no way on.
     */
    limitNotice?: LimitReachedError | null;
    /**
     * Client-side owned-score cap (or student limit 0), or a cloud-score refusal.
     * Disables Add/Upload; `limitNotice` says why.
     */
    quotaExhausted?: boolean;
    /**
     * This month's IMSLP imports are spent (the server's 402 said so). Blocks
     * the IMSLP Add button only — uploading a PDF of your own is still open.
     */
    importLimit?: LimitReachedError | null;
    /** False on student (limit 0): disabled copy, no upgrade CTA. */
    quotaUpgradeHint?: boolean;
    tier: EffectiveTier;
    /**
     * Whether this plan includes a student roster at all.
     *
     * Not a quota — a full roster is still the server's 402 to raise. This is the
     * capability itself: Personal is a solo plan and a provisioned student has
     * nobody to teach, so both get `students: 0` from tier_limits() and never see
     * the roster or the assign action. Read straight off the server's limits so
     * it cannot drift from the tiers.
     */
    canManageStudents: boolean;
    openPricing: () => void;
};

/**
 * A finished upload's bar, on its way out: the fill slides to 100% (the
 * ProgressBar's 200ms transform), holds there a beat so the eye sees it
 * complete, then fades (150ms) — and only then does the viewer open. Without
 * it the bar was taken down wherever the last progress event had left it.
 */
const BAR_FILL_MS = 200;
const BAR_HOLD_MS = 120;
const BAR_FADE_MS = 150;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const NAV_ITEMS: { to: string; label: string; shortLabel?: string; end: boolean; needsStudents?: boolean }[] = [
    { to: '/library', label: 'Library', end: true },
    { to: '/students', label: 'Students', end: true, needsStudents: true },
    { to: '/search', label: 'Find on IMSLP', shortLabel: 'IMSLP', end: true },
];

/**
 * One measure for the whole shell: the top bar's inner row and the content
 * column share it so the wordmark, the nav and the page heading sit on the
 * same left edge. 100rem (1600px) keeps ~160px gutters at 1920 instead of the
 * 896px of dead space a max-w-5xl column left behind.
 */
const SHELL_CONTAINER = 'mx-auto w-full max-w-[100rem] px-4 sm:px-6 lg:px-10';

const NAV_LINK_BASE = 'shrink-0 rounded-lg px-3 py-1.5 text-sm transition-colors';
const NAV_LINK_ACTIVE = 'bg-white/70 font-medium text-stone-900 shadow-sm ring-1 ring-stone-300/50';
const NAV_LINK_IDLE = 'text-stone-600 hover:bg-ink/5 hover:text-stone-900';

/** Authenticated app chrome: top bar + shared upload for library/search. */
export const LibraryShell = () => {
    if (!isSupabaseConfigured()) {
        return <Navigate to="/" replace />;
    }
    return (
        <RequireRegistered>
            {(session) => (
                <LibraryFrame
                    userId={session.user.id}
                    userLabel={displayNameOf(session)}
                    userEmail={session.user.email ?? ''}
                />
            )}
        </RequireRegistered>
    );
};

const LibraryFrame = ({ userId, userLabel, userEmail }: { userId: string; userLabel: string; userEmail: string }) => {
    const [uploadPct, setUploadPct] = useState<number | null>(null);
    const [importingImslp, setImportingImslp] = useState(false);
    /** The IMSLP import landed: its sweep becomes a full bar for the finishing beat. */
    const [imslpFilled, setImslpFilled] = useState(false);
    /** The top bar's progress is fading out (settleBar). */
    const [barFading, setBarFading] = useState(false);
    const [importOffer, setImportOffer] = useState<DocumentRow | null>(null);
    const [uploadLimit, setUploadLimit] = useState<LimitReachedError | null>(null);
    const [capReached, setCapReached] = useState(false);
    const [pricingOpen, setPricingOpen] = useState(false);
    const { entitlements } = useEntitlements(userId, { viaLibraryBootstrap: true });
    const headerRef = useRef<HTMLElement | null>(null);
    const [barHeight, setBarHeight] = useState<number | null>(null);

    // Publish the bar's real height to whatever sticks below it (the IMSLP
    // search bar). The rem fallback in index.css can't know the safe-area
    // inset the bar pads itself with, or how its nav row wraps, so a guess
    // left a slit (or, on a notched phone, an overlap) under it.
    useEffect(() => {
        const header = headerRef.current;
        if (!header || typeof ResizeObserver === 'undefined') {
            return;
        }
        const measure = () => setBarHeight(header.getBoundingClientRect().height);
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(header);
        return () => observer.disconnect();
    }, []);
    const tier = entitlements?.tier ?? 'free';
    // Hidden until the plan is known rather than shown and withdrawn: entitlements
    // come back from the Dexie cache on any repeat visit, so the wait is a frame,
    // and offering a roster only to retract it is the worse of the two flickers.
    const canManageStudents = entitlements !== null && entitlements.limits.students !== 0;
    const navItems = NAV_ITEMS.filter((item) => !item.needsStudents || canManageStudents);
    const navigate = useNavigate();
    // Where the teacher is, read by an upload that finishes later: a bar they
    // have navigated away from has no one to finish in front of.
    const { pathname } = useLocation();
    const pathnameRef = useRef(pathname);
    useEffect(() => {
        pathnameRef.current = pathname;
    }, [pathname]);
    const uploading = uploadPct !== null || importingImslp;
    const cloudScoreLimit = entitlements?.limits.cloud_scores;
    const quotaUpgradeHint = cloudScoreLimit !== 0;
    const atScoreCap =
        cloudScoreLimit === 0 || (typeof cloudScoreLimit === 'number' && !isUnlimited(cloudScoreLimit) && capReached);
    // Only a cloud-score refusal blocks uploading. An IMSLP-import refusal is a
    // different allowance: the teacher can still upload a PDF of their own.
    const quotaExhausted = atScoreCap || uploadLimit?.metric === 'cloud_scores';
    const importLimit = uploadLimit?.metric === 'smart_imports' ? uploadLimit : null;
    const limitNotice =
        uploadLimit ??
        (atScoreCap && entitlements && typeof cloudScoreLimit === 'number'
            ? cloudScoresLimitError(cloudScoreLimit, entitlements.tier)
            : null);

    const clearErrors = () => {
        setUploadLimit(null);
    };

    /** Drop the cached plan too — a shared device must not leak the last teacher's tier. */
    const handleSignOut = async () => {
        await clearCachedEntitlements(userId).catch(() => undefined);
        await signOut();
    };
    // Uploads (or asks about) unsynced marks first — sign-out clears them.
    const { requestSignOut, checking: savingBeforeSignOut, dialog: signOutDialog } = useGuardedSignOut(handleSignOut);

    /**
     * A quota refusal is not a failure to report as one: it gets its own state so
     * the library can offer an upgrade, inline, where it stays. Anything else is
     * a toast — the upload is over, and nothing on the page waits on the error.
     * True for a quota refusal.
     */
    const captureFailure = (err: unknown, fallback: string): boolean => {
        if (isLimitReachedError(err)) {
            setUploadLimit(err);
            return true;
        }
        const loose = parseLooseLimitError(err, entitlements);
        if (loose) {
            setUploadLimit(loose);
            return true;
        }
        toast.error(err instanceof Error && err.message ? err.message : fallback);
        return false;
    };

    /**
     * See the bar out before the page moves on (BAR_FILL_MS): wait out the
     * fill (unless it is already there, or jumps under reduced motion) and the
     * hold, then fade. A teacher who has navigated away meanwhile is not kept
     * waiting on a bar that is no longer in front of them.
     */
    const settleBar = async (startedAt: string, { fillMs, hold }: { fillMs: number; hold: boolean }) => {
        const stillHere = () => pathnameRef.current === startedAt;
        if (hold && stillHere()) {
            await wait((prefersReducedMotion() ? 0 : fillMs) + BAR_HOLD_MS);
        }
        if (!stillHere()) {
            return;
        }
        setBarFading(true);
        await wait(BAR_FADE_MS);
    };

    /**
     * The client-side half of the cap, checked before anything is sent. It
     * refuses with the same typed error the server's trigger would, so the page
     * shows the plan notice (with its way to upgrade) rather than a bare red
     * "limit reached". A plan with no cloud scores at all (limit 0) gets the same
     * typed refusal: ScoreLimitNotice already words it as the plain sentence, and
     * a plain Error here would repeat that sentence as red error text below it.
     */
    const refuseIfCloudScoreCap = async (
        snapshot: Promise<LibraryListSnapshot | null>,
    ): Promise<LibraryListSnapshot | null> => {
        const snap = await snapshot.catch(() => null);
        const limit = entitlements?.limits.cloud_scores;
        if (
            entitlements &&
            typeof limit === 'number' &&
            (limit === 0 || cloudScoreCapReached(limit, snap?.documents ?? [], userId))
        ) {
            setCapReached(true);
            throw cloudScoresLimitError(limit, entitlements.tier);
        }
        setCapReached(false);
        return snap;
    };

    const refreshCap = (docs: Array<{ owner_id: string; archived_at: string | null }>) => {
        const limit = entitlements?.limits.cloud_scores;
        if (limit === undefined || isUnlimited(limit)) {
            setCapReached(false);
            return;
        }
        if (limit === 0) {
            setCapReached(true);
            return;
        }
        setCapReached(cloudScoreCapReached(limit, docs, userId));
    };

    const clearUploadError = () => {
        clearErrors();
        void readCachedLibraryList(userId)
            .then((snap) => refreshCap(snap?.documents ?? []))
            .catch(() => undefined);
        void fetchLibraryBootstrap(userId)
            .then((boot) => refreshCap(boot.documents))
            .catch(() => undefined);
    };

    useEffect(() => {
        if (!userId || !entitlements) {
            return;
        }
        const limit = entitlements.limits.cloud_scores;
        if (isUnlimited(limit) || limit === 0) {
            return;
        }
        let cancelled = false;
        const apply = (docs: Array<{ owner_id: string; archived_at: string | null }>) => {
            if (!cancelled) {
                refreshCap(docs);
            }
        };
        // The answer that brought these entitlements usually just landed:
        // count from it rather than ask for the whole library again.
        const known = recentLibraryBootstrap(userId);
        if (known) {
            apply(known.documents);
            return () => {
                cancelled = true;
            };
        }
        void readCachedLibraryList(userId)
            .then((snap) => {
                if (snap) {
                    apply(snap.documents);
                }
            })
            .catch(() => undefined);
        void fetchLibraryBootstrap(userId)
            .then((boot) => apply(boot.documents))
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
        // refreshCap reads the latest entitlements/userId from this effect's closure.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [userId, entitlements]);

    /**
     * The library snapshot, read before the write that will clear it, so the
     * new score can be put at the top of it afterwards and the return from the
     * viewer paints instantly instead of loading.
     */
    const snapshotBefore = (): Promise<LibraryListSnapshot | null> => readCachedLibraryList(userId).catch(() => null);
    const rememberNewScore = (before: Promise<LibraryListSnapshot | null>, document: DocumentRow) =>
        void before.then((snapshot) => prependCachedLibraryDocument(userId, snapshot, document)).catch(() => undefined);

    const onUpload = async (file: File) => {
        const before = snapshotBefore();
        const startedAt = pathnameRef.current;
        let barShown = false;
        let lastPct = 0;
        try {
            const beforeSnap = await refuseIfCloudScoreCap(before);
            clearErrors();
            setUploadPct(0);
            barShown = true;
            const { document } = await uploadDocument(file, userId, ({ loaded, total }) => {
                lastPct = total > 0 ? Math.round((loaded / total) * 100) : 0;
                setUploadPct(lastPct);
            });
            // Done, whatever the last progress event said: fill the bar.
            setUploadPct(100);
            rememberNewScore(before, document);
            refreshCap([document, ...(beforeSnap?.documents ?? [])]);
            // Play-along analysis is never started here: it costs an OMR run,
            // so only the viewer's Generate button requests it.
            // Free, local prescan: does this score already carry colored-ink
            // markings? If so (and the user never declined), offer the import.
            // Not asked at all while smart import is off (features.smartImport).
            if (features.smartImport) {
                try {
                    // Loaded after an upload only: the page rasterizer and segmenter
                    // have no business in the bundle every library visit pays for.
                    const [bytes, { prescanDocument }] = await Promise.all([
                        loadDocumentBytes(document, { userId }),
                        import('@/features/import/prescan'),
                    ]);
                    if ((await prescanDocument(bytes)) && (await shouldOfferImport(document.id))) {
                        await settleBar(startedAt, { fillMs: 0, hold: true });
                        toast.success('Score uploaded', { description: document.title });
                        setImportOffer(document);
                        return; // the dialog decides where to navigate
                    }
                } catch {
                    // Best-effort — never block the upload flow.
                }
            }
            await settleBar(startedAt, { fillMs: lastPct === 100 ? 0 : BAR_FILL_MS, hold: true });
            // Together, so the toast lands on the viewer as it opens.
            navigate(`/doc/${document.id}`);
            toast.success('Score uploaded', { description: document.title });
        } catch (err) {
            const quota = captureFailure(err, 'Upload failed.');
            // A failure does not fill: the bar fades where it stopped.
            if (barShown && !quota) {
                await settleBar(startedAt, { fillMs: 0, hold: false });
            }
            throw err;
        } finally {
            setUploadPct(null);
            setBarFading(false);
        }
    };

    const resolveImportOffer = (accepted: boolean) => {
        const doc = importOffer;
        if (!doc) {
            return;
        }
        setImportOffer(null);
        void recordImportStatus(doc.id, accepted ? 'prompted' : 'declined');
        navigate(accepted ? `/doc/${doc.id}?import=1` : `/doc/${doc.id}`);
    };

    const onImportImslp = async (
        filename: string,
        workTitle: string,
        acceptedDisclaimer: boolean,
        onStage?: (stage: ImslpDownloadStage) => void,
        signal?: AbortSignal,
    ) => {
        const before = snapshotBefore();
        const startedAt = pathnameRef.current;
        let barShown = false;
        try {
            const beforeSnap = await refuseIfCloudScoreCap(before);
            clearErrors();
            // The Edge function fetches server-side, so there is no byte progress
            // to report — show the indeterminate bar instead of a stuck 0%.
            setImportingImslp(true);
            barShown = true;
            const result = await importDocumentFromImslp(filename, workTitle, userId, acceptedDisclaimer, {
                onStage,
                signal,
            });
            if (!result.ok) {
                return {
                    ok: false as const,
                    openUrl: result.fallback.openUrl,
                    message: result.fallback.message,
                };
            }
            rememberNewScore(before, result.document);
            refreshCap([result.document, ...(beforeSnap?.documents ?? [])]);
            // The user cancelled or moved on while this was in flight: the
            // score is in their library, but they are not pulled back to it
            // (nor kept waiting on the bar) — the toast says where it went.
            if (!signal?.aborted) {
                // The sweep becomes a full bar for the same finishing beat.
                setImslpFilled(true);
                await settleBar(startedAt, { fillMs: 0, hold: true });
                navigate(`/doc/${result.document.id}`);
            }
            toast.success('Imported from IMSLP', { description: result.document.title });
            return { ok: true as const };
        } catch (err) {
            // A cancelled queue wait created nothing and is not a failure.
            if (!isImslpImportCancelled(err)) {
                const quota = captureFailure(err, 'Import failed.');
                if (barShown && !quota) {
                    await settleBar(startedAt, { fillMs: 0, hold: false });
                }
            }
            throw err;
        } finally {
            setImportingImslp(false);
            setImslpFilled(false);
            setBarFading(false);
        }
    };

    const outlet: LibraryOutletContext = {
        userId,
        uploadPct,
        uploading,
        onUpload,
        onImportImslp,
        uploadFading: barFading,
        clearUploadError,
        uploadLimit,
        limitNotice,
        quotaExhausted,
        importLimit,
        quotaUpgradeHint,
        tier,
        canManageStudents,
        openPricing: () => setPricingOpen(true),
    };

    return (
        <main className="paper-page min-h-full">
            {/* Translucent so the paper wash reads through; sticky so upload
                progress and the account menu stay reachable from any page. */}
            <header
                ref={headerRef}
                className="chrome-paper sticky top-0 z-30 border-b border-line bg-paper/85 pt-[var(--safe-top)] pl-[var(--safe-left)] pr-[var(--safe-right)] backdrop-blur"
            >
                <div
                    className={`${SHELL_CONTAINER} flex flex-wrap items-center gap-x-4 gap-y-2 py-2.5 sm:h-16 sm:flex-nowrap sm:gap-x-6 sm:py-0`}
                >
                    <Link to="/library" className="landing-brand shrink-0 font-display text-2xl font-semibold">
                        Cleffy
                    </Link>

                    {/* Below sm the strip drops to its own row (order-last) and scrolls
                        sideways rather than wrapping. The negative margin cancels the
                        container's gutter so the strip runs edge to edge, and the
                        matching width keeps it that wide — a plain w-full would stop
                        one gutter short and strand the last link behind a dead margin. */}
                    <nav
                        aria-label="Main"
                        className="no-scrollbar order-last -mx-4 flex w-[calc(100%+2rem)] items-center gap-1 overflow-x-auto overscroll-x-contain px-4 sm:order-none sm:mx-0 sm:w-auto sm:overflow-x-visible sm:px-0"
                    >
                        {navItems.map((item) => (
                            <NavLink
                                key={item.to}
                                to={item.to}
                                end={item.end}
                                className={({ isActive }) =>
                                    `${NAV_LINK_BASE} ${isActive ? NAV_LINK_ACTIVE : NAV_LINK_IDLE}`
                                }
                            >
                                {item.shortLabel ? (
                                    <>
                                        <span className="sm:hidden">{item.shortLabel}</span>
                                        <span className="hidden sm:inline">{item.label}</span>
                                    </>
                                ) : (
                                    item.label
                                )}
                            </NavLink>
                        ))}
                    </nav>

                    <div className="ml-auto flex shrink-0 items-center gap-2">
                        <ShellUploadButton uploading={uploading} quotaExhausted={quotaExhausted} onUpload={onUpload} />
                        {/* The menu closes on click, and the upload before sign-out can
                            take seconds on a slow connection: say what is happening
                            where the menu was, or the click looks like it did nothing. */}
                        {savingBeforeSignOut ? (
                            <span role="status" className="text-sm text-stone-600">
                                Saving changes…
                            </span>
                        ) : null}
                        <AccountMenu
                            userLabel={userLabel}
                            userEmail={userEmail}
                            tier={tier}
                            signingOut={savingBeforeSignOut}
                            onSignOut={() => void requestSignOut()}
                        />
                    </div>
                </div>
                {uploadPct !== null ? (
                    <ProgressBar
                        value={uploadPct}
                        label="Uploading score"
                        done={barFading}
                        className="shell-progress absolute inset-x-0 bottom-0"
                    />
                ) : importingImslp ? (
                    <ProgressBar
                        indeterminate={!imslpFilled}
                        value={100}
                        label="Importing from IMSLP"
                        done={barFading}
                        className="shell-progress absolute inset-x-0 bottom-0"
                    />
                ) : savingBeforeSignOut ? (
                    <ProgressBar
                        indeterminate
                        label="Saving changes before signing out"
                        className="shell-progress absolute inset-x-0 bottom-0"
                    />
                ) : null}
            </header>

            <div className={`${SHELL_CONTAINER} py-8 lg:py-10`}>
                <div
                    className="library-shell min-w-0"
                    style={barHeight ? ({ '--shell-bar-height': `${barHeight}px` } as CSSProperties) : undefined}
                >
                    <Outlet context={outlet} />
                </div>
            </div>

            {importOffer ? (
                <ConfirmDialog
                    title="Existing marks found"
                    body="This score already carries handwritten marks (colored ink). Cleffy can lift them off the page and turn them into marks you can edit and erase — you review everything before anything changes."
                    confirmLabel="Review marks"
                    cancelLabel="Not now"
                    onConfirm={() => resolveImportOffer(true)}
                    onCancel={() => resolveImportOffer(false)}
                />
            ) : null}

            {pricingOpen ? (
                <Suspense fallback={null}>
                    <PricingDialog
                        currentTier={tier}
                        subscription={ownSubscriptionOf(entitlements)}
                        onClose={() => setPricingOpen(false)}
                    />
                </Suspense>
            ) : null}

            {signOutDialog}
        </main>
    );
};

/**
 * Upload from anywhere in the shell: the same label-wraps-file-input shape the
 * library page uses. Two deliberate differences, because this one is permanent
 * chrome rather than a control on one page. The caption goes screen-reader-only
 * below sm, which shrinks the button to its icon without unnaming the input.
 * And the input is sr-only rather than display:none, so it stays in the tab
 * order; the label borrows its focus ring, matching the global :focus-visible.
 */
const ShellUploadButton = ({
    uploading,
    quotaExhausted,
    onUpload,
}: {
    uploading: boolean;
    quotaExhausted: boolean;
    onUpload: (file: File) => Promise<void>;
}) => (
    <label
        className={buttonClassName(
            'primary',
            'sm',
            `shell-upload${uploading || quotaExhausted ? ' pointer-events-none opacity-80' : ''}`,
        )}
    >
        <UploadIcon size={16} />
        <SwapLabel
            labels={{ idle: 'Upload score', busy: 'Uploading…' }}
            active={uploading ? 'busy' : 'idle'}
            className="sr-only sm:not-sr-only"
        />
        <input
            type="file"
            accept={UPLOAD_ACCEPT}
            // Named outright: the wrapping label carries the inactive caption
            // too (aria-hidden), which a plain text match would read as one.
            aria-label={uploading ? 'Uploading…' : 'Upload score'}
            className="sr-only"
            disabled={uploading || quotaExhausted}
            onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                    void onUpload(file).catch(() => undefined);
                }
                e.target.value = '';
            }}
        />
    </label>
);

/**
 * Account cluster at the right end of the bar: identity, plan, and the two
 * destinations that used to live in the sidebar. A Base UI menu (outside
 * press, Escape, arrow keys, focus back on the avatar), and also closed by a
 * route change so it can never outlive the page it was opened from.
 */
const AccountMenu = ({
    userLabel,
    userEmail,
    tier,
    signingOut = false,
    onSignOut,
}: {
    userLabel: string;
    userEmail: string;
    tier: EffectiveTier;
    /** The pre-sign-out upload is running; a second click would only queue another. */
    signingOut?: boolean;
    onSignOut: () => void;
}) => {
    // The route the menu was opened from, rather than a plain boolean: navigating
    // away closes it during render, with no effect that resets state after paint.
    const [openedAt, setOpenedAt] = useState<string | null>(null);
    const { pathname } = useLocation();
    const open = openedAt === pathname;
    const close = () => setOpenedAt(null);
    // Forget the route the moment it stops being the one we are on. The menu
    // sees presses and Escape only, so a link taken from the keyboard — or
    // Back, or a navigate() — leaves the old pathname sitting there, and
    // returning to that page would re-derive `open` and put the menu up again with
    // nobody having touched it. During render, so still no effect resetting state
    // after paint.
    if (openedAt !== null && !open) {
        setOpenedAt(null);
    }

    // displayNameOf falls back to the email, so only show the second line when
    // it would actually say something the first line does not.
    const secondary = userEmail && userEmail !== userLabel ? userEmail : null;

    return (
        <Menu
            label={`Account menu (${userLabel})`}
            menuLabel="Account"
            popupClassName="w-64"
            open={open}
            onOpenChange={(next) => setOpenedAt(next ? pathname : null)}
            triggerClassName="flex cursor-pointer items-center gap-1 rounded-full p-0.5 transition-colors hover:bg-ink/5 sm:pr-1.5"
            triggerContent={
                <>
                    <span
                        aria-hidden="true"
                        className="grid h-8 w-8 place-items-center rounded-full bg-accent-soft text-xs font-semibold text-accent"
                    >
                        {initialsOf(userLabel)}
                    </span>
                    <ChevronDownIcon size={16} className="hidden text-stone-500 sm:block" />
                </>
            }
        >
            <div className="px-3 py-2">
                <p className="truncate text-sm font-medium text-stone-800">{userLabel}</p>
                {secondary ? <p className="truncate text-xs text-stone-500">{secondary}</p> : null}
                <PlanBadge tier={tier} className="mt-2" />
            </div>
            <MenuSeparator />
            <MenuItem render={<Link to="/account" />} onClick={close}>
                Account
            </MenuItem>
            <MenuItem render={<a href={`mailto:${LEGAL_ENTITY.contactEmail}`} />} onClick={close}>
                Help &amp; support
            </MenuItem>
            <MenuItem disabled={signingOut} onClick={onSignOut}>
                {signingOut ? 'Saving changes…' : 'Sign out'}
            </MenuItem>
            <MenuSeparator />
            <div className="flex flex-wrap gap-1 px-1.5 pb-0.5">
                {LEGAL_MENU_LINKS.map(({ to, label }) => (
                    <MenuItem
                        key={to}
                        render={<Link to={to} />}
                        onClick={close}
                        className="rounded-md px-1.5 py-1 text-xs text-stone-500 outline-none data-highlighted:bg-ink/5"
                    >
                        {label}
                    </MenuItem>
                ))}
            </div>
        </Menu>
    );
};
