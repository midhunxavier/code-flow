import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { Icon, type IconName } from "./icons.js";
import { baseName } from "./lib.js";
import { rememberSide, sideMemo, sideScope, type SideScope } from "./state.js";
import type { AgentId, RunSummary } from "./types.js";

/** Pieces the side panel's tabs share: the folders it can show, the strip of open sessions, a menu. */

// ---------------------------------------------------------------- where: a run's worktrees, or the repository
export interface Place {
  label: string;
  path: string;
  /** The run this worktree belongs to, when it's one. */
  runId?: string;
}

/** The folders the panel can show: a run's worktrees and its repository, or the project's repositories. */
export function placesFor(s: SideScope): Place[] {
  const places: Place[] = [];
  if (s.run) for (const wt of s.run.worktrees) places.push({ label: `${wt.name} · ${wt.branch}`, path: wt.path, runId: s.run.id });
  const repos = s.run ? [s.run.repo] : [s.repo, ...(s.project?.repos ?? [])];
  for (const r of new Set(repos.filter(Boolean))) places.push({ label: `${baseName(r)} · repository`, path: r });
  return places;
}

/** The worktree a run's result is on (where a side chat works, and where the panel starts). */
export const resultWorktree = (run: RunSummary) => run.worktrees.find((w) => w.path === run.artifacts[0]?.path) ?? run.worktrees[0];

/** Where a tab starts for a scope: a run's result worktree, else the scope's repository. */
export function defaultPlace(s: SideScope, places = placesFor(s)): Place | undefined {
  const result = s.run ? resultWorktree(s.run)?.path : undefined;
  return places.find((p) => p.path === result) ?? places[0];
}

/** The folder a tab shows, remembered per run or project. */
export function usePlace(tab: "files"): [Place | undefined, (p: Place) => void, Place[]] {
  const s = sideScope.value;
  const places = placesFor(s);
  const current = places.find((p) => p.path === sideMemo.value[tab]) ?? defaultPlace(s, places);
  return [current, (p) => rememberSide({ [tab]: p.path }), places];
}

/** A folder's short name: the run worktree or repository it's in, and where in it. */
export function placeName(cwd: string, places: Place[]): string {
  const home = places.filter((p) => cwd === p.path || cwd.startsWith(`${p.path}/`)).sort((a, b) => b.path.length - a.path.length)[0];
  if (!home) return baseName(cwd);
  const name = home.runId ? home.label.split(" · ")[0]! : baseName(home.path);
  return cwd === home.path ? name : `${name}/${cwd.slice(home.path.length + 1)}`;
}

export function PlacePicker({ place, places, onChange, label }: { place?: Place; places: Place[]; onChange: (p: Place) => void; label: string }) {
  if (!places.length) return <span class="help">Choose a repository first.</span>;
  return (
    <select class="field" aria-label={label} title={place?.path} value={place?.path ?? ""} onChange={(e) => onChange(places.find((p) => p.path === e.currentTarget.value) ?? places[0]!)}>
      {places.map((p) => (
        <option key={p.path} value={p.path}>
          {p.label}
        </option>
      ))}
    </select>
  );
}

// ---------------------------------------------------------------- the strip of open sessions
/** One open session in a tab's strip: a side chat, a chat, a terminal, an app's log. */
export interface StripItem {
  key: string;
  label: string;
  title?: string;
  agent?: AgentId;
  /** working: a spinner. queued: a spinner, waiting its turn. unread: a reply you haven't seen. */
  state?: "working" | "queued" | "unread" | "failed";
  /** A short word after the name: "exit 1", "exited". */
  note?: string;
  /** Shown in the lower half of a split. */
  below?: boolean;
}

/** The sessions open in a tab, like browser tabs: pick one, close one; the tab's own buttons go after. */
export function Strip({ items, active, onPick, onClose, label, children }: { items: StripItem[]; active?: string; onPick: (key: string) => void; onClose?: (key: string) => void; label: string; children?: ComponentChildren }) {
  return (
    <div class="sess-strip">
      {/* A group of buttons, not a tablist: each session has its own close button, which a tablist can't hold. */}
      <div class="sess-list" role={items.length ? "group" : undefined} aria-label={items.length ? label : undefined}>
        {items.map((it) => (
          <span key={it.key} class={`sess ${it.key === active ? "on" : ""} ${it.below ? "below" : ""} ${it.state === "failed" ? "failed" : ""}`}>
            <button type="button" aria-current={it.key === active ? "true" : undefined} class="sess-pick" title={it.title ?? it.label} onClick={() => onPick(it.key)}>
              {it.state === "working" || it.state === "queued" ? (
                <span class={`spin ${it.state}`} role="img" aria-label={it.state === "working" ? "working" : "queued"} />
              ) : it.agent ? (
                <span class={`sess-agent ${it.agent}`} aria-hidden="true" />
              ) : null}
              <span class="nm">{it.label}</span>
              {it.state === "unread" ? <span class="unread" role="img" aria-label="new reply" /> : null}
              {it.note ? <span class="sess-note">{it.note}</span> : null}
            </button>
            {onClose ? (
              <button type="button" class="sess-x" aria-label={`Close ${it.label}`} title="Close" onClick={() => onClose(it.key)}>
                <Icon name="close" />
              </button>
            ) : null}
          </span>
        ))}
      </div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- a small menu
/**
 * A menu under an icon button; a pick, Escape or a click elsewhere closes it. Opened, its first
 * item has focus and ↓ ↑ (Home, End) move between items; a pick or Escape goes back to the button.
 */
export function Menu({ label, icon, title, trigger, above = false, align = "start", class: cls = "", children }: { label: string; icon: IconName; title?: string; trigger?: ComponentChildren; above?: boolean; align?: "start" | "end"; class?: string; children: (close: () => void) => ComponentChildren }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const items = () => [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])];
  /** Closed by a pick or Escape: back to the button, where the keyboard was. */
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  useLayoutEffect(() => {
    if (!open || !above) return;
    const position = () => {
      if (!button.current || !menu.current) return;
      const anchor = button.current.getBoundingClientRect();
      const boundary = button.current.closest(".chatbox, dialog")?.getBoundingClientRect();
      const left = Math.max(12, boundary ? boundary.left + 8 : 12);
      const right = Math.min(window.innerWidth - 12, boundary ? boundary.right - 8 : window.innerWidth - 12);
      menu.current.style.maxWidth = `${Math.max(0, right - left)}px`;
      const box = menu.current.getBoundingClientRect();
      const preferredLeft = align === "end" ? anchor.right - box.width : anchor.left;
      menu.current.style.left = `${Math.max(left, Math.min(preferredLeft, right - box.width))}px`;
      menu.current.style.top = `${Math.max(12, anchor.top - box.height - 8)}px`;
    };
    position();
    window.addEventListener("resize", position);
    document.addEventListener("scroll", position, true);
    return () => { window.removeEventListener("resize", position); document.removeEventListener("scroll", position, true); };
  }, [open, above, align]);
  useLayoutEffect(() => {
    if (!open) return;
    items()[0]?.focus();
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      close();
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Tab") { close(); return; }
    const list = items();
    if (!list.length) return;
    const at = list.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "ArrowDown" ? (at + 1) % list.length : e.key === "ArrowUp" ? (at <= 0 ? list.length : at) - 1 : e.key === "Home" ? 0 : e.key === "End" ? list.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    list[next]!.focus();
  };
  return (
    <div class={`pop-wrap ${cls}`} ref={ref}>
      <button type="button" ref={button} class={`icon-btn ${open ? "on" : ""}`} aria-label={label} aria-haspopup="menu" aria-expanded={open} title={title ?? label} onClick={() => setOpen(!open)}>
        {trigger ?? <Icon name={icon} />}
      </button>
      {open ? (
        <div class="pop-menu" role="menu" aria-label={label} ref={menu} onKeyDown={onKey}>
          {children(close)}
        </div>
      ) : null}
    </div>
  );
}

export function MenuItem({ onClick, children, sub, disabled, on }: { onClick: () => void; children: ComponentChildren; sub?: string; disabled?: boolean; on?: boolean }) {
  return (
    <button type="button" role="menuitem" class={`pop-item ${on ? "on" : ""}`} disabled={disabled} onClick={onClick}>
      <span class="pi-main">{children}</span>
      {sub ? <span class="pi-sub">{sub}</span> : null}
    </button>
  );
}

export const MenuTitle = ({ children }: { children: ComponentChildren }) => <div class="pop-title">{children}</div>;
