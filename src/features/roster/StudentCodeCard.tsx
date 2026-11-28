/**
 * The printable setup card — how a code-method student reaches their account
 * the once, before they have a credential of their own.
 *
 * The code on it is spent, not kept: the student types it into /student/claim,
 * chooses a username and password, and from then on signs in with those and the
 * card is waste paper. It still has to survive a school bag, be readable off a
 * music stand, and say where to go without an adult present — hence the short
 * URL and the mono, wide-tracked code in the alphabet that already drops 0/O and
 * 1/I/L (see supabase/functions/_shared/studentCodes.ts).
 *
 * DELIBERATE DEVIATION: no QR code. Every QR generator is a new npm dependency,
 * and this milestone adds none — the origin plus a twelve-character code is the
 * card. If a QR is wanted later it belongs here, beside the code, not instead
 * of it: the code is what student-login accepts.
 *
 * Printing is a stylesheet, not a second render. `Print card` calls
 * window.print() and the rules in StudentCodeCard.css hide the rest of the
 * app — the shell, the dialog scrim, the buttons — leaving the card alone at
 * the top of the sheet.
 * visibility rather than display, so the card keeps its position in the tree
 * while everything around it stops painting.
 */
import type { ReactNode } from 'react';

import './StudentCodeCard.css';

export interface StudentCodeCardProps {
    displayName: string;
    /** Already grouped XXXX-XXXX-XXXX by the server; shown exactly as given. */
    loginCode: string;
    /**
     * The username this student already claimed, on a card that replaces the
     * access of somebody who has been signing in for a while. Printed so they
     * are not asked to remember a name they picked months ago.
     */
    username?: string | null;
    /** The teacher's own display name; the "From" line is left off without one. */
    teacherName?: string;
    /** Where the claim page lives; this deployment's origin by default. */
    site?: string;
    /** Off for a card drawn as decoration, so printing that page does not print only the card. */
    printable?: boolean;
    className?: string;
}

const Step = ({ letter, children }: { letter: string; children: ReactNode }) => (
    <li className="flex items-start gap-3.5">
        <span
            aria-hidden="true"
            className="student-code-card-letter box-content flex size-[30px] flex-none items-center justify-center border-[1.5px] border-ink font-display text-[17px] font-semibold"
        >
            {letter}
        </span>
        <div className="min-w-0 flex-1 pt-1 text-[15px] leading-[1.45]">{children}</div>
    </li>
);

export const StudentCodeCard = ({
    displayName,
    loginCode,
    username = null,
    teacherName = '',
    site = window.location.origin,
    printable = true,
    className = '',
}: StudentCodeCardProps) => (
    <div
        className={`${printable ? 'student-code-card ' : ''}rounded bg-white p-3 text-left text-ink shadow-[0_0_0_1px_rgba(28,25,23,0.1),0_34px_60px_-30px_rgba(0,0,0,0.6)]${
            className ? ` ${className}` : ''
        }`}
    >
        <div className="student-code-card-frame border border-ink px-4 pt-5 pb-4 sm:px-[22px] sm:pt-[22px]">
            <div className="flex items-center justify-between gap-3">
                <span className="inline-flex items-center gap-2">
                    <span className="landing-brand font-display text-[22px] font-semibold">Cleffy</span>
                    <span
                        aria-hidden="true"
                        className="student-code-card-rule mt-1 w-[21px] border-t-2 border-accent"
                    />
                </span>
                <p className="student-code-card-label text-xs font-semibold tracking-[0.08em] text-ink-muted uppercase">
                    Setup card
                </p>
            </div>
            <p className="student-code-card-name mt-5 font-display text-[40px] leading-[1.05] font-semibold tracking-[-0.01em] [overflow-wrap:anywhere]">
                {displayName}
            </p>
            {teacherName ? (
                <p className="student-code-card-hint mt-1.5 text-sm text-ink-muted [overflow-wrap:anywhere]">
                    From {teacherName}
                </p>
            ) : null}
            {username ? (
                <p className="student-code-card-hint mt-1.5 text-sm text-ink-muted">
                    Your username: <span className="font-medium text-ink [overflow-wrap:anywhere]">{username}</span>
                </p>
            ) : null}
            <ol className="mt-5 flex flex-col gap-3.5">
                <Step letter="A">
                    Go to <strong className="[overflow-wrap:anywhere]">{site}/student/claim</strong>
                </Step>
                <Step letter="B">
                    Type this setup code
                    <p className="student-code-card-code mt-2.5 w-fit max-w-full border-[1.5px] border-dashed border-[#8a8478] px-3.5 py-2.5 font-mono text-[15px] font-bold tracking-[0.06em] sm:tracking-[0.12em] [overflow-wrap:anywhere] sm:text-[22px]">
                        {loginCode}
                    </p>
                </Step>
                <Step letter="C">Choose a username and a password. That’s it.</Step>
            </ol>
            <p className="student-code-card-hint mt-[18px] border-t border-hairline pt-3 text-xs leading-[1.45] text-ink-muted">
                Keep this card. The code works once and is never shown again.
            </p>
        </div>
    </div>
);
