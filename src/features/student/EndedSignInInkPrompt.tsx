import { useEffect, useState } from 'react';

import { ShareExportMenu } from '@/features/export/ShareExportMenu';
import type { EndedSignInInk } from '@/features/student/useEndedSignInInkPrompt';
import { getCachedPdfMeta } from '@/sync/pdfCache';
import { Button } from '@/ui/Button';

interface EndedSignInInkPromptProps {
    prompt: EndedSignInInk;
    signingOut: boolean;
    onSignOut: () => void;
}

/**
 * Says the account's unsaved ink will go with the sign-out and offers an
 * Export of each score it is on, before the sign-out runs. Stays up, Export
 * and all, until the sign-out has completed: the held ink is the export's
 * until then. Exports are made for the account signing out, whose marks
 * they are, though the session may already have lapsed under it.
 */
export const EndedSignInInkPrompt = ({ prompt, signingOut, onSignOut }: EndedSignInInkPromptProps) => {
    const { known } = prompt;
    const [titles, setTitles] = useState<Record<string, string>>({});

    useEffect(() => {
        let cancelled = false;
        const unknown = prompt.docIds.filter((docId) => !known[docId]);
        void Promise.all(
            unknown.map(async (docId) => [docId, (await getCachedPdfMeta(docId))?.title ?? null] as const),
        ).then((found) => {
            if (!cancelled) {
                setTitles(Object.fromEntries(found.filter((entry): entry is [string, string] => !!entry[1])));
            }
        });
        return () => {
            cancelled = true;
        };
    }, [prompt.docIds, known]);

    return (
        <main className="landing-page flex min-h-full flex-col items-center justify-center gap-4 p-8">
            <div className="flex w-full max-w-md flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-900">
                <p className="text-sm leading-snug" role="status">
                    {prompt.accountDeleted
                        ? 'Your account was removed, so you’re being signed out. Some marks you made couldn’t be saved on this device and will be lost. Export a copy first to keep them.'
                        : 'Your teacher changed your access, so you’re being signed out. Some marks you made couldn’t be saved on this device. Signing out tries once more to save them; if that fails, they’re lost. Export a copy first to keep them.'}
                </p>
                <ul className="flex flex-col gap-2">
                    {prompt.docIds.map((docId) => {
                        const score = known[docId];
                        const title = score?.title ?? titles[docId] ?? 'A score';
                        return (
                            <li key={docId} className="flex items-center justify-between gap-2">
                                <span className="min-w-0 truncate text-sm font-medium">{title}</span>
                                <ShareExportMenu
                                    docId={docId}
                                    doc={score?.doc}
                                    role={score?.role}
                                    title={title}
                                    userId={prompt.userId}
                                />
                            </li>
                        );
                    })}
                </ul>
                <Button size="sm" variant="secondary" className="self-end" disabled={signingOut} onClick={onSignOut}>
                    {signingOut ? 'Signing out…' : 'Sign out now'}
                </Button>
            </div>
        </main>
    );
};
