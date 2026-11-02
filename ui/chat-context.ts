import { signal } from "@preact/signals";

/** Side tools follow the visible chat without changing an existing workflow's saved draft. */
export const activeChatContext = signal<{ id: string; project: string; repo: string; runId?: string; appendText: (text: string) => void } | null>(null);
