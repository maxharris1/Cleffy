import { useOutletContext } from 'react-router';

import { ImslpBrowser } from '@/features/imslp/ImslpBrowser';
import type { LibraryOutletContext } from '@/features/library/LibraryShell';
import { ScoreLimitNotice } from '@/features/library/ScoreLimitNotice';
import { ErrorText } from '@/ui/ErrorText';

export const SearchPage = () => {
    const {
        uploading,
        onUpload,
        onImportImslp,
        uploadError,
        limitNotice,
        quotaExhausted,
        importLimit,
        quotaUpgradeHint,
        openPricing,
    } = useOutletContext<LibraryOutletContext>();

    return (
        <div>
            <header>
                <h1 className="font-display text-2xl font-semibold tracking-tight text-stone-800">Find on IMSLP</h1>
                <p className="mt-1 text-sm text-stone-500">
                    Search or browse popular scores, then add a PDF to your library.
                </p>
            </header>

            {/* Quota refusals — and a cap the account is already at — get the
                amber notice with its way to the plans, not red error text: same
                split as LibraryPage. A student (limit 0) gets the plain copy. */}
            <ScoreLimitNotice
                limit={limitNotice}
                upgradeHint={quotaUpgradeHint !== false}
                onUpgrade={openPricing}
                className="mt-4"
            />
            {uploadError ? <ErrorText className="mt-4">{uploadError}</ErrorText> : null}

            <ImslpBrowser
                busy={uploading}
                quotaExhausted={Boolean(quotaExhausted)}
                importLimit={importLimit ?? null}
                quotaUpgradeHint={quotaUpgradeHint !== false}
                onUpgrade={openPricing}
                onImportFile={onUpload}
                onImportImslp={onImportImslp}
                showHeading={false}
            />
        </div>
    );
};
