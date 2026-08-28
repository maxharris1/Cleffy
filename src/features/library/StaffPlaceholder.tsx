/**
 * Engraved five-line staff standing in for a first page that has not rendered
 * yet (score not cached on this device, render still queued, or a PDF pdf.js
 * could not open).
 *
 * Used by the list row's 36x48 thumbnail, which is far too small to carry type.
 * The shelf card sets its own typographic fallback instead — at cover size an
 * empty staff says nothing about which score it is.
 */
export const StaffPlaceholder = () => (
    <svg viewBox="0 0 36 48" className="h-full w-full text-stone-300" aria-hidden="true">
        {[15, 19.5, 24, 28.5, 33].map((y) => (
            <line key={y} x1={5} x2={31} y1={y} y2={y} stroke="currentColor" strokeWidth={1} />
        ))}
    </svg>
);
