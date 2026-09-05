import { useOutletContext } from 'react-router';

import { LimitReachedNotice } from '@/features/billing/LimitReachedNotice';
import { ImslpBrowser } from '@/features/imslp/ImslpBrowser';
import type { LibraryOutletContext } from '@/features/library/LibraryShell';
import { ErrorText } from '@/ui/ErrorText';

export const SearchPage = () => {
    const { uploading, onUpload, onImportImslp, uploadError, uploadLimit, openPricing } =
        useOutletContext<LibraryOutletContext>();

    return (
        <div>
            <header>
                <h1 className="font-display text-2xl font-semibold tracking-tight text-stone-800">Find on IMSLP</h1>
                <p className="mt-1 text-sm text-stone-500">
                    Search or browse popular scores, then add a PDF to your library.
                </p>
            </header>

            {/* Quota refusals get the amber upgrade card, not red error text —
                same split as LibraryPage. */}
            {uploadLimit ? <LimitReachedNotice limit={uploadLimit} onUpgrade={openPricing} className="mt-4" /> : null}
            {uploadError ? <ErrorText className="mt-4">{uploadError}</ErrorText> : null}

            <ImslpBrowser busy={uploading} onImportFile={onUpload} onImportImslp={onImportImslp} showHeading={false} />
        </div>
    );
};
