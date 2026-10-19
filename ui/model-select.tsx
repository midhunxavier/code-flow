import { useEffect, useId, useLayoutEffect, useRef, useState } from "preact/hooks";
import { Icon } from "./icons.js";
import { isFreeModel } from "./model-order.js";

export type ModelOption = { id: string; label: string; description?: string };

/** Search stays local to the open picker; choosing a model preserves the caller's settings logic. */
export function ModelSelect({ label, title, value, options, onChange, placeholder = "Choose model", compact = false, disabled = false, class: cls = "" }: {
  label: string; title?: string; value: string; options: ModelOption[]; onChange: (value: string) => void;
  placeholder?: string; compact?: boolean; disabled?: boolean; class?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [freeOnly, setFreeOnly] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const filtered = freeOnly ? options.filter(option => !!option.id && isFreeModel(option)) : options;
  const matches = filtered.filter(option => words.every(word => `${option.label} ${option.id} ${option.description ?? ""}`.toLocaleLowerCase().includes(word)));
  const index = Math.min(active, Math.max(0, matches.length - 1));
  const selected = options.find(option => option.id === value);
  const close = (focus = true) => { setOpen(false); if (focus) trigger.current?.focus(); };
  const choose = (id: string) => { onChange(id); close(); };
  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      if (!trigger.current || !popup.current) return;
      const anchor = trigger.current.getBoundingClientRect();
      const width = Math.min(Math.max(anchor.width, 340), window.innerWidth - 24);
      const below = window.innerHeight - anchor.bottom - 20;
      const above = anchor.top - 20;
      const up = below < 280 && above > below;
      Object.assign(popup.current.style, {
        width: `${width}px`, left: `${Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12))}px`,
        maxHeight: `${Math.min(420, Math.max(100, up ? above : below))}px`,
        top: up ? "auto" : `${anchor.bottom + 6}px`, bottom: up ? `${window.innerHeight - anchor.top + 6}px` : "auto",
      });
    };
    position();
    input.current?.focus();
    const scroll = (event: Event) => { if (!popup.current?.contains(event.target as Node)) position(); };
    window.addEventListener("resize", position);
    document.addEventListener("scroll", scroll, true);
    const away = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) close(false); };
    document.addEventListener("pointerdown", away);
    return () => { window.removeEventListener("resize", position); document.removeEventListener("scroll", scroll, true); document.removeEventListener("pointerdown", away); };
  }, [open]);
  useEffect(() => {
    if (open) document.getElementById(`${listId}-${index}`)?.scrollIntoView({ block: "nearest" });
  }, [open, index, query, freeOnly]);
  return <div class={`model-select ${compact ? "compact" : ""} ${cls}`} ref={root}>
    <button type="button" class="model-select-trigger" ref={trigger} disabled={disabled} aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined} title={selected?.label ?? placeholder} onClick={() => {
      setQuery(""); setActive(Math.max(0, filtered.findIndex(option => option.id === value))); setOpen(!open);
    }}><span>{selected?.label ?? (value || placeholder)}</span><Icon name="chevron" /></button>
    {open ? <div class="model-select-popup" ref={popup} onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    }} onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) close(false); }}>
      <div class="model-select-search">
        <div class="model-select-heading">
          <div class="pop-title">{title ?? label}</div>
          <button type="button" class="model-free-filter" aria-pressed={freeOnly} onClick={() => { setFreeOnly(!freeOnly); setActive(0); }}><span aria-hidden="true">{freeOnly ? "✓" : "+"}</span> Free only</button>
        </div>
        <input ref={input} class="field" type="search" role="combobox" aria-label={`Search ${label}`} aria-autocomplete="list" aria-expanded="true" aria-controls={listId} aria-activedescendant={matches.length ? `${listId}-${index}` : undefined} placeholder="Search models…" value={query} onInput={event => { setQuery(event.currentTarget.value); setActive(0); }} onKeyDown={event => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault(); setActive(matches.length ? (index + (event.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length : 0);
          } else if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); if (matches[index]) choose(matches[index]!.id); }
        }} />
      </div>
      <div class="model-select-results" role="listbox" id={listId} aria-label={label}>
        {matches.map((option, i) => <button key={option.id} id={`${listId}-${i}`} type="button" role="option" aria-selected={option.id === value} tabIndex={-1} class={`model-select-option ${i === index ? "active" : ""}`} onClick={() => choose(option.id)}>
          <span><span class="model-option-name">{option.label}</span>{option.description ? <span class="model-option-description">{option.description}</span> : null}</span>
          <span class="model-option-meta">
            {option.id && isFreeModel(option) ? <span class="model-free-badge">Free</span> : null}
            {option.id === value ? <span aria-hidden="true">✓</span> : null}
          </span>
        </button>)}
      </div>
      {!matches.length ? <div class="model-select-empty" role="status">{freeOnly ? "No free models found. Try another search or turn off Free only." : "No models found. Try another name or model ID."}</div> : null}
    </div> : null}
  </div>;
}
