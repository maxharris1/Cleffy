import { useState } from 'react';

import { hasScoreSource, requiresAttribution, type ProvenanceFields } from '@/features/viewer/scoreSource';
import { Dialog } from '@/ui/Dialog';
import { buttonClassName, linkClassName } from '@/ui/classNames';

/**
 * "Source" in the viewer header: where an imported score came from, its
 * license, and who IMSLP credits for the edition. Shown to everyone on the
 * score, not only the owner — a Creative Commons Attribution edition shared
 * from Cleffy must still name its editor/engraver to the people it reaches.
 * Renders nothing for an uploaded PDF (no recorded source).
 */
export const ScoreSourceButton = ({ doc }: { doc: ProvenanceFields }) => {
    const [open, setOpen] = useState(false);
    if (!hasScoreSource(doc)) {
        return null;
    }
    return (
        <>
            <button
                type="button"
                title="Source and license of this score"
                onClick={() => setOpen(true)}
                className={buttonClassName('ghost', 'sm')}
            >
                Source
            </button>
            {open ? (
                <Dialog label="About this score" onClose={() => setOpen(false)}>
                    <ScoreSourceDetails doc={doc} />
                </Dialog>
            ) : null}
        </>
    );
};

const Row = ({ term, value }: { term: string; value: string | null | undefined }) =>
    value ? (
        <div className="flex flex-wrap gap-x-2 py-1">
            <dt className="w-24 shrink-0 text-stone-500">{term}</dt>
            <dd className="min-w-0 flex-1 break-words text-stone-800">{value}</dd>
        </div>
    ) : null;

export const ScoreSourceDetails = ({ doc }: { doc: ProvenanceFields }) => {
    const credit = doc.source_attribution ?? null;
    const publisher = credit?.publisher
        ? [credit.publisher, credit.year].filter(Boolean).join(', ')
        : credit?.year
          ? String(credit.year)
          : null;
    // The column only ever holds an https URL (documents_source_url_check);
    // checked again here because it becomes a link.
    const sourceUrl = doc.source_url && doc.source_url.startsWith('https://') ? doc.source_url : null;
    return (
        <div className="text-sm">
            {credit?.source === 'imslp' || sourceUrl?.startsWith('https://imslp.org/') ? (
                <p className="text-stone-600">Imported from IMSLP, the Petrucci Music Library.</p>
            ) : null}
            <dl className="mt-3">
                <Row term="Work" value={credit?.work} />
                <Row term="Composer" value={credit?.composer} />
                <Row term="Editor" value={credit?.editor} />
                <Row term="Arranger" value={credit?.arranger} />
                <Row term="Publisher" value={publisher} />
                <Row term="License" value={doc.source_license ?? 'Not recorded'} />
                <Row term="File" value={doc.source_filename} />
            </dl>
            {requiresAttribution(doc.source_license) ? (
                <p className="mt-3 text-xs leading-relaxed text-stone-600">
                    This edition is shared under a Creative Commons license that requires attribution. Keep this credit
                    with any copy you share or print.
                </p>
            ) : null}
            {sourceUrl ? (
                <a
                    href={sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className={`mt-3 inline-block text-sm ${linkClassName}`}
                >
                    View on IMSLP
                </a>
            ) : null}
        </div>
    );
};
