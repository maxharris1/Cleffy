/**
 * The printable login card — the whole of a provisioned student's credential.
 *
 * A student has no email and no password to remember: they type the code off
 * this card into /student. So the card has to survive a school bag, be readable
 * off a music stand, and say where to go without an adult present. Hence the
 * short URL and the mono, wide-tracked code in the alphabet that already drops
 * 0/O and 1/I/L (see supabase/functions/_shared/studentCodes.ts).
 *
 * DELIBERATE DEVIATION: no QR code. Every QR generator is a new npm dependency,
 * and this milestone adds none — the origin plus a twelve-character code is the
 * card. If a QR is wanted later it belongs here, beside the code, not instead
 * of it: the code is what student-login accepts.
 *
 * Printing is a stylesheet, not a second render. `Print card` calls
 * window.print() and these rules hide the rest of the app — the shell, the
 * dialog scrim, the buttons — leaving the card alone at the top of the sheet.
 * visibility rather than display, so the card keeps its position in the tree
 * while everything around it stops painting.
 */
const PRINT_STYLES = `
@media print {
    @page {
        margin: 16mm;
    }

    body > #root {
        visibility: hidden;
    }

    .student-code-card,
    .student-code-card * {
        visibility: visible;
    }

    .student-code-card {
        position: fixed;
        left: 0;
        top: 0;
        width: 100%;
        margin: 0;
        padding: 14mm 10mm;
        background: #fff;
        border: 1px solid #1c1917;
        box-shadow: none;
    }

    /* Ink on white: the on-screen stone greys are too light to print, and no
       printer is asked to render a background. */
    .student-code-card-name,
    .student-code-card-code {
        color: #000;
    }

    .student-code-card-label,
    .student-code-card-hint {
        color: #3f3f46;
    }
}
`;

export interface StudentCodeCardProps {
    displayName: string;
    /** Already grouped XXXX-XXXX-XXXX by the server; shown exactly as given. */
    loginCode: string;
    className?: string;
}

export const StudentCodeCard = ({ displayName, loginCode, className = '' }: StudentCodeCardProps) => (
    <>
        <style>{PRINT_STYLES}</style>
        <div
            className={`student-code-card rounded-2xl border border-stone-300 bg-white px-5 py-6 text-center${
                className ? ` ${className}` : ''
            }`}
        >
            <p className="student-code-card-label text-xs font-medium uppercase tracking-[0.08em] text-stone-500">
                Cleffy login card
            </p>
            <p className="student-code-card-name mt-1 font-display text-2xl font-semibold text-stone-800">
                {displayName}
            </p>
            <p className="student-code-card-code mt-5 break-words font-mono text-2xl font-semibold tracking-widest text-ink sm:text-3xl">
                {loginCode}
            </p>
            <p className="student-code-card-hint mt-5 text-sm leading-relaxed text-stone-600">
                Go to <span className="font-medium text-stone-800">{window.location.origin}/student</span> and enter
                this code.
            </p>
            <p className="student-code-card-hint mt-1 text-xs text-stone-500">
                Keep this card — the code is never shown again.
            </p>
        </div>
    </>
);
