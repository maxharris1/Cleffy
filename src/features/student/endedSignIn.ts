import { signOutDeletedAccount, signOutKeepingChanges } from '@/features/auth/session';

/**
 * Router state for the student sign-in page (StudentLoginPage) after the app
 * signed a student out because the server ended their sign-in.
 */
export interface SignedOutByTeacherState {
    signedOutByTeacher: true;
    /** Queued changes kept on this device for the account's next sign-in here. */
    keptChanges: number;
    /** The account no longer exists (deleted with its teacher). */
    accountDeleted?: true;
    /** Queued changes discarded with it: nothing can ever upload them. */
    discardedChanges?: number;
}

/**
 * Sign out a student whose sign-in the server ended, and say what became of
 * their queued changes. Archived or reset (the account is still there): kept
 * for its next sign-in here. Deleted with the teacher (fetchAccountDeleted):
 * discarded, and the sign-in page must not promise otherwise.
 */
export const signOutEndedStudent = async (accountDeleted: boolean): Promise<SignedOutByTeacherState> => {
    if (accountDeleted) {
        const discardedChanges = await signOutDeletedAccount().catch(() => 0);
        return { signedOutByTeacher: true, keptChanges: 0, accountDeleted: true, discardedChanges };
    }
    const keptChanges = await signOutKeepingChanges().catch(() => 0);
    return { signedOutByTeacher: true, keptChanges };
};
