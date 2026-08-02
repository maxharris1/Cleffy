import { useState } from 'react';

import type { LibraryTagRow } from '@/types/database';
import { Button } from '@/ui/Button';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import { Dialog } from '@/ui/Dialog';
import { ErrorText } from '@/ui/ErrorText';
import { TextField } from '@/ui/TextField';
import { fieldClassName } from '@/ui/classNames';

/** Library-level tag manager: create / rename / delete (no score assignment). */
export const TagManageDialog = ({
    tags,
    busy,
    onClose,
    onCreateTag,
    onRenameTag,
    onDeleteTag,
}: {
    tags: LibraryTagRow[];
    busy: boolean;
    onClose: () => void;
    onCreateTag: (name: string) => Promise<void>;
    onRenameTag: (tagId: string, name: string) => Promise<void>;
    onDeleteTag: (tagId: string) => Promise<void>;
}) => {
    const [newName, setNewName] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [renameTarget, setRenameTarget] = useState<LibraryTagRow | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<LibraryTagRow | null>(null);
    const [renameValue, setRenameValue] = useState('');

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

    const saveRename = async () => {
        if (!renameTarget) {
            return;
        }
        setError(null);
        try {
            await onRenameTag(renameTarget.id, renameValue);
            setRenameTarget(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not rename tag.');
        }
    };

    const confirmDelete = async () => {
        if (!deleteTarget) {
            return;
        }
        setError(null);
        try {
            await onDeleteTag(deleteTarget.id);
            setDeleteTarget(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not delete tag.');
            setDeleteTarget(null);
        }
    };

    return (
        <>
            <Dialog label="Manage tags" onClose={onClose}>
                <p className="text-sm text-stone-600">
                    Create personal tags to organize your library — for example Teacher, Lesson, or Concert. Assign them
                    from any score’s tag button.
                </p>

                {tags.length === 0 ? (
                    <p className="mt-4 text-sm text-stone-500">No tags yet — create one below.</p>
                ) : (
                    <ul className="mt-4 max-h-56 space-y-1 overflow-y-auto">
                        {tags.map((tag) => (
                            <li
                                key={tag.id}
                                className="flex items-center gap-2 rounded-lg px-1 py-1.5 hover:bg-ink/5"
                            >
                                <span className="min-w-0 flex-1 truncate text-sm text-stone-800">{tag.name}</span>
                                <button
                                    type="button"
                                    className="shrink-0 text-xs text-stone-500 hover:text-stone-700"
                                    disabled={busy}
                                    onClick={() => {
                                        setRenameValue(tag.name);
                                        setRenameTarget(tag);
                                    }}
                                >
                                    Rename
                                </button>
                                <button
                                    type="button"
                                    className="shrink-0 text-xs text-danger hover:underline"
                                    disabled={busy}
                                    onClick={() => setDeleteTarget(tag)}
                                >
                                    Delete
                                </button>
                            </li>
                        ))}
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

            {renameTarget ? (
                <Dialog label="Rename tag" onClose={() => setRenameTarget(null)}>
                    <TextField
                        id="rename-tag"
                        label="Name"
                        value={renameValue}
                        autoFocus
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                void saveRename();
                            }
                        }}
                    />
                    <div className="mt-5 flex justify-end gap-2">
                        <Button variant="ghost" size="sm" onClick={() => setRenameTarget(null)} disabled={busy}>
                            Cancel
                        </Button>
                        <Button size="sm" onClick={() => void saveRename()} disabled={busy}>
                            Save
                        </Button>
                    </div>
                </Dialog>
            ) : null}

            {deleteTarget ? (
                <ConfirmDialog
                    title="Delete this tag?"
                    body={`“${deleteTarget.name}” will be removed from all scores. This can't be undone.`}
                    confirmLabel="Delete"
                    danger
                    busy={busy}
                    onConfirm={() => void confirmDelete()}
                    onCancel={() => setDeleteTarget(null)}
                />
            ) : null}
        </>
    );
};
