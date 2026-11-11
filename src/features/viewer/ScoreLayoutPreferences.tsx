import type { PageColumns } from '@/features/viewer/geometry';
import { COVER_PAGE_HINT } from '@/features/viewer/viewerPrefs';
import { useViewerStore } from '@/state/store';

const SUB_HEADING = 'text-sm font-medium text-stone-800';

const CHOICES: ReadonlyArray<{ columns: PageColumns; label: string }> = [
    { columns: 1, label: 'Single page' },
    { columns: 2, label: 'Two pages side by side' },
];

/**
 * Account Preferences cluster: how scores lay out. The same store values the
 * viewer's layout button sets, so a choice made in either place is the one
 * the other shows, and the next score opens in it.
 */
export const ScoreLayoutPreferences = () => {
    const pageColumns = useViewerStore((s) => s.pageColumns);
    const setPageColumns = useViewerStore((s) => s.setPageColumns);
    const spreadCover = useViewerStore((s) => s.spreadCover);
    const setSpreadCover = useViewerStore((s) => s.setSpreadCover);

    return (
        <fieldset className="mt-6">
            <legend className={SUB_HEADING}>Score layout</legend>
            <p className="mt-1.5 text-sm text-stone-600">
                How scores open on a tablet or computer. A phone always shows one page at a time.
            </p>
            <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
                {CHOICES.map(({ columns, label }) => (
                    <label key={columns} className="flex items-center gap-2 text-sm text-stone-700">
                        <input
                            type="radio"
                            name="score-layout"
                            checked={pageColumns === columns}
                            onChange={() => setPageColumns(columns)}
                            className="accent-accent"
                        />
                        {label}
                    </label>
                ))}
            </div>
            {pageColumns === 2 ? (
                <label className="mt-3 flex items-start gap-2 text-sm text-stone-700">
                    <input
                        type="checkbox"
                        checked={spreadCover}
                        onChange={(e) => setSpreadCover(e.target.checked)}
                        aria-describedby="score-layout-cover-hint"
                        className="mt-0.5 accent-accent"
                    />
                    <span>
                        Start with cover page
                        <span id="score-layout-cover-hint" className="mt-0.5 block text-xs text-stone-500">
                            {COVER_PAGE_HINT}.
                        </span>
                    </span>
                </label>
            ) : null}
        </fieldset>
    );
};
