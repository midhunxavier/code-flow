import { useState } from "preact/hooks";
import { contextBudget, setContextBudget } from "./context-budget.js";

export function ContextBudgetControls() {
  const budget = contextBudget.value; const [error, setError] = useState("");
  const update = (value: unknown) => { try { setContextBudget(value); setError(""); } catch (err) { setError((err as Error).message); } };
  return <fieldset class="context-budget"><legend>Invocation context budget</legend>
    <label class="check"><input type="checkbox" checked={!!budget} onChange={(event) => update(event.currentTarget.checked ? { maxPromptBytes: 65536, policy: "warn" } : undefined)} />Set an explicit input budget for each provider launch</label>
    <p class="help">Measured immediately before dispatch from the assembled prompt and JSON schema. Earlier CLI conversations, provider system instructions, file reads and image tokens are excluded. Reference file sizes below are separate estimates.</p>
    {budget ? <><label class="lbl" for="context-max-bytes">Maximum explicit input bytes</label><input class="field" id="context-max-bytes" type="number" min={1} max={67108864} value={budget.maxPromptBytes ?? ""} placeholder="No byte ceiling" onInput={(event) => update({ ...budget, maxPromptBytes: event.currentTarget.value ? Number(event.currentTarget.value) : undefined })} />
      <label class="lbl" for="context-max-tokens">Maximum approximate input tokens</label><input class="field" id="context-max-tokens" type="number" min={1} max={16777216} value={budget.maxApproximateTokens ?? ""} placeholder="No estimated token ceiling" onInput={(event) => update({ ...budget, maxApproximateTokens: event.currentTarget.value ? Number(event.currentTarget.value) : undefined })} />
      <label class="lbl" for="context-budget-policy">When the explicit input exceeds this budget</label><select class="field" id="context-budget-policy" value={budget.policy} onChange={(event) => update({ ...budget, policy: event.currentTarget.value })}><option value="warn">Record a warning and continue</option><option value="block">Block the provider launch</option></select>
      <p class="help">Active budget: {budget.maxPromptBytes ? `${budget.maxPromptBytes.toLocaleString()} bytes` : "no byte ceiling"} · {budget.maxApproximateTokens ? `${budget.maxApproximateTokens.toLocaleString()} estimated tokens` : "no estimated token ceiling"} · {budget.policy}. Token ceilings are approximate guards, not a guarantee about a provider’s context window.</p></> : null}
    {error ? <p class="msg err" role="alert">{error}</p> : null}
  </fieldset>;
}
