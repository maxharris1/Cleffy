import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';

import {
    ILLEGAL_CATEGORY_LABELS,
    fetchModerationQueue,
    isContentModerator,
    moderate,
    type ContentReportRow,
    type ModerationAction,
    type ModerationQueue,
    type TakedownRow,
} from '@/features/moderation/moderationApi';
import { REPEAT_INFRINGER_STRIKES } from '@/features/moderation/moderationRules';
import { Button } from '@/ui/Button';
import { fieldClassName, fieldLabelClassName, linkClassName } from '@/ui/classNames';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import { ErrorText } from '@/ui/ErrorText';
import { LoadingText } from '@/ui/Loading';

const SECTION = 'mt-8 border-t border-stone-300/50 pt-6';
const SECTION_HEADING = 'text-sm font-medium uppercase tracking-[0.08em] text-stone-600';
const CARD = 'mt-3 rounded-xl border border-stone-200/80 bg-white/70 px-4 py-3';
const META = 'text-xs text-stone-500';

const when = (iso: string): string =>
    new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

const categoryLabel = (row: ContentReportRow): string =>
    row.kind === 'copyright'
        ? 'Copyright'
        : (ILLEGAL_CATEGORY_LABELS[row.category as keyof typeof ILLEGAL_CATEGORY_LABELS] ?? row.category);

const GROUND_DEFAULTS = {
    copyright: '17 U.S.C. §512(c) (DMCA); EU Directive 2001/29/EC',
    illegal: '',
    terms: 'Terms of Service, “Acceptable use”',
} as const;

type Ground = keyof typeof GROUND_DEFAULTS;

interface TakedownDraft {
    document: string;
    reportId: string;
    mode: 'restrict' | 'remove';
    ground: Ground;
    legalBasis: string;
    facts: string;
}

const emptyDraft = (): TakedownDraft => ({
    document: '',
    reportId: '',
    mode: 'remove',
    ground: 'copyright',
    legalBasis: GROUND_DEFAULTS.copyright,
    facts: '',
});

const statusBadge = (status: ContentReportRow['status']): string =>
    status === 'received'
        ? 'bg-amber-100 text-amber-900'
        : status === 'actioned'
          ? 'bg-emerald-100 text-emerald-900'
          : 'bg-stone-200 text-stone-700';

/** A one-field "say why" form that runs an action, used for reject and lift. */
const ReasonForm = ({
    id,
    label,
    submitLabel,
    onSubmit,
    onCancel,
}: {
    id: string;
    label: string;
    submitLabel: string;
    onSubmit: (reason: string) => Promise<void>;
    onCancel: () => void;
}) => {
    const [reason, setReason] = useState('');
    const [busy, setBusy] = useState(false);
    return (
        <form
            className="mt-3"
            onSubmit={(event) => {
                event.preventDefault();
                if (!reason.trim() || busy) {
                    return;
                }
                setBusy(true);
                void onSubmit(reason.trim()).finally(() => setBusy(false));
            }}
        >
            <label htmlFor={id} className={fieldLabelClassName}>
                {label}
            </label>
            <textarea
                id={id}
                rows={3}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                className={`mt-1.5 ${fieldClassName('sm', 'resize-y')}`}
            />
            <div className="mt-2 flex gap-2">
                <Button type="submit" size="sm" disabled={busy || !reason.trim()}>
                    {busy ? 'Saving…' : submitLabel}
                </Button>
                <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
                    Cancel
                </Button>
            </div>
        </form>
    );
};

/**
 * The moderators' page: open reports, takedowns with each uploader's strike
 * count, and the notice log. Every action goes through content-moderation,
 * which checks the caller is a moderator; this page only hides itself from
 * everyone else.
 */
export const ModerationPage = () => {
    const [allowed, setAllowed] = useState<boolean | null>(null);
    const [queue, setQueue] = useState<ModerationQueue | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [draft, setDraft] = useState<TakedownDraft>(emptyDraft);
    const [confirming, setConfirming] = useState(false);
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);
    const [rejecting, setRejecting] = useState<string | null>(null);
    const [lifting, setLifting] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            setQueue(await fetchModerationQueue());
            setLoadError(null);
        } catch (err) {
            setLoadError(err instanceof Error ? err.message : 'Could not load the reports.');
        }
    }, []);

    useEffect(() => {
        let current = true;
        void isContentModerator().then((moderator) => {
            if (!current) {
                return;
            }
            setAllowed(moderator);
            if (moderator) {
                void load();
            }
        });
        return () => {
            current = false;
        };
    }, [load]);

    const run = async (request: ModerationAction): Promise<boolean> => {
        setActionError(null);
        setNotice(null);
        try {
            setNotice(await moderate(request));
            await load();
            return true;
        } catch (err) {
            setActionError(err instanceof Error ? err.message : 'The action failed.');
            return false;
        }
    };

    if (allowed === null) {
        return <LoadingText className="mt-10">Loading reports…</LoadingText>;
    }
    if (!allowed) {
        return (
            <div className="w-full max-w-3xl">
                <h1 className="font-display text-2xl font-semibold tracking-tight text-stone-800">Reports</h1>
                <p className="mt-2 text-sm text-stone-600">
                    This page is for Cleffy’s moderators. To report a score, use the{' '}
                    <Link to="/report" className={linkClassName}>
                        report form
                    </Link>
                    .
                </p>
            </div>
        );
    }

    const openReports = queue?.reports.filter((row) => row.status === 'received') ?? [];
    const decidedReports = queue?.reports.filter((row) => row.status !== 'received') ?? [];
    const liveTakedowns = queue?.takedowns.filter((row) => !row.lifted_at) ?? [];
    const pastTakedowns = queue?.takedowns.filter((row) => row.lifted_at) ?? [];

    const startTakedown = (row: ContentReportRow) => {
        const ground: Ground = row.kind === 'copyright' ? 'copyright' : 'illegal';
        setDraft({
            document: row.document_id ?? row.content_url,
            reportId: row.id,
            mode: 'remove',
            ground,
            legalBasis: GROUND_DEFAULTS[ground],
            facts: '',
        });
        setNotice(null);
        setActionError(null);
        document.getElementById('takedown-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    const submitDraft = (event: FormEvent) => {
        event.preventDefault();
        if (!draft.document.trim() || !draft.legalBasis.trim() || !draft.facts.trim()) {
            setActionError('Give the score, the law or term relied on, and the facts.');
            return;
        }
        setActionError(null);
        setConfirming(true);
    };

    const confirmTakedown = async () => {
        setBusy(true);
        const ok = await run({
            action: 'takedown',
            document: draft.document.trim(),
            ...(draft.reportId ? { reportId: draft.reportId } : {}),
            mode: draft.mode,
            ground: draft.ground,
            legalBasis: draft.legalBasis.trim(),
            facts: draft.facts.trim(),
        });
        setBusy(false);
        setConfirming(false);
        if (ok) {
            setDraft(emptyDraft());
        }
    };

    // Render functions rather than nested components: a component defined in
    // render is a new type each time, which would reset an open reason form.
    const reportCard = (row: ContentReportRow) => (
        <li key={row.id} className={CARD}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-medium text-stone-800">
                    {row.reference} · {categoryLabel(row)}
                </p>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusBadge(row.status)}`}>
                    {row.status}
                </span>
            </div>
            <p className={META}>
                {when(row.created_at)} · from {row.reporter_name} ({row.reporter_email})
                {row.on_behalf_of ? ` for ${row.on_behalf_of}` : ''} ·{' '}
                {row.acknowledged_at ? 'acknowledged' : 'not acknowledged'}
            </p>
            <p className="mt-2 text-sm text-stone-700 [overflow-wrap:anywhere]">
                <span className="font-medium">Where:</span> {row.content_url}
                {row.document_id ? (
                    <>
                        {' '}
                        →{' '}
                        <Link to={`/doc/${row.document_id}`} className={linkClassName}>
                            {row.document_title ?? row.document_id}
                        </Link>
                    </>
                ) : (
                    <span className="text-stone-500"> (no score matched — find it by hand)</span>
                )}
            </p>
            {row.work_description ? (
                <p className="mt-1 text-sm text-stone-700 [overflow-wrap:anywhere]">
                    <span className="font-medium">Work:</span> {row.work_description}
                </p>
            ) : null}
            <p className="mt-1 whitespace-pre-wrap text-sm text-stone-700 [overflow-wrap:anywhere]">
                {row.explanation}
            </p>
            {row.decision_note ? <p className="mt-1 text-sm text-stone-500">Decision: {row.decision_note}</p> : null}
            {row.status === 'received' ? (
                rejecting === row.id ? (
                    <ReasonForm
                        id={`reject-${row.id}`}
                        label="Why no action is taken (the reporter is told)"
                        submitLabel="Reject report"
                        onCancel={() => setRejecting(null)}
                        onSubmit={async (note) => {
                            if (await run({ action: 'reject', reportId: row.id, note })) {
                                setRejecting(null);
                            }
                        }}
                    />
                ) : (
                    <div className="mt-3 flex flex-wrap gap-2">
                        <Button size="sm" variant="danger" onClick={() => startTakedown(row)}>
                            Take down…
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => setRejecting(row.id)}>
                            Reject…
                        </Button>
                    </div>
                )
            ) : null}
        </li>
    );

    const takedownCard = (row: TakedownRow) => (
        <li key={row.id} className={CARD}>
            <p className="text-sm font-medium text-stone-800">
                {row.action === 'remove' ? 'Removed' : 'Restricted'} · {row.ground} ·{' '}
                {row.document_id ? (
                    <Link to={`/doc/${row.document_id}`} className={linkClassName}>
                        {row.document_title ?? row.document_id}
                    </Link>
                ) : (
                    <span>{row.document_title ?? 'deleted score'}</span>
                )}
            </p>
            <p className={META}>
                {when(row.created_at)}
                {row.lifted_at ? ` · lifted ${when(row.lifted_at)}` : ''} · uploader’s active strikes:{' '}
                <span
                    className={
                        row.uploader_active_strikes >= REPEAT_INFRINGER_STRIKES ? 'font-semibold text-danger' : ''
                    }
                >
                    {row.uploader_active_strikes}
                    {row.uploader_active_strikes >= REPEAT_INFRINGER_STRIKES ? ' (repeat infringer)' : ''}
                </span>
            </p>
            <p className="mt-1 text-sm text-stone-700 [overflow-wrap:anywhere]">
                <span className="font-medium">Basis:</span> {row.legal_basis}
            </p>
            <p className="mt-1 whitespace-pre-wrap text-sm text-stone-700 [overflow-wrap:anywhere]">{row.facts}</p>
            {row.lift_reason ? <p className="mt-1 text-sm text-stone-500">Lifted: {row.lift_reason}</p> : null}
            {!row.lifted_at ? (
                lifting === row.id ? (
                    <ReasonForm
                        id={`lift-${row.id}`}
                        label="Why it is lifted (the uploader is told)"
                        submitLabel="Lift takedown"
                        onCancel={() => setLifting(null)}
                        onSubmit={async (reason) => {
                            if (await run({ action: 'lift', takedownId: row.id, reason })) {
                                setLifting(null);
                            }
                        }}
                    />
                ) : (
                    <Button size="sm" variant="secondary" className="mt-3" onClick={() => setLifting(row.id)}>
                        Lift…
                    </Button>
                )
            ) : null}
        </li>
    );

    return (
        <div className="w-full max-w-3xl">
            <header>
                <h1 className="font-display text-2xl font-semibold tracking-tight text-stone-800">Reports</h1>
                <p className="mt-1 text-sm text-stone-500">
                    Reports about scores, takedowns and the notices sent. Every decision emails the people involved and
                    is logged.
                </p>
            </header>

            {loadError ? <ErrorText className="mt-4">{loadError}</ErrorText> : null}
            {notice ? (
                <p
                    role="status"
                    className="mt-4 rounded-xl border border-emerald-300/70 bg-emerald-50/70 px-4 py-3 text-sm text-emerald-900"
                >
                    {notice}
                </p>
            ) : null}
            {actionError ? <ErrorText className="mt-4">{actionError}</ErrorText> : null}

            <section className={SECTION} aria-labelledby="open-reports">
                <h2 id="open-reports" className={SECTION_HEADING}>
                    Open reports ({openReports.length})
                </h2>
                {openReports.length === 0 ? (
                    <p className="mt-2 text-sm text-stone-600">Nothing waiting.</p>
                ) : (
                    <ul>{openReports.map(reportCard)}</ul>
                )}
            </section>

            <section id="takedown-form" className={`${SECTION} scroll-mt-36`} aria-labelledby="takedown-heading">
                <h2 id="takedown-heading" className={SECTION_HEADING}>
                    Take down a score
                </h2>
                <form onSubmit={submitDraft} className="mt-3 grid gap-4">
                    <div>
                        <label htmlFor="takedown-document" className={fieldLabelClassName}>
                            Score link or id
                        </label>
                        <input
                            id="takedown-document"
                            type="text"
                            value={draft.document}
                            onChange={(event) => setDraft({ ...draft, document: event.target.value })}
                            className={`mt-1.5 ${fieldClassName('sm')}`}
                        />
                        {draft.reportId ? (
                            <p className={`mt-1 ${META}`}>
                                For report{' '}
                                {queue?.reports.find((row) => row.id === draft.reportId)?.reference ?? draft.reportId} ·{' '}
                                <button
                                    type="button"
                                    className={linkClassName}
                                    onClick={() => setDraft({ ...draft, reportId: '' })}
                                >
                                    not from a report
                                </button>
                            </p>
                        ) : null}
                    </div>
                    <fieldset>
                        <legend className={fieldLabelClassName}>Action</legend>
                        <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
                            {(
                                [
                                    ['remove', 'Remove', 'Nobody can open it, its owner included.'],
                                    ['restrict', 'Restrict', 'Unshared: only its owner can open it.'],
                                ] as const
                            ).map(([value, title, description]) => (
                                <label
                                    key={value}
                                    className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2 ${draft.mode === value ? 'border-accent bg-accent-soft' : 'border-stone-300/90 bg-white/70'}`}
                                >
                                    <input
                                        type="radio"
                                        name="takedown-mode"
                                        checked={draft.mode === value}
                                        onChange={() => setDraft({ ...draft, mode: value })}
                                        className="mt-1 accent-accent"
                                    />
                                    <span>
                                        <span className="block text-sm font-medium text-stone-800">{title}</span>
                                        <span className="block text-xs text-stone-500">{description}</span>
                                    </span>
                                </label>
                            ))}
                        </div>
                    </fieldset>
                    <div>
                        <label htmlFor="takedown-ground" className={fieldLabelClassName}>
                            Ground
                        </label>
                        <select
                            id="takedown-ground"
                            value={draft.ground}
                            onChange={(event) => {
                                const ground = event.target.value as Ground;
                                setDraft({ ...draft, ground, legalBasis: GROUND_DEFAULTS[ground] });
                            }}
                            className={`mt-1.5 ${fieldClassName('sm')}`}
                        >
                            <option value="copyright">Copyright (counts as a strike)</option>
                            <option value="illegal">Illegal content</option>
                            <option value="terms">Breach of the Terms of Service</option>
                        </select>
                    </div>
                    <div>
                        <label htmlFor="takedown-basis" className={fieldLabelClassName}>
                            {draft.ground === 'terms' ? 'Term relied on' : 'Law relied on'}
                        </label>
                        <input
                            id="takedown-basis"
                            type="text"
                            value={draft.legalBasis}
                            onChange={(event) => setDraft({ ...draft, legalBasis: event.target.value })}
                            className={`mt-1.5 ${fieldClassName('sm')}`}
                        />
                    </div>
                    <div>
                        <label htmlFor="takedown-facts" className={fieldLabelClassName}>
                            Facts relied on (sent to the uploader)
                        </label>
                        <textarea
                            id="takedown-facts"
                            rows={3}
                            value={draft.facts}
                            onChange={(event) => setDraft({ ...draft, facts: event.target.value })}
                            className={`mt-1.5 ${fieldClassName('sm', 'resize-y')}`}
                        />
                    </div>
                    <div>
                        <Button type="submit" size="sm" variant="danger">
                            Review takedown…
                        </Button>
                    </div>
                </form>
            </section>

            <section className={SECTION} aria-labelledby="live-takedowns">
                <h2 id="live-takedowns" className={SECTION_HEADING}>
                    Live takedowns ({liveTakedowns.length})
                </h2>
                {liveTakedowns.length === 0 ? (
                    <p className="mt-2 text-sm text-stone-600">None.</p>
                ) : (
                    <ul>{liveTakedowns.map(takedownCard)}</ul>
                )}
            </section>

            {decidedReports.length > 0 || pastTakedowns.length > 0 ? (
                <section className={SECTION} aria-labelledby="history">
                    <h2 id="history" className={SECTION_HEADING}>
                        Decided
                    </h2>
                    <ul>
                        {decidedReports.map(reportCard)}
                        {pastTakedowns.map(takedownCard)}
                    </ul>
                </section>
            ) : null}

            <section className={SECTION} aria-labelledby="notice-log">
                <h2 id="notice-log" className={SECTION_HEADING}>
                    Notice log
                </h2>
                {(queue?.log.length ?? 0) === 0 ? (
                    <p className="mt-2 text-sm text-stone-600">Nothing logged yet.</p>
                ) : (
                    <ol className="mt-3 space-y-1 text-xs text-stone-600">
                        {queue?.log.map((entry) => (
                            <li key={entry.id} className="[overflow-wrap:anywhere]">
                                <span className="text-stone-500">{when(entry.created_at)}</span> ·{' '}
                                {entry.event.replace(/_/g, ' ')}
                                {entry.recipient ? ` → ${entry.recipient}` : ''}
                                {entry.delivery ? ` (${entry.delivery})` : ''}
                            </li>
                        ))}
                    </ol>
                )}
            </section>

            {confirming ? (
                <ConfirmDialog
                    title={draft.mode === 'remove' ? 'Remove this score?' : 'Restrict this score?'}
                    body={`${draft.mode === 'remove' ? 'Nobody, including its owner, will be able to open it.' : 'Everyone but its owner loses access, and its share links stop working.'} The uploader is emailed a statement of reasons${draft.reportId ? ' and the reporter is told the outcome' : ''}.${draft.ground === 'copyright' ? ' This adds a copyright strike to the uploader’s account.' : ''} You can lift it later.`}
                    confirmLabel={draft.mode === 'remove' ? 'Remove score' : 'Restrict score'}
                    danger
                    busy={busy}
                    onConfirm={() => void confirmTakedown()}
                    onCancel={() => setConfirming(false)}
                />
            ) : null}
        </div>
    );
};
