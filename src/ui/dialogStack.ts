/** Open app dialogs (Dialog), oldest first — Escape acts on the top one only. */
export const dialogStack: symbol[] = [];

/**
 * Whether any app modal (dialog or alertdialog) is open. The viewer's window
 * keyboard shortcuts stand down while one is: a key pressed with a confirm
 * open belongs to the confirm, wherever focus happens to be.
 */
export const isDialogOpen = (): boolean => dialogStack.length > 0;
