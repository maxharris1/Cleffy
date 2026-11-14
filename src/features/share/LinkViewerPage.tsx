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
 * when the link dies or the page closes.
 */
export const LinkViewerPage = ({ token, first, onDead }: LinkViewerPageProps) => {
    const [open, setOpen] = useState<{ backend: LinkViewerBackend; bytes: ArrayBuffer } | null>(null);
    const [busySec, setBusySec] = useState<number | null>(null);
    const onDeadRef = useRef(onDead);
    const membershipRef = useRef<() => void>(() => undefined);
    const renewRef = useRef<() => void>(() => undefined);
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
        const session = new LinkSession(token, first, {
            onRenewed: (jwt) => {
                void session.client.realtime.setAuth(jwt);
                setBusySec(null);
            },
            onDead: die,
            onBusy: setBusySec,
        });
        const backend = createLinkViewerBackend(session.client);
        cleanups.push(
            () => session.dispose(),
            () => void backend.dispose(),
        );
        renewRef.current = () => void session.renew();
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
        if (first.linkExpiresAt) {
            const expiredAt = first.linkExpiresAt;
            cleanups.push(
                armAt(new Date(expiredAt).getTime(), () => die({ kind: 'dead', state: 'expired', expiredAt })),
            );
        }
        session.start();
        void fetch(pdfUrlOnProject(first.pdfUrl), {
            cache: 'no-store',
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
        })
            .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(`pdf ${res.status}`))))
            .then((bytes) => {
                if (live) {
                    setOpen({ backend, bytes });
                }
            })
            .catch(() => die({ kind: 'dead', state: 'unavailable', expiredAt: null }));
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
        }),
        [selfId],
    );

    return (
        <div className="fixed inset-0 flex flex-col">
            <ViewerHeader backTo="/" backLabel="Cleffy home" title={first.doc.title}>
                <Badge>View only</Badge>
            </ViewerHeader>
            {busySec !== null ? (
                <BusyCountdown
                    retryAfterSec={busySec}
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
