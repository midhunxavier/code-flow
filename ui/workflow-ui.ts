import { signal } from "@preact/signals";
/** The current composer draft can be evaluated explicitly from Insights. Never starts work itself. */
export const comparisonDraft = signal<Record<string, any> | null>(null);
