import { useEffect, useRef, useState } from 'react';

import { MoreVerticalIcon } from '@/ui/icons';

/**
 * Owner-only actions for one score, as a popover menu.
 *
 * Lifted out of LibraryPage unchanged so the shelf card and the list row share
 * one implementation — the accessible name ("Score actions"), the item labels
 * and the dismiss behaviour are contract, not decoration.
 *
 * The trigger carries `aria-expanded`, which callers can also key off in CSS
 * (`has-[[aria-expanded=true]]:…`) to keep an open menu painted above its
 * neighbours.
 */
export const RowMenu = ({
    onRename,
    onShare,
    onAssign,
    onDelete,
}: {
    onRename: () => void;
    onShare: () => void;
    onAssign: () => void;
    onDelete: () => void;
}) => {
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (!open) {
            return;
        }
        const onPointerDown = (e: PointerEvent) => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setOpen(false);
            }
        };
        window.addEventListener('pointerdown', onPointerDown);
        window.addEventListener('keydown', onKey);
        return () => {
            window.removeEventListener('pointerdown', onPointerDown);
            window.removeEventListener('keydown', onKey);
        };
    }, [open]);

    const pick = (action: () => void) => {
        setOpen(false);
        action();
    };

    return (
        <div ref={rootRef} className="relative">
            <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label="Score actions"
                onClick={() => setOpen((v) => !v)}
                className="rounded-lg p-1.5 text-stone-400 transition hover:bg-ink/5 hover:text-stone-600"
            >
                <MoreVerticalIcon size={16} />
            </button>
            {open ? (
                <div
                    role="menu"
                    className="absolute right-0 z-20 mt-1 w-44 rounded-xl border border-stone-200 bg-white py-1 shadow-lg"
                >
                    <MenuItem label="Rename" onClick={() => pick(onRename)} />
                    <MenuItem label="Share…" onClick={() => pick(onShare)} />
                    <MenuItem label="Assign to student…" onClick={() => pick(onAssign)} />
                    <MenuItem label="Delete" danger onClick={() => pick(onDelete)} />
                </div>
            ) : null}
        </div>
    );
};

const MenuItem = ({ label, danger = false, onClick }: { label: string; danger?: boolean; onClick: () => void }) => (
    <button
        type="button"
        role="menuitem"
        onClick={onClick}
        className={`w-full px-3 py-2 text-left text-sm transition hover:bg-ink/5 ${
            danger ? 'text-danger' : 'text-stone-800'
        }`}
    >
        {label}
    </button>
);
