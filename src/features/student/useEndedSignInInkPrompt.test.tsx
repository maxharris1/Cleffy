import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { useEndedSignInInkPrompt } from '@/features/student/useEndedSignInInkPrompt';
import { ScribblerDb } from '@/sync/db';
import { heldDocIds, holdOps, resetInkRecoveryForTests } from '@/sync/inkRecovery';
import type { Annotation } from '@/types/models';

const DOC = 'c0ffee00-0000-4000-8000-0000000000d1';
const USER = 'student-1';

const stroke = (id: string): Annotation => ({
    id,
    docId: DOC,
    page: 0,
    kind: 'stroke',
    color: '#111111',
    payload: { pts: [0.1, 0.1, 0.5], w: 0.005 },
    createdBy: null,
    createdAt: '2026-10-22T00:00:00.000Z',
    updatedAt: '2026-10-22T00:00:00.000Z',
    deletedAt: null,
    seq: 0,
});

afterEach(() => resetInkRecoveryForTests());

describe('useEndedSignInInkPrompt (round 3, item 3)', () => {
    it('goes straight on when the account holds nothing', async () => {
        const { result } = renderHook(() => useEndedSignInInkPrompt());
        await expect(result.current.askFirst(USER, false)).resolves.toBe(true);
    });

    it('waits on the student, then goes on when they choose to sign out', async () => {
        holdOps(new ScribblerDb(`prompt-${crypto.randomUUID()}`), DOC, [
            { op: { type: 'create', annotation: stroke('a1') }, author: USER },
        ]);
        const { result } = renderHook(() => useEndedSignInInkPrompt());

        let asked!: Promise<boolean>;
        act(() => {
            asked = result.current.askFirst(USER, false);
        });
        expect(result.current.prompt?.docIds).toEqual([DOC]);
        act(() => result.current.proceed());

        await expect(asked).resolves.toBe(true);
        expect(result.current.signingOut).toBe(true);
    });

    it('never goes on by itself when the page unmounts: no sign-out, and the ink stays', async () => {
        holdOps(new ScribblerDb(`prompt-${crypto.randomUUID()}`), DOC, [
            { op: { type: 'create', annotation: stroke('a1') }, author: USER },
        ]);
        const { result, unmount } = renderHook(() => useEndedSignInInkPrompt());

        let asked!: Promise<boolean>;
        act(() => {
            asked = result.current.askFirst(USER, false);
        });
        unmount();

        await expect(asked).resolves.toBe(false);
        expect(heldDocIds(USER)).toEqual([DOC]);
    });
});
