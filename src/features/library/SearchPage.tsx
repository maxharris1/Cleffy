import { useOutletContext } from 'react-router';

import { ImslpBrowser } from '@/features/imslp/ImslpBrowser';
import type { LibraryOutletContext } from '@/features/library/LibraryShell';
import { ErrorText } from '@/ui/ErrorText';

export const SearchPage = () => {
    const { uploading, onUpload, onImportImslp, uploadError } = useOutletContext<LibraryOutletContext>();

    return (
        <div>
            <header>
                <h1 className="font-display text-2xl font-semibold tracking-tight text-stone-800">Find on IMSLP</h1>
                <p className="mt-1 text-sm text-stone-500">
                    Search or browse popular scores, then add a PDF to your library.
                </p>
            </header>

            {uploadError ? <ErrorText className="mt-4">{uploadError}</ErrorText> : null}

            <ImslpBrowser busy={uploading} onImportFile={onUpload} onImportImslp={onImportImslp} showHeading={false} />
        </div>
    );
};
