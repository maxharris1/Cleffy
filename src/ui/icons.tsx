import { ArrowLeft, EllipsisVertical, Minus, Plus, Pointer, Redo2, Star, Undo2, X } from 'lucide-react';
import type { LucideIcon, LucideProps } from 'lucide-react';

/**
 * Lucide icons pinned to the 1.75 stroke of the hand-drawn tool icons in the
 * viewer toolbar, and aria-hidden by default (pair with aria-label on the control).
 */
const withBrandStroke = (Icon: LucideIcon) => {
    const BrandIcon = (props: LucideProps) => <Icon strokeWidth={1.75} aria-hidden="true" {...props} />;
    BrandIcon.displayName = `Brand(${Icon.displayName ?? 'Icon'})`;
    return BrandIcon;
};

export const ArrowLeftIcon = withBrandStroke(ArrowLeft);
export const CloseIcon = withBrandStroke(X);
export const UndoIcon = withBrandStroke(Undo2);
export const RedoIcon = withBrandStroke(Redo2);
export const ZoomInIcon = withBrandStroke(Plus);
export const ZoomOutIcon = withBrandStroke(Minus);
export const PointerIcon = withBrandStroke(Pointer);
export const StarIcon = withBrandStroke(Star);
export const MoreVerticalIcon = withBrandStroke(EllipsisVertical);
