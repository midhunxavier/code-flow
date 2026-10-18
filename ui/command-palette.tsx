import { useEffect, useRef, useState } from "preact/hooks";
import { useDialog } from "./app.js";
import { commandPaletteOpen, healthOpen, openSide, pickerOpen, projects, projectsOpen, route, runs, selectProject } from "./state.js";

interface Command { id: string; label: string; detail: string; run: () => void }

export function CommandPalette() {
  const close = () => (commandPaletteOpen.value = false);
  const ref = useDialog(true, close);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const actions: Command[] = [
    { id: "new", label: "New run", detail: "Actions", run: () => (route.value = { view: "composer" }) },
    { id: "workspace", label: "Repository workspace", detail: "Files, verification and operations", run: () => (route.value = { view: "workspace" }) },
    { id: "repo", label: "Choose repository", detail: "Actions", run: () => (pickerOpen.value = true) },
    { id: "projects", label: "Manage projects", detail: "Actions", run: () => (projectsOpen.value = true) },
    { id: "health", label: "Check provider and Git health", detail: "Actions", run: () => (healthOpen.value = true) },
    { id: "insights", label: "Insights", detail: "Navigation", run: () => (route.value = { view: "insights" }) },
    { id: "automations", label: "Automations", detail: "Navigation", run: () => (route.value = { view: "automations" }) },
    { id: "files", label: "Open files panel", detail: "Actions", run: () => openSide("files") },
    { id: "terminal", label: "Open terminal", detail: "Actions", run: () => openSide("terminal") },
    ...projects.value.map((p): Command => ({ id: `project:${p.id}`, label: p.name, detail: "Project", run: () => { selectProject(p.id); route.value = { view: "project", id: p.id }; } })),
    ...[...runs.value.values()].filter((r) => !r.archived).sort((a, b) => b.createdAt - a.createdAt).map((r): Command => ({ id: `run:${r.id}`, label: r.task.split("\n")[0] || r.id, detail: `Run · ${r.status} · ${r.repo}`, run: () => (route.value = { view: "run", id: r.id }) })),
  ];
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const results = actions.filter((c) => terms.every((t) => `${c.label} ${c.detail}`.toLowerCase().includes(t))).slice(0, 40);
  const selected = Math.min(active, Math.max(0, results.length - 1));
  const choose = (command?: Command) => { if (command) { close(); command.run(); } };
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => { document.getElementById(`command-${selected}`)?.scrollIntoView({ block: "nearest" }); }, [selected]);
  return (
    <dialog class="picker command-palette" ref={ref} aria-labelledby="command-title">
      <div class="picker-inner">
        <div class="picker-head">
          <h3 id="command-title">Commands and navigation</h3>
          <input ref={input} class="field" role="combobox" aria-label="Find a command, project or run" aria-autocomplete="list" aria-controls="command-results" aria-expanded="true" aria-activedescendant={results.length ? `command-${selected}` : undefined} value={query} placeholder="Type a command, project, or task…" onInput={(e) => { setQuery(e.currentTarget.value); setActive(0); }} onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setActive(Math.min(Math.max(0, active + (e.key === "ArrowDown" ? 1 : -1)), Math.max(0, results.length - 1))); }
            if (e.key === "Enter") { e.preventDefault(); choose(results[selected]); }
          }} />
        </div>
        <div class="picker-list" id="command-results" role="listbox" aria-label="Matching commands">
          {results.map((command, i) => <div id={`command-${i}`} key={command.id} class={`command-result ${i === selected ? "active" : ""}`} role="option" aria-selected={i === selected} onMouseEnter={() => setActive(i)} onClick={() => choose(command)}><b>{command.label}</b><span class="help">{command.detail}</span></div>)}
          {!results.length ? <p class="help">No commands, projects or runs match.</p> : null}
        </div>
        <div class="picker-foot"><span class="ps">↑ ↓ to choose · Enter to open · Esc to close</span><button class="btn" onClick={close}>Close</button></div>
      </div>
    </dialog>
  );
}
