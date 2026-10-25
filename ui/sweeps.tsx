import { useEffect, useState } from "preact/hooks";
import { useDialog } from "./app.js";
import { RoleModels, startProblem } from "./composer.js";
import { Icon } from "./icons.js";
import { supportsRunPermissions } from "../src/run-permissions.js";
import { fillTeamTemplate, type TeamTemplate } from "../src/team-templates.js";
import { api, enc, post, showToast } from "./lib.js";
import {
  agentSettings,
  agents,
  baseRef,
  checkCmd,
  limits,
  optionsFor,
  patterns,
  refreshRuns,
  repo,
  repoConfig,
  roleModels,
  rolesFor,
  route,
  setRoles,
  setOption,
  setAgentSetting,
  setRoleModel,
  setRunCheck,
  setupCmd,
  sweepPicker,
  loadProjects,
  target,
  trust,
} from "./state.js";
import type { AgentId, SweepItem, SweepList } from "./types.js";
import type { RoleValue } from "./roles.js";

/** Most runs one sweep starts (the server holds the same limit). */
const MAX_SWEEP = 25;

interface SweepOutcome {
  started: { key: string; id: string }[];
  skipped: { key: string; why: string }[];
  failed: { key: string; error: string }[];
  automation?: string;
}

const sevClass = (s?: string) => (/^(critical|high|error)$/i.test(s ?? "") ? "high" : /^(medium|warning)$/i.test(s ?? "") ? "medium" : "");

/**
 * A sweep: the open issues, Dependabot's PRs or the security alerts, each with a checkbox. The
 * picked ones start one run each with the workflow configured here, and their results wait
 * in the inbox. Template instructions supplement each item's own task and source.
 */
export function SweepDialog() {
  const t = sweepPicker.value;
  const ref = useDialog(!!t, () => (sweepPicker.value = null));
  const [list, setList] = useState<SweepList | null>(null);
  const [destination, setDestination] = useState<{ project?: string; repo: string; name?: string }>();
  const [error, setError] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [scope, setScope] = useState<"ready" | "all">("ready");
  const [outcome, setOutcome] = useState<SweepOutcome | null>(null);
  const [repeat, setRepeat] = useState(false);
  const [at, setAt] = useState("07:00");
  const [busy, setBusy] = useState(false);
  const [workflow, setWorkflow] = useState("");
  const [configOpen, setConfigOpen] = useState(false);
  const [templates, setTemplates] = useState<TeamTemplate[]>([]);
  const [templateError, setTemplateError] = useState("");
  const [templateLoading, setTemplateLoading] = useState(false);
  const [templateInputs, setTemplateInputs] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!t) return;
    setList(null);
    setError("");
    setFilter("");
    setScope("ready");
    setOutcome(null);
    setRepeat(false);
    setWorkflow(t.pattern);
    setConfigOpen(false);
    setTemplates([]);
    setTemplateInputs({});
    setTemplateError("");
    setTemplateLoading(true);
    const captured = { project: target.value.project?.id, name: target.value.project?.name, repo: repo.value };
    setDestination(captured);
    if (!captured.repo) { setTemplateLoading(false); return setError("Choose a repository first"); }
    let active = true;
    api<{ templates: TeamTemplate[] }>(`/api/team-templates${captured.project ? `?project=${enc(captured.project)}` : ""}`).then(
      result => { if (active) setTemplates(result.templates); },
      error => { if (active) setTemplateError(error.message); },
    ).finally(() => { if (active) setTemplateLoading(false); });
    api<SweepList>(`/api/github/sweep?repo=${enc(captured.repo)}&kind=${t.sweep}`).then(
      (l) => {
        if (!active) return;
        setList(l);
        setPicked(new Set(l.items.filter((i) => i.selected).map((i) => i.key)));
      },
      (e) => { if (active) setError(e.message); },
    );
    return () => { active = false; };
  }, [t]);

  const template = templates.find(entry => `template:${entry.id}` === workflow);
  const p = t ? patterns.value.find(x => x.id === (template ? template.workflow ?? "auto-team" : workflow || t.pattern)) : undefined;
  const roles = rolesFor(p);
  // The shared template goal is paired with the specific issue/PR task supplied for every run,
  // including future recurring runs; it never pins a template to the first selected item.
  const inputs = template ? Object.fromEntries(template.parameters.map(key => [key, key === "task" ? t?.task ?? "" : templateInputs[key] ?? ""])) : {};
  let inputProblem = "";
  if (template) { try { fillTeamTemplate(template, inputs); } catch (error) { inputProblem = (error as Error).message; } }
  const items = list?.items ?? [];
  const pickable = (i: SweepItem) => !i.manual && !i.blockedReason && !i.existingRun && !!i.source && !!i.task;
  const ready = items.filter(i => i.selected && pickable(i));
  const chosen = items.filter((i) => picked.has(i.key) && pickable(i));
  const unsupportedRoles = p?.roles.filter(role => (roles[role.id] ?? []).some(id => id !== "auto" && !supportsRunPermissions(id))) ?? [];
  useEffect(() => { if (unsupportedRoles.length) setConfigOpen(true); }, [unsupportedRoles.length]);
  const q = filter.trim().toLowerCase();
  const shown = items.filter((i) => (scope === "all" || ready.includes(i)) && (!q || `${i.ref} ${i.title} ${i.detail} ${i.note ?? ""}`.toLowerCase().includes(q)));
  const problem = inputProblem || (unsupportedRoles.length ? `Choose a supported provider for ${unsupportedRoles.map(role => role.label.toLowerCase()).join(", ")}.` : startProblem(p, roles, false)) || (chosen.length > MAX_SWEEP ? `Pick at most ${MAX_SWEEP}; the rest can go in a later sweep` : "");
  const chooseWorkflow = (value: string) => {
    setWorkflow(value); setTemplateInputs({});
    const selected = templates.find(entry => `template:${entry.id}` === value);
    const next = patterns.value.find(entry => entry.id === (selected?.workflow ?? "auto-team"));
    if (!selected?.preferences || !next) return;
    const prefs = selected.preferences;
    for (const role of next.roles) if (prefs.roles[role.id]) setRoles(next.id, role.id, prefs.roles[role.id] as RoleValue[]);
    for (const option of next.options) if (prefs.options[option.id] !== undefined) setOption(next, option.id, prefs.options[option.id]!);
    for (const [id, settings] of Object.entries(prefs.agentSettings)) setAgentSetting(id as AgentId, settings);
    for (const [role, providers] of Object.entries(prefs.roleSettings)) for (const [id, settings] of Object.entries(providers)) setRoleModel(next.id, role, id as AgentId, settings);
  };
  const editTeam = () => {
    setConfigOpen(true);
    const field = document.querySelector<HTMLElement>(unsupportedRoles.length ? `.sweep-dialog #sweep-role-${unsupportedRoles[0]!.id} select, .sweep-dialog #sweep-role-${unsupportedRoles[0]!.id} button` : ".sweep-dialog #sweep-workflow");
    field?.scrollIntoView({ block: "center" }); field?.focus({ preventScroll: true });
  };

  const toggle = (key: string) => {
    const next = new Set(picked);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setPicked(next);
  };
  const pickShown = (on: boolean) => {
    const next = new Set(picked);
    for (const i of shown) if (pickable(i)) on ? next.add(i.key) : next.delete(i.key);
    setPicked(next);
  };

  const start = async () => {
    if (!t || !p || problem || !chosen.length || busy) return;
    if (!destination || destination.project !== target.value.project?.id || destination.repo !== repo.value) { setError("The draft destination changed. Close this backlog and choose it again for the intended project."); return; }
    setBusy(true);
    setError("");
    try {
      const out = await post<SweepOutcome>("/api/sweeps", {
        kind: t.sweep,
        name: t.name,
        max: 5,
        schedule: repeat ? { at } : undefined,
        run: {
          repo: destination.repo,
          project: destination.project,
          projectSelection: "explicit",
          pattern: p.id,
          templateRef: template ? { id: template.id, version: template.version, inputs } : undefined,
          roles,
          options: optionsFor(p),
          baseRef: baseRef.value,
          agentSettings: agentSettings.value,
          roleSettings: roleModels.value[p.id] ?? {},
          trust: trust.value,
          loop: { check: checkCmd.value.trim(), setup: setupCmd.value.trim(), maxMinutes: limits.value.maxMinutes, maxSteps: limits.value.maxSteps, copy: repoConfig.value?.config.copy },
        },
        items: chosen.map((i) => ({ key: i.key, task: i.task, source: i.source })),
      });
      await Promise.all([refreshRuns(), loadProjects()]);
      const n = (k: number, what: string) => `${k} ${what}${k === 1 ? "" : "s"}`;
      showToast(
        [
          `Started ${n(out.started.length, "run")}`,
          out.skipped.length ? `${out.skipped.length} skipped: ${out.skipped[0]!.why}` : "",
          out.failed.length ? `${out.failed.length} couldn't start (${out.failed[0]!.key}: ${out.failed[0]!.error})` : "",
          out.automation ? "saved as a daily sweep" : "",
        ]
          .filter(Boolean)
          .join(" · "),
        out.failed.length ? 8000 : 5000,
      );
      if (out.failed.length || !out.started.length) {
        setOutcome(out);
        setPicked(new Set(out.failed.map(item => item.key)));
        setScope("all");
        setList(previous => previous ? { ...previous, items: previous.items.map(item => {
          const started = out.started.find(result => result.key === item.key);
          const skipped = out.skipped.find(result => result.key === item.key);
          return started ? { ...item, selected: false, existingRun: started.id, blockedReason: "A run is working on it", note: "A run is working on it" } :
            skipped ? { ...item, selected: false, blockedReason: skipped.why, note: skipped.why } : item;
        }) } : previous);
        // A retry only submits failed items; it must not create a second daily schedule.
        if (out.automation) setRepeat(false);
      } else {
        sweepPicker.value = null;
        route.value = { view: "inbox" };
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog class="picker sweep-dialog" ref={ref} aria-labelledby="sweep-title">
      {t ? (
        <div class="picker-inner">
          <div class="picker-head">
            <h3 id="sweep-title">
              <Icon name="layers" /> {t.name}
            </h3>
            <div class="help">{t.description}</div><p class="help sweep-destination">{destination?.name || destination?.repo.split(/[\\/]/).filter(Boolean).at(-1)}</p>
            <div class="row">
              <input class="field" placeholder="Filter by number, title, label, severity…" aria-label="Filter" value={filter} onInput={(e) => setFilter(e.currentTarget.value)} />
            </div>
            {list ? (
              <div class="sweep-tools">
                <div class="sweep-scope" role="group" aria-label="Show GitHub items">
                  <button type="button" class="btn" aria-pressed={scope === "ready"} onClick={() => setScope("ready")}>Needs work {ready.length}</button>
                  <button type="button" class="btn" aria-pressed={scope === "all"} onClick={() => setScope("all")}>All {items.length}</button>
                </div>
                <span>
                  <b>{chosen.length}</b> selected
                </span>
                <button type="button" class="linkish" onClick={() => pickShown(true)}>
                  Select shown
                </button>
                <button type="button" class="linkish" onClick={() => pickShown(false)}>
                  None
                </button>
              </div>
            ) : null}
          </div>
          <div class="sweep-body">
          {outcome ? <div class="sweep-outcome" role="status">
            <b>{outcome.started.length} started · {outcome.skipped.length} skipped · {outcome.failed.length} could not start</b>
            {outcome.started.length ? <a href="#/inbox" onClick={() => (sweepPicker.value = null)}>View results in Inbox</a> : null}
            {outcome.failed.map(item => <p key={item.key}>{item.key}: {item.error}</p>)}
            {outcome.failed.length ? <p>Failed items stay selected. Adjust the setup, then retry.</p> : null}
          </div> : null}
          <div class="picker-list sweep-list">
            {error ? <div class="msg err pad">{error}</div> : null}
            {list?.notices.map((n) => (
              <div key={n} class="config-note bad">
                {n}
              </div>
            ))}
            {!list && !error ? <div class="help pad">Loading from GitHub…</div> : null}
            {list && !items.length ? <div class="help pad">Nothing open — all clear.</div> : null}
            {list && items.length && !shown.length ? <div class="help pad">{q ? "Nothing matches your filter." : "No items need a new repair. Open All to see passing checks, existing runs and items needing attention."}</div> : null}
            {shown.map((i) => (
              <label key={i.key} class={`sweep-item ${pickable(i) ? "" : "manual"} ${picked.has(i.key) && pickable(i) ? "on" : ""}`}>
                <input type="checkbox" checked={picked.has(i.key) && pickable(i)} disabled={!pickable(i)} onChange={() => toggle(i.key)} />
                <span class="si-main">
                  <span class="si-title">
                    <span class="si-ref">{i.ref}</span> {i.title}
                  </span>
                  <span class="si-detail">
                    {i.severity ? <span class={`sev ${sevClass(i.severity)}`}>{i.severity}</span> : null} {i.detail}
                  </span>
                  {i.note ? (
                    <span class={`si-note ${i.manual ? "warn" : ""}`}>
                      {i.note}
                      {i.existingRun ? (
                        <>
                          {" · "}
                          <a href={`#/run/${i.existingRun}`} onClick={() => (sweepPicker.value = null)}>
                            open it
                          </a>
                        </>
                      ) : null}
                    </span>
                  ) : null}
                </span>
                <a class="si-link" href={i.url} target="_blank" rel="noreferrer" title="Open on GitHub" aria-label={`Open ${i.ref} on GitHub`} onClick={(e) => e.stopPropagation()}>
                  <Icon name="external" />
                </a>
              </label>
            ))}
          </div>
          <div class="sweep-how">
            <fieldset class="sweep-setup" disabled={busy}>
              <legend>Run setup</legend>
              <label class="sweep-workflow">Run with<select id="sweep-workflow" class="field" value={workflow} onChange={event => chooseWorkflow(event.currentTarget.value)}>
                <optgroup label="Agent">{patterns.value.filter(entry => entry.id === "solo").map(entry => <option key={entry.id} value={entry.id}>Single agent</option>)}</optgroup>
                <optgroup label="Recommended">{patterns.value.filter(entry => entry.id === "fix-review").map(entry => <option key={entry.id} value={entry.id}>Fix &amp; review · recommended</option>)}</optgroup>
                <optgroup label="Team patterns">{patterns.value.filter(entry => entry.id !== "solo" && entry.id !== "fix-review").map(entry => <option key={entry.id} value={entry.id}>{entry.id === "auto-team" ? "Team · dynamic plan" : entry.name}</option>)}</optgroup>
                <optgroup label="Saved templates">{templates.length ? templates.map(entry => <option key={entry.id} value={`template:${entry.id}`}>{entry.name} · v{entry.version}</option>) : <option disabled>{templateLoading ? "Loading templates…" : templateError ? "Templates unavailable" : "No saved templates yet"}</option>}</optgroup>
              </select></label>
              <p class="help sweep-workflow-description">{template?.description || p?.summary}</p>
              {templateLoading ? <p class="help">Loading saved templates…</p> : templateError ? <p class="help" role="status">Saved templates unavailable: {templateError}. Built-in workflows are still available.</p> : null}
              {template ? <div class="sweep-template-inputs">
                {template.parameters.filter(key => key !== "task").map(key => <label key={key}>{key}<input class="field" value={templateInputs[key] ?? ""} maxLength={10000} onInput={event => setTemplateInputs({ ...templateInputs, [key]: event.currentTarget.value })} /></label>)}
                <p class="help">Uses {template.name} v{template.version} for each item, with its own GitHub task and source.</p>
              </div> : null}
              <details class="sweep-config" open={configOpen} onToggle={event => setConfigOpen(event.currentTarget.open)}>
              <summary>Configure agents and checks</summary>
              {p ? <div class={`sweep-roles${p.roles.length === 1 ? " single" : ""}`}>{p.roles.map(role => {
                const selected = roles[role.id] ?? [];
                return role.multiple ? <div key={role.id} id={`sweep-role-${role.id}`} class="sweep-multiple-role">
                  <span class="sweep-role-label">{role.label}</span><div class="pills" role="group" aria-label={`${role.label} providers`}>
                    {agents.value.map(agent => <button key={agent.id} type="button" class="pill" aria-pressed={selected.includes(agent.id)} disabled={(!agent.available || !supportsRunPermissions(agent.id)) && !selected.includes(agent.id)} onClick={() => setRoles(p.id, role.id, selected.includes(agent.id) ? selected.filter(id => id !== agent.id) : [...selected, agent.id])}>{agent.displayName}</button>)}
                    {p.id !== "auto-team" || role.id !== "pool" ? <button type="button" class="pill" aria-pressed={selected.includes("auto")} onClick={() => setRoles(p.id, role.id, selected.includes("auto") ? selected.filter(id => id !== "auto") : [...selected, "auto"])}>Auto</button> : null}
                  </div>
                </div> : <label key={role.id} id={`sweep-role-${role.id}`}>{role.label}<select class="field" value={selected[0] ?? ""} onChange={event => setRoles(p.id, role.id, [event.currentTarget.value].filter(Boolean) as typeof selected)}>
                  <option value="" disabled={!role.optional}>{role.optional ? "Skip" : "Choose provider"}</option>
                  {agents.value.map(agent => <option key={agent.id} value={agent.id} disabled={!agent.available || !supportsRunPermissions(agent.id)}>{agent.displayName}{!supportsRunPermissions(agent.id) ? " · unsupported for sweeps" : !agent.available ? " · not installed" : ""}</option>)}
                  <option value="auto">Auto · choose a compatible provider</option>
                </select></label>;
              })}</div> : null}
              <label class="sweep-check">Done when<input class="field" value={checkCmd.value} placeholder="e.g. npm test" onInput={event => setRunCheck(event.currentTarget.value)} /></label>
              {p ? <details class="sweep-advanced" key={workflow}><summary>Models and workflow options</summary>
                {p.roles.map(role => <RoleModels key={role.id} p={p} roleId={role.id} roleLabel={role.label.toLowerCase()} agents={(roles[role.id] ?? []).filter((id): id is AgentId => id !== "auto")} />)}
                <div class="sweep-options">{p.options.map(option => option.type === "boolean" ? <label class="check" key={option.id}><input type="checkbox" checked={!!optionsFor(p)[option.id]} onChange={event => setOption(p, option.id, event.currentTarget.checked)} />{option.label}</label> : <label key={option.id}>{option.label}<input class="field" type="number" min={option.min} max={option.max} value={Number(optionsFor(p)[option.id])} onInput={event => setOption(p, option.id, Number(event.currentTarget.value))} /></label>)}</div>
              </details> : null}
              </details>
            </fieldset>
            <label class="check">
              <input type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.currentTarget.checked)} /> Also check every day at{" "}
              <input class="field inline" type="time" value={at} aria-label="Time of day" disabled={!repeat} onInput={(e) => setAt(e.currentTarget.value || "07:00")} /> and start runs for new ones (up to 5 each time)
            </label>
          </div>
          </div>
          <div class="picker-foot">
            <span class="ps" id="sweep-start-status" role="status">{problem || (!chosen.length ? t.sweep === "dependabot" && items.length ? "No PRs selected. Failing CI is picked by default; green PRs need no repair." : "Pick at least one item to start." : "Results wait in the inbox for you to approve. Nothing is merged automatically.")}{unsupportedRoles.length ? <> <button type="button" class="linkish" onClick={editTeam}>Change the team</button></> : null}</span>
            <button class="btn" type="button" onClick={() => (sweepPicker.value = null)}>
              Cancel
            </button>
            <button class="btn primary" type="button" aria-describedby="sweep-start-status" disabled={!!problem || !chosen.length || busy} onClick={start}>
              {busy ? "Starting…" : `${outcome?.failed.length ? "Retry" : "Start"} ${chosen.length} run${chosen.length === 1 ? "" : "s"}`}
            </button>
          </div>
        </div>
      ) : null}
    </dialog>
  );
}
