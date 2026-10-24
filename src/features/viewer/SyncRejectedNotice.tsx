import { ViewerNotice } from '@/features/viewer/ViewerNotice';
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
 * Same amber card as the viewer's other notices (ViewerNotice) — the app has no toasts.
 */
export const SyncRejectedNotice = ({ count, onDismiss }: SyncRejectedNoticeProps) => {
    if (count <= 0) {
        return null;
    }
    const subject = count === 1 ? 'One of your changes' : `${count} of your changes`;
    return (
        <ViewerNotice>
            {/* Short on phones, where every line of a notice hides score. */}
            <p className="min-w-0 flex-1">
                <span className="sm:hidden">
                    {subject} couldn&rsquo;t be saved and {count === 1 ? 'was' : 'were'} undone.
                </span>
                <span className="hidden sm:inline">
                    {subject} could not be saved to this score and {count === 1 ? 'was' : 'were'} undone. You may no
                    longer have permission to edit it.
                </span>
            </p>
            <Button size="sm" variant="secondary" onClick={onDismiss}>
                Dismiss
            </Button>
        </ViewerNotice>
    );
};

interface SyncHeldNoticeProps {
    /** Marks with changes kept on this device that the server refuses for now. */
    count: number;
    /**
     * Why: the score is archived (the default), or this account's Academy
     * seat is read-only, which refuses its changes on every score.
     */
    reason?: 'archived' | 'seat-read-only';
}

/**
 * The score was archived (over the plan's score cap), or this account's
 * Academy seat went read-only, while changes were still waiting to upload. The
 * sync engine keeps them rather than undoing them — resubscribing restores the
 * score, and an active seat takes them again — but until that happens they
 * exist only on this device, which the musician needs to know before clearing
 * site data or signing out. Not dismissible: it is the standing state of the
 * score, like the Archived badge.
 */
export const SyncHeldNotice = ({ count, reason = 'archived' }: SyncHeldNoticeProps) => {
    if (count <= 0) {
        return null;
    }
    const changes = count === 1 ? '1 change' : `${count} changes`;
    const are = count === 1 ? 'is' : 'are';
    const upload = count === 1 ? 'It uploads' : 'They upload';
    return (
        <ViewerNotice bare>
            {/* It cannot be dismissed, so on phones it keeps to a line or two. */}
            {reason === 'seat-read-only' ? (
                <p>
                    <span className="sm:hidden">
                        Your seat is read-only: {changes} {are} saved only on this device until it&rsquo;s active.
                    </span>
                    <span className="hidden sm:inline">
                        Your Academy seat is read-only, so {changes} you made to this score {are} saved only on this
                        device. {upload} automatically once your seat is active again, for example when the
                        academy&rsquo;s owner renews or picks your seat.
                    </span>
                </p>
            ) : (
                <p>
                    <span className="sm:hidden">
                        This score is archived: {changes} {are} saved only on this device until it&rsquo;s restored.
                    </span>
                    <span className="hidden sm:inline">
                        This score is archived and read-only, so {changes} you made to it {are} saved only on this
                        device. {upload} automatically once the score is restored, for example when its owner renews
                        their plan.
                    </span>
                </p>
            )}
        </ViewerNotice>
    );
};
