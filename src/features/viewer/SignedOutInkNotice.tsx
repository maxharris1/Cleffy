import { useEffect, useState, useSyncExternalStore } from 'react';

import { ShareExportMenu } from '@/features/export/ShareExportMenu';
import { discardSignedOutInk, signedOutInk, subscribeInkRecovery, type SignedOutReason } from '@/sync/inkRecovery';
import { getCachedPdfMeta } from '@/sync/pdfCache';
import { Button } from '@/ui/Button';
import { Dialog } from '@/ui/Dialog';

/** One read per change, so useSyncExternalStore sees a stable value between them. */
let snapshot = signedOutInk();
let stale = false;
subscribeInkRecovery(() => {
    stale = true;
});
const read = () => {
    if (stale) {
        snapshot = signedOutInk();
        stale = false;
    }
    return snapshot;
};

const marksWord = (n: number): string => (n === 1 ? 'mark' : 'marks');

/** What the strip says: short on phones, so it stays about two lines with its buttons beside it. */
const copy = (reason: SignedOutReason): { short: string; long: string } =>
    reason === 'other-tab'
        ? {
              short: 'You were signed out in another tab. You have unsaved ink.',
              long: 'You were signed out in another tab. You have unsaved ink here that couldn’t be saved: export a copy to keep it.',
          }
        : {
              short: 'You’re signed out. You have unsaved ink.',
              long: 'You’re signed out, and this tab still has unsaved ink that couldn’t be saved: export a copy to keep it.',
          };

/**
 * Unsaved ink of an account that signed out — here, or in another tab of
 * this browser — that this tab still holds (inkRecovery.retireAccountInk).
 * Sign-out cut off its writes, so it can no longer be saved, but it is never
 * thrown away unasked: it stays until the user chooses Discard (which asks
 * first, offering Export), closes the tab (the browser's leave-page prompt
 * asks), or another account signs in here. Export makes a copy of each
 * score's unsaved marks for the account that made them, never another's.
 *
 * App-wide, under every route, since sign-out leaves whatever page held it:
 * a strip fixed to the bottom of the screen, in the viewer notices' amber.
 */
export const SignedOutInkNotice = () => {
    const accounts = useSyncExternalStore(subscribeInkRecovery, read);
    const [exporting, setExporting] = useState(false);
    const [confirmingDiscard, setConfirmingDiscard] = useState(false);

    const first = accounts[0];
    if (!first) {
        return null;
    }
    const scores = accounts.flatMap((account) => account.scores.map((score) => ({ ...score, userId: account.userId })));
    const marks = scores.reduce((sum, score) => sum + score.marks, 0);
    const { short, long } = copy(first.reason);

    return (
        <>
            <div
                className="fixed inset-x-0 bottom-0 z-30 flex items-center gap-2 border-t border-amber-200 bg-amber-50 px-3 py-1.5 pb-[max(0.375rem,var(--safe-bottom))] sm:py-2"
                role="status"
            >
                <p className="min-w-0 flex-1 text-sm leading-snug text-amber-900">
                    <span className="sm:hidden">{short}</span>
                    <span className="hidden sm:inline">{long}</span>
                </p>
                <Button size="sm" variant="secondary" className="shrink-0" onClick={() => setExporting(true)}>
                    Export
                </Button>
                <Button size="sm" variant="ghost" className="shrink-0" onClick={() => setConfirmingDiscard(true)}>
                    Discard
                </Button>
            </div>
            {exporting ? (
                <Dialog label="Export your unsaved ink" onClose={() => setExporting(false)}>
                    <p className="text-sm leading-relaxed text-stone-600">
                        Each export has only the unsaved marks on that score.
                    </p>
                    <ul className="mt-3 flex min-h-48 flex-col gap-2">
                        {scores.map((score) => (
                            <SignedOutScoreRow key={`${score.userId}:${score.docId}`} {...score} />
                        ))}
                    </ul>
                </Dialog>
            ) : null}
            {confirmingDiscard ? (
                <Dialog label="Discard your unsaved ink?" onClose={() => setConfirmingDiscard(false)}>
                    <p className="text-sm leading-relaxed text-stone-600">
                        {marks} unsaved {marksWord(marks)} on{' '}
                        {scores.length === 1 ? '1 score' : `${scores.length} scores`} {marks === 1 ? 'is' : 'are'} only
                        in this tab. Discarding deletes {marks === 1 ? 'it' : 'them'} for good. Export a copy first to
                        keep {marks === 1 ? 'it' : 'them'}.
                    </p>
                    <div className="mt-5 flex flex-wrap justify-end gap-2">
                        <Button variant="ghost" size="sm" onClick={() => setConfirmingDiscard(false)}>
                            Cancel
                        </Button>
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => {
                                setConfirmingDiscard(false);
                                setExporting(true);
                            }}
                        >
                            Export first
                        </Button>
                        <Button
                            variant="danger"
                            size="sm"
                            onClick={() => {
                                setConfirmingDiscard(false);
                                discardSignedOutInk();
                            }}
                        >
                            Discard
                        </Button>
                    </div>
                </Dialog>
            ) : null}
        </>
    );
};

/** A score with signed-out ink: its title, how many marks, and its Export menu, for the account that made them. */
const SignedOutScoreRow = ({
    docId,
    userId,
    marks,
    title: known,
    bytes,
}: {
    docId: string;
    userId: string;
    marks: number;
    title?: string;
    bytes?: ArrayBuffer;
}) => {
    const [cached, setCached] = useState<string | null>(null);
    useEffect(() => {
        if (known) {
            return;
        }
        let cancelled = false;
        void getCachedPdfMeta(docId)
            .then((meta) => {
                if (!cancelled) {
                    setCached(meta?.title ?? null);
                }
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, [docId, known]);
    const title = known ?? cached ?? 'A score';

    return (
        <li className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-sm">
                <span className="font-medium text-stone-800">{title}</span>{' '}
                <span className="text-stone-500">
                    ({marks} {marksWord(marks)})
                </span>
            </span>
            <ShareExportMenu docId={docId} bytes={bytes} title={title} userId={userId} />
        </li>
    );
};
