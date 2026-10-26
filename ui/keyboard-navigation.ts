/** Keep a keyboard traversal's order while opening a task changes its unread section. */
export class RunNavigation {
  private scope = "";
  private order: string[] = [];
  private current: string | undefined;
  reset() { this.order = []; this.current = undefined; }
  next(visible: string[], current: string | undefined, scope: string, direction: 1 | -1): string | undefined {
    if (scope !== this.scope || current !== this.current || !this.order.length) {
      this.order = [...visible]; this.scope = scope;
    }
    const at = this.order.indexOf(current ?? "");
    let index = at < 0 ? 0 : Math.min(this.order.length - 1, Math.max(0, at + direction));
    // A deleted/filtered task is never opened from the snapshot.
    while (index >= 0 && index < this.order.length && !visible.includes(this.order[index]!)) index += direction;
    const next = this.order[index];
    this.current = next;
    return next;
  }
}
