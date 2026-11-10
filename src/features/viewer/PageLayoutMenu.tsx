import type { PageColumns } from '@/features/viewer/geometry';
import { COVER_PAGE_HINT } from '@/features/viewer/viewerPrefs';
import { SinglePageIcon, TwoPagesIcon } from '@/ui/icons';
import { Menu, MenuCheckboxItem, MenuRadioGroup, MenuRadioItem, MenuSeparator } from '@/ui/Menu';

const LAYOUT_NAMES: Record<PageColumns, string> = { 1: 'Single page', 2: 'Two pages' };

/**
 * The viewer's page layout, folded into one round button in the floating
 * stack, the size of the zoom keys beside it. Its icon is the layout showing;
 * pressing it opens a menu with Single page and Two pages and, in two-page
 * mode only, Start with cover page. Choosing closes the menu, as do a press
 * outside it and Escape.
 *
 * The same two choices live in Account → Preferences; both write the store,
 * which keeps them for the next visit.
 */
export const PageLayoutMenu = ({
    pageColumns,
    onPageColumnsChange,
    spreadCover,
    onSpreadCoverChange,
    triggerClassName,
}: {
    pageColumns: PageColumns;
    onPageColumnsChange: (columns: PageColumns) => void;
    spreadCover: boolean;
    onSpreadCoverChange: (spreadCover: boolean) => void;
    triggerClassName: string;
}) => {
    const name = LAYOUT_NAMES[pageColumns];
    const Icon = pageColumns === 2 ? TwoPagesIcon : SinglePageIcon;
    return (
        <Menu
            label={`Page layout: ${name}`}
            triggerTitle={`Page layout: ${name}`}
            triggerClassName={triggerClassName}
            triggerContent={<Icon size={20} />}
            menuLabel="Page layout"
            popupClassName="w-60"
            side="top"
        >
            <MenuRadioGroup
                label="Pages per row"
                value={String(pageColumns)}
                onValueChange={(value) => {
                    const columns: PageColumns = value === '2' ? 2 : 1;
                    if (columns !== pageColumns) {
                        onPageColumnsChange(columns);
                    }
                }}
            >
                <MenuRadioItem value="1">
                    <SinglePageIcon size={18} />
                    {LAYOUT_NAMES[1]}
                </MenuRadioItem>
                <MenuRadioItem value="2">
                    <TwoPagesIcon size={18} />
                    {LAYOUT_NAMES[2]}
                </MenuRadioItem>
            </MenuRadioGroup>
            {pageColumns === 2 ? (
                <>
                    <MenuSeparator />
                    <MenuCheckboxItem
                        checked={spreadCover}
                        onCheckedChange={onSpreadCoverChange}
                        title={COVER_PAGE_HINT}
                    >
                        <span aria-hidden="true" className="w-[18px] shrink-0" />
                        Start with cover page
                    </MenuCheckboxItem>
                </>
            ) : null}
        </Menu>
    );
};
