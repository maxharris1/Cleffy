import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Button } from '@/ui/Button';
import { buttonClassName } from '@/ui/classNames';

afterEach(() => {
    cleanup();
});

describe('Button', () => {
    it('renders a real button with its accessible name and safe default type', () => {
        render(<Button>Create link</Button>);
        const button = screen.getByRole('button', { name: 'Create link' });
        expect(button).toBeInTheDocument();
        expect(button).toHaveAttribute('type', 'button');
    });

    it('respects disabled and does not fire clicks', () => {
        const onClick = vi.fn();
        render(
            <Button disabled onClick={onClick}>
                Save
            </Button>,
        );
        const button = screen.getByRole('button', { name: 'Save' });
        expect(button).toBeDisabled();
        button.click();
        expect(onClick).not.toHaveBeenCalled();
    });

    it('exposes class strings for link- and label-shaped CTAs', () => {
        expect(buttonClassName('primary')).toContain('landing-cta');
        expect(buttonClassName('ghost', 'sm')).toContain('text-sm');
    });
});
