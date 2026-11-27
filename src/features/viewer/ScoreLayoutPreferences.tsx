import { ACCOUNT_BODY, ACCOUNT_SUB_HEADING, ACCOUNT_SUBSECTION } from '@/features/account/AccountSection';
import type { PageColumns } from '@/features/viewer/geometry';
import { COVER_PAGE_HINT } from '@/features/viewer/viewerPrefs';
import { useViewerStore } from '@/state/store';

const RADIO =
    'size-5 shrink-0 cursor-pointer appearance-none rounded-full border-[1.5px] border-field-line bg-white checked:border-accent checked:bg-[radial-gradient(circle,var(--color-accent)_4.5px,#fff_5px)]';

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
        <fieldset className={ACCOUNT_SUBSECTION}>
            <legend className={`${ACCOUNT_SUB_HEADING} float-left w-full`}>Score layout</legend>
            <p className={`${ACCOUNT_BODY} clear-left pt-1`}>
                How scores open on a tablet or computer. A phone always shows one page at a time.
            </p>
            <div className="mt-2 flex flex-wrap gap-x-7 gap-y-1">
                {CHOICES.map(({ columns, label }) => (
                    <label
                        key={columns}
                        className="inline-flex min-h-11 cursor-pointer items-center gap-2.5 text-[15px] text-ink"
                    >
                        <input
                            type="radio"
                            name="score-layout"
                            checked={pageColumns === columns}
                            onChange={() => setPageColumns(columns)}
                            className={RADIO}
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
