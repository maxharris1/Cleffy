import { useState } from 'react';

import type { LibraryTagRow } from '@/types/database';
import { Button } from '@/ui/Button';
import { Dialog } from '@/ui/Dialog';
import { ErrorText } from '@/ui/ErrorText';
import { fieldClassName } from '@/ui/classNames';

/** Per-score assign dialog: checklist + create-and-assign. */
export const TagAssignDialog = ({
    scoreTitle,
    tags,
    assignedTagIds,
    busy,
    onClose,
    onToggleTag,
    onCreateTag,
}: {
    scoreTitle: string;
    tags: LibraryTagRow[];
    assignedTagIds: Set<string>;
    busy: boolean;
    onClose: () => void;
    onToggleTag: (tagId: string, assigned: boolean) => Promise<void>;
    onCreateTag: (name: string) => Promise<void>;
}) => {
    const [newName, setNewName] = useState('');
    const [error, setError] = useState<string | null>(null);

    const create = async () => {
        const trimmed = newName.trim();
        if (!trimmed) {
            setError('Enter a tag name.');
            return;
        }
        setError(null);
        try {
            await onCreateTag(trimmed);
            setNewName('');
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not create tag.');
        }
    };

    const toggle = async (tagId: string, assigned: boolean) => {
        setError(null);
        try {
            await onToggleTag(tagId, assigned);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not update tag.');
        }
    };

    return (
        <Dialog label="Tags" onClose={onClose}>
            <p className="text-sm text-stone-600">
                Organize “{scoreTitle}” with personal tags. Try names like Teacher, Lesson, or Concert.
            </p>

            {tags.length === 0 ? (
                <p className="mt-4 text-sm text-stone-500">No tags yet — create one below.</p>
            ) : (
                <ul className="mt-4 max-h-56 space-y-1 overflow-y-auto">
                    {tags.map((tag) => {
                        const checked = assignedTagIds.has(tag.id);
                        return (
                            <li key={tag.id} className="rounded-lg px-1 py-1.5 hover:bg-ink/5">
                                <label className="flex min-w-0 cursor-pointer items-center gap-2.5">
                                    <input
                                        type="checkbox"
                                        checked={checked}
                                        disabled={busy}
                                        onChange={() => void toggle(tag.id, !checked)}
                                        className="size-4 shrink-0 rounded border-stone-300 text-accent focus:ring-accent"
                                    />
                                    <span className="truncate text-sm text-stone-800">{tag.name}</span>
                                </label>
                            </li>
                        );
                    })}
                </ul>
            )}

            <div className="mt-4 flex gap-2">
                <input
                    type="text"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                            void create();
                        }
                    }}
                    placeholder="New tag name…"
                    disabled={busy}
                    aria-label="New tag name"
                    className={fieldClassName('sm', 'flex-1')}
                />
                <Button size="sm" onClick={() => void create()} disabled={busy}>
                    Create
                </Button>
            </div>

            {error ? <ErrorText className="mt-3">{error}</ErrorText> : null}

            <div className="mt-5 flex justify-end">
                <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
                    Done
                </Button>
            </div>
        </Dialog>
    );
};
