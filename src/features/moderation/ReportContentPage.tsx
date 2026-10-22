import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';

import { TurnstileField } from '@/features/auth/TurnstileField';
import { isTurnstileEnabled } from '@/features/auth/turnstile';
import { LEGAL_ENTITY } from '@/features/legal/legalEntity';
import {
    ILLEGAL_CATEGORY_LABELS,
    ReportError,
    submitContentReport,
    type IllegalCategory,
    type ReportKind,
} from '@/features/moderation/moderationApi';
import { Button } from '@/ui/Button';
import { fieldClassName, fieldLabelClassName, linkClassName } from '@/ui/classNames';
import { ErrorText } from '@/ui/ErrorText';
import { TextField } from '@/ui/TextField';

const PERJURY_STATEMENT =
    'I have a good-faith belief that the use of the material described above is not authorised by the copyright owner, its agent or the law. The information in this notice is accurate and, under penalty of perjury, I am the owner of the copyright or authorised to act on the owner’s behalf.';

const GOOD_FAITH_STATEMENT =
    'I believe in good faith that the information and allegations in this report are accurate and complete.';

const Paper = ({ children }: { children: ReactNode }) => (
    <main className="paper-page min-h-full">
        <div className="mx-auto w-full max-w-2xl px-4 py-6 sm:px-6 sm:py-10">
            <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
                <Link to="/" className="landing-brand font-display text-2xl font-semibold sm:text-3xl">
                    Cleffy
                </Link>
                <Link to="/copyright" className={`${linkClassName} text-sm`}>
                    Copyright and Content Policy
                </Link>
            </header>
            {children}
        </div>
    </main>
);

const Check = ({
    id,
    checked,
    onChange,
    children,
}: {
    id: string;
    checked: boolean;
    onChange: (value: boolean) => void;
    children: ReactNode;
}) => (
    <div className="mt-4 flex items-start gap-3">
        <input
            id={id}
            type="checkbox"
            checked={checked}
            onChange={(event) => onChange(event.target.checked)}
            className="mt-1 h-4 w-4 shrink-0 accent-accent"
        />
        <label htmlFor={id} className="text-sm leading-relaxed text-stone-700">
            {children}
        </label>
    </div>
);

const TextArea = ({
    id,
    label,
    hint,
    value,
    onChange,
    rows = 4,
    required = false,
}: {
    id: string;
    label: string;
    hint?: string;
    value: string;
    onChange: (value: string) => void;
    rows?: number;
    required?: boolean;
}) => (
    <div className="mt-5">
        <label htmlFor={id} className={fieldLabelClassName}>
            {label}
        </label>
        {hint ? (
            <p id={`${id}-hint`} className="mt-1 text-xs text-stone-500">
                {hint}
            </p>
        ) : null}
        <textarea
            id={id}
            rows={rows}
            required={required}
            value={value}
            aria-describedby={hint ? `${id}-hint` : undefined}
            onChange={(event) => onChange(event.target.value)}
            className={`mt-1.5 ${fieldClassName('md', 'resize-y')}`}
        />
    </div>
);

/**
 * The notice-and-action form (Copyright and Content Policy, DSA Art. 16, DMCA
 * §512(c)(3)). Public: anyone may report a score, signed in or not. A link to
 * it can carry the score's address in `?url=`.
 */
export const ReportContentPage = () => {
    const [params] = useSearchParams();
    const [kind, setKind] = useState<ReportKind>('copyright');
    const [category, setCategory] = useState<IllegalCategory | ''>('');
    const [contentUrl, setContentUrl] = useState(params.get('url') ?? '');
    const [workDescription, setWorkDescription] = useState('');
    const [onBehalfOf, setOnBehalfOf] = useState('');
    const [explanation, setExplanation] = useState('');
    const [reporterName, setReporterName] = useState('');
    const [reporterEmail, setReporterEmail] = useState('');
    const [reporterAddress, setReporterAddress] = useState('');
    const [reporterPhone, setReporterPhone] = useState('');
    const [goodFaith, setGoodFaith] = useState(false);
    const [perjury, setPerjury] = useState(false);
    const [signature, setSignature] = useState('');
    const [captchaToken, setCaptchaToken] = useState<string | null>(null);
    const [captchaRound, setCaptchaRound] = useState(0);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState<{ reference: string; acknowledged: boolean } | null>(null);

    const copyright = kind === 'copyright';

    const onSubmit = async (event: FormEvent) => {
        event.preventDefault();
        if (submitting) {
            return;
        }
        if (!copyright && !category) {
            setError('Choose what the content is.');
            return;
        }
        if (!goodFaith || (copyright && !perjury)) {
            setError('Confirm the statements above to send the report.');
            return;
        }
        if (isTurnstileEnabled() && !captchaToken) {
            setError('Finish the “I’m human” check, then send.');
            return;
        }
        setError(null);
        setSubmitting(true);
        try {
            const result = await submitContentReport(
                {
                    kind,
                    ...(copyright ? {} : { category: category as IllegalCategory }),
                    contentUrl,
                    workDescription: copyright ? workDescription : undefined,
                    onBehalfOf: copyright ? onBehalfOf : undefined,
                    explanation,
                    reporterName,
                    reporterEmail,
                    reporterAddress,
                    reporterPhone,
                    goodFaith,
                    perjuryStatement: copyright && perjury,
                    signature,
                },
                captchaToken,
            );
            setDone(result);
        } catch (err) {
            setError(err instanceof ReportError || err instanceof Error ? err.message : 'Could not send the report.');
            // A Turnstile token is single use: a retry needs a fresh challenge.
            setCaptchaToken(null);
            setCaptchaRound((round) => round + 1);
        } finally {
            setSubmitting(false);
        }
    };

    if (done) {
        return (
            <Paper>
                <section className="mt-8 sm:mt-10" aria-live="polite">
                    <h1 className="font-display text-3xl font-semibold tracking-tight text-stone-800">
                        Report received
                    </h1>
                    <p className="mt-4 text-[0.95rem] leading-relaxed text-stone-700">
                        Your reference is <strong className="font-semibold">{done.reference}</strong>. A person will
                        review your report, and we will email you what we decide.
                    </p>
                    <p className="mt-3 text-[0.95rem] leading-relaxed text-stone-700">
                        {done.acknowledged
                            ? `We have emailed a confirmation to ${reporterEmail.trim()}.`
                            : `We've received your report and will email a confirmation to ${reporterEmail.trim()} as soon as possible; keep this reference meanwhile.`}{' '}
                        To follow up, write to{' '}
                        <a href={`mailto:${LEGAL_ENTITY.emails.legal}`} className={linkClassName}>
                            {LEGAL_ENTITY.emails.legal}
                        </a>
                        .
                    </p>
                    <p className="mt-6 text-sm">
                        <Link to="/" className={linkClassName}>
                            Back to Cleffy
                        </Link>
                    </p>
                </section>
            </Paper>
        );
    }

    return (
        <Paper>
            <section className="mt-8 sm:mt-10">
                <h1 className="font-display text-3xl font-semibold tracking-tight text-stone-800">Report content</h1>
                <p className="mt-3 text-[0.95rem] leading-relaxed text-stone-600">
                    Tell us about a score on Cleffy that you believe infringes copyright or is illegal. You do not need
                    a Cleffy account. We confirm every report by email and tell you what we decide. You can also write
                    to{' '}
                    <a href={`mailto:${LEGAL_ENTITY.emails.legal}`} className={linkClassName}>
                        {LEGAL_ENTITY.emails.legal}
                    </a>
                    .
                </p>

                <form onSubmit={(event) => void onSubmit(event)} className="mt-6" noValidate>
                    <fieldset>
                        <legend className={fieldLabelClassName}>What are you reporting?</legend>
                        <div className="mt-2 grid gap-2 sm:grid-cols-2">
                            {(
                                [
                                    [
                                        'copyright',
                                        'Copyright infringement',
                                        'You own the rights, or act for whoever does.',
                                    ],
                                    ['illegal', 'Illegal content', 'Anything else you believe breaks the law.'],
                                ] as const
                            ).map(([value, title, description]) => (
                                <label
                                    key={value}
                                    className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3.5 py-3 transition ${kind === value ? 'border-accent bg-accent-soft' : 'border-stone-300/90 bg-white/70'}`}
                                >
                                    <input
                                        type="radio"
                                        name="kind"
                                        value={value}
                                        checked={kind === value}
                                        onChange={() => setKind(value)}
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

                    {!copyright ? (
                        <div className="mt-5">
                            <label htmlFor="report-category" className={fieldLabelClassName}>
                                What is the content?
                            </label>
                            <select
                                id="report-category"
                                value={category}
                                onChange={(event) => setCategory(event.target.value as IllegalCategory | '')}
                                className={`mt-1.5 ${fieldClassName()}`}
                            >
                                <option value="">Choose one…</option>
                                {Object.entries(ILLEGAL_CATEGORY_LABELS).map(([value, label]) => (
                                    <option key={value} value={value}>
                                        {label}
                                    </option>
                                ))}
                            </select>
                        </div>
                    ) : null}

                    <div className="mt-5">
                        <TextField
                            id="report-url"
                            label="Link to the score"
                            type="text"
                            inputMode="url"
                            autoComplete="off"
                            placeholder="https://cleffy.io/doc/…"
                            required
                            value={contentUrl}
                            onChange={(event) => setContentUrl(event.target.value)}
                        />
                        <p className="mt-1 text-xs text-stone-500">
                            The score’s address, or the share link you were sent.
                        </p>
                    </div>

                    {copyright ? (
                        <>
                            <TextArea
                                id="report-work"
                                label="The copyrighted work"
                                hint="Title, composer, arranger, publisher and edition — enough for us to identify it."
                                rows={3}
                                required
                                value={workDescription}
                                onChange={setWorkDescription}
                            />
                            <div className="mt-5">
                                <TextField
                                    id="report-behalf"
                                    label="Rights holder (if not you)"
                                    type="text"
                                    autoComplete="organization"
                                    value={onBehalfOf}
                                    onChange={(event) => setOnBehalfOf(event.target.value)}
                                />
                            </div>
                        </>
                    ) : null}

                    <TextArea
                        id="report-explanation"
                        label={copyright ? 'How the score infringes it' : 'Why the content is illegal'}
                        hint={
                            copyright
                                ? 'For example: which pages are copied, and from which edition.'
                                : 'Explain what is illegal about it and, if you can, which law it breaks.'
                        }
                        rows={5}
                        required
                        value={explanation}
                        onChange={setExplanation}
                    />

                    <h2 className="mt-8 font-display text-xl font-semibold text-stone-800">About you</h2>
                    <div className="mt-3 grid gap-x-4 sm:grid-cols-2">
                        <div className="mt-2">
                            <TextField
                                id="report-name"
                                label="Your name"
                                type="text"
                                autoComplete="name"
                                required
                                value={reporterName}
                                onChange={(event) => setReporterName(event.target.value)}
                            />
                        </div>
                        <div className="mt-2">
                            <TextField
                                id="report-email"
                                label="Your email"
                                type="email"
                                autoComplete="email"
                                required
                                value={reporterEmail}
                                onChange={(event) => setReporterEmail(event.target.value)}
                            />
                        </div>
                        <div className="mt-4">
                            <TextField
                                id="report-address"
                                label={copyright ? 'Postal address' : 'Postal address (optional)'}
                                type="text"
                                autoComplete="street-address"
                                value={reporterAddress}
                                onChange={(event) => setReporterAddress(event.target.value)}
                            />
                        </div>
                        <div className="mt-4">
                            <TextField
                                id="report-phone"
                                label={copyright ? 'Phone' : 'Phone (optional)'}
                                type="tel"
                                autoComplete="tel"
                                value={reporterPhone}
                                onChange={(event) => setReporterPhone(event.target.value)}
                            />
                        </div>
                    </div>

                    <Check id="report-good-faith" checked={goodFaith} onChange={setGoodFaith}>
                        {GOOD_FAITH_STATEMENT}
                    </Check>
                    {copyright ? (
                        <Check id="report-perjury" checked={perjury} onChange={setPerjury}>
                            {PERJURY_STATEMENT}
                        </Check>
                    ) : null}

                    <div className="mt-5">
                        <TextField
                            id="report-signature"
                            label="Signature: type your full name"
                            type="text"
                            autoComplete="name"
                            required
                            value={signature}
                            onChange={(event) => setSignature(event.target.value)}
                        />
                    </div>

                    <p className="mt-4 text-xs leading-relaxed text-stone-500">
                        We use what you send to handle this report, as our{' '}
                        <Link to="/privacy" className={linkClassName}>
                            Privacy Policy
                        </Link>{' '}
                        describes. We do not give the uploader your contact details unless the law requires it.
                        {copyright
                            ? ' Knowingly misrepresenting that material infringes can make you liable for damages.'
                            : ''}
                    </p>

                    <TurnstileField
                        key={captchaRound}
                        action="content-report"
                        onToken={setCaptchaToken}
                        className="mt-5"
                    />

                    {error ? <ErrorText className="mt-4">{error}</ErrorText> : null}

                    <Button type="submit" className="mt-6 w-full sm:w-auto" disabled={submitting}>
                        {submitting ? 'Sending…' : 'Send report'}
                    </Button>
                </form>
            </section>
        </Paper>
    );
};
