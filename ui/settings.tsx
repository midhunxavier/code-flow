import { AutomationManagement } from "./scheduling.js";
import { ActivityView } from "./activity.js";
import { TeamBoardView } from "./collab-board.js";
import { browserPerformance } from "./performance.js";
import { DesktopUpdatesCard } from "./desktop-updates.js";
import { MlSettingsCard } from "./ml/settings.js";
import { ConnectionsView } from "./connections.js";
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { Icon } from "./icons.js";
import { api, enc, showToast, showError } from "./lib.js";
import { MAX_EXECUTION_BUDGET, DEFAULT_EXECUTION_BUDGET } from "../src/execution-budget.js";
import { TRUST } from "./composer.js";
import { SETTINGS_SECTIONS, searchSettings, type SettingsSection } from "./settings-sections.js";
import { notificationPermission, canNotify, setDesktopNotifications } from "./preferences.js";
import { themeChoice, setTheme, type ThemeChoice } from "./theme.js";
import { executionHost } from "./ssh-projects.js";
import { NotificationsView } from "./notifications.js";
import { IntegrationsScreen } from "./integration-connections.js";
import { ConventionsPanel } from "./conventions.js";
import { FilePolicyPanel } from "./filesystem-policy.js";
import { PolicyPauseNotice } from "./policy-pause.js";
import { ExtensionsPanel } from "./extensions.js";
import { ProjectRunSettings } from "./project-run-settings.js";
import { DependencyDiscovery } from "./dependency-health.js";
import { PromptImprovementSettings } from "./prompt-improvement.js";
import { CodexProfileSetting } from "./codex-profile.js";
import { WorkbenchRetentionPanel } from "./retention.js";
import { downloadArtifact } from "./workbench.js";
import {
  executionPaused, healthError, healthOpen, refreshProviders, providersRefreshing, loadHealth, loadModels, loadAgents, limitPreference, setLimits, type Limits, trust, setTrust, settingsProject,
  patterns, defaultPattern, setPattern,
  railView, setRailView, shortcutsOpen, projectsOpen, projects, repo, route,
  externalSource, source, setTask, type Trust,
} from "./state.js";

export function SettingsView({ section = "general", group, connection }: { section?: SettingsSection; group?: string; connection?: string }) {
  const [query, setQuery] = useState("");
  const navigation = useRef<HTMLElement>(null);
  // Reset before the new section is interactive so a delayed effect cannot erase fresh input.
  useLayoutEffect(() => {
    setQuery("");
    document.getElementById("main-content")?.scrollTo({ top: 0 });
  }, [section, group]);
  useEffect(() => {
    const nav = navigation.current, active = nav?.querySelector("[aria-current='page']");
    if (!query && nav && active && nav.scrollWidth > nav.clientWidth) {
      nav.scrollLeft += active.getBoundingClientRect().left - nav.getBoundingClientRect().left - 8;
    }
  }, [section, query]);
  const item = SETTINGS_SECTIONS.find((item) => item.id === section)!;
  const matches = searchSettings(query);
  const host = executionHost.value;
  const go = (section: SettingsSection) => { setQuery(""); route.value = { view: "settings", section }; };
  return <div class="settings-page">
    <header class="settings-header"><div><h1>Settings</h1></div><span class="settings-scope"><Icon name={host.kind === "local" ? "panel" : "terminal"} />{host.kind === "ssh" ? host.name : host.kind === "host" ? "Remote server" : "This computer"}</span></header>
    <div class="settings-layout">
      <aside class="settings-sidebar">
        <div class="settings-search"><Icon name="search" /><input class="field" type="search" aria-label="Search settings" placeholder="Search settings…" value={query} onInput={(e) => setQuery(e.currentTarget.value)} /></div>
        <nav ref={navigation} aria-label="Settings categories">
          {["Preferences", "Connections", "Tools & activity", "Management"].map((group) => <div key={group} class="settings-nav-group"><div class="settings-nav-label">{group}</div>{SETTINGS_SECTIONS.filter((entry) => entry.group === group).map((entry) => <a key={entry.id} class={`settings-nav-item ${section === entry.id && !query.trim() ? "active" : ""}`} href={`#/settings/${entry.id}`} aria-current={section === entry.id && !query.trim() ? "page" : undefined} onClick={() => setQuery("")}><Icon name={entry.icon} />{entry.label}</a>)}</div>)}
        </nav>
      </aside>
      <div class="settings-content">
        {query.trim() ? <section aria-label="Settings search results"><h2>Search settings</h2><p class="help" role="status">{matches.length} {matches.length === 1 ? "category" : "categories"} for “{query.trim()}”</p>{matches.length ? matches.map((entry) => <button key={entry.id} class="settings-result" onClick={() => go(entry.id)}><Icon name={entry.icon} /><span><strong>{entry.label}</strong><span>{entry.description}</span></span><span aria-hidden="true">→</span></button>) : <div class="settings-empty"><Icon name="search" /><h3>No matching settings</h3><p>Try “SSH”, “models”, “theme” or “permissions”.</p><button class="btn" onClick={() => setQuery("")}>Clear search</button></div>}</section> : <>
          {section !== "integrations" ? <div class="settings-section-heading"><h2>{item.label}</h2><p>{item.description}</p></div> : null}
          <div key={section} class="settings-section-content">
            {section === "general" ? <GeneralSettings /> : null}
            {section === "agents" ? <AgentSettings /> : null}
            {section === "runs" ? <RunSettings /> : null}
            {section === "connections" ? <ConnectionsView purpose={group} connection={connection} /> : null}
            {section === "notifications" ? <><section class="settings-card settings-compact" aria-label="Desktop notifications"><div class="settings-inline-row"><strong>Desktop notifications</strong><button class="settings-switch" role="switch" aria-label="Desktop notifications" title="Notify when work finishes or needs your attention. Saved for this browser and workspace." aria-checked={canNotify()} onClick={() => void setDesktopNotifications(!canNotify())}><span /></button></div>{"Notification" in window ? notificationPermission.value === "denied" ? <p class="help">Blocked by your browser. Allow notifications in site permissions.</p> : null : <p class="help">This browser doesn’t support desktop notifications.</p>}</section><NotificationsView /></> : null}
            {section === "integrations" ? <IntegrationsScreen /> : null}
            {section === "projects" ? <ProjectSettings /> : null}
            {section === "automations" ? <AutomationManagement /> : null}
            {section === "board" ? <TeamBoardView embedded navigate={to => { route.value = to; }} /> : null}
            {section === "inbox" || section === "insights" ? <ActivityView current={{ view: section, ...(section === "insights" && group ? { group } : {}) }} /> : null}
            {section === "data" ? <WorkbenchRetentionPanel /> : null}
            {section === "advanced" ? <AdvancedSettings /> : null}
          </div>
        </>}
      </div>
    </div>
  </div>;
}
function SettingsCard({ title, children }: { title: string; children: ComponentChildren }) {
  return <section class="settings-card"><h3>{title}</h3>{children}</section>;
}
function SettingsRow({ title, description, children }: { title: string; description: string; children: ComponentChildren }) {
  return <div class="settings-row"><div><strong>{title}</strong><p>{description}</p></div><div class="settings-row-control">{children}</div></div>;
}
function GeneralSettings() {
  return <>
    <DesktopUpdatesCard />
    <SettingsCard title="Appearance">
      <p class="help">Choose a look. Your preference is saved in this browser and applies to every workspace.</p>
      <div class="theme-options" role="group" aria-label="Appearance">
        {(["light", "dark", "system"] as ThemeChoice[]).map((value) => <button class={`theme-option ${themeChoice.value === value ? "selected" : ""}`} key={value} aria-pressed={themeChoice.value === value} onClick={() => setTheme(value)}><span class={`theme-preview ${value}`} aria-hidden="true"><span /><span><i /><i /><i /></span></span><span>{value === "system" ? "System" : value === "light" ? "Light" : "Dark"}{themeChoice.value === value ? <span aria-hidden="true">✓</span> : null}</span></button>)}
      </div>
    </SettingsCard>
    <SettingsCard title="Workspace preferences">
      <SettingsRow title="Group chats by" description="Choose how chats are organized in the sidebar."><select class="field" aria-label="Group chats by" value={railView.value.group} onChange={(e) => setRailView({ group: e.currentTarget.value as "project" | "status" })}><option value="project">Project</option><option value="status">Status</option></select></SettingsRow>
      <SettingsRow title="Show archived chats" description="Include archived work in your chat list."><button class="settings-switch" role="switch" aria-label="Show archived chats" aria-checked={railView.value.archived} onClick={() => setRailView({ archived: !railView.value.archived })}><span /></button></SettingsRow>
      <SettingsRow title="Keyboard shortcuts" description="Move around your workspace without leaving the keyboard."><button class="btn small" onClick={() => { shortcutsOpen.value = true; }}>View shortcuts</button></SettingsRow>
    </SettingsCard>
    <MlSettingsCard />
  </>;
}
function AgentSettings() {
  const [busy, setBusy] = useState(false);
  const paused = executionPaused.value;
  return <>
    <PolicyPauseNotice what="Provider checks and agent runs are paused" />
    <p class="help">Choose prompt improvement settings and manage provider connections. Open Health to check installation and sign-in status.</p>
    <div class="settings-actions"><button class="btn" disabled={busy || providersRefreshing.value} onClick={async () => { setBusy(true); try { await refreshProviders(); } finally { setBusy(false); } }}>{busy || providersRefreshing.value ? "Checking…" : "Refresh providers"}</button><button class="btn" onClick={() => { healthOpen.value = true; }}>Health</button></div>
    {healthError.value && !paused ? <p class="msg err" role="alert">{healthError.value}</p> : null}
    <PromptImprovementSettings />
    <CodexProfileSetting />
    <details class="settings"><summary>Check this computer</summary><div class="settings-body"><DependencyDiscovery /></div></details>
  </>;
}
function NumberSetting({ label, hint, value, min = 1, max, step = 1, optional = false, save }: { label: string; hint?: string; value?: number; min?: number; max?: number; step?: number; optional?: boolean; save: (value: number | undefined) => void }) {
  const [draft, setDraft] = useState(value === undefined ? "" : String(value));
  useEffect(() => setDraft(value === undefined ? "" : String(value)), [value]);
  return <label title={hint}>{label}<input title={hint} class="field" type="number" min={min} max={max} step={step} required={!optional} placeholder={optional ? "No ceiling" : undefined} value={draft} onInput={(e) => setDraft(e.currentTarget.value)} onBlur={(e) => {
    if (e.currentTarget.validity.valid && (draft || optional)) save(draft ? Number(draft) : undefined);
    else { setDraft(value === undefined ? "" : String(value)); showError(`Enter a valid value for ${label.toLowerCase()}`); }
  }} /></label>;
}
function RunSettings() {
  // Until you save limits here, a repository's .codeflow/config.json supplies its own.
  const savedLimits: Limits = limitPreference.value ?? DEFAULT_EXECUTION_BUDGET;
  const mode = defaultPattern.value === "solo" ? "solo" : "auto-team";
  return <>
    <p class="help">Choose defaults for new chats. You can change Agent or Team in each chat.</p>
    <SettingsCard title="New chats">
      <SettingsRow title="Default mode" description="Use one agent or let a team work together."><select class="field" aria-label="Default chat mode" value={mode} onChange={event => setPattern(event.currentTarget.value)}><option value="solo">Agent</option><option value="auto-team">Team</option></select></SettingsRow>
    </SettingsCard>
    <SettingsCard title="Agent permissions">
      <label class="sr-only" for="settings-trust">Agent permissions</label><select class="field" id="settings-trust" value={trust.value} onChange={(e) => setTrust(e.currentTarget.value as Trust)}>{(Object.keys(TRUST) as Trust[]).map((value) => <option key={value} value={value}>{TRUST[value].label}</option>)}</select>
      <p class={trust.value === "full" ? "full-warn" : "help"}>{TRUST[trust.value].help}</p>
    </SettingsCard>
    <section class="settings-card settings-compact" aria-label="Run limits"><h3 title="Work stops when a limit is reached. Changes save when you leave a field.">Run limits</h3><div class="settings-limit-fields">
      <NumberSetting label="Time (min)" hint="Maximum execution minutes per run." value={savedLimits.maxMinutes} max={MAX_EXECUTION_BUDGET.maxMinutes} save={(value) => setLimits({ maxMinutes: value! })} />
      <NumberSetting label="Agent steps" hint="Maximum agent steps per run." value={savedLimits.maxSteps} max={MAX_EXECUTION_BUDGET.maxSteps} save={(value) => setLimits({ maxSteps: value! })} />
      <NumberSetting label="Token limit" hint="Reported token ceiling; checked between operations. Empty means unlimited." value={savedLimits.maxTokens} optional save={(value) => setLimits({ maxTokens: value })} />
      <NumberSetting label="Cost limit ($)" hint="API-equivalent cost ceiling, based on provider reports. This is not your subscription bill. Empty means unlimited." value={savedLimits.maxCostUsd} optional min={0.01} step={0.01} save={(value) => setLimits({ maxCostUsd: value })} />
    </div></section>
    <p class="help">Repository setup, checks, branch names, team roles and per-run isolation are available in <a href="#/workflows">Saved workflows → Advanced agent settings</a>.</p>
  </>;
}
function ProjectSettings() {
  const [id, setId] = useState("");
  // A "Review the filesystem policy" link chose the project to show.
  useEffect(() => { if (settingsProject.value) { setId(settingsProject.value); settingsProject.value = ""; } }, [settingsProject.value]);
  const project = projects.value.find((p) => p.id === id) ?? projects.value.find((p) => p.repos.includes(repo.value)) ?? projects.value[0];
  return <>
    <SettingsCard title="Projects"><SettingsRow title="Repositories" description="Create projects and change their repositories."><button class="btn small" onClick={() => { projectsOpen.value = true; }}>Manage projects</button></SettingsRow></SettingsCard>
    {project ? <><label class="lbl" for="settings-project">Project</label><select id="settings-project" class="field" value={project.id} onChange={(e) => setId(e.currentTarget.value)}>{projects.value.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select><ProjectRunSettings key={project.id} projectId={project.id} repositories={project.repos} /><ConventionsPanel key={`conventions:${project.id}`} projectId={project.id} repos={project.repos} /><FilePolicyPanel key={`policy:${project.id}`} projectId={project.id} projectName={project.name} /></> : <><p class="help">Create a project to configure its conventions and filesystem access.</p><ProjectRunSettings repositories={repo.value ? [repo.value] : []} /></>}
    <p class="help">Manage people and project access in <a href="#/settings/connections/sharing">Connections → Share access</a>.</p>
  </>;
}
function AdvancedSettings() {
  const [diagnostics, setDiagnostics] = useState<unknown>();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  return <>
    <section class="settings-card settings-compact" aria-label="Diagnostics"><div class="settings-inline-row"><strong title="Collect versions, connection health and recent logs. Credentials are redacted before export.">Diagnostics</strong><div class="settings-actions"><button class="btn" disabled={busy} onClick={async () => { setBusy(true); setError(""); setDiagnostics(undefined); try { setDiagnostics({ ...await api(`/api/diagnostics${repo.value ? `?repo=${enc(repo.value)}` : ""}`), browserPerformance: browserPerformance(), runtime: await api("/api/health") }); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } }}>{busy ? "Collecting…" : "Collect diagnostics"}</button>{diagnostics ? <button class="btn" onClick={() => downloadArtifact("codeflow-diagnostics.json", JSON.stringify(diagnostics, null, 2))}>Export diagnostics</button> : null}</div></div>{diagnostics ? <details><summary>Collected diagnostics</summary><pre>{JSON.stringify(diagnostics, null, 2)}</pre></details> : null}{error ? <p role="alert" class="msg err">{error}</p> : null}</section>
    <section class="settings-card settings-compact"><div class="settings-inline-row"><strong title="Port, data directory and CLI paths are configured on the server. Changes require a restart.">Server configuration</strong><a class="btn small" href="/docs/configuration.html" target="_blank" rel="noreferrer">Reference ↗</a></div></section>
    <details class="settings advanced-extensions"><summary>Extensions</summary><ExtensionsPanel /></details>
  </>;
}
