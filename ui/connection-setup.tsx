import { useState } from "preact/hooks";
import { useDialog } from "./app.js";
import { post } from "./lib.js";
import { projects } from "./state.js";
import type { ConnectionProvider, ConnectionSummary, ConnectionDraft } from "../src/integration-connections.js";

export const SERVICE_NAMES: Record<ConnectionProvider, string> = { github: "GitHub", gitlab: "GitLab", bitbucket: "Bitbucket", linear: "Linear", jira: "Jira", slack: "Slack", webhook: "Webhooks" };
export const SERVICE_ACTIONS: Record<ConnectionProvider, string> = { github: "Issues, pull requests, CI logs and publishing", gitlab: "Issues, merge requests and publishing", bitbucket: "Issues, pull requests and publishing", linear: "Issues to agent tasks", jira: "Issues to agent tasks", slack: "Selected project updates", webhook: "Selected project updates to your HTTPS endpoint" };
const DEFAULT_AUTH = { gitlab: "private-token", bitbucket: "bearer", linear: "api-key", jira: "basic" } as const;

export function ConnectionSetup({ provider, existing, projectId, repository, suggestion, close, connected }: {
  provider: ConnectionProvider; existing?: ConnectionSummary; projectId?: string; repository?: string;
  suggestion?: { provider?: string; scope: string; host: string }; close: () => void; connected: () => Promise<void>;
}) {
  const dialog = useDialog(true, close);
  const notification = provider === "slack" || provider === "webhook";
  const [step, setStep] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [project, setProject] = useState(projectId ?? ""), [repo, setRepo] = useState(repository ?? existing?.repository ?? "");
  const [draft, setDraft] = useState<ConnectionDraft>({ id: existing?.id, provider, name: existing?.name ?? SERVICE_NAMES[provider], scope: existing?.scope ?? (suggestion?.provider === provider ? suggestion.scope : ""), baseUrl: existing?.baseUrl ?? (provider === "gitlab" && suggestion?.provider === provider && suggestion.host !== "gitlab.com" ? `https://${suggestion.host}/api/v4/` : ""), gitBaseUrl: existing?.gitBaseUrl ?? "", auth: (existing?.auth as ConnectionDraft["auth"]) ?? DEFAULT_AUTH[provider as keyof typeof DEFAULT_AUTH] });
  const [test, setTest] = useState<{ testId: string; message: string }>();
  const field = (name: keyof ConnectionDraft, value: string) => { setDraft(current => ({ ...current, [name]: value })); setTest(undefined); };
  const selectedProject = projects.value.find(p => p.id === project);
  const testConnection = async () => {
    setBusy(true); setError("");
    try { setTest(await post("/api/integration-connections/test", { ...draft, projectId: project || undefined, repository: repo || undefined, scope: provider === "github" ? draft.scope || "GitHub repository" : draft.scope })); setStep(2); }
    catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  };
  const connect = async () => {
    if (!test) return; setBusy(true); setError("");
    try { await post("/api/integration-connections/connect", { testId: test.testId, ...(project ? { projectId: project, repository: repo } : {}) }); setDraft({ provider }); await connected(); close(); }
    catch (error) { setError((error as Error).message); setStep(1); setTest(undefined); } finally { setBusy(false); }
  };
  return <dialog class="picker connection-dialog" ref={dialog} aria-labelledby="connection-setup-title"><div class="picker-inner">
    <div class="picker-head"><h3 id="connection-setup-title">{existing ? "Reconnect" : "Connect"} {SERVICE_NAMES[provider]}</h3><p class="help">{["1. Authenticate", "2. Choose repository or workspace", "3. Test and connect"][step]}</p></div>
    <div class="dialog-body connection-fields">
      {step === 0 ? <>
        {provider === "github" ? <p>Use your existing GitHub CLI login on this computer. If needed, run <code>gh auth login</code> once, then continue here.</p> : notification ? <>
          <label>{provider === "slack" ? "Slack incoming webhook URL" : "Webhook URL"}<input class="field" type="password" autoComplete="off" value={draft.url ?? ""} placeholder={existing ? "Leave empty to keep the saved URL" : "https://…"} onInput={e => field("url", e.currentTarget.value)} /></label>
          {provider === "webhook" ? <label>Bearer token (optional)<input class="field" type="password" autoComplete="off" value={draft.credential ?? ""} onInput={e => field("credential", e.currentTarget.value)} /></label> : null}
        </> : <>
          <label>Authentication<select class="field" value={draft.auth} onChange={e => field("auth", e.currentTarget.value)}><option value="bearer">Bearer token / OAuth access token</option><option value="private-token">Private token</option><option value="api-key">API key</option><option value="basic">Username and API token</option></select></label>
          {draft.auth === "basic" ? <label>Username or email<input class="field" autoComplete="off" value={draft.username ?? ""} placeholder={existing ? "Leave empty to keep saved username" : ""} onInput={e => field("username", e.currentTarget.value)} /></label> : null}
          <label>{provider === "linear" ? "API key or access token" : "Access token"}<input class="field" type="password" autoComplete="off" value={draft.credential ?? ""} placeholder={existing ? "Leave empty to keep the saved token" : ""} onInput={e => field("credential", e.currentTarget.value)} /></label>
          <p class="help">Use credentials that can read the repository or workspace you want. Publishing later requires the corresponding write permission.</p>
        </>}
        <p class="help">{provider === "github" ? "GitHub authentication stays with gh on this computer. Code Flow does not copy its token into the connection store." : "Credentials stay encrypted on this server. Saved secrets are never returned to the browser or added to agent environments."} Coding-agent logins are managed under Agents.</p>
      </> : step === 1 ? <>
        <label>Connection name<input class="field" maxLength={80} value={draft.name ?? ""} onInput={e => field("name", e.currentTarget.value)} /></label>
        {!projectId ? <label>Project<select class="field" value={project} onChange={e => { setProject(e.currentTarget.value); setRepo(projects.value.find(p => p.id === e.currentTarget.value)?.repos[0] ?? ""); }}><option value="">{provider === "github" ? "Choose a project" : "Connect without assigning a project"}</option>{projects.value.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label> : <p>Project: <b>{selectedProject?.name}</b></p>}
        {selectedProject ? <label>Local repository<select class="field" value={repo} onChange={e => setRepo(e.currentTarget.value)}><option value="" disabled>Choose a repository</option>{selectedProject.repos.map(repository => <option key={repository} value={repository}>{repository.split("/").pop()}</option>)}</select></label> : null}
        {!notification && provider !== "github" ? <label>{provider === "linear" ? "Linear team key or ID" : provider === "jira" ? "Jira project key" : "Repository on the service"}<input class="field" value={draft.scope ?? ""} placeholder={provider === "gitlab" ? "group/repository" : provider === "bitbucket" ? "workspace/repository" : "ENG"} onInput={e => field("scope", e.currentTarget.value)} /></label> : null}
        {provider === "jira" ? <label>Jira site URL<input class="field" type="url" value={draft.baseUrl ?? ""} placeholder="https://your-team.atlassian.net/" onInput={e => field("baseUrl", e.currentTarget.value)} /></label> : null}
        {!notification && provider !== "github" ? <details><summary>Advanced connection options</summary>{provider !== "jira" ? <label>API base URL (optional)<input class="field" type="url" value={draft.baseUrl ?? ""} placeholder="Use the service default" onInput={e => field("baseUrl", e.currentTarget.value)} /></label> : null}{provider === "gitlab" || provider === "bitbucket" ? <label>HTTPS Git root (optional)<input class="field" type="url" value={draft.gitBaseUrl ?? ""} placeholder="Use the service default" onInput={e => field("gitBaseUrl", e.currentTarget.value)} /></label> : null}</details> : null}
      </> : <><p class="msg ok" role="status">{test?.message}</p><p><b>{draft.name}</b>{draft.scope ? ` · ${draft.scope}` : ""}</p><p>{selectedProject ? `Connect to ${selectedProject.name} · ${repo.split("/").pop()}.` : "This connection can be added to a project later."}</p>{notification ? <p>Notifications start off. Choose projects and events before enabling delivery.</p> : null}</>}
      {error ? <p class="msg err" role="alert">{error}</p> : null}
    </div>
    <div class="picker-foot"><button class="btn" disabled={busy} onClick={close}>Cancel</button>{step > 0 ? <button class="btn" disabled={busy} onClick={() => { setStep(step - 1); setTest(undefined); setError(""); }}>Back</button> : null}
      {step === 0 ? <button class="btn primary" onClick={() => setStep(1)}>Continue</button> : step === 1 ? <button class="btn primary" disabled={busy || !!project && !repo || provider === "github" && !project} onClick={() => void testConnection()}>{busy ? "Testing…" : "Test connection"}</button> : <button class="btn primary" disabled={busy || !test} onClick={() => void connect()}>{busy ? "Connecting…" : existing ? "Reconnect" : "Connect"}</button>}
    </div>
  </div></dialog>;
}
