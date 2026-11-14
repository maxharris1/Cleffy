import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';

import { BusyCountdown } from '@/features/share/BusyCountdown';
import { anonymousName } from '@/features/share/anonymousAnimals';
import { LinkSession, pdfUrlOnProject, type DeadAnswer, type ViewerAnswer } from '@/features/share/linkSession';
import { createLinkViewerBackend, readLinkAccess, type LinkViewerBackend } from '@/features/share/linkViewerBackend';
import { PdfProvider } from '@/features/viewer/pdf/PdfProvider';
import { PdfViewport } from '@/features/viewer/PdfViewport';
import { ViewerBackendProvider } from '@/features/viewer/ViewerBackendContext';
import { ViewerHeader } from '@/features/viewer/ViewerHeader';
import { Badge } from '@/ui/Badge';
import { linkClassName } from '@/ui/classNames';
import { LoadingText } from '@/ui/Loading';

/** setTimeout's ceiling; a link expiring further out is re-armed in steps. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** How soon to check the deadline again when it passed during a renewal already in flight. */
const EXPIRY_RECHECK_MS = 1000;

/** How long past the deadline the server has to confirm a renewal before the score is cleared. */
const EXPIRY_CONFIRM_MS = 10_000;

const armAt = (at: number, fire: () => void): (() => void) => {
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
        const left = at - Date.now();
        timer = setTimeout(left > MAX_TIMER_MS ? arm : fire, Math.max(0, Math.min(left, MAX_TIMER_MS)));
    };
    arm();
    return () => clearTimeout(timer);
};

interface LinkViewerPageProps {
    token: string;
    first: ViewerAnswer;
    /** The link stopped working while open: the score is already gone from memory. */
    onDead: (answer: DeadAnswer) => void;
}

/**
 * A signed-out visitor on a view link: the score, read-only and live, with
 * nothing asked and nothing kept. Marks live in an in-memory database, the
 * token in a LinkSession, the PDF in an ArrayBuffer; all of it is dropped
 * when the link dies or the page closes. Each renewal re-arms the expiry
 * deadline from the server's answer and brings in a replaced PDF. At the
 * deadline share-session is asked once more, so an owner's renewal keeps the
 * score open; any answer short of a later expiry, or no answer within
 * EXPIRY_CONFIRM_MS, clears it. A `doc`
 * event or a pull reporting a newer content_rev asks for that renewal early.
 */
export const LinkViewerPage = ({ token, first, onDead }: LinkViewerPageProps) => {
    const [open, setOpen] = useState<{ backend: LinkViewerBackend; bytes: ArrayBuffer } | null>(null);
    const [busy, setBusy] = useState<{ sec: number; attempt: number } | null>(null);
    const onDeadRef = useRef(onDead);
    const membershipRef = useRef<() => void>(() => undefined);
    const renewRef = useRef<() => void>(() => undefined);
    const docReplacedRef = useRef<(contentRev: number) => void>(() => undefined);
    const selfId = useMemo(() => crypto.randomUUID(), []);

    useEffect(() => {
        onDeadRef.current = onDead;
    }, [onDead]);

    useEffect(() => {
        let live = true;
        const cleanups: Array<() => void> = [];
        const end = () => {
            live = false;
            for (const cleanup of cleanups.splice(0)) {
                cleanup();
            }
        };
        const die = (answer: DeadAnswer) => {
            if (live) {
                end();
                onDeadRef.current(answer);
            }
        };
        let stopExpiry: () => void = () => undefined;
        let stopGiveUp: () => void = () => undefined;
        const armExpiry = (linkExpiresAt: string | null) => {
            stopExpiry();
            stopGiveUp();
            stopGiveUp = () => undefined;
            stopExpiry = linkExpiresAt
                ? armAt(new Date(linkExpiresAt).getTime(), () => {
                      stopGiveUp = armAt(Date.now() + EXPIRY_CONFIRM_MS, () =>
                          die({ kind: 'dead', state: 'expired', expiredAt: linkExpiresAt }),
                      );
                      void confirmExpiry(linkExpiresAt);
                  })
                : () => undefined;
        };
        const confirmExpiry = async (linkExpiresAt: string) => {
            const answer = await session.renew();
            if (!live) {
                return;
            }
            if (answer === null) {
                stopExpiry = armAt(Date.now() + EXPIRY_RECHECK_MS, () => void confirmExpiry(linkExpiresAt));
                return;
            }
            const stillLive =
                answer.kind === 'viewer' &&
                (answer.linkExpiresAt === null || new Date(answer.linkExpiresAt).getTime() > Date.now());
            if (!stillLive && answer.kind !== 'dead') {
                die({ kind: 'dead', state: 'expired', expiredAt: linkExpiresAt });
            }
        };
        cleanups.push(
            () => stopExpiry(),
            () => stopGiveUp(),
        );
        let shownRev = first.doc.content_rev;
        let wantedRev = shownRev;
        let pdfLoad = 0;
        const loadPdf = (answer: ViewerAnswer) => {
            const load = ++pdfLoad;
            const rev = answer.doc.content_rev;
            void fetch(pdfUrlOnProject(answer.pdfUrl), {
                cache: 'no-store',
                credentials: 'omit',
                referrerPolicy: 'no-referrer',
            })
                .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(`pdf ${res.status}`))))
                .then((bytes) => {
                    if (live && load === pdfLoad) {
                        shownRev = rev;
                        setOpen({ backend, bytes });
                    }
                })
                .catch(() => {
                    if (answer === first) {
                        die({ kind: 'dead', state: 'unavailable', expiredAt: null });
                    }
                });
        };
        const session = new LinkSession(token, first, {
            onRenewed: (answer) => {
                void session.client.realtime.setAuth(answer.jwt);
                setBusy(null);
                armExpiry(answer.linkExpiresAt);
                if (answer.doc.content_rev > shownRev) {
                    loadPdf(answer);
                }
            },
            onDead: die,
            onBusy: (sec) => setBusy((was) => ({ sec, attempt: (was?.attempt ?? 0) + 1 })),
        });
        const backend = createLinkViewerBackend(session.client);
        cleanups.push(
            () => session.dispose(),
            () => void backend.dispose(),
        );
        renewRef.current = () => void session.renew();
        docReplacedRef.current = (contentRev) => {
            if (contentRev > Math.max(shownRev, wantedRev)) {
                wantedRev = contentRev;
                void session.renew();
            }
        };
        membershipRef.current = () => {
            void readLinkAccess(session.client).then((access) => {
                if (access.status !== 'open') {
                    die({
                        kind: 'dead',
                        state: access.status === 'failed' ? 'unavailable' : access.status,
                        expiredAt: null,
                    });
                }
            });
        };
        armExpiry(first.linkExpiresAt);
        session.start();
        loadPdf(first);
        return end;
    }, [token, first]);

    useEffect(() => {
        const previous = document.title;
        document.title = `${first.doc.title} · View only · Cleffy`;
        return () => {
            document.title = previous;
        };
    }, [first.doc.title]);

    const sync = useMemo(
        () => ({
            userId: selfId,
            name: anonymousName(selfId),
            isAnonymous: true,
            via: 'link' as const,
            canWrite: false,
            onMembershipChanged: () => membershipRef.current(),
            onDocReplaced: (contentRev: number) => docReplacedRef.current(contentRev),
        }),
        [selfId],
    );

    return (
        <div className="fixed inset-0 flex flex-col">
            <ViewerHeader backTo="/" backLabel="Cleffy home" title={first.doc.title}>
                <Badge>View only</Badge>
            </ViewerHeader>
            {busy !== null ? (
                <BusyCountdown
                    key={busy.attempt}
                    retryAfterSec={busy.sec}
                    onRetry={() => renewRef.current()}
                    className="bg-amber-50 px-3 py-1.5 text-sm text-stone-700"
                />
            ) : null}
            <div className="relative min-h-0 flex-1">
                {open ? (
                    <ViewerBackendProvider value={open.backend}>
                        <PdfProvider data={open.bytes}>
                            <PdfViewport docId={first.doc.id} readOnly sync={sync} />
                        </PdfProvider>
                    </ViewerBackendProvider>
                ) : (
                    <LoadingText className="p-8 text-center">Opening the score…</LoadingText>
                )}
            </div>
            <p className="border-t border-stone-200 bg-white px-3 py-1.5 text-center text-xs text-stone-600">
                Nothing about you is kept: no account, no name, nothing saved on this device.{' '}
                <Link to="/children-privacy" className={linkClassName}>
                    What we keep
                </Link>
            </p>
        </div>
    );
};
