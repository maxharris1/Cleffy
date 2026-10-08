import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router';

import {
    LEGAL_LAST_UPDATED,
    PRIVACY_POLICY,
    TERMS_OF_SERVICE,
    type LegalBlock,
    type LegalDocument,
} from '@/features/legal/legalContent';
import { linkClassName } from '@/ui/classNames';

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

const Block = ({ block }: { block: LegalBlock }) =>
    block.kind === 'h' ? (
        <h3 className="mt-5 text-sm font-medium uppercase tracking-[0.08em] text-stone-600">{block.text}</h3>
    ) : block.kind === 'p' ? (
        <p className="mt-3 text-[0.95rem] leading-relaxed text-stone-700">{withMailto(block.text)}</p>
    ) : (
        <ul className="mt-3 list-disc space-y-2 pl-5 text-[0.95rem] leading-relaxed text-stone-700 marker:text-stone-400">
            {block.items.map((item) => (
                <li key={item}>{withMailto(item)}</li>
            ))}
        </ul>
    );

/**
 * One legal document as a reading page. Public, outside every auth gate: the
 * sign-up form links here, so it must render for someone with no session.
 *
 * Same paper surface and reading column as the student and account pages, with
 * the wordmark linking home and the sibling document one click away.
 */
const LegalPage = ({ document: doc, sibling }: { document: LegalDocument; sibling: 'privacy' | 'terms' }) => (
    <main className="paper-page min-h-full">
        <div className="mx-auto w-full max-w-2xl px-4 py-6 sm:px-6 sm:py-10">
            <header className="flex items-baseline justify-between gap-4">
                <Link to="/" className="landing-brand font-display text-2xl font-semibold sm:text-3xl">
                    Cleffy
                </Link>
                <Link to={sibling === 'privacy' ? '/privacy' : '/terms'} className={linkClassName}>
                    {sibling === 'privacy' ? 'Privacy Policy' : 'Terms of Service'}
                </Link>
            </header>

            <article className="mt-8 sm:mt-10">
                <h1 className="font-display text-3xl font-semibold tracking-tight text-stone-800">{doc.title}</h1>
                <p className="mt-2 text-sm text-stone-500">Last updated {LEGAL_LAST_UPDATED}</p>
                <p className="mt-4 text-[0.95rem] leading-relaxed text-stone-600">{doc.summary}</p>

                <nav aria-label="Contents" className="mt-6 rounded-xl border border-stone-200/80 bg-white/60 px-4 py-3">
                    <ol className="grid gap-1 text-sm sm:grid-cols-2">
                        {doc.sections.map((section) => (
                            <li key={section.id}>
                                <a href={`#${section.id}`} className="text-stone-600 transition hover:text-accent">
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

export const PrivacyPage = () => <LegalPage document={PRIVACY_POLICY} sibling="terms" />;

export const TermsPage = () => <LegalPage document={TERMS_OF_SERVICE} sibling="privacy" />;
