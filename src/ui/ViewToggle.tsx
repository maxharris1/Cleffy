import { LayoutGridIcon, ListIcon } from '@/ui/icons';
import { Segmented } from '@/ui/Segmented';

export type ToggleView = 'grid' | 'list';

const OPTIONS = [
    { value: 'grid', label: 'Grid view', icon: <LayoutGridIcon size={15} /> },
    { value: 'list', label: 'List view', icon: <ListIcon size={15} /> },
] as const;

/**
 * Shelf or list. Two icon buttons rather than a select: it is a two-state
 * choice made rarely, and the icons say what the words would. The selection
 * slides across (Segmented), so the switch reads as one choice moving.
 */
export const ViewToggle = ({ view, onChange }: { view: ToggleView; onChange: (v: ToggleView) => void }) => (
    <Segmented label="View" value={view} options={OPTIONS} onChange={onChange} />
);
