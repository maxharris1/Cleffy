import { Button } from '@/ui/Button';
import { Dialog } from '@/ui/Dialog';

export interface ConfirmDialogProps {
    title: string;
    body: string;
    confirmLabel: string;
    cancelLabel?: string;
    /** Destructive action — confirm button renders filled red. */
    danger?: boolean;
    busy?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
}

/** Small decision dialog replacing window.confirm(): an alertdialog, so a stray press on the scrim cannot answer it. */
export const ConfirmDialog = ({
    title,
    body,
    confirmLabel,
    cancelLabel = 'Cancel',
    danger = false,
    busy = false,
    onConfirm,
    onCancel,
}: ConfirmDialogProps) => (
    <Dialog label={title} onClose={onCancel} alert>
        <p className="text-sm leading-relaxed text-stone-600 [overflow-wrap:anywhere]">{body}</p>
        <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
                {cancelLabel}
            </Button>
            <Button variant={danger ? 'danger' : 'primary'} size="sm" onClick={onConfirm} disabled={busy}>
                {confirmLabel}
            </Button>
        </div>
    </Dialog>
);
