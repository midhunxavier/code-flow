import { signal } from "@preact/signals";

export interface ConfirmationOptions { title: string; confirmLabel: string; danger?: boolean }
export interface Confirmation extends ConfirmationOptions { id: number; message: string; resolve: (accepted: boolean) => void }
export const confirmations = signal<Confirmation[]>([]);
let nextId = 0;

/** One decision at a time. Cancelled requests never execute their caller's action. */
export function confirmAction(message: string, options: ConfirmationOptions): Promise<boolean> {
  return new Promise(resolve => {
    confirmations.value = [...confirmations.value, { ...options, message, id: ++nextId, resolve }];
  });
}

export function settleConfirmation(id: number, accepted: boolean) {
  const current = confirmations.value[0];
  if (!current || current.id !== id) return;
  confirmations.value = confirmations.value.slice(1);
  current.resolve(accepted);
}

export function cancelConfirmations() {
  const pending = confirmations.value;
  confirmations.value = [];
  for (const request of pending) request.resolve(false);
}
