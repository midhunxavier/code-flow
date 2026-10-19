import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Icon } from "./icons.js";
import { api, enc, showToast } from "./lib.js";
import { ModelRow, TRUST } from "./composer.js";
import { SETTINGS_SECTIONS, searchSettings, type SettingsSection } from "./settings-sections.js";
import { notificationPermission, canNotify, setDesktopNotifications } from "./preferences.js";
import { themeChoice, setTheme, type ThemeChoice } from "./theme.js";
import { executionHost, SshConnections } from "./ssh-projects.js";
import { RemoteAccess } from "./remote-access.js";
import { TeamSettings } from "./collab-settings.js";
import { AutomationsView, inbox } from "./automations.js";
import { DeferredRunsPanel } from "./deferred-runs.js";
import { NotificationsView } from "./notifications.js";
import { IntegrationsView } from "./integrations.js";
import { CodeHostsPanel } from "./code-hosts.js";
import { RemoteWorkersView } from "./remote-workers.js";
import { SharedAccountsPanel } from "./shared.js";
import { ConventionsPanel } from "./conventions.js";
import { FilePolicyPanel } from "./filesystem-policy.js";
import { ExtensionsPanel } from "./extensions.js";
import { WorkbenchRetentionPanel } from "./retention.js";
import { InsightsView } from "./insights.js";
import { downloadArtifact, WorkbenchView } from "./workbench.js";
import {
  agents, health, healthOpen, loadHealth, loadModels, limits, setLimits, trust, setTrust,
  patterns, patternId, setPattern, CHECKPOINTS, planApprovalFor, setApprovePlan,
  railView, setRailView, shortcutsOpen, projectsOpen, projects, repo, route,
  externalSource, source, setTask, type Trust,
} from "./state.js";

export function SettingsView({ section = "general", group }: { section?: SettingsSection; group?: string }) {
  const [query, setQuery] = useState("");
  const navigation = useRef<HTMLElement>(null);
  useEffect(() => {
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
  const pending = inbox().length;
  const go = (section: SettingsSection) => { setQuery(""); route.value = { view: "settings", section }; };
  return <div class={`settings-page ${section === "workspace" || section === "insights" ? "settings-tools" : ""}`}>
    <header class="settings-header"><div><div class="eyebrow">Your workspace, your way</div><h1>Settings</h1></div><span class="settings-scope"><Icon name={host.kind === "local" ? "panel" : "terminal"} />{host.kind === "ssh" ? host.name : host.kind === "host" ? "Remote server" : "This computer"}</span></header>
    <div class="settings-layout">
      <aside class="settings-sidebar">
        <div class="settings-search"><Icon name="search" /><input class="field" type="search" aria-label="Search settings" placeholder="Search settings…" value={query} onInput={(e) => setQuery(e.currentTarget.value)} /></div>
        <nav ref={navigation} aria-label="Settings categories">
          {["Preferences", "Connections", "Tools & activity", "Management"].map((group) => <div key={group} class="settings-nav-group"><div class="settings-nav-label">{group}</div>{SETTINGS_SECTIONS.filter((entry) => entry.group === group).map((entry) => <a key={entry.id} class={`settings-nav-item ${section === entry.id && !query.trim() ? "active" : ""}`} href={`#/settings/${entry.id}`} title={entry.id === "automations" && pending ? `${pending} runs need attention` : undefined} aria-current={section === entry.id && !query.trim() ? "page" : undefined} onClick={() => setQuery("")}><Icon name={entry.icon} />{entry.label}{entry.id === "automations" && pending ? <span class="count" aria-hidden="true">{pending}</span> : null}</a>)}</div>)}
        </nav>
        <p class="settings-nav-note">A little more you.<br />A little less setup.</p>
      </aside>
      <div class="settings-content">
        {query.trim() ? <section aria-label="Settings search results"><h2>Search settings</h2><p class="help" role="status">{matches.length} {matches.length === 1 ? "category" : "categories"} for “{query.trim()}”</p>{matches.length ? matches.map((entry) => <button key={entry.id} class="settings-result" onClick={() => go(entry.id)}><Icon name={entry.icon} /><span><strong>{entry.label}</strong><span>{entry.description}</span></span><span aria-hidden="true">→</span></button>) : <div class="settings-empty"><Icon name="search" /><h3>No matching settings</h3><p>Try “SSH”, “models”, “theme” or “permissions”.</p><button class="btn" onClick={() => setQuery("")}>Clear search</button></div>}</section> : <>
          <div class="settings-section-heading"><h2>{item.label}</h2><p>{item.description}</p></div>
          <div key={section} class="settings-section-content">
            {section === "general" ? <GeneralSettings /> : null}
            {section === "agents" ? <AgentSettings /> : null}
            {section === "runs" ? <RunSettings /> : null}
            {section === "ssh" ? <SshConnections /> : null}
            {section === "remote-access" ? host.kind === "local" ? <RemoteAccess /> : <SettingsCard title="Manage access on your computer"><p>Remote device access is configured in your local workspace.</p>{host.kind === "ssh" ? <a class="btn" href={`${host.returnUrl}#/settings/remote-access`}>Back to this computer</a> : null}</SettingsCard> : null}
            {section === "team" ? <TeamSettings /> : null}
            {section === "notifications" ? <><SettingsCard title="Desktop notifications"><SettingsRow title="Run updates" description="Notify when a run finishes or needs your attention, while you’re away from it."><button class="settings-switch" role="switch" aria-label="Desktop notifications" aria-checked={canNotify()} onClick={() => void setDesktopNotifications(!canNotify())}><span /></button></SettingsRow><p class="help">{"Notification" in window ? notificationPermission.value === "denied" ? "Notifications are blocked. Allow them in your browser’s site permissions to enable this setting." : "This preference is saved in this browser for the current workspace." : "This browser doesn’t support desktop notifications."}</p></SettingsCard><NotificationsView /></> : null}
            {section === "integrations" ? <><IntegrationsView onImport={(imported) => { externalSource.value = imported; source.value = null; setTask(`Address ${imported.provider} ${imported.kind} ${imported.key}: ${imported.title}`); route.value = { view: "composer" }; }} /><CodeHostsPanel projects={projects.value} /><RemoteWorkersView /></> : null}
            {section === "workspace" ? <WorkbenchView /> : null}
            {section === "insights" ? <InsightsView group={group} /> : null}
            {section === "automations" ? <><AutomationsView /><DeferredRunsPanel /></> : null}
            {section === "projects" ? <ProjectSettings /> : null}
            {section === "extensions" ? <ExtensionsPanel /> : null}
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
    <SettingsCard title="Appearance">
      <p class="help">Choose a look. Your preference is saved in this browser and applies to every workspace.</p>
      <div class="theme-options" role="group" aria-label="Appearance">
        {(["light", "dark", "system"] as ThemeChoice[]).map((value) => <button class={`theme-option ${themeChoice.value === value ? "selected" : ""}`} key={value} aria-pressed={themeChoice.value === value} onClick={() => setTheme(value)}><span class={`theme-preview ${value}`} aria-hidden="true"><span /><span><i /><i /><i /></span></span><span>{value === "system" ? "System" : value === "light" ? "Light" : "Dark"}{themeChoice.value === value ? <span aria-hidden="true">✓</span> : null}</span></button>)}
      </div>
    </SettingsCard>
    <SettingsCard title="Workspace preferences">
      <SettingsRow title="Group runs by" description="Choose how runs are organized in the sidebar."><select class="field" aria-label="Group runs by" value={railView.value.group} onChange={(e) => setRailView({ group: e.currentTarget.value as "project" | "status" })}><option value="project">Project</option><option value="status">Status</option></select></SettingsRow>
      <SettingsRow title="Show archived runs" description="Include archived work in your run list."><button class="settings-switch" role="switch" aria-label="Show archived runs" aria-checked={railView.value.archived} onClick={() => setRailView({ archived: !railView.value.archived })}><span /></button></SettingsRow>
      <SettingsRow title="Keyboard shortcuts" description="Move around your workspace without leaving the keyboard."><button class="btn small" onClick={() => { shortcutsOpen.value = true; }}>View shortcuts</button></SettingsRow>
    </SettingsCard>
    <div class="settings-callout"><Icon name="terminal" /><div><strong>Take your workspace further</strong><p>Connect a VM and keep your projects and tools on your remote machine.</p><a href="#/settings/ssh">Set up an SSH connection <span aria-hidden="true">→</span></a></div></div>
  </>;
}
function AgentSettings() {
  const [busy, setBusy] = useState(false);
  return <>
    <p class="help">Saved model choices apply to new runs in this workspace. Project defaults and individual role overrides can take precedence. Sign in through each agent’s CLI on the machine where it runs.</p>
    <div class="settings-actions"><button class="btn" disabled={busy} onClick={async () => { setBusy(true); try { await Promise.all([loadModels(), loadHealth()]); } finally { setBusy(false); } }}>{busy ? "Checking…" : "Refresh providers"}</button><button class="btn" onClick={() => { healthOpen.value = true; }}>Health & usage</button></div>
    {agents.value.map((agent) => {
      const status = health.value?.find((item) => item.id === agent.id);
      return <SettingsCard key={agent.id} title={agent.displayName}><div class="settings-provider-status"><span class={`badge ${status?.installed && status.signedIn !== false ? "ok" : ""}`}>{status ? !status.installed ? "Not installed" : status.signedIn === false ? "Signed out" : status.signedIn ? "Signed in" : "Installed · login unknown" : "Checking health…"}</span><span class="help">{status?.version}</span></div>{agent.available ? <ModelRow agent={agent} used /> : <p class="help">Install this CLI on the current machine to configure its models.</p>}{status?.fix ? <p class="msg warn">{status.fix}</p> : null}</SettingsCard>;
    })}
  </>;
}
function NumberSetting({ label, value, min = 1, max, step = 1, optional = false, save }: { label: string; value?: number; min?: number; max?: number; step?: number; optional?: boolean; save: (value: number | undefined) => void }) {
  const [draft, setDraft] = useState(value === undefined ? "" : String(value));
  useEffect(() => setDraft(value === undefined ? "" : String(value)), [value]);
  return <label>{label}<input class="field" type="number" min={min} max={max} step={step} required={!optional} placeholder={optional ? "No ceiling" : undefined} value={draft} onInput={(e) => setDraft(e.currentTarget.value)} onBlur={(e) => {
    if (e.currentTarget.validity.valid && (draft || optional)) save(draft ? Number(draft) : undefined);
    else { setDraft(value === undefined ? "" : String(value)); showToast(`Enter a valid value for ${label.toLowerCase()}`); }
  }} /></label>;
}
function RunSettings() {
  return <>
    <p class="help">These are the composer’s remembered choices for this browser and workspace. Changes also update your current draft; running work keeps its existing settings.</p>
    <SettingsCard title="Workflow">
      <SettingsRow title="Default workflow" description="The team pattern used for a new task."><select class="field" aria-label="Default workflow" value={patternId.value} onChange={(e) => setPattern(e.currentTarget.value)}>{patterns.value.map((pattern) => <option key={pattern.id} value={pattern.id}>{pattern.name}</option>)}</select></SettingsRow>
      {CHECKPOINTS[patternId.value] ? <SettingsRow title="Approve before building" description={`Pause so you can review ${CHECKPOINTS[patternId.value]}. This choice is remembered per workflow.`}><button class="settings-switch" role="switch" aria-label="Approve before building" aria-checked={planApprovalFor(patternId.value)} onClick={() => setApprovePlan(!planApprovalFor(patternId.value), patternId.value)}><span /></button></SettingsRow> : null}
    </SettingsCard>
    <SettingsCard title="Agent permissions">
      <label class="sr-only" for="settings-trust">Agent permissions</label><select class="field" id="settings-trust" value={trust.value} onChange={(e) => setTrust(e.currentTarget.value as Trust)}>{(Object.keys(TRUST) as Trust[]).map((value) => <option key={value} value={value}>{TRUST[value].label}</option>)}</select>
      <p class={trust.value === "full" ? "full-warn" : "help"}>{TRUST[trust.value].help}</p>
    </SettingsCard>
    <SettingsCard title="Run limits"><p class="help">Stop when a limit is reached. Changes save when you leave a field.</p><div class="settings-grid">
      <NumberSetting label="Minutes per run" value={limits.value.maxMinutes} max={720} save={(value) => setLimits({ maxMinutes: value! })} />
      <NumberSetting label="Agent steps per run" value={limits.value.maxSteps} max={200} save={(value) => setLimits({ maxSteps: value! })} />
      <NumberSetting label="Reported token ceiling" value={limits.value.maxTokens} optional save={(value) => setLimits({ maxTokens: value })} />
      <NumberSetting label="API-equivalent cost ceiling ($)" value={limits.value.maxCostUsd} optional min={0.01} step={0.01} save={(value) => setLimits({ maxCostUsd: value })} />
    </div><p class="help">Usage ceilings depend on provider reports and are checked between operations. API-equivalent cost is not your subscription bill.</p></SettingsCard>
    <p class="help">Repository setup, checks, branch names, team roles and per-run isolation are available in <a href="#/">New run → Advanced team controls</a>.</p>
  </>;
}
function ProjectSettings() {
  const [id, setId] = useState("");
  const project = projects.value.find((p) => p.id === id) ?? projects.value.find((p) => p.repos.includes(repo.value)) ?? projects.value[0];
  return <>
    <SettingsCard title="Projects"><SettingsRow title="Repositories & teams" description="Create projects, change their repositories and manage saved teams."><button class="btn small" onClick={() => { projectsOpen.value = true; }}>Manage projects</button></SettingsRow></SettingsCard>
    {project ? <><label class="lbl" for="settings-project">Project</label><select id="settings-project" class="field" value={project.id} onChange={(e) => setId(e.currentTarget.value)}>{projects.value.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select><ConventionsPanel key={`conventions:${project.id}`} projectId={project.id} repos={project.repos} /><FilePolicyPanel key={`policy:${project.id}`} projectId={project.id} projectName={project.name} /></> : <p class="help">Create a project to configure its conventions and filesystem access.</p>}
    <SharedAccountsPanel projects={projects.value} />
  </>;
}
function AdvancedSettings() {
  const [diagnostics, setDiagnostics] = useState<unknown>();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  return <>
    <SettingsCard title="Diagnostics"><p class="help">Collect versions, connection health, resource queues and recent logs for the current machine. Credential-like values are redacted before export.</p><div class="settings-actions"><button class="btn" disabled={busy} onClick={async () => { setBusy(true); setError(""); try { setDiagnostics(await api(`/api/diagnostics${repo.value ? `?repo=${enc(repo.value)}` : ""}`)); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } }}>{busy ? "Collecting…" : "Collect diagnostics"}</button>{diagnostics ? <button class="btn" onClick={() => downloadArtifact("codeflow-diagnostics.json", JSON.stringify(diagnostics, null, 2))}>Export diagnostics</button> : null}</div>{diagnostics ? <details><summary>Collected diagnostics</summary><pre>{JSON.stringify(diagnostics, null, 2)}</pre></details> : null}{error ? <p role="alert" class="msg err">{error}</p> : null}</SettingsCard>
    <SettingsCard title="Server configuration"><p class="help">Process settings such as the server port, data directory, concurrency, CLI paths and integration credentials are configured through environment variables when starting code-flow. Changes require a server restart.</p><p class="help">Repository defaults live in <code>.codeflow/config.json</code>. Browser preferences are separate for each SSH workspace.</p><a href="https://github.com/midhunxavier/code-flow/blob/main/docs/configuration.md" target="_blank" rel="noreferrer">Configuration reference ↗</a></SettingsCard>
  </>;
}
