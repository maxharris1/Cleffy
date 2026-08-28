/**
 * Engraved five-line staff standing in for a first page that has not rendered
 * yet (score not cached on this device, render still queued, or a PDF pdf.js
 * could not open).
 *
 * Shared by the list row's 36x48 thumbnail and the shelf card's full A4 cover,
 * which is the only reason the stroke is a prop: the viewBox is drawn about six
 * times larger on a cover, where a 1-unit line stops reading as a hairline.
 * The row's default keeps its original rendering exactly.
 */
export const StaffPlaceholder = ({ strokeWidth = 1 }: { strokeWidth?: number }) => (
    <svg viewBox="0 0 36 48" className="h-full w-full text-stone-300" aria-hidden="true">
        {[15, 19.5, 24, 28.5, 33].map((y) => (
            <line key={y} x1={5} x2={31} y1={y} y2={y} stroke="currentColor" strokeWidth={strokeWidth} />
        ))}
    </svg>
);
