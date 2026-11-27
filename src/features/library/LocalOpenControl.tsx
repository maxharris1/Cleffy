import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router';

import { UPLOAD_ACCEPT, prepareUploadFile } from '@/features/import/prepareUpload';
import { localDocId, putLocalDoc } from '@/lib/localDocs';
import { ErrorText } from '@/ui/ErrorText';

/** The local-only landing's own filled CTA, kept off the app's restyled primary Button. */
const LANDING_CTA_CLASS =
    'landing-cta inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-xl px-5 py-3 font-medium text-white transition-[color,background-color,border-color,scale] duration-(--duration-press) ease-out active:scale-[0.97]';

const PAGE_LINK_CLASS =
    'cursor-pointer font-medium text-ink-muted underline underline-offset-[3px] transition-colors hover:text-accent';

export const LocalOpenControl = ({
    label,
    subtle = false,
    page = false,
}: {
    label: string;
    subtle?: boolean;
    page?: boolean;
}) => {
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
                    page
                        ? PAGE_LINK_CLASS
                        : subtle
                          ? 'cursor-pointer text-sm text-stone-500 underline decoration-stone-300 underline-offset-2 transition-colors hover:text-accent hover:decoration-accent/40'
                          : LANDING_CTA_CLASS
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
