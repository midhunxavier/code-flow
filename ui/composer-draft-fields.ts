import { signal } from "@preact/signals";
import type { TaskIntent } from "../src/experience.js";
import type { Journey } from "../src/journeys.js";

export const intentDraft = signal<TaskIntent | undefined>();
export const journeyDraft = signal<Journey | undefined>();
