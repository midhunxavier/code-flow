import { peopleEnabled } from "./preferences.js";
import { SETTINGS_SECTIONS } from "./settings-sections.js";
import { useEffect, useRef, useState } from "preact/hooks";
import { useDialog } from "./app.js";
import { Icon, type IconName } from "./icons.js";
import { baseName, STATUS_TEXT } from "./lib.js";
import { commandPaletteOpen, healthOpen, openSide, pickerOpen, projects, projectsOpen, route, runs, selectProject } from "./state.js";

/** A palette row: an icon (or, for a run, its status dot), the label, and what kind of thing it is (`detail`, which
 *  searches match; `shown` when the row says it shorter, as a run's repository by its folder name). */
interface Command { id: string; label: string; detail: string; shown?: string; icon?: IconName; status?: string; run: () => void }

export function CommandPalette() {
  const close = () => (commandPaletteOpen.value = false);
  const ref = useDialog(true, close);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const actions: Command[] = [
    { id: "new", label: "New run", detail: "Actions", icon: "plus", run: () => (route.value = { view: "composer" }) },
    { id: "docs", label: "Help & documentation", detail: "Guides, search and Ask code-flow using your local CLI", icon: "help", run: () => { window.open("/docs/", "_blank", "noopener"); } },
    { id: "settings", label: "Settings", detail: "Preferences, agents and remote connections", icon: "sliders", run: () => (route.value = { view: "settings" }) },
    ...SETTINGS_SECTIONS.filter(section => !["workspace", "automations", "insights"].includes(section.id)).map((section): Command => ({ id: `settings:${section.id}`, label: section.label, detail: `Settings · ${section.keywords}`, icon: section.icon, run: () => (route.value = { view: "settings", section: section.id }) })),
    { id: "inbox", label: "Inbox", detail: "Questions, failures and results needing review", icon: "bell", run: () => (route.value = { view: "inbox" }) },
    { id: "automations", label: "Scheduling", detail: "Schedules and deferred runs", icon: "clock", run: () => (route.value = { view: "automations" }) },
    { id: "workspace", label: "Repository workspace", detail: "Code, checks and repository tools", icon: "files", run: () => (route.value = { view: "workspace" }) },
    { id: "insights", label: "Insights", detail: "Run results and usage", icon: "chart", run: () => (route.value = { view: "insights" }) },
    { id: "team", label: "People board", detail: "Tasks, hand-overs and your team inbox", icon: "people", run: () => (route.value = { view: "team" }) },
    { id: "repo", label: "Choose repository", detail: "Actions", icon: "folder", run: () => (pickerOpen.value = true) },
    { id: "projects", label: "Manage projects", detail: "Actions", icon: "project", run: () => (projectsOpen.value = true) },
    { id: "health", label: "Check provider and Git health", detail: "Actions", icon: "alert", run: () => (healthOpen.value = true) },
    { id: "files", label: "Open files panel", detail: "Actions", icon: "files", run: () => openSide("files") },
    { id: "terminal", label: "Open terminal", detail: "Actions", icon: "terminal", run: () => openSide("terminal") },
    ...projects.value.map((p): Command => ({ id: `project:${p.id}`, label: p.name, detail: "Project", icon: "project", run: () => { selectProject(p.id); route.value = { view: "project", id: p.id }; } })),
    ...[...runs.value.values()].filter((r) => !r.archived).sort((a, b) => b.createdAt - a.createdAt).map((r): Command => ({ id: `run:${r.id}`, label: r.task.split("\n")[0] || r.id, detail: `Run · ${r.status} · ${r.repo}`, shown: `Run · ${STATUS_TEXT[r.status] ?? r.status} · ${baseName(r.repo)}`, status: r.status, run: () => (route.value = { view: "run", id: r.id }) })),
  ];
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const results = actions.filter((c) => (c.id !== "team" || peopleEnabled.value) && terms.every((t) => `${c.label} ${c.detail}`.toLowerCase().includes(t))).slice(0, 40);
  const selected = Math.min(active, Math.max(0, results.length - 1));
  const choose = (command?: Command) => { if (command) { close(); command.run(); } };
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => { document.getElementById(`command-${selected}`)?.scrollIntoView({ block: "nearest" }); }, [selected]);
  return (
    <dialog class="picker command-palette" ref={ref} aria-labelledby="command-title">
      <div class="picker-inner">
        {/* search first, like a launcher: the dialog's title stays for screen readers */}
        <div class="picker-head cp-head">
          <h3 id="command-title" class="sr-only">Commands and navigation</h3>
          <div class="cp-search">
            <Icon name="search" />
            <input ref={input} class="field" role="combobox" aria-label="Find a command, project or run" aria-autocomplete="list" aria-controls="command-results" aria-expanded="true" aria-activedescendant={results.length ? `command-${selected}` : undefined} value={query} placeholder="Type a command, project, or task…" onInput={(e) => { setQuery(e.currentTarget.value); setActive(0); }} onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setActive(Math.min(Math.max(0, active + (e.key === "ArrowDown" ? 1 : -1)), Math.max(0, results.length - 1))); }
              if (e.key === "Enter") { e.preventDefault(); choose(results[selected]); }
            }} />
          </div>
        </div>
        <div class="picker-list" id="command-results" role="listbox" aria-label="Matching commands">
          {results.map((command, i) => (
            <div id={`command-${i}`} key={command.id} class={`command-result ${i === selected ? "active" : ""}`} role="option" aria-selected={i === selected} onMouseEnter={() => setActive(i)} onClick={() => choose(command)}>
              {command.status ? <span class={`cr-dot dot ${command.status}`} aria-hidden="true" /> : <Icon name={command.icon ?? "chevron"} />}
              <span class="cr-label">{command.label}</span>
              <span class="cr-detail" title={command.shown ? command.detail : undefined}>{command.shown ?? command.detail}</span>
            </div>
          ))}
          {!results.length ? <p class="cp-empty">No commands, projects or runs match.</p> : null}
        </div>
        <div class="picker-foot">
          <span class="ps"><kbd>↑</kbd><kbd>↓</kbd> to choose · <kbd>Enter</kbd> to open · <kbd>Esc</kbd> to close</span>
          <button class="btn" onClick={close}>Close</button>
        </div>
      </div>
    </dialog>
  );
}
