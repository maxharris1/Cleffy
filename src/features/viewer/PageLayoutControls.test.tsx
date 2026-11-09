import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PageColumns } from '@/features/viewer/geometry';
import { PageLayoutControls } from '@/features/viewer/PageLayoutControls';

afterEach(cleanup);

const renderControls = (initial: PageColumns = 1) => {
    const onColumns = vi.fn();
    const onCover = vi.fn();
    const Harness = () => {
        const [columns, setColumns] = useState<PageColumns>(initial);
        const [cover, setCover] = useState(false);
        return (
            <PageLayoutControls
                pageColumns={columns}
                onPageColumnsChange={(next) => {
                    onColumns(next);
                    setColumns(next);
                }}
                spreadCover={cover}
                onSpreadCoverChange={(next) => {
                    onCover(next);
                    setCover(next);
                }}
            />
        );
    };
    render(<Harness />);
    return { onColumns, onCover };
};

const single = () => screen.getByRole('radio', { name: 'Single page' });
const two = () => screen.getByRole('radio', { name: 'Two pages side by side' });
const cover = () => screen.queryByRole('button', { name: 'Start with cover page' });

describe('PageLayoutControls', () => {
    it('groups Single page and Two pages as one radio group', () => {
        renderControls();
        expect(screen.getByRole('radiogroup', { name: 'Page layout' })).toContainElement(single());
        expect(screen.getByRole('radiogroup', { name: 'Page layout' })).toContainElement(two());
    });

    it('shows single page chosen, and two pages not, before any click', () => {
        renderControls();
        expect(single()).toHaveAttribute('aria-checked', 'true');
        expect(two()).toHaveAttribute('aria-checked', 'false');
        expect(single()).toHaveClass('bg-accent-soft', 'text-accent');
        expect(two()).not.toHaveClass('bg-accent-soft');
    });

    it('moves the choice: choosing one clears the other', () => {
        const { onColumns } = renderControls();
        fireEvent.click(two());
        expect(onColumns).toHaveBeenLastCalledWith(2);
        expect(two()).toHaveAttribute('aria-checked', 'true');
        expect(single()).toHaveAttribute('aria-checked', 'false');
        fireEvent.click(single());
        expect(onColumns).toHaveBeenLastCalledWith(1);
        expect(single()).toHaveAttribute('aria-checked', 'true');
        expect(two()).toHaveAttribute('aria-checked', 'false');
    });

    it('does nothing when the layout already shown is chosen again', () => {
        const { onColumns } = renderControls();
        fireEvent.click(single());
        expect(onColumns).not.toHaveBeenCalled();
        expect(single()).toHaveAttribute('aria-checked', 'true');
    });

    it('makes the chosen layout the one tab stop, and moves the choice and focus with the arrow keys', () => {
        const { onColumns } = renderControls();
        expect(single()).toHaveAttribute('tabindex', '0');
        expect(two()).toHaveAttribute('tabindex', '-1');
        single().focus();
        fireEvent.keyDown(single(), { key: 'ArrowDown' });
        expect(onColumns).toHaveBeenLastCalledWith(2);
        expect(two()).toHaveFocus();
        expect(two()).toHaveAttribute('tabindex', '0');
        fireEvent.keyDown(two(), { key: 'ArrowLeft' });
        expect(onColumns).toHaveBeenLastCalledWith(1);
        expect(single()).toHaveFocus();
    });

    it('offers the cover page only in two-page mode', () => {
        renderControls();
        expect(cover()).toBeNull();
        fireEvent.click(two());
        expect(cover()).toBeInTheDocument();
        fireEvent.click(single());
        expect(cover()).toBeNull();
    });

    it('keeps the cover page a checkbox-style option outside the layout choice', () => {
        const { onCover } = renderControls(2);
        const button = cover();
        expect(button).not.toBeNull();
        expect(screen.getByRole('radiogroup')).not.toContainElement(button);
        expect(screen.getAllByRole('radio')).toHaveLength(2);
        expect(button).toHaveAttribute('aria-pressed', 'false');
        expect(button).toHaveAttribute('title', expect.stringContaining('2|3'));
        fireEvent.click(button as HTMLElement);
        expect(onCover).toHaveBeenLastCalledWith(true);
        expect(button).toHaveAttribute('aria-pressed', 'true');
        expect(two()).toHaveAttribute('aria-checked', 'true');
    });
});
