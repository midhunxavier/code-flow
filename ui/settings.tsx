import { browserPerformance } from "./performance.js";
import { DesktopUpdatesCard } from "./desktop-updates.js";
import { MlSettingsCard } from "./ml/settings.js";
import { ConnectionsView } from "./connections.js";
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { Icon } from "./icons.js";
import { api, enc, showToast, showError } from "./lib.js";
import { DEFAULT_EXECUTION_BUDGET } from "../src/execution-budget.js";
import { ModelRow, TRUST } from "./composer.js";
import { SETTINGS_SECTIONS, searchSettings, type SettingsSection } from "./settings-sections.js";
import { notificationPermission, canNotify, setDesktopNotifications } from "./preferences.js";
import { themeChoice, setTheme, type ThemeChoice } from "./theme.js";
import { executionHost } from "./ssh-projects.js";
import { NotificationsView } from "./notifications.js";
import { IntegrationsScreen } from "./integration-connections.js";
import { ConventionsPanel } from "./conventions.js";
import { FilePolicyPanel } from "./filesystem-policy.js";
import { POLICY_PAUSED, PolicyPauseNotice } from "./policy-pause.js";
import { ExtensionsPanel } from "./extensions.js";
import { ProjectRunSettings } from "./project-run-settings.js";
import { DependencyDiscovery, unrestrictedOnly } from "./dependency-health.js";
import { PromptImprovementSettings } from "./prompt-improvement.js";
import { AcpConnectionsPanel } from "./acp-connections.js";
import { WorkbenchRetentionPanel } from "./retention.js";
import { downloadArtifact } from "./workbench.js";
import {
  agents, executionPaused, health, healthError, healthOpen, refreshProviders, providersRefreshing, loadHealth, loadModels, loadAgents, limitPreference, setLimits, type Limits, trust, setTrust, settingsProject,
  patterns, defaultPattern, setPattern, CHECKPOINTS, planApprovalFor, setApprovePlan,
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
  const go = (section: SettingsSection) => { setQuery(""); route.value = section === "workspace" || section === "automations" || section === "insights" ? { view: section } : { view: "settings", section }; };
  return <div class="settings-page">
    <header class="settings-header"><div><div class="eyebrow">Your workspace, your way</div><h1>Settings</h1></div><span class="settings-scope"><Icon name={host.kind === "local" ? "panel" : "terminal"} />{host.kind === "ssh" ? host.name : host.kind === "host" ? "Remote server" : "This computer"}</span></header>
    <div class="settings-layout">
      <aside class="settings-sidebar">
        <div class="settings-search"><Icon name="search" /><input class="field" type="search" aria-label="Search settings" placeholder="Search settings…" value={query} onInput={(e) => setQuery(e.currentTarget.value)} /></div>
        <nav ref={navigation} aria-label="Settings categories">
          {["Preferences", "Connections", "Management"].map((group) => <div key={group} class="settings-nav-group"><div class="settings-nav-label">{group}</div>{SETTINGS_SECTIONS.filter((entry) => entry.group === group && !["workspace", "automations", "insights"].includes(entry.id)).map((entry) => <a key={entry.id} class={`settings-nav-item ${section === entry.id && !query.trim() ? "active" : ""}`} href={`#/settings/${entry.id}`} aria-current={section === entry.id && !query.trim() ? "page" : undefined} onClick={() => setQuery("")}><Icon name={entry.icon} />{entry.label}</a>)}</div>)}
        </nav>
        <p class="settings-nav-note">A little more you.<br />A little less setup.</p>
      </aside>
      <div class="settings-content">
        {query.trim() ? <section aria-label="Settings search results"><h2>Search settings</h2><p class="help" role="status">{matches.length} {matches.length === 1 ? "category" : "categories"} for “{query.trim()}”</p>{matches.length ? matches.map((entry) => <button key={entry.id} class="settings-result" onClick={() => go(entry.id)}><Icon name={entry.icon} /><span><strong>{entry.label}</strong><span>{entry.description}</span></span><span aria-hidden="true">→</span></button>) : <div class="settings-empty"><Icon name="search" /><h3>No matching settings</h3><p>Try “SSH”, “models”, “theme” or “permissions”.</p><button class="btn" onClick={() => setQuery("")}>Clear search</button></div>}</section> : <>
          {section !== "integrations" ? <div class="settings-section-heading"><h2>{item.label}</h2><p>{item.description}</p></div> : null}
          <div key={section} class="settings-section-content">
            {section === "general" ? <GeneralSettings /> : null}
            {section === "agents" ? <AgentSettings /> : null}
            {section === "runs" ? <RunSettings /> : null}
            {section === "connections" ? <ConnectionsView purpose={group} connection={connection} /> : null}
            {section === "notifications" ? <><SettingsCard title="Desktop notifications"><SettingsRow title="Run updates" description="Notify when a run finishes or needs your attention, while you’re away from it."><button class="settings-switch" role="switch" aria-label="Desktop notifications" aria-checked={canNotify()} onClick={() => void setDesktopNotifications(!canNotify())}><span /></button></SettingsRow><p class="help">{"Notification" in window ? notificationPermission.value === "denied" ? "Notifications are blocked. Allow them in your browser’s site permissions to enable this setting." : "This preference is saved in this browser for the current workspace." : "This browser doesn’t support desktop notifications."}</p></SettingsCard><NotificationsView /></> : null}
            {section === "integrations" ? <IntegrationsScreen /> : null}
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
    <DesktopUpdatesCard />
    <MlSettingsCard />
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
    <div class="settings-callout"><Icon name="terminal" /><div><strong>Take your workspace further</strong><p>Connect a VM and keep your projects and tools on your remote machine.</p><a href="#/settings/connections/workspace">Set up an SSH connection <span aria-hidden="true">→</span></a></div></div>
  </>;
}
function AgentSettings() {
  const [busy, setBusy] = useState(false);
  const paused = executionPaused.value;
  return <>
    <PolicyPauseNotice what="Provider checks and agent runs are paused" />
    <PromptImprovementSettings />
    <AcpConnectionsPanel />
    <details class="settings"><summary>Check this computer</summary><div class="settings-body"><DependencyDiscovery /></div></details>
    <p class="help">Saved model choices apply to new runs in this workspace. A project’s remembered team, a template or a role override can choose other models for one draft without changing these. Sign in through each agent’s CLI on the machine where it runs.</p>
    <div class="settings-actions"><button class="btn" disabled={busy || providersRefreshing.value} onClick={async () => { setBusy(true); try { await refreshProviders(); } finally { setBusy(false); } }}>{busy || providersRefreshing.value ? "Checking…" : "Refresh providers"}</button><button class="btn" onClick={() => { healthOpen.value = true; }}>Health & usage</button></div>
    {healthError.value && !paused ? <p class="msg err" role="alert">{healthError.value}</p> : null}
    {agents.value.map((agent) => {
      const status = health.value?.find((item) => item.id === agent.id);
      // Paused, the server checks no CLI: say so rather than "Checking health…" and "Install this CLI".
      const policyPaused = paused || agent.unavailableReason === "filesystem-policy";
      // The doctor's warnings (such as Antigravity that can't run isolated, the default for runs) belong beside the login state.
      const checked = !policyPaused && status?.installed ? status : undefined;
      return <SettingsCard key={agent.id} title={agent.displayName}><div class="settings-provider-status"><span class={`badge ${status?.installed && status.signedIn !== false ? "ok" : ""}`}>{policyPaused ? POLICY_PAUSED : status ? !status.installed ? "Not installed" : status.signedIn === false ? "Signed out" : status.signedIn ? "Signed in" : "Installed · login unknown" : healthError.value ? "Health unavailable" : "Checking health…"}</span>{checked && unrestrictedOnly(checked) ? <span class="badge warn">Unrestricted only</span> : null}<span class="help">{status?.version}</span></div>{agent.available ? <ModelRow agent={agent} used /> : policyPaused ? <p class="help">Models can be configured again once no project restricts file access.</p> : <p class="help">Install this CLI on the current machine to configure its models.</p>}{checked?.warnings?.map((warning) => <p class="msg warn" key={warning}>{warning}</p>)}{status?.fix ? <p class="msg warn">{status.fix}</p> : null}</SettingsCard>;
    })}
  </>;
}
function NumberSetting({ label, value, min = 1, max, step = 1, optional = false, save }: { label: string; value?: number; min?: number; max?: number; step?: number; optional?: boolean; save: (value: number | undefined) => void }) {
  const [draft, setDraft] = useState(value === undefined ? "" : String(value));
  useEffect(() => setDraft(value === undefined ? "" : String(value)), [value]);
  return <label>{label}<input class="field" type="number" min={min} max={max} step={step} required={!optional} placeholder={optional ? "No ceiling" : undefined} value={draft} onInput={(e) => setDraft(e.currentTarget.value)} onBlur={(e) => {
    if (e.currentTarget.validity.valid && (draft || optional)) save(draft ? Number(draft) : undefined);
    else { setDraft(value === undefined ? "" : String(value)); showError(`Enter a valid value for ${label.toLowerCase()}`); }
  }} /></label>;
}
function RunSettings() {
  // Until you save limits here, a repository's .codeflow/config.json supplies its own.
  const savedLimits: Limits = limitPreference.value ?? DEFAULT_EXECUTION_BUDGET;
  const workflow = defaultPattern.value;
  const remembering = projects.value.filter((project) => project.defaults && patterns.value.some((pattern) => pattern.id === project.defaults!.pattern));
  return <>
    <p class="help">These are the composer’s remembered choices for this browser and workspace. Changes also update your current draft; running work keeps its existing settings.</p>
    <SettingsCard title="Workflow">
      <SettingsRow title="Default workflow" description="The team pattern a new task starts with, in projects that don’t remember a team of their own."><select class="field" aria-label="Default workflow" aria-describedby={remembering.length ? "default-workflow-projects" : undefined} value={workflow} onChange={(e) => setPattern(e.currentTarget.value)}>{patterns.value.map((pattern) => <option key={pattern.id} value={pattern.id}>{pattern.name}</option>)}</select></SettingsRow>
      {remembering.length ? <p class="help" id="default-workflow-projects">A project remembers the workflow and team of the last run started from its composer, and its new drafts start from that instead: {remembering.slice(0, 5).map((project) => `${project.name} (${patterns.value.find((pattern) => pattern.id === project.defaults!.pattern)!.name})`).join(", ")}{remembering.length > 5 ? ` and ${remembering.length - 5} more` : ""}.</p> : null}
      {CHECKPOINTS[workflow] ? <SettingsRow title="Approve before building" description={`Pause so you can review ${CHECKPOINTS[workflow]}. This choice is remembered per workflow.`}><button class="settings-switch" role="switch" aria-label="Approve before building" aria-checked={planApprovalFor(workflow)} onClick={() => setApprovePlan(!planApprovalFor(workflow), workflow)}><span /></button></SettingsRow> : null}
    </SettingsCard>
    <SettingsCard title="Agent permissions">
      <label class="sr-only" for="settings-trust">Agent permissions</label><select class="field" id="settings-trust" value={trust.value} onChange={(e) => setTrust(e.currentTarget.value as Trust)}>{(Object.keys(TRUST) as Trust[]).map((value) => <option key={value} value={value}>{TRUST[value].label}</option>)}</select>
      <p class={trust.value === "full" ? "full-warn" : "help"}>{TRUST[trust.value].help}</p>
    </SettingsCard>
    <SettingsCard title="Run limits"><p class="help">Stop when a limit is reached. Changes save when you leave a field.</p><div class="settings-grid">
      <NumberSetting label="Minutes per run" value={savedLimits.maxMinutes} max={720} save={(value) => setLimits({ maxMinutes: value! })} />
      <NumberSetting label="Agent steps per run" value={savedLimits.maxSteps} max={200} save={(value) => setLimits({ maxSteps: value! })} />
      <NumberSetting label="Reported token ceiling" value={savedLimits.maxTokens} optional save={(value) => setLimits({ maxTokens: value })} />
      <NumberSetting label="API-equivalent cost ceiling ($)" value={savedLimits.maxCostUsd} optional min={0.01} step={0.01} save={(value) => setLimits({ maxCostUsd: value })} />
    </div><p class="help">Usage ceilings depend on provider reports and are checked between operations. API-equivalent cost is not your subscription bill.</p></SettingsCard>
    <p class="help">Repository setup, checks, branch names, team roles and per-run isolation are available in <a href="#/">New run → Advanced agent settings</a>.</p>
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
    <SettingsCard title="Diagnostics"><p class="help">Collect versions, connection health, resource queues and recent logs for the current machine. Credential-like values are redacted before export.</p><div class="settings-actions"><button class="btn" disabled={busy} onClick={async () => { setBusy(true); setError(""); setDiagnostics(undefined); try { setDiagnostics({ ...await api(`/api/diagnostics${repo.value ? `?repo=${enc(repo.value)}` : ""}`), browserPerformance: browserPerformance(), runtime: await api("/api/health") }); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } }}>{busy ? "Collecting…" : "Collect diagnostics"}</button>{diagnostics ? <button class="btn" onClick={() => downloadArtifact("codeflow-diagnostics.json", JSON.stringify(diagnostics, null, 2))}>Export diagnostics</button> : null}</div>{diagnostics ? <details><summary>Collected diagnostics</summary><pre>{JSON.stringify(diagnostics, null, 2)}</pre></details> : null}{error ? <p role="alert" class="msg err">{error}</p> : null}</SettingsCard>
    <SettingsCard title="Server configuration"><p class="help">Process settings such as the server port, data directory, concurrency, CLI paths and integration credentials are configured through environment variables when starting code-flow. Changes require a server restart.</p><p class="help">Repository defaults live in <code>.codeflow/config.json</code>. Browser preferences are separate for each SSH workspace.</p><a href="https://github.com/midhunxavier/code-flow/blob/main/docs/configuration.md" target="_blank" rel="noreferrer">Configuration reference ↗</a></SettingsCard>
  </>;
}
