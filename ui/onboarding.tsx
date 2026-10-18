import { useEffect, useRef, useState } from "preact/hooks";
import { useDialog } from "./app.js";
import { post, showToast, store } from "./lib.js";
import { acceptanceCriteria, agentSettings, baseRef, catalogs, checkCmd, checkHint, composerOrigins, configChecking, contextPaths, attachments, gitHealth, health, healthOpen, limits, optionsFor, patterns, planApprovalFor, repo, repoConfig, roleModels, rolesFor, setAcceptanceCriteria, setAgentSetting, setApprovePlan, setLimits, setOption, setPattern, setRoleModel, setRoles, setTask, setTrust, setupCmd, target, task, trust } from "./state.js";
import { fillTemplate, parseComposerLibrary, taskWithCriteria, templateParameters, type ComposerLibrary, type PresetConfig, type TaskTemplate } from "./composer-tools.js";
import type { AgentId, PatternInfo } from "./types.js";
import type { VerificationProfile } from "../src/verification.js";
import { DependencyDiscovery } from "./dependency-health.js";
import { ContextBudgetControls } from "./context-budget-controls.js";
import { contextBudget, contextBudgetOrigin, setContextBudget } from "./context-budget.js";
import type { ContextInspection } from "../src/context-inspection.js";

const EMPTY_LIBRARY: ComposerLibrary = { schemaVersion: 1, presets: [], templates: [] };

export function FirstRunGuide() {
  const [dismissed, setDismissed] = useState(store.get("onboardingDismissed") === "1");
  if (dismissed) return null;
  const providers = health.value?.filter((h) => h.installed && h.signedIn !== false && h.compatible !== false) ?? [];
  return <details class="settings first-run">
    <summary><span class="st">Getting started</span><span class="ss">{repo.value ? "Repository selected" : "Choose a repository"} · {health.value ? `${providers.length} available provider${providers.length === 1 ? "" : "s"}` : "Checking providers…"}</span></summary>
    <div class="settings-body"><ol><li>Choose the Git repository to work in.</li><li>Check that Git and at least one provider are installed, compatible, and signed in.</li><li>Describe the change and choose a verification command. Inspect readiness before the first run.</li></ol>
      <p class="help">Git: {gitHealth.value ? gitHealth.value.ok ? "ready" : gitHealth.value.warning || "needs attention" : "checking…"}. Provider authentication can only be reported when the CLI exposes it.</p>
      <div class="onboarding-actions"><button class="btn" onClick={() => (healthOpen.value = true)}>Check provider and Git health</button><button class="btn ghost" onClick={() => { store.set("onboardingDismissed", "1"); setDismissed(true); }}>Dismiss guide</button></div>
      <DependencyDiscovery />
    </div>
  </details>;
}

export function AcceptanceEditor() {
  return <details class="settings acceptance-editor">
    <summary><span class="st">Acceptance criteria</span><span class="ss">{acceptanceCriteria.value.filter((c) => c.trim()).length || "Optional"} · explicit requirements for the team</span></summary>
    <div class="settings-body"><label class="lbl" for="acceptance-criteria">One requirement per line</label>
      <textarea id="acceptance-criteria" class="field" rows={4} placeholder="The new behavior has automated tests.&#10;Existing API clients continue to work." value={acceptanceCriteria.value.join("\n")} onInput={(e) => setAcceptanceCriteria(e.currentTarget.value.split("\n"))} />
      <p class="help">These requirements are included in the run's task and in saved automations. Review them before starting.</p>
    </div>
  </details>;
}

export interface ReadinessReport { ok: boolean; checkedAt?: number; items: Array<{ id: string; label: string; status: "passed" | "failed" | "warning" | "skipped"; detail?: string }> }
export function RepositoryReadiness() {
  const [report, setReport] = useState<ReadinessReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [validated, setValidated] = useState(false);
  const key = JSON.stringify([repo.value, baseRef.value, setupCmd.value, checkCmd.value]);
  const selected = useRef(key);
  selected.current = key;
  const requests = useRef(0);
  useEffect(() => { ++requests.current; setBusy(false); setReport(null); setError(""); setValidated(false); }, [key]);
  const inspect = async (execute: boolean) => {
    const request = ++requests.current;
    const selection = key;
    setBusy(true); setError(""); setReport(null);
    try {
      const result = await post<ReadinessReport>("/api/readiness", { repo: repo.value, baseRef: baseRef.value, setup: setupCmd.value, check: checkCmd.value, execute });
      if (request !== requests.current || selected.current !== selection) return;
      setReport(result); setValidated(execute);
    } catch (err) {
      if (request === requests.current && selected.current === selection) setError((err as Error).message);
    } finally { if (request === requests.current && selected.current === selection) setBusy(false); }
  };
  return <details class="settings readiness">
    <summary><span class="st">Repository readiness</span><span class="ss">{busy ? "Checking…" : report ? `${validated ? "Commands validated" : "Inspection complete"} · ${report.ok ? "ready" : "needs attention"}` : "Check the repository and provider setup"}</span></summary>
    <div class="settings-body"><p class="help">Inspect readiness checks configuration and installed tools. Validate commands runs setup and checks in a temporary worktree; this executes repository code.</p>
      <div class="onboarding-actions"><button class="btn" disabled={!repo.value || busy || configChecking.value} onClick={() => inspect(false)}>Inspect readiness</button><button class="btn" disabled={!repo.value || busy || configChecking.value || (!setupCmd.value.trim() && !checkCmd.value.trim())} onClick={() => inspect(true)}>Validate commands</button></div>
      {busy ? <p role="status">Checking repository readiness…</p> : null}
      {error ? <p class="msg err" role="alert">{error}</p> : null}
      {report ? <ul class="readiness-results">{report.items.map((item) => <li key={item.id}><span class={`badge ${item.status === "passed" ? "ok" : ""}`}>{item.status}</span><span><b>{item.label}</b>{item.detail ? <span class="help">{item.detail}</span> : null}</span></li>)}</ul> : null}
    </div>
  </details>;
}

function currentConfig(p: PatternInfo): PresetConfig {
  return structuredClone({ pattern: p.id, roles: rolesFor(p), options: optionsFor(p), agentSettings: agentSettings.value, roleSettings: roleModels.value[p.id] ?? {}, trust: trust.value, limits: limits.value, approvePlan: planApprovalFor(p.id), toolApprovals: store.get("interactiveApprovals") === "1", contextBudget: contextBudget.value });
}
function applyPreset(config: PresetConfig, label: string) {
  const p = patterns.value.find((p) => p.id === config.pattern);
  if (!p) throw new Error("This workflow is no longer available.");
  setPattern(config.pattern);
  for (const role of p.roles) setRoles(p.id, role.id, config.roles[role.id] ?? []);
  for (const option of p.options) setOption(p, option.id, config.options[option.id] ?? option.default);
  agentSettings.value = {};
  store.set("agentSettings", "{}");
  roleModels.value = { ...roleModels.value, [p.id]: {} };
  store.set("roleModels", JSON.stringify(roleModels.value));
  for (const [id, setting] of Object.entries(config.agentSettings)) setAgentSetting(id as AgentId, setting!);
  for (const [role, providers] of Object.entries(config.roleSettings)) for (const [id, setting] of Object.entries(providers)) setRoleModel(p.id, role, id as AgentId, setting!);
  setTrust(config.trust); setLimits({ ...config.limits, maxTokens: config.limits.maxTokens, maxCostUsd: config.limits.maxCostUsd }); setApprovePlan(config.approvePlan, p.id);
  setContextBudget(config.contextBudget, label);
  store.set("interactiveApprovals", config.toolApprovals ? "1" : "0");
  composerOrigins.value = { ...composerOrigins.value, pattern: label, roles: label, models: label };
}

/** Personal, versioned workflow presets and task templates. Exported files are validated before use. */
export function ComposerLibraryEditor({ p, onToolApprovalsChange }: { p: PatternInfo; onToolApprovalsChange?: (value: boolean) => void }) {
  const [initial] = useState(() => {
    try { return { library: parseComposerLibrary(store.json("composerLibrary", EMPTY_LIBRARY), patterns.value), error: "" }; }
    catch (err) { return { library: structuredClone(EMPTY_LIBRARY), error: `Saved library could not be loaded: ${(err as Error).message}. Import a valid backup to recover it.` }; }
  });
  const [library, setLibrary] = useState(initial.library);
  const libraryRef = useRef(library);
  libraryRef.current = library;
  const [error, setError] = useState(initial.error);
  const [presetId, setPresetId] = useState("");
  const [presetName, setPresetName] = useState("");
  const [revision, setRevision] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [filling, setFilling] = useState<TaskTemplate | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const selected = library.presets.find((item) => item.id === presetId);
  const save = (value: ComposerLibrary) => {
    try { const clean = parseComposerLibrary(value, patterns.value); localStorage.setItem("composerLibrary", JSON.stringify(clean)); libraryRef.current = clean; setLibrary(clean); setError(""); return true; }
    catch (err) { setError((err as Error).message); return false; }
  };
  const savePreset = () => {
    const previous = selected;
    const id = previous?.id ?? crypto.randomUUID();
    const updated = { id, name: presetName.trim(), revision: (previous?.revision ?? 0) + 1, updatedAt: Date.now(), config: currentConfig(p), history: previous ? [...previous.history, { revision: previous.revision, updatedAt: previous.updatedAt, config: previous.config }].slice(-10) : [] };
    if (save({ ...library, presets: [...library.presets.filter((item) => item.id !== id), updated] })) { setPresetId(id); setRevision(""); showToast(`Saved ${updated.name}, revision ${updated.revision}`); }
  };
  const useTemplate = (template: TaskTemplate, values: Record<string, string>) => {
    const filled = fillTemplate(template, values);
    setPattern(template.pattern); setTask(filled.task); setAcceptanceCriteria(filled.criteria); setFilling(null);
  };
  const exportLibrary = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(library, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "code-flow-library.json"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <details class="settings composer-library">
    <summary><span class="st">Saved teams and task templates</span><span class="ss">{library.presets.length} teams · {library.templates.length} templates</span></summary>
    <div class="settings-body">
      <p class="help">Saved in this browser. Export a backup to share or move them. Teams include permissions, models, workflow options and limits; repository commands remain repository-specific.</p>
      <div class="settings-grid"><div><label class="lbl" for="saved-preset">Team preset</label><select class="field" id="saved-preset" value={presetId} onChange={(e) => { const item = library.presets.find((p) => p.id === e.currentTarget.value); setPresetId(item?.id ?? ""); setPresetName(item?.name ?? ""); setRevision(""); }}><option value="">New team preset…</option>{library.presets.map((item) => <option value={item.id} key={item.id}>{item.name} · r{item.revision}</option>)}</select></div>
        <div><label class="lbl" for="preset-name">Team name</label><input id="preset-name" class="field" maxLength={80} value={presetName} onInput={(e) => setPresetName(e.currentTarget.value)} /></div></div>
      {selected ? <div><label class="lbl" for="preset-revision">Revision to apply</label><select id="preset-revision" class="field" value={revision} onChange={(e) => setRevision(e.currentTarget.value)}><option value="">Current · r{selected.revision}</option>{[...selected.history].reverse().map((h) => <option value={h.revision} key={h.revision}>r{h.revision} · {new Date(h.updatedAt).toLocaleString()}</option>)}</select><p class="help">Permissions: {(revision ? selected.history.find((h) => String(h.revision) === revision)?.config : selected.config)?.trust}. Up to 10 previous revisions are kept.</p></div> : null}
      <div class="onboarding-actions"><button class="btn" disabled={!presetName.trim()} onClick={savePreset}>{selected ? "Save new revision" : "Save current team"}</button><button class="btn" disabled={!selected} onClick={() => { if (selected) { const config = revision ? selected.history.find((h) => String(h.revision) === revision)!.config : selected.config; applyPreset(config, `Preset ${selected.name} r${revision || selected.revision}`); onToolApprovalsChange?.(config.toolApprovals === true); } }}>Apply team</button>{selected ? <button class="btn ghost" onClick={() => { if (save({ ...library, presets: library.presets.filter((item) => item.id !== presetId) })) { setPresetId(""); setPresetName(""); } }}>Delete team</button> : null}</div>
      <div class="settings-grid"><div><label class="lbl" for="saved-template">Task template</label><select class="field" id="saved-template" value={templateId} onChange={(e) => { const item = library.templates.find((t) => t.id === e.currentTarget.value); setTemplateId(item?.id ?? ""); setTemplateName(item?.name ?? ""); }}><option value="">New task template…</option>{library.templates.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></div><div><label class="lbl" for="template-name">Template name</label><input class="field" id="template-name" maxLength={80} value={templateName} onInput={(e) => setTemplateName(e.currentTarget.value)} /></div></div>
      <p class="help">Save the current task, workflow and acceptance criteria. Write parameters such as <code>{"{{component}}"}</code> or <code>{"{{issue}}"}</code> in the task or criteria; you'll be asked to fill each one when applying.</p>
      <div class="onboarding-actions"><button class="btn" disabled={!templateName.trim() || !task.value.trim()} onClick={() => { const id = templateId || crypto.randomUUID(); if (save({ ...library, templates: [...library.templates.filter((item) => item.id !== id), { id, name: templateName, pattern: p.id, task: task.value, criteria: acceptanceCriteria.value }] })) setTemplateId(id); }}>Save current task as template</button><button class="btn" disabled={!templateId} onClick={() => { const template = library.templates.find((t) => t.id === templateId)!; if (templateParameters(template).length) setFilling(template); else useTemplate(template, {}); }}>Apply template</button>{templateId ? <button class="btn ghost" onClick={() => { if (save({ ...library, templates: library.templates.filter((item) => item.id !== templateId) })) { setTemplateId(""); setTemplateName(""); } }}>Delete template</button> : null}</div>
      <div class="onboarding-actions"><button class="btn" onClick={exportLibrary}>Export library</button><button class="btn" onClick={() => file.current?.click()}>Import library</button></div>
      <input ref={file} type="file" hidden accept=".json,application/json" onChange={async (e) => { const chosen = e.currentTarget.files?.[0]; e.currentTarget.value = ""; if (!chosen) return; try { if (chosen.size > 1024 * 1024) throw new Error("Library files must be under 1 MB."); const imported = parseComposerLibrary(JSON.parse(await chosen.text()), patterns.value); const existing = libraryRef.current; const merge = <T extends { id: string }>(a: T[], b: T[]) => [...a, ...b.map((item) => a.some((old) => old.id === item.id) ? { ...item, id: crypto.randomUUID() } : item)]; if (save({ schemaVersion: 1, presets: merge(existing.presets, imported.presets), templates: merge(existing.templates, imported.templates) })) showToast("Library imported. Existing entries were preserved."); } catch (err) { setError((err as Error).message); } }} />
      {error ? <p class="msg err" role="alert">{error}</p> : null}
    </div>
    {filling ? <FillTemplateDialog template={filling} onClose={() => setFilling(null)} onApply={(values) => useTemplate(filling, values)} /> : null}
  </details>;
}

function FillTemplateDialog({ template, onClose, onApply }: { template: TaskTemplate; onClose: () => void; onApply: (values: Record<string, string>) => void }) {
  const ref = useDialog(true, onClose);
  const [values, setValues] = useState<Record<string, string>>({});
  const names = templateParameters(template);
  let preview = "";
  try { const filled = fillTemplate(template, values); preview = taskWithCriteria(filled.task, filled.criteria); } catch { /* incomplete parameters */ }
  return <dialog class="picker" ref={ref} aria-labelledby="fill-template-title"><div class="picker-inner"><div class="picker-head"><h3 id="fill-template-title">Apply {template.name}</h3></div><div class="dialog-body">{names.map((name) => <div key={name}><label class="lbl" for={`parameter-${name}`}>{name}</label><input class="field" id={`parameter-${name}`} value={values[name] ?? ""} maxLength={4000} onInput={(e) => setValues({ ...values, [name]: e.currentTarget.value })} /></div>)}{preview ? <details><summary>Preview task</summary><pre class="template-preview">{preview}</pre></details> : null}</div><div class="picker-foot"><span class="ps" /><button class="btn" onClick={onClose}>Cancel</button><button class="btn primary" disabled={!preview} onClick={() => onApply(values)}>Use template</button></div></div></dialog>;
}

export function EffectiveSettings({ p, verificationProfile, container }: { p: PatternInfo; verificationProfile?: VerificationProfile | null; container?: { enabled: boolean; image: string; authVolume: string } }) {
  const r = repo.value;
  const config = repoConfig.value?.config ?? {};
  const rememberedCheck = r ? store.get(`check:${r}`) : null;
  const rememberedSetup = r ? store.get(`setup:${r}`) : null;
  const rows: Array<[string, string, string]> = [
    ["Repository", r || "Not chosen", "Repository picker"],
    ["Project", target.value.project?.name ?? "Created from repository on start", "Project selection / repository membership"],
    ["Workflow", p.name, composerOrigins.value.pattern ?? "Workflow default"],
    ["Team", Object.entries(rolesFor(p)).map(([role, ids]) => `${role}: ${ids.join(", ") || "skipped"}`).join(" · "), composerOrigins.value.roles ?? "Workflow defaults"],
    ["Verification command", checkCmd.value || "No automated command", rememberedCheck !== null ? "Repository preference (this browser)" : config.check ? ".codeflow/config.json" : checkHint.value || "Not configured"],
    ["Worktree setup", setupCmd.value || "None", rememberedSetup !== null ? "Repository preference (this browser)" : config.setup ? ".codeflow/config.json" : setupCmd.value ? "Repository detection" : "Not configured"],
    ["Permissions", trust.value, store.get("trust") !== null ? "Explicit browser preference" : config.trust ? ".codeflow/config.json" : "Application default"],
    ["Plan approval", planApprovalFor(p.id) ? "Required" : "Automatic", "Per-workflow browser preference / workflow default"],
    ["Tool permissions", store.get("interactiveApprovals") === "1" ? "Ask for supported native requests" : "Decline requests requiring interaction", store.get("interactiveApprovals") !== null ? "Explicit browser preference / selected preset" : "Application default"],
    ["Verification gates", verificationProfile ? `${verificationProfile.name}: ${verificationProfile.checks.map((check) => `${check.id} (${check.required ? "required" : "optional"}) · ${check.command}`).join("; ") || "No runnable gates"}` : "Single configured check", verificationProfile ? `Detected profile${verificationProfile.source ? ` from ${verificationProfile.source}` : ""}; selected for this run` : "Verification command above"],
    ["Agent container", container?.enabled ? `${container.image || "Image not configured"}${container.authVolume ? ` · authentication volume ${container.authVolume}` : " · no authentication volume"}` : "Host CLI execution", container?.enabled ? "Explicit choice for this run; network enabled" : "Application default"],
    ["Start branch", baseRef.value || "Current HEAD", baseRef.value ? "Selected branch (remembered)" : "Repository HEAD"],
    ["Limits", `${limits.value.maxMinutes} minutes · ${limits.value.maxSteps} steps${limits.value.maxTokens ? ` · ${limits.value.maxTokens.toLocaleString()} reported tokens` : ""}${limits.value.maxCostUsd ? ` · $${limits.value.maxCostUsd} reported API equivalent` : ""}`, store.get("limits") ? "Browser preferences / selected preset" : "Application defaults"],
    ["Explicit input context budget", contextBudget.value ? `${contextBudget.value.maxPromptBytes ?? "No"} byte ceiling · ${contextBudget.value.maxApproximateTokens ?? "no"} estimated token ceiling · ${contextBudget.value.policy}` : "No configured ceiling", contextBudgetOrigin.value],
  ];
  for (const [role, ids] of Object.entries(rolesFor(p))) for (const id of ids) {
    if (id === "auto") { rows.push([`${role} model`, "Selected at dispatch from available providers", "Auto selection"]); continue; }
    const overrides = roleModels.value[p.id]?.[role]?.[id];
    const base = agentSettings.value[id];
    const catalog = catalogs.value[id];
    const model = overrides?.model || base?.model || (catalog && !("error" in catalog) ? catalog.defaultModel : undefined);
    const effort = overrides?.effort || base?.effort || (catalog && !("error" in catalog) ? catalog.models.find((m) => m.id === model)?.defaultEffort || catalog.defaultEffort : undefined);
    rows.push([`${role} · ${id}`, `${model || "CLI default"} · ${effort || "default effort"}`, overrides?.model || overrides?.effort ? "Per-role override" : base?.model || base?.effort ? composerOrigins.value.models ?? "Provider settings" : "CLI defaults"]);
  }
  return <details class="settings effective-settings"><summary><span class="st">Effective settings</span><span class="ss">Values and where they came from</span></summary><div class="settings-body"><div class="settings-table-scroll"><table><thead><tr><th>Setting</th><th>Value</th><th>Source</th></tr></thead><tbody>{rows.map(([label, value, source], i) => <tr key={`${label}-${i}`}><th scope="row">{label}</th><td>{value}</td><td>{source}</td></tr>)}</tbody></table></div></div></details>;
}

export function ContextInspector() {
  const paths = [...contextPaths.value.values()];
  const uploads = attachments.value;
  const [report, setReport] = useState<ContextInspection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selected = JSON.stringify([repo.value, baseRef.value, paths, uploads.map(({ name, size }) => ({ name, size }))]);
  const latest = useRef(selected); latest.current = selected;
  const request = useRef(0);
  useEffect(() => { ++request.current; setReport(null); setBusy(false); setError(""); }, [selected]);
  const inspect = async () => {
    const generation = ++request.current;
    setBusy(true); setError("");
    try {
      const result = await post<ContextInspection>("/api/workspace/context", { repo: repo.value, baseRef: baseRef.value || undefined, paths: paths.map((path) => path.path), attachments: uploads.map(({ name, size }) => ({ name, size })) });
      if (generation === request.current && selected === latest.current) setReport(result);
    } catch (err) { if (generation === request.current && selected === latest.current) setError((err as Error).message); }
    finally { if (generation === request.current && selected === latest.current) setBusy(false); }
  };
  return <details class="settings context-inspector"><summary><span class="st">Context inspector</span><span class="ss">{paths.length} repository paths · {uploads.length} attachments</span></summary><div class="settings-body"><p class="help">Preview selected files and expand folders from the chosen committed base. Explicit files show your current copy. Credential paths and symbolic selections are refused during actual context preparation; preview redaction does not remove secrets from other repository files.</p>
    <ul>{paths.map((item) => <li key={item.path}><code>{item.path}{item.type === "dir" ? "/" : ""}</code> · selected repository path</li>)}{uploads.map((attachment, index) => <li key={index}>{attachment.name} · {attachment.size.toLocaleString()} bytes · uploaded file</li>)}</ul>{!paths.length && !uploads.length ? <p class="help">No explicit context selected. Agents can inspect their worktree.</p> : null}
    <button class="btn" disabled={!repo.value || !paths.length && !uploads.length || busy} onClick={inspect}>{busy ? "Reading context…" : "Preview selected context"}</button>
    {report ? <div class="context-inspection-results"><p class="help">{report.fileBytes.toLocaleString()} inspected text bytes · {report.omittedBytes.toLocaleString()} known omitted-file bytes · {report.attachmentBytes.toLocaleString()} attachment bytes · approximately {report.approximateTokens.toLocaleString()} known text tokens. {report.note}</p>{report.truncated ? <p class="msg warn">Inspection reached its file or byte limit. Narrow the selection to review the remaining context.</p> : null}
      {report.files.map((file, index) => <details key={`${file.path}-${index}`}><summary>{file.path} · {file.source === "base-ref" ? "committed base" : "current copy"}{file.truncated ? " · preview truncated" : ""}</summary>{file.omitted ? <p class="help">{file.bytes !== undefined ? `${file.bytes.toLocaleString()} known bytes · ` : ""}{file.omitted}</p> : <><p class="help">{file.bytes?.toLocaleString()} bytes · approximately {file.approximateTokens?.toLocaleString()} tokens{file.redacted ? " · possible secret material redacted in this preview only" : ""}</p><pre class="template-preview">{file.preview}</pre></>}</details>)}
      {report.attachments.map((attachment, index) => <p class="help" key={index}>{attachment.name}: {attachment.bytes.toLocaleString()} bytes · {attachment.omitted ?? (attachment.approximateTokens === undefined ? "token footprint unknown (image, binary or unrecognized format)" : `approximately ${attachment.approximateTokens.toLocaleString()} text tokens from byte size`)}</p>)}
    </div> : null}{error ? <p class="msg err" role="alert">{error}</p> : null}<ContextBudgetControls />
  </div></details>;
}
