import {
    ArrowLeft,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    ChevronUp,
    EllipsisVertical,
    Hourglass,
    LocateFixed,
    Minus,
    Music,
    Pause,
    Play,
    Plus,
    Pointer,
    Redo2,
    RefreshCw,
    Repeat,
    Settings2,
    SkipBack,
    Square,
    Star,
    Tags,
    Timer,
    Undo2,
    Upload,
    Volume2,
    VolumeX,
    X,
} from 'lucide-react';
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
export const TagIcon = withBrandStroke(Tags);
export const MoreVerticalIcon = withBrandStroke(EllipsisVertical);
export const SettingsIcon = withBrandStroke(Settings2);
export const UploadIcon = withBrandStroke(Upload);

// Play-along transport.
export const PlayIcon = withBrandStroke(Play);
export const PauseIcon = withBrandStroke(Pause);
export const StopIcon = withBrandStroke(Square);
export const SkipBackIcon = withBrandStroke(SkipBack);
export const HourglassIcon = withBrandStroke(Hourglass);
export const ChevronLeftIcon = withBrandStroke(ChevronLeft);
export const ChevronRightIcon = withBrandStroke(ChevronRight);
export const ChevronDownIcon = withBrandStroke(ChevronDown);
export const ChevronUpIcon = withBrandStroke(ChevronUp);
export const Volume2Icon = withBrandStroke(Volume2);
export const VolumeXIcon = withBrandStroke(VolumeX);
export const RepeatIcon = withBrandStroke(Repeat);
export const MetronomeIcon = withBrandStroke(Timer);
export const FollowIcon = withBrandStroke(LocateFixed);
export const MusicIcon = withBrandStroke(Music);
export const RetryIcon = withBrandStroke(RefreshCw);
