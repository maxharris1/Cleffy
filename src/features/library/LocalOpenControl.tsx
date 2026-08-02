import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router';

import { localDocId, putLocalDoc } from '@/lib/localDocs';
import { ErrorText } from '@/ui/ErrorText';
import { buttonClassName } from '@/ui/classNames';

export const LocalOpenControl = ({ label, subtle = false }: { label: string; subtle?: boolean }) => {
    const navigate = useNavigate();
    const [openError, setOpenError] = useState<string | null>(null);

    const openFile = useCallback(
        async (file: File) => {
            setOpenError(null);
            if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
                setOpenError('Please choose a PDF file.');
                return;
            }
            const buffer = await file.arrayBuffer();
            const id = await localDocId(buffer);
            putLocalDoc(id, buffer);
            navigate(`/doc/${id}`);
        },
        [navigate],
    );

    return (
        <div className="flex flex-col items-center gap-1">
            <label
                className={
                    subtle
                        ? 'cursor-pointer text-sm text-stone-500 underline decoration-stone-300 underline-offset-2 transition hover:text-accent hover:decoration-accent/40'
                        : buttonClassName('primary', 'md')
                }
            >
                {label}
                <input
                    type="file"
                    accept="application/pdf,.pdf"
                    className="hidden"
                    onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) {
                            void openFile(file);
                        }
                        e.target.value = '';
                    }}
                />
            </label>
            {openError ? <ErrorText>{openError}</ErrorText> : null}
        </div>
    );
};
