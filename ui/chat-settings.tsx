import type { ComponentChildren } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { Icon } from "./icons.js";

/** A small model picker; execution diagnostics belong to the separate inspector. */
export function MessageSettings({ summary, title, children }: { summary: ComponentChildren; title: string; children: ComponentChildren }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const close = (focus = true) => { setOpen(false); if (focus) trigger.current?.focus(); };
  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const anchor = trigger.current?.getBoundingClientRect(); if (!anchor || !panel.current) return;
      const width = Math.min(360, window.innerWidth - 24);
      Object.assign(panel.current.style, { width: `${width}px`, left: `${Math.max(12, Math.min(anchor.right - width, window.innerWidth - width - 12))}px`, bottom: `${window.innerHeight - anchor.top + 8}px`, maxHeight: `${Math.max(120, anchor.top - 20)}px` });
    };
    position(); panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const away = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) close(false); };
    const blur = (e: FocusEvent) => { if (e.relatedTarget && !root.current?.contains(e.relatedTarget as Node)) close(false); };
    document.addEventListener("pointerdown", away); root.current?.addEventListener("focusout", blur); window.addEventListener("resize", position);
    const element = root.current;
    return () => { document.removeEventListener("pointerdown", away); element?.removeEventListener("focusout", blur); window.removeEventListener("resize", position); };
  }, [open]);
  return <div class="chat-settings-anchor" ref={root} onKeyDown={e => { if (open && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } }}>
    <button ref={trigger} type="button" class="btn ghost small chat-model-summary" aria-label="Message settings" aria-haspopup="dialog" aria-expanded={open} title={title} onClick={() => setOpen(!open)}>{summary}<Icon name="chevron"/></button>
    {open ? <div class="chat-settings-popover" ref={panel} role="dialog" aria-label="Message settings"><div class="chat-settings-heading"><b>{title}</b><button type="button" class="icon-btn" aria-label="Close message settings" onClick={() => close()}><Icon name="close"/></button></div>{children}<p class="help">Changes apply to new messages. Accepted tasks keep their reviewed settings.</p></div> : null}
  </div>;
}
