import { useEffect, useRef, useState } from "preact/hooks";
import { fillTeamTemplate, validateTeamTemplate, templatePreferences, type TeamTemplate } from "../src/team-templates.js";
import { api, post, showToast, store } from "./lib.js";
import { composerProject, patterns, setAcceptanceCriteria, setPattern, setTask, task, setRoles, setOption, setAgentSetting, setRoleModel, pattern, rolesFor, optionsFor, agentSettings, roleModels } from "./state.js";
import type { AgentId } from "./types.js";
import { selectedTeamTemplate } from "./team-template-state.js";

function fresh(project?: string): TeamTemplate {
  return { schemaVersion: 1, id: `strategy-${Date.now().toString(36)}`, version: 1, name: "New team strategy", description: "Describe when this strategy helps.", scope: project ? "project" : "personal", ...(project ? { project } : {}), autoEnabled: false, parameters: ["task"], roles: ["builder"], workflow: undefined, task: "{{task}}", criteria: [], contracts: [], tasks: [{ id: "implement", title: "Implement the task", role: "builder", kind: "implementation", instructions: "{{task}}", dependsOn: [], paths: ["*"], acceptance: ["The requested behavior is implemented and tested."] }] };
}
function download(template: TeamTemplate) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(template, null, 2)], { type: "application/json" }));
  const a = document.createElement("a"); a.href = url; a.download = `${template.id}-v${template.version}.json`; a.click(); URL.revokeObjectURL(url);
}
/** The same definition is edited, previewed, saved, imported, and instantiated. */
export function TeamTemplateLibrary({ initial }: { initial?: TeamTemplate }) {
  const project = initial?.project ?? (composerProject.value || undefined);
  const query = project ? `?project=${encodeURIComponent(project)}` : "";
  const [templates, setTemplates] = useState<TeamTemplate[]>([]);
  const [selected, setSelected] = useState<TeamTemplate | null>(initial ?? null);
  const [editing, setEditing] = useState(!!initial);
  const [draft, setDraft] = useState(initial ? JSON.stringify(initial, null, 2) : "");
  const [expected, setExpected] = useState(0);
  const [inputs, setInputs] = useState<Record<string, string>>({ task: task.value });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<TeamTemplate[]>([]);
  const file = useRef<HTMLInputElement>(null);
  const reload = async () => setTemplates((await api<{ templates: TeamTemplate[] }>(`/api/team-templates${query}`)).templates);
  useEffect(() => {
    let live = true;
    setError(""); setTemplates([]);
    void api<{ templates: TeamTemplate[] }>(`/api/team-templates${query}`).then(r => { if (live) setTemplates(r.templates); }, e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [project]);
  let parsed: TeamTemplate | undefined, validation = "";
  if (editing) { try { parsed = validateTeamTemplate(JSON.parse(draft)); } catch (e) { validation = (e as Error).message; } }
  const edit = (template: TeamTemplate, isNew = false) => {
    setSelected(template); setDraft(JSON.stringify(template, null, 2)); setExpected(isNew ? 0 : template.version); setEditing(true); setError(""); setHistory([]);
  };
  const publish = async () => {
    if (!parsed) return;
    setBusy(true); setError("");
    try {
      const saved = await post<TeamTemplate>("/api/team-templates", { template: { ...parsed, version: expected + 1 }, expectedVersion: expected });
      await reload(); edit(saved); showToast(`Saved ${saved.name} v${saved.version}`);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const use = () => {
    if (!selected) return;
    try {
      const values = Object.fromEntries(selected.parameters.map(p => [p, inputs[p] ?? ""]));
      const filled = fillTeamTemplate(selected, values);
      setPattern(selected.workflow ?? "auto-team"); setTask(filled.task); setAcceptanceCriteria(filled.criteria);
      const p = patterns.value.find(p => p.id === (selected.workflow ?? "auto-team"));
      if (p && selected.preferences) {
        const prefs = selected.preferences;
        for (const role of p.roles) if (prefs.roles[role.id]) setRoles(p.id, role.id, prefs.roles[role.id] as (AgentId | "auto")[]);
        for (const option of p.options) if (prefs.options[option.id] !== undefined) setOption(p, option.id, prefs.options[option.id]!);
        for (const [id, settings] of Object.entries(prefs.agentSettings)) setAgentSetting(id as AgentId, settings);
        for (const [role, providers] of Object.entries(prefs.roleSettings)) for (const [id, settings] of Object.entries(providers)) setRoleModel(p.id, role, id as AgentId, settings);
      }
      selectedTeamTemplate.value = { template: selected, inputs: values };
      showToast(`Using ${selected.name} v${selected.version}; run permissions retained`);
    } catch (e) { setError((e as Error).message); }
  };
  return <section class="section team-template-library" aria-label="Reusable team templates">
    <h3>Reusable team templates</h3>
    <p class="help">Auto can build its own plan or reuse enabled task graphs (up to six definitions of 16,000 characters per run, ordered by ID). Fixed workflows keep their original checks and execution behavior. All templates use the run's permissions.</p>
    <label class="lbl" for="team-template-select">Saved templates</label>
    <select class="field" id="team-template-select" value={selected?.id ?? ""} onChange={e => { const t = templates.find(t => t.id === e.currentTarget.value) ?? null; setSelected(t); setEditing(false); setHistory([]); setError(""); setInputs({ task: task.value }); }}>
      <option value="">Choose a saved template</option>{templates.map(t => <option value={t.id} key={t.id}>{t.name} · v{t.version} · {t.scope}{t.autoEnabled ? " · available to Auto" : ""}</option>)}
    </select>
    {selected && !editing ? <div class="section">
      <p>{selected.description}</p>
      {selected.parameters.map(p => <label class="lbl" key={p}>{p}<input class="field" value={inputs[p] ?? ""} onInput={e => setInputs({ ...inputs, [p]: e.currentTarget.value })} /></label>)}
      <p class="help">{selected.workflow ? `Workflow: ${patterns.value.find(p => p.id === selected.workflow)?.name ?? selected.workflow}` : `${selected.tasks.length} tasks · ${selected.roles.join(", ")} · independent final verification`}</p>
      <button class="btn" onClick={use}>Use this template</button>{" "}<button class="btn" onClick={() => edit(selected)}>Edit new version</button>{" "}<button class="btn" onClick={() => edit({ ...selected, id: `copy-${Date.now().toString(36)}`, version: 1, name: `${selected.name} copy` }, true)}>Copy</button>{" "}<button class="btn" onClick={() => download(selected)}>Export</button>{" "}
      <button class="btn" onClick={async () => { try { const r = await api<{ templates: TeamTemplate[] }>(`/api/team-templates${query}${query ? "&" : "?"}history=1`); setHistory(r.templates.filter(t => t.id === selected.id)); } catch (e) { setError((e as Error).message); } }}>Version history</button>
      {history.map(t => <details key={t.version}><summary>Version {t.version}{t.version === selected.version ? " · selected" : ""}</summary><pre>{JSON.stringify(t, null, 2)}</pre><button class="btn" onClick={() => { setSelected(t); setInputs({ task: task.value }); }}>Use this version</button></details>)}
    </div> : null}
    <div class="section"><button class="btn" onClick={() => edit(fresh(project), true)}>Design a template</button>{" "}
      {pattern.value && pattern.value.id !== "auto-team" ? <><button class="btn" onClick={() => {
        const p = pattern.value!;
        edit({ ...fresh(project), name: `${p.name} template`, workflow: p.id, roles: [], tasks: [], task: task.value || "{{task}}", preferences: templatePreferences({ roles: rolesFor(p), options: optionsFor(p), agentSettings: agentSettings.value, roleSettings: roleModels.value[p.id] ?? {} }) }, true);
      }}>Save current workflow as template</button>{" "}</> : null}<button class="btn" onClick={() => file.current?.click()}>Import template</button>{" "}
      <button class="btn" disabled={busy} onClick={async () => {
        setBusy(true); setError("");
        try {
          let imported = 0;
          for (const scope of [undefined, ...(project ? [project] : [])]) {
            const key = scope ? `composerLibrary:${scope}` : "composerLibrary";
            const raw = store.get(key); if (!raw) continue;
            const result = await post<{ imported: number }>(`/api/team-templates/migrate${scope ? `?project=${encodeURIComponent(scope)}` : ""}`, JSON.parse(raw)); imported += result.imported;
          }
          await reload(); showToast(`Imported ${imported} templates. Browser originals retained; permissions were not imported.`);
        } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
      }}>Import browser library</button>
      <input hidden ref={file} type="file" accept="application/json,.json" onChange={async e => { const f = e.currentTarget.files?.[0]; if (!f) return; try { if (f.size > 150000) throw new Error("Template is too large"); const t = validateTeamTemplate(JSON.parse(await f.text())); edit({ ...t, id: `import-${Date.now().toString(36)}`, version: 1, scope: project ? "project" : "personal", project, autoEnabled: false }, true); } catch (e) { setError((e as Error).message); } }} />
    </div>
    {editing ? <div class="section">
      <p>Design parameters, roles, instructions, dependencies, owned paths, and acceptance criteria below. Publishing creates version {expected + 1}. The previous version stays unchanged.</p>
      {parsed ? <><label class="lbl">Name<input class="field" value={parsed.name} onInput={e => setDraft(JSON.stringify({ ...parsed, name: e.currentTarget.value }, null, 2))} /></label><label class="checkpoint"><input type="checkbox" checked={parsed.autoEnabled} disabled={!!parsed.workflow} onChange={e => setDraft(JSON.stringify({ ...parsed, autoEnabled: e.currentTarget.checked }, null, 2))} /><span>Allow Auto to reuse this strategy</span></label></> : null}
      <label class="lbl" for="team-template-definition">Template definition</label><textarea id="team-template-definition" class="field mono" rows={18} spellcheck={false} value={draft} onInput={e => setDraft(e.currentTarget.value)} />
      {validation ? <p class="err" role="alert">{validation}</p> : parsed ? <div class="help"><b>Execution preview:</b> {parsed.workflow ? `Fixed workflow ${parsed.workflow}` : <ol>{parsed.tasks.map(t => <li key={t.id}>{t.title} · {t.role} · {t.kind}{t.dependsOn.length ? ` · after ${t.dependsOn.join(", ")}` : ""}</li>)}</ol>}<p>Required task criteria and independent verification survive Auto adaptations. Permissions and spending limits come from the run.</p></div> : null}
      <button class="btn primary" disabled={busy || !!validation} onClick={() => void publish()}>{busy ? "Saving…" : "Publish template version"}</button>{" "}<button class="btn" onClick={() => setEditing(false)}>Close editor</button>
    </div> : null}
    {error ? <p class="err" role="alert">{error}</p> : null}
  </section>;
}
