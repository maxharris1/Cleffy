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
import { LEGAL_DOCUMENT_IDS, type LegalDocumentId } from '@/features/legal/legalVersions';
import { buttonClassName, linkClassName } from '@/ui/classNames';

const EMAIL = /([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi;

/** Plain text with any email address turned into a mailto link. */
const withMailto = (text: string): ReactNode =>
    text.split(EMAIL).map((part, index) =>
        // split() with a capture group puts the matches at the odd indices.
        index % 2 === 1 ? (
            <a key={index} href={`mailto:${part}`} className={linkClassName}>
                {part}
            </a>
        ) : (
            <Fragment key={index}>{part}</Fragment>
        ),
    );

const BODY = 'text-[0.95rem] leading-relaxed text-stone-700';

const Block = ({ block }: { block: LegalBlock }) => {
    switch (block.kind) {
        case 'h':
            return (
                <h3 className="mt-5 text-sm font-medium uppercase tracking-[0.08em] text-stone-600">{block.text}</h3>
            );
        case 'p':
            return <p className={`mt-3 ${BODY}`}>{withMailto(block.text)}</p>;
        case 'list':
            return (
                <ul className={`mt-3 list-disc space-y-2 pl-5 ${BODY} marker:text-stone-400`}>
                    {block.items.map((item) => (
                        <li key={item}>{withMailto(item)}</li>
                    ))}
                </ul>
            );
        case 'form':
            return (
                <div className={`mt-3 space-y-2 rounded-xl border border-stone-300 bg-white/70 px-4 py-3 ${BODY}`}>
                    {block.lines.map((line) => (
                        <p key={line} className="break-words">
                            {withMailto(line)}
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

/** The other three documents, one click away from each. */
const DocumentNav = ({ current }: { current: LegalDocumentId }) => (
    <nav aria-label="Policies">
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {LEGAL_DOCUMENT_IDS.map((id) => (
                <li key={id}>
                    {id === current ? (
                        <span aria-current="page" className="font-medium text-stone-800">
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
 * Same paper surface and reading column as the student and account pages, with
 * the wordmark linking home and the sibling documents one click away.
 */
const LegalPage = ({ document: doc }: { document: LegalDocument }) => (
    <main className="paper-page min-h-full">
        <div className="mx-auto w-full max-w-2xl px-4 py-6 sm:px-6 sm:py-10">
            <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
                <Link to="/" className="landing-brand font-display text-2xl font-semibold sm:text-3xl">
                    Cleffy
                </Link>
                <DocumentNav current={doc.id} />
            </header>

            <article className="mt-8 sm:mt-10">
                <h1 className="font-display text-3xl font-semibold tracking-tight text-stone-800">{doc.title}</h1>
                <p className="mt-2 text-sm text-stone-500">
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
                <p className="mt-4 text-[0.95rem] leading-relaxed text-stone-600">{doc.summary}</p>
                {doc.action ? (
                    <Link to={doc.action.to} className={buttonClassName('secondary', 'sm', 'mt-4')}>
                        {doc.action.label}
                    </Link>
                ) : null}

                <nav aria-label="Contents" className="mt-6 rounded-xl border border-stone-200/80 bg-white/60 px-4 py-3">
                    <ol className="grid gap-1 text-sm sm:grid-cols-2">
                        {doc.sections.map((section) => (
                            <li key={section.id}>
                                <a
                                    href={`#${section.id}`}
                                    className="text-stone-600 transition-colors hover:text-accent"
                                >
                                    {section.heading}
                                </a>
                            </li>
                        ))}
                    </ol>
                </nav>

                {doc.sections.map((section) => (
                    <section key={section.id} id={section.id} className="mt-8 scroll-mt-6">
                        <h2 className="font-display text-xl font-semibold text-stone-800">{section.heading}</h2>
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

export const TermsPage = () => <LegalPage document={LEGAL_DOCUMENTS.terms} />;

export const RefundPolicyPage = () => <LegalPage document={LEGAL_DOCUMENTS.refunds} />;

export const CopyrightPolicyPage = () => <LegalPage document={LEGAL_DOCUMENTS.copyright} />;
