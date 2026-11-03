import { Markdown } from "./bits.js";
import { enc } from "./lib.js";
import { Icon } from "./icons.js";
import { chatLeadReply, type LeadStepView } from "./chat-lead-reply.js";
function Steps({ items }: { items: LeadStepView[] }) {
  return <ol class="lead-workflow">{items.map((step, i) => <li key={i}><b>{step.title}</b>{step.detail ? <p>{step.detail}</p> : null}{step.children.length ? <Steps items={step.children}/> : null}</li>)}</ol>;
}
export function ChatLeadResult({ text, chatId }: { text: string; chatId?: string }) {
  const reply = chatLeadReply(text), proposal = reply?.kind === "proposal";
  let raw = text; try { raw = JSON.stringify(JSON.parse(text), null, 2); } catch { /* Preserve malformed historical output for inspection. */ }
  return <section class="lead-response" aria-label="Conversation lead response">
    <div class="lead-response-heading"><span class="task-avatar"><Icon name={proposal ? "layers" : "chat"}/></span><div><p class="task-kicker">Conversation lead</p><h2>{proposal ? "Proposed approach" : reply?.kind === "clarify" ? "A question for you" : "Lead response"}</h2></div>{reply?.scope ? <span class="badge">{({ review: "Review only", plan: "Plan only", write: "Implement and verify" } as Record<string, string>)[reply.scope] ?? reply.scope}</span> : null}</div>
    {reply ? <Markdown text={reply.body}/> : <p>The response could not be formatted. Open the chat to review its recorded state, or inspect the technical response below.</p>}
    {reply?.participants.length ? <><h3>Proposed participants</h3><div class="lead-participants">{reply.participants.map(p => <article key={p.id}><b>{p.id}</b><span>{p.provider === "claude" ? "Claude" : p.provider === "codex" ? "Codex" : p.provider}</span><code>{p.model ?? "Provider default model"}</code><small>{p.effort ? `${p.effort} effort` : "Provider default effort"}</small></article>)}</div></> : null}
    {reply?.steps.length ? <><h3>How the work will run</h3><Steps items={reply.steps}/></> : null}
    {reply?.completion.length ? <><h3>Done when</h3><ul>{reply.completion.map(item => <li key={item}>{item}</li>)}</ul></> : null}
    {proposal ? <div class="lead-execution-details">{reply?.source ? <p><b>Source</b>{reply.source === "head" ? "Committed code at HEAD" : "Current working copy"}</p> : null}{reply?.calls || reply?.minutes ? <p><b>Limits</b>{[reply.calls ? `${reply.calls} agent calls` : "", reply.minutes ? `${reply.minutes} minutes` : ""].filter(Boolean).join(" · ")}</p> : null}{reply?.setup ? <p><b>Setup</b><code>{reply.setup}</code></p> : null}{reply?.check ? <p><b>Check</b><code>{reply.check}</code></p> : null}</div> : null}
    {chatId ? <div class="lead-return"><a class="btn primary" href={`#/chat/${enc(chatId)}`}>{proposal ? "Review approach in chat" : "Continue in chat"}<Icon name="chevron"/></a>{proposal ? <p>Workers start after you review the approach and choose Start task in the chat.</p> : null}</div> : null}
    <details class="lead-raw"><summary>Technical response (JSON)</summary><pre><code>{raw}</code></pre></details>
  </section>;
}
