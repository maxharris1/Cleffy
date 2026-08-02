import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router';

import { UPLOAD_ACCEPT, prepareUploadFile } from '@/features/import/prepareUpload';
import { localDocId, putLocalDoc } from '@/lib/localDocs';
import { ErrorText } from '@/ui/ErrorText';
import { buttonClassName } from '@/ui/classNames';

export const LocalOpenControl = ({ label, subtle = false }: { label: string; subtle?: boolean }) => {
    const navigate = useNavigate();
    const [openError, setOpenError] = useState<string | null>(null);

    const openFile = useCallback(
        async (picked: File) => {
            setOpenError(null);
            try {
                // Same normalization as cloud uploads: images become one-page PDFs.
                const { file } = await prepareUploadFile(picked);
                const buffer = await file.arrayBuffer();
                const id = await localDocId(buffer);
                putLocalDoc(id, buffer);
                navigate(`/doc/${id}`);
            } catch (err) {
                setOpenError(err instanceof Error ? err.message : 'Could not open that file.');
            }
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
                    accept={UPLOAD_ACCEPT}
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
