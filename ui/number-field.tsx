import { signal } from "@preact/signals";
import { useLayoutEffect, useState } from "preact/hooks";
import { numberProblem, type NumberRule } from "../src/start-input-validation.js";
const problems = signal<Record<string, string>>({});
export function setNumberInputProblem(key: string, problem: string) {
  if ((problems.peek()[key] ?? "") === problem) return;
  const next = { ...problems.peek() }; if (problem) next[key] = problem; else delete next[key]; problems.value = next;
}
export function numberInputProblem(prefix: string): string { return Object.entries(problems.value).find(([key]) => key.startsWith(prefix))?.[1] ?? ""; }
/** Preserve an unfinished edit; only accepted numbers update summaries and persisted settings. */
export function NumberField({ id, problemKey = id, value, rule, optional, placeholder, onChange }: { id: string; problemKey?: string; value: number | undefined; rule: NumberRule; optional?: boolean; placeholder?: string; onChange: (value: number | undefined) => void }) {
  const [raw, setRaw] = useState(String(value ?? ""));
  const [incomplete, setIncomplete] = useState(false);
  useLayoutEffect(() => { setRaw(String(value ?? "")); setIncomplete(false); }, [value]);
  const problem = incomplete ? numberProblem(undefined, rule) : optional && raw === "" ? "" : numberProblem(raw === "" ? undefined : Number(raw), rule);
  useLayoutEffect(() => { setNumberInputProblem(problemKey, problem); return () => setNumberInputProblem(problemKey, ""); }, [problemKey, problem]);
  return <><input class="field" type="number" id={id} min={rule.min} max={rule.max} step={rule.integer ? 1 : "any"} placeholder={placeholder} value={raw} aria-invalid={!!problem} aria-describedby={problem ? `${id}-error` : undefined} onInput={event => {
    const text = event.currentTarget.value, parsed = text === "" ? undefined : Number(text);
    const partial = event.currentTarget.validity.badInput;
    const error = partial ? numberProblem(undefined, rule) : optional && text === "" ? "" : numberProblem(parsed, rule);
    setRaw(text); setIncomplete(partial); setNumberInputProblem(problemKey, error); if (!error) onChange(parsed);
  }} />{problem ? <span id={`${id}-error`} class="help err" role="alert">{problem}</span> : null}</>;
}
