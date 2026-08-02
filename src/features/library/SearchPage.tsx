import { useOutletContext } from 'react-router';

import { ImslpBrowser } from '@/features/imslp/ImslpBrowser';
import type { LibraryOutletContext } from '@/features/library/LibraryShell';

export const SearchPage = () => {
    const { uploading, onUpload, onImportImslp, uploadError } = useOutletContext<LibraryOutletContext>();

    return (
        <div>
            <header>
                <h1 className="text-lg font-medium tracking-tight text-stone-800">Find on IMSLP</h1>
                <p className="mt-1 text-sm text-stone-500">
                    Search or browse popular scores, then add a PDF to your library.
                </p>
            </header>

            {uploadError ? (
                <p className="mt-4 text-sm text-red-600" role="status">
                    {uploadError}
                </p>
            ) : null}

            <ImslpBrowser
                busy={uploading}
                onImportFile={onUpload}
                onImportImslp={onImportImslp}
                showHeading={false}
                className="imslp-browser mt-5 rounded-xl border border-stone-300/60 bg-white/50 p-4 sm:p-5"
            />
        </div>
    );
};
