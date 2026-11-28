import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router';

import {
    LEGAL_DOCUMENTS,
    LEGAL_DOCUMENTS_ARE_DRAFTS,
    LEGAL_LAST_UPDATED,
    LEGAL_PATHS,
    LEGAL_VERSIONS,
    type LegalBlock,
    type LegalDocument,
} from '@/features/legal/legalContent';
import { DocumentHeader } from '@/features/legal/DocumentHeader';
import { LEGAL_DOCUMENT_IDS, type LegalDocumentId } from '@/features/legal/legalVersions';
import { buttonClassName, linkClassName } from '@/ui/classNames';

/** An email address, or an https URL that does not swallow the full stop after it. */
const LINKABLE = /(https:\/\/[^\s]*[^\s.,;:)]|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi;

/** Plain text with any email address or https URL turned into a link. */
const withLinks = (text: string): ReactNode =>
    text.split(LINKABLE).map((part, index) =>
        // split() with a capture group puts the matches at the odd indices.
        index % 2 === 1 ? (
            <a
                key={index}
                href={part.startsWith('https://') ? part : `mailto:${part}`}
                className={linkClassName}
                {...(part.startsWith('https://') ? { target: '_blank', rel: 'noreferrer' } : {})}
            >
                {part}
            </a>
        ) : (
            <Fragment key={index}>{part}</Fragment>
        ),
    );

const BODY = 'text-[15px] leading-relaxed text-ink-soft';

const Block = ({ block }: { block: LegalBlock }) => {
    switch (block.kind) {
        case 'h':
            return (
                <h3 className="display-opsz mt-6 font-display text-[19px] leading-[1.2] font-semibold text-ink">
                    {block.text}
                </h3>
            );
        case 'p':
            return <p className={`mt-3 ${BODY}`}>{withLinks(block.text)}</p>;
        case 'list':
            return (
                <ul className={`mt-3 list-disc space-y-2 pl-5 ${BODY} marker:text-ink-muted`}>
                    {block.items.map((item) => (
                        <li key={item}>{withLinks(item)}</li>
                    ))}
                </ul>
            );
        case 'form':
            return (
                <div className={`mt-3 space-y-2 rounded-[14px] border border-panel-line px-4 py-3 ${BODY}`}>
                    {block.lines.map((line) => (
                        <p key={line} className="break-words">
                            {withLinks(line)}
                        </p>
                    ))}
                </div>
            );
        case 'placeholder':
            return (
                <p
                    className={`mt-3 rounded-lg border border-dashed border-amber-400 bg-amber-50 px-3 py-2 ${BODY} text-amber-900`}
                >
                    <strong className="font-semibold">Placeholder — awaiting legal review:</strong> {block.text}
                </p>
            );
    }
};

/** The other documents, one click away from each. */
const DocumentNav = ({ current }: { current: LegalDocumentId }) => (
    <nav aria-label="Policies">
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {LEGAL_DOCUMENT_IDS.map((id) => (
                <li key={id}>
                    {id === current ? (
                        <span aria-current="page" className="font-semibold text-ink">
                            {LEGAL_DOCUMENTS[id].shortTitle}
                        </span>
                    ) : (
                        <Link to={LEGAL_PATHS[id]} className={linkClassName}>
                            {LEGAL_DOCUMENTS[id].shortTitle}
                        </Link>
                    )}
                </li>
            ))}
        </ul>
    </nav>
);

/**
 * One legal document as a reading page. Public, outside every auth gate: the
 * sign-up form and the footer link here, so it must render for someone with
 * no session.
 *
 * Flat paper and a reading column, with the wordmark linking home and the sibling documents one click away.
 */
const LegalPage = ({ document: doc }: { document: LegalDocument }) => (
    <main className="paper-page safe-page min-h-full">
        <div className="mx-auto w-full max-w-2xl px-4 py-6 sm:px-6 sm:py-10">
            <DocumentHeader>
                <DocumentNav current={doc.id} />
            </DocumentHeader>

            <article className="mt-8 sm:mt-10">
                <h1 className="display-opsz font-display text-[44px] leading-[1.02] font-semibold tracking-[-0.02em] text-balance text-ink [overflow-wrap:anywhere] sm:text-[60px]">
                    {doc.title}
                </h1>
                <p className="mt-3.5 text-[13px] text-ink-muted tabular-nums">
                    Last updated {LEGAL_LAST_UPDATED[doc.id]} · Version {LEGAL_VERSIONS[doc.id]}
                </p>
                {LEGAL_DOCUMENTS_ARE_DRAFTS ? (
                    <p
                        role="note"
                        className="mt-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm leading-relaxed text-amber-900"
                    >
                        Draft: this document is awaiting final legal review. Passages marked “Placeholder” will be
                        replaced before it takes effect.
                    </p>
                ) : null}
                <p className="mt-4 text-[17px] leading-normal text-pretty text-ink-muted">{doc.summary}</p>
                {doc.action ? (
                    <Link to={doc.action.to} className={buttonClassName('secondary', 'sm', 'mt-4')}>
                        {doc.action.label}
                    </Link>
                ) : null}

                <nav aria-label="Contents" className="mt-8 border-y border-hairline px-1 py-4">
                    <ol className="grid gap-1 text-sm sm:grid-cols-2">
                        {doc.sections.map((section) => (
                            <li key={section.id}>
                                <a
                                    href={`#${section.id}`}
                                    className="text-ink-soft transition-colors hover:text-accent"
                                >
                                    {section.heading}
                                </a>
                            </li>
                        ))}
                    </ol>
                </nav>

                {doc.sections.map((section) => (
                    <section key={section.id} id={section.id} className="mt-10 scroll-mt-6">
                        <h2 className="display-opsz font-display text-[26px] leading-[1.1] font-semibold tracking-[-0.01em] text-balance text-ink">
                            {section.heading}
                        </h2>
                        {section.blocks.map((block, index) => (
                            <Block key={index} block={block} />
                        ))}
                    </section>
                ))}
            </article>
        </div>
    </main>
);

export const PrivacyPage = () => <LegalPage document={LEGAL_DOCUMENTS.privacy} />;

export const ChildrenPrivacyPage = () => <LegalPage document={LEGAL_DOCUMENTS.children} />;

export const TermsPage = () => <LegalPage document={LEGAL_DOCUMENTS.terms} />;

export const RefundPolicyPage = () => <LegalPage document={LEGAL_DOCUMENTS.refunds} />;

export const CopyrightPolicyPage = () => <LegalPage document={LEGAL_DOCUMENTS.copyright} />;
