import { describe, expect, it } from 'vitest';

import { monitoringUserIdOf } from '@/lib/monitoring';

describe('monitoringUserIdOf', () => {
    it('attaches a teacher’s opaque id', () => {
        expect(monitoringUserIdOf({ user: { id: 'teacher-1', app_metadata: { provider: 'email' } } })).toBe(
            'teacher-1',
        );
    });

    it('never attaches a roster student’s', () => {
        expect(
            monitoringUserIdOf({ user: { id: 'student-1', app_metadata: { user_type: 'student', teacher_id: 't' } } }),
        ).toBeNull();
    });

    it('clears on sign-out', () => {
        expect(monitoringUserIdOf(null)).toBeNull();
    });
});
