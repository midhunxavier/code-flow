/** An action rejected before any external input or write was dispatched. Safe to retry after correcting its grounding. */
export class ActionNotPerformed extends Error {}
