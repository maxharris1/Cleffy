/**
 * Added to SIGNED_OUT_BY_TEACHER when that sign-out kept changes the server had
 * not received yet (session.ts signOutKeepingChanges): they are not lost, and
 * the student should sign in on this same device to send them.
 */
export const keptChangesNotice = (count: number): string =>
    count === 1
        ? 'One change you made has not been saved yet. It is kept on this device and is saved when you sign in here again.'
        : `${count} changes you made have not been saved yet. They are kept on this device and are saved when you sign in here again.`;

/**
 * Added to ACCOUNT_DELETED when that sign-out discarded changes the server had
 * not received (session.ts signOutDeletedAccount). The scores they were made on
 * went with the account, so there is nothing left to save them to.
 */
export const discardedChangesNotice = (count: number): string =>
    count === 1
        ? 'One change you made had not been saved. It could not be, because the account and its scores no longer exist, so it was removed from this device.'
        : `${count} changes you made had not been saved. They could not be, because the account and its scores no longer exist, so they were removed from this device.`;
