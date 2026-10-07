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
