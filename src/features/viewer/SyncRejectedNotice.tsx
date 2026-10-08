import { Button } from '@/ui/Button';

interface SyncRejectedNoticeProps {
    /** Marks whose local change the server refused and the viewer rolled back. */
    count: number;
    onDismiss: () => void;
}

/**
 * Non-blocking banner for changes the server refused for good (lost edit
 * access, archived score, invalid mark). The sync engine has already put
 * those marks back to the shared score's version; without this the edit
 * would just vanish, and the musician would find out at the lesson.
 * Same amber strip as the viewer's other notices — the app has no toasts.
 */
export const SyncRejectedNotice = ({ count, onDismiss }: SyncRejectedNoticeProps) => {
    if (count <= 0) {
        return null;
    }
    const subject = count === 1 ? 'One of your changes' : `${count} of your changes`;
    return (
        <div
            className="flex flex-wrap items-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2"
            role="status"
        >
            <p className="text-sm text-amber-900">
                {subject} could not be saved to this score and {count === 1 ? 'was' : 'were'} undone. You may no longer
                have permission to edit it.
            </p>
            <Button size="sm" variant="secondary" onClick={onDismiss}>
                Dismiss
            </Button>
        </div>
    );
};

interface SyncHeldNoticeProps {
    /** Marks with changes kept on this device that the archived score refuses. */
    count: number;
}

/**
 * The score was archived (over the plan's score cap) while changes to it were
 * still waiting to upload. The sync engine keeps them rather than undoing
 * them — resubscribing restores the score and they upload then — but until
 * that happens they exist only on this device, which the musician needs to
 * know before clearing site data or signing out. Not dismissible: it is the
 * standing state of the score, like the Archived badge.
 */
export const SyncHeldNotice = ({ count }: SyncHeldNoticeProps) => {
    if (count <= 0) {
        return null;
    }
    return (
        <div className="border-b border-amber-200 bg-amber-50 px-3 py-2" role="status">
            <p className="text-sm text-amber-900">
                This score is archived and read-only, so {count === 1 ? '1 change' : `${count} changes`} you made to it{' '}
                {count === 1 ? 'is' : 'are'} saved only on this device. {count === 1 ? 'It uploads' : 'They upload'}{' '}
                automatically once the score is restored, for example when its owner renews their plan.
            </p>
        </div>
    );
};
