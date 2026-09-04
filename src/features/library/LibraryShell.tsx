import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate } from 'react-router';

import { RequireRegistered } from '@/features/auth/AuthGates';
import { displayNameOf, signOut } from '@/features/auth/session';
import { recordImportStatus, shouldOfferImport } from '@/features/import/importPromptService';
import { prescanDocument } from '@/features/import/prescan';
import { UPLOAD_ACCEPT } from '@/features/import/prepareUpload';
import { importDocumentFromImslp, loadDocumentBytes, uploadDocument } from '@/features/library/documentsService';
import {
    prependCachedLibraryDocument,
    readCachedLibraryList,
    type LibraryListSnapshot,
} from '@/features/library/libraryBootstrap';
import { requestScoreAnalysis } from '@/features/playback/scoreAnalysisService';
import { isSupabaseConfigured } from '@/lib/supabase';
import type { DocumentRow, EffectiveTier } from '@/types/database';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import { PlanBadge } from '@/features/billing/PlanBadge';
import { clearCachedEntitlements } from '@/features/billing/entitlementsService';
import { isLimitReachedError, type LimitReachedError } from '@/features/billing/limitErrors';
import { useEntitlements } from '@/features/billing/useEntitlements';
import { buttonClassName } from '@/ui/classNames';
import { ChevronDownIcon, UploadIcon } from '@/ui/icons';
import { ProgressBar } from '@/ui/ProgressBar';

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
    ) => Promise<{ ok: true } | { ok: false; openUrl: string; message: string }>;
    uploadError: string | null;
    clearUploadError: () => void;
    /** Set when the server refused for quota reasons rather than a real failure. */
    uploadLimit: LimitReachedError | null;
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

const NAV_LINK_BASE = 'shrink-0 rounded-lg px-3 py-1.5 text-sm transition';
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
    const [uploadError, setUploadError] = useState<string | null>(null);
    const [importOffer, setImportOffer] = useState<DocumentRow | null>(null);
    const [uploadLimit, setUploadLimit] = useState<LimitReachedError | null>(null);
    const [pricingOpen, setPricingOpen] = useState(false);
    const { entitlements } = useEntitlements(userId, { viaLibraryBootstrap: true });
    const tier = entitlements?.tier ?? 'free';
    // Hidden until the plan is known rather than shown and withdrawn: entitlements
    // come back from the Dexie cache on any repeat visit, so the wait is a frame,
    // and offering a roster only to retract it is the worse of the two flickers.
    const canManageStudents = entitlements !== null && entitlements.limits.students !== 0;
    const navItems = NAV_ITEMS.filter((item) => !item.needsStudents || canManageStudents);
    const navigate = useNavigate();
    const uploading = uploadPct !== null || importingImslp;

    const clearErrors = () => {
        setUploadError(null);
        setUploadLimit(null);
    };

    /** Drop the cached plan too — a shared device must not leak the last teacher's tier. */
    const handleSignOut = async () => {
        await clearCachedEntitlements(userId).catch(() => undefined);
        await signOut();
    };

    /**
     * A quota refusal is not a failure to report as one: it gets its own state so
     * the library can offer an upgrade instead of showing red error text.
     */
    const captureFailure = (err: unknown, fallback: string) => {
        if (isLimitReachedError(err)) {
            setUploadLimit(err);
            return;
        }
        setUploadError(err instanceof Error ? err.message : fallback);
    };

    /**
     * The library snapshot, read before the write that will clear it, so the
     * new score can be put at the top of it afterwards and the return from the
     * viewer paints instantly instead of loading.
     */
    const snapshotBefore = (): Promise<LibraryListSnapshot | null> => readCachedLibraryList(userId).catch(() => null);
    const rememberNewScore = (before: Promise<LibraryListSnapshot | null>, document: DocumentRow) =>
        void before.then((snapshot) => prependCachedLibraryDocument(userId, snapshot, document)).catch(() => undefined);

    const onUpload = async (file: File) => {
        clearErrors();
        setUploadPct(0);
        const before = snapshotBefore();
        try {
            const { document } = await uploadDocument(file, userId, ({ loaded, total }) => {
                const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
                setUploadPct(pct);
            });
            rememberNewScore(before, document);
            // Kick off play-along analysis in the background; the viewer's
            // transport bar reports progress and offers a retry on failure.
            void requestScoreAnalysis(document.id).catch(() => undefined);
            // Free, local prescan: does this score already carry colored-ink
            // markings? If so (and the user never declined), offer the import.
            try {
                const bytes = await loadDocumentBytes(document, { userId });
                if ((await prescanDocument(bytes)) && (await shouldOfferImport(document.id))) {
                    setImportOffer(document);
                    return; // the dialog decides where to navigate
                }
            } catch {
                // Best-effort — never block the upload flow.
            }
            navigate(`/doc/${document.id}`);
        } catch (err) {
            captureFailure(err, 'Upload failed.');
            throw err;
        } finally {
            setUploadPct(null);
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

    const onImportImslp = async (filename: string, workTitle: string, acceptedDisclaimer: boolean) => {
        clearErrors();
        // The Edge function fetches server-side, so there is no byte progress
        // to report — show the indeterminate bar instead of a stuck 0%.
        setImportingImslp(true);
        const before = snapshotBefore();
        try {
            const result = await importDocumentFromImslp(filename, workTitle, userId, acceptedDisclaimer);
            if (!result.ok) {
                return {
                    ok: false as const,
                    openUrl: result.fallback.openUrl,
                    message: result.fallback.message,
                };
            }
            rememberNewScore(before, result.document);
            void requestScoreAnalysis(result.document.id).catch(() => undefined);
            navigate(`/doc/${result.document.id}`);
            return { ok: true as const };
        } catch (err) {
            captureFailure(err, 'Import failed.');
            throw err;
        } finally {
            setImportingImslp(false);
        }
    };

    const outlet: LibraryOutletContext = {
        userId,
        uploadPct,
        uploading,
        onUpload,
        onImportImslp,
        uploadError,
        clearUploadError: clearErrors,
        uploadLimit,
        tier,
        canManageStudents,
        openPricing: () => setPricingOpen(true),
    };

    return (
        <main className="paper-page min-h-full">
            {/* Translucent so the paper wash reads through; sticky so upload
                progress and the account menu stay reachable from any page. */}
            <header className="sticky top-0 z-30 border-b border-line bg-paper/85 backdrop-blur">
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
                        className="no-scrollbar order-last -mx-4 flex w-[calc(100%+2rem)] items-center gap-1 overflow-x-auto px-4 sm:order-none sm:mx-0 sm:w-auto sm:overflow-x-visible sm:px-0"
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
                        <ShellUploadButton uploading={uploading} onUpload={onUpload} />
                        <AccountMenu
                            userLabel={userLabel}
                            userEmail={userEmail}
                            tier={tier}
                            onSignOut={() => void handleSignOut()}
                        />
                    </div>
                </div>
                {uploadPct !== null ? (
                    <ProgressBar
                        value={uploadPct}
                        label="Uploading score"
                        className="shell-progress absolute inset-x-0 bottom-0"
                    />
                ) : importingImslp ? (
                    <ProgressBar
                        indeterminate
                        label="Importing from IMSLP"
                        className="shell-progress absolute inset-x-0 bottom-0"
                    />
                ) : null}
            </header>

            <div className={`library-layout ${SHELL_CONTAINER} py-8 lg:py-10`}>
                <div className="library-shell min-w-0">
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
                    <PricingDialog currentTier={tier} onClose={() => setPricingOpen(false)} />
                </Suspense>
            ) : null}
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
    onUpload,
}: {
    uploading: boolean;
    onUpload: (file: File) => Promise<void>;
}) => (
    <label
        className={buttonClassName(
            'primary',
            'sm',
            `shell-upload${uploading ? ' pointer-events-none opacity-80' : ''}`,
        )}
    >
        <UploadIcon size={16} />
        <span className="sr-only sm:not-sr-only">{uploading ? 'Uploading…' : 'Upload score'}</span>
        <input
            type="file"
            accept={UPLOAD_ACCEPT}
            className="sr-only"
            disabled={uploading}
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
 * Two letters standing in for a face: first initials of a two-word display
 * name, else the opening of the local part of the email. Never empty — an
 * avatar with nothing in it reads as a broken image.
 */
const initialsOf = (label: string): string => {
    const words = label.trim().split(/\s+/).filter(Boolean);
    const first = words[0] ?? '';
    const second = words[1];
    if (second) {
        return `${first.slice(0, 1)}${second.slice(0, 1)}`.toUpperCase();
    }
    const localPart = first.split('@')[0] ?? '';
    return localPart.slice(0, 2).toUpperCase() || '?';
};

/**
 * Account cluster at the right end of the bar: identity, plan, and the two
 * destinations that used to live in the sidebar. Closes on outside pointerdown,
 * Escape and route change so it can never outlive the page it was opened from.
 */
const AccountMenu = ({
    userLabel,
    userEmail,
    tier,
    onSignOut,
}: {
    userLabel: string;
    userEmail: string;
    tier: EffectiveTier;
    onSignOut: () => void;
}) => {
    // The route the menu was opened from, rather than a plain boolean: navigating
    // away closes it during render, with no effect that resets state after paint.
    const [openedAt, setOpenedAt] = useState<string | null>(null);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const { pathname } = useLocation();
    const open = openedAt === pathname;
    const close = () => setOpenedAt(null);
    // Forget the route the moment it stops being the one we are on. The listeners
    // below see pointerdown and Escape only, so a link taken from the keyboard —
    // or Back, or a navigate() — leaves the old pathname sitting there, and
    // returning to that page would re-derive `open` and put the menu up again with
    // nobody having touched it. During render, so still no effect resetting state
    // after paint.
    if (openedAt !== null && !open) {
        setOpenedAt(null);
    }

    useEffect(() => {
        if (!open) {
            return;
        }
        const onPointerDown = (e: PointerEvent) => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
                close();
            }
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                close();
            }
        };
        window.addEventListener('pointerdown', onPointerDown);
        window.addEventListener('keydown', onKey);
        return () => {
            window.removeEventListener('pointerdown', onPointerDown);
            window.removeEventListener('keydown', onKey);
        };
    }, [open]);

    // displayNameOf falls back to the email, so only show the second line when
    // it would actually say something the first line does not.
    const secondary = userEmail && userEmail !== userLabel ? userEmail : null;

    return (
        <div ref={rootRef} className="relative">
            <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={`Account menu (${userLabel})`}
                onClick={() => setOpenedAt(open ? null : pathname)}
                className="flex cursor-pointer items-center gap-1 rounded-full p-0.5 transition hover:bg-ink/5 sm:pr-1.5"
            >
                <span
                    aria-hidden="true"
                    className="grid h-8 w-8 place-items-center rounded-full bg-accent-soft text-xs font-semibold text-accent"
                >
                    {initialsOf(userLabel)}
                </span>
                <ChevronDownIcon size={16} className="hidden text-stone-500 sm:block" />
            </button>
            {open ? (
                <div
                    role="menu"
                    aria-label="Account"
                    className="absolute right-0 z-40 mt-2 w-64 rounded-xl border border-stone-200 bg-white py-1 shadow-lg"
                >
                    <div className="px-3 py-2">
                        <p className="truncate text-sm font-medium text-stone-800">{userLabel}</p>
                        {secondary ? <p className="truncate text-xs text-stone-500">{secondary}</p> : null}
                        <PlanBadge tier={tier} className="mt-2" />
                    </div>
                    <div className="my-1 border-t border-stone-200" />
                    <Link
                        role="menuitem"
                        to="/account"
                        onClick={close}
                        className="block px-3 py-2 text-sm text-stone-800 transition hover:bg-ink/5"
                    >
                        Account
                    </Link>
                    <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                            close();
                            onSignOut();
                        }}
                        className="w-full cursor-pointer px-3 py-2 text-left text-sm text-stone-800 transition hover:bg-ink/5"
                    >
                        Sign out
                    </button>
                </div>
            ) : null}
        </div>
    );
};
