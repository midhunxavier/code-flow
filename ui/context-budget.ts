import { signal } from "@preact/signals";
import { store } from "./lib.js";
import { validateContextBudget, type ContextBudget } from "../src/context-budget.js";
let initial: ContextBudget | undefined;
try { initial = validateContextBudget(JSON.parse(store.get("contextBudget") ?? "null")); } catch { initial = undefined; }
export const contextBudget = signal<ContextBudget | undefined>(initial);
export const contextBudgetOrigin = signal(initial ? store.get("contextBudgetOrigin") || "Explicit browser preference" : "Application default");
export function setContextBudget(value: unknown, origin?: string) { const next = validateContextBudget(value); contextBudget.value = next; contextBudgetOrigin.value = origin ?? (next ? "Explicit browser preference" : "Application default"); store.set("contextBudget", JSON.stringify(next ?? null)); store.set("contextBudgetOrigin", contextBudgetOrigin.value); }
