import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import { cancelConfirmations, confirmations, settleConfirmation, type Confirmation } from "./confirm-state.js";

export function ConfirmationHost() {
  useEffect(() => {
    window.addEventListener("hashchange", cancelConfirmations);
    window.addEventListener("pagehide", cancelConfirmations);
    return () => {
      window.removeEventListener("hashchange", cancelConfirmations);
      window.removeEventListener("pagehide", cancelConfirmations);
      cancelConfirmations();
    };
  }, []);
  const request = confirmations.value[0];
  return request ? <ConfirmationDialog key={request.id} request={request} /> : null;
}

function ConfirmationDialog({ request }: { request: Confirmation }) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const finish = (accepted: boolean) => {
    ref.current?.close();
    settleConfirmation(request.id, accepted);
  };
  useLayoutEffect(() => {
    const previous = document.activeElement;
    ref.current?.showModal();
    cancel.current?.focus();
    return () => {
      ref.current?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return <dialog ref={ref} class="picker small-dialog confirmation-dialog" aria-labelledby={`confirmation-title-${request.id}`} aria-describedby={`confirmation-body-${request.id}`}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); finish(false); }}
    onClose={() => settleConfirmation(request.id, false)}>
    <div class="picker-inner">
      <div class="picker-head"><h3 id={`confirmation-title-${request.id}`}>{request.title}</h3></div>
      <div class="dialog-body" id={`confirmation-body-${request.id}`}>{request.message.split(/\n\s*\n/).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>
      <div class="picker-foot">
        <span class="ps" />
        <button type="button" class="btn" ref={cancel} onClick={() => finish(false)}>Cancel</button>
        <button type="button" class={`btn ${request.danger ? "danger" : "primary"}`} onClick={() => finish(true)}>{request.confirmLabel}</button>
      </div>
    </div>
  </dialog>;
}
