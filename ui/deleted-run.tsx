import { copy } from "./lib.js";
import { useMessageDraft } from "./message-draft.js";
import { deletedRunNotice } from "./state.js";

/** Deletion never makes an unsent reply inaccessible or sends it to a different task. */
export function DeletedRunRecovery({ id, elsewhere = false }: { id: string; elsewhere?: boolean }) {
  const draft = useMessageDraft(`main:${id}`, `agent-draft:${id}`);
  return <section class="deleted-run-recovery section" role="alert" aria-label="Deleted run">
    <h2>{elsewhere ? "This run was deleted in another window or by another user" : "This run is no longer available"}</h2>
    <p>The conversation cannot receive more messages. Your unsent reply is kept here.</p>
    {!draft.ready ? <p>Restoring unsent reply…</p> : <>
      {draft.text ? <><label>Unsent reply<textarea class="field" readOnly value={draft.text} rows={5} /></label><button class="btn" onClick={() => void copy(draft.text, "Unsent reply copied")}>Copy unsent reply</button></> : <p>No unsent reply text was saved.</p>}
      {draft.images.map((image, index) => <p key={`${image.name}:${index}`}><a href={`data:image/png;base64,${image.data}`} download={image.name}>Save {image.name}</a></p>)}
      {draft.warning ? <p class="msg warn">{draft.warning}</p> : null}
    </>}
    <p><a href="#/" onClick={() => { deletedRunNotice.value = null; }}>Start a new run</a>{deletedRunNotice.value?.id === id ? <> · <button class="btn small ghost" onClick={() => { deletedRunNotice.value = null; }}>Dismiss notice</button></> : null}</p>
  </section>;
}
