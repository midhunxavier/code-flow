import { NumberField, setNumberInputProblem } from "./number-field.js";
import { useEffect } from "preact/hooks";
import { useState } from "preact/hooks";
import { contextBudget, setContextBudget } from "./context-budget.js";

export function ContextBudgetControls() {
  const budget = contextBudget.value; const [error, setError] = useState("");
  const update = (value: unknown) => { try { setContextBudget(value); setError(""); setNumberInputProblem("context:ceiling", ""); } catch (err) { setError((err as Error).message); setNumberInputProblem("context:ceiling", (err as Error).message); } };
  useEffect(() => () => setNumberInputProblem("context:ceiling", ""), []);
  return <fieldset class="context-budget"><legend>Invocation context budget</legend>
    <label class="check"><input type="checkbox" checked={!!budget} onChange={(event) => update(event.currentTarget.checked ? { maxPromptBytes: 65536, policy: "warn" } : undefined)} />Set an explicit input budget for each provider launch</label>
    <p class="help">Measured immediately before dispatch from the assembled prompt and JSON schema. Earlier CLI conversations, provider system instructions, file reads and image tokens are excluded. Reference file sizes below are separate estimates.</p>
    {budget ? <><label class="lbl" for="context-max-bytes">Maximum explicit input bytes</label><NumberField id="context-max-bytes" problemKey="context:maxPromptBytes" value={budget.maxPromptBytes} rule={{ label: "Explicit input bytes", min: 1, max: 67108864, integer: true }} optional placeholder="No byte ceiling" onChange={value => update({ ...budget, maxPromptBytes: value })} />
      <label class="lbl" for="context-max-tokens">Maximum approximate input tokens</label><NumberField id="context-max-tokens" problemKey="context:maxApproximateTokens" value={budget.maxApproximateTokens} rule={{ label: "Approximate input tokens", min: 1, max: 16777216, integer: true }} optional placeholder="No estimated token ceiling" onChange={value => update({ ...budget, maxApproximateTokens: value })} />
      <label class="lbl" for="context-budget-policy">When the explicit input exceeds this budget</label><select class="field" id="context-budget-policy" value={budget.policy} onChange={(event) => update({ ...budget, policy: event.currentTarget.value })}><option value="warn">Record a warning and continue</option><option value="block">Block the provider launch</option></select>
      <p class="help">Active budget: {budget.maxPromptBytes ? `${budget.maxPromptBytes.toLocaleString()} bytes` : "no byte ceiling"} · {budget.maxApproximateTokens ? `${budget.maxApproximateTokens.toLocaleString()} estimated tokens` : "no estimated token ceiling"} · {budget.policy}. Token ceilings are approximate guards, not a guarantee about a provider’s context window.</p></> : null}
    {error ? <p class="msg err" role="alert">{error}</p> : null}
  </fieldset>;
}
