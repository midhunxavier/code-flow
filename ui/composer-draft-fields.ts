import { signal } from "@preact/signals";
import type { TaskIntent } from "../src/experience.js";

export const intentDraft = signal<TaskIntent | undefined>();
