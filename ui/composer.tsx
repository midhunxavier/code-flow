import { useEffect, useRef, useState } from "preact/hooks";
import { AgentTag } from "./bits.js";
import { api, enc, fmtSize, FLOWS, post, readBase64, SHORT, store } from "./lib.js";
import {
  agents,
  agentSettings,
  approvePlan,
  CHECKPOINTS,
  setApprovePlan,
  attachments,
  baseRef,
  branchPrefix,
  catalogs,
  checkCmd,
  checkHint,
  contextError,
  contextPaths,
  filesOpen,
  limits,
  optionsFor,
  pattern,
  patterns,
  pickerOpen,
  refreshRuns,
  repo,
  repoError,
  repoInfo,
  rolesFor,
  route,
  setAgentSetting,
  setCheck,
  setLimits,
  setOption,
  setPattern,
  setRoles,
  setSetup,
  setTask,
  setupCmd,
  task,
} from "./state.js";
import type { AgentId, AgentInfo, ContextItem, ModelCatalog, PatternInfo, TreeEntry } from "./types.js";

const DRAG_TYPE = "application/x-codeflow-path";
const MAX_FILE = 10 * 1024 * 1024;
const MAX_TOTAL = 25 * 1024 * 1024;
const fileIcon = (type: string) => (type === "dir" ? "📁" : "📄");

// ================================================================= composer
export function Composer() {
  const p = pattern.value;
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const roles = rolesFor(p);
  const problem = startProblem(p, roles);

  const start = async () => {
    if (problem || !p || starting) return;
    setStarting(true);
    setError("");
    try {
      const { id } = await post<{ id: string }>("/api/runs", {
        repo: repo.value,
        task: task.value,
        pattern: p.id,
        roles,
        options: optionsFor(p),
        baseRef: baseRef.value,
        branchPrefix: branchPrefix.value.trim(),
        context: {
          paths: [...contextPaths.value.values()].map((c) => ({ path: c.path })),
          attachments: attachments.value.map((a) => ({ name: a.name, data: a.data })),
        },
        agentSettings: agentSettings.value,
        approvals: { plan: !!CHECKPOINTS[p.id] && approvePlan.value },
        loop: { check: checkCmd.value.trim(), setup: setupCmd.value.trim(), maxMinutes: limits.value.maxMinutes, maxSteps: limits.value.maxSteps },
      });
      store.set("baseRef", baseRef.value);
      // Fresh composer for the next run; "Edit & run again" brings these back.
      setTask("");
      branchPrefix.value = "";
      contextPaths.value = new Map();
      attachments.value = [];
      await refreshRuns();
      route.value = { view: "run", id };
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStarting(false);
    }
  };

  return (
    <div class="composer">
      <h1>What should the team build?</h1>
      <p class="lede">Describe the task, add the files that matter, and pick how your agents work together.</p>
      {!repoInfo.value ? (
        <div class={`banner ${repoError.value ? "bad" : ""}`}>
          <p>{repoError.value ? `${repoError.value}. Pick the folder that contains your project's .git.` : "Choose the repository the agents should work in."}</p>
          <button class="btn primary" onClick={() => (pickerOpen.value = true)}>
            Choose repository
          </button>
        </div>
      ) : null}

      <TaskBox onStart={start} />
      {contextError.value ? <div class="msg err">{contextError.value}</div> : null}

      <div class="section">
        <div class="section-title">How should they work together?</div>
        <div class="patterns">
          {patterns.value.map((x) => (
            <button key={x.id} type="button" class={`pattern ${x.id === p?.id ? "selected" : ""}`} aria-pressed={x.id === p?.id} onClick={() => setPattern(x.id)}>
              <span class="pn">{x.name}</span>
              <span class="pf">{FLOWS[x.id] ?? x.summary}</span>
            </button>
          ))}
        </div>
        {p ? <p class="pattern-why">{p.description}</p> : null}
        {p ? <Team p={p} roles={roles} /> : null}
        {p && CHECKPOINTS[p.id] && (p.id !== "debate" || roles.builder?.length) ? (
          <label class="checkpoint">
            <input type="checkbox" checked={approvePlan.value} onChange={(e) => setApprovePlan(e.currentTarget.checked)} />
            <span>
              <b>Let me approve {CHECKPOINTS[p.id]}</b> before agents build — the run pauses (and its time budget with it) until you approve, ask for changes, or reject.
            </span>
          </label>
        ) : null}
        <div class={`donewhen ${p?.requiresCheck && !checkCmd.value.trim() ? "required" : ""}`}>
          <label class="lbl" for="checkCmd">
            Done when this passes
          </label>
          <div class="dw-row">
            <span class="dw-prompt">$</span>
            <input class="field" id="checkCmd" placeholder="e.g. npm test" spellcheck={false} autocomplete="off" value={checkCmd.value} onInput={(e) => setCheck(e.currentTarget.value)} />
          </div>
          <div class="help">
            {checkHint.value ? `${checkHint.value} ` : ""}code-flow runs this itself after every change, so loops end on evidence. Leave empty to rely on the agents' judgment.
          </div>
        </div>
      </div>

      {p ? <Settings p={p} roles={roles} /> : null}

      <div class="start-row">
        <button class="btn primary" disabled={!!problem || starting} onClick={start}>
          {starting ? "Starting…" : "Start run"} <span class="kbd">⌘↵</span>
        </button>
        <span class="why">{problem}</span>
      </div>
      {error ? <div class="msg err">{error}</div> : null}
    </div>
  );
}

function startProblem(p: PatternInfo | undefined, roles: Record<string, AgentId[]>): string {
  if (!repo.value) return "Choose a repository first";
  if (!task.value.trim()) return "Describe the task to start";
  if (!p) return "Pick how the agents work together";
  for (const role of p.roles) if (!role.optional && !roles[role.id]?.length) return `Pick an agent for ${role.label}`;
  if (p.id === "race" && (roles.contestants?.length ?? 0) < 2) return "A race needs at least two contestants";
  if (p.id === "debate" && (roles.debaters?.length ?? 0) < 2) return "A debate needs at least two debaters";
  if (p.requiresCheck && !checkCmd.value.trim()) return `${p.name} needs a “Done when” command, e.g. npm test`;
  return "";
}

// ---------------------------------------------------------------- task box
function TaskBox({ onStart }: { onStart: () => void }) {
  const [over, setOver] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const autosize = () => {
    const t = area.current;
    if (!t) return;
    t.style.height = "auto";
    t.style.height = `${Math.min(420, Math.max(120, t.scrollHeight))}px`;
  };
  useEffect(autosize, [task.value]);

  // A file dropped anywhere else would make the browser open it and lose your work.
  useEffect(() => {
    const guard = (e: DragEvent) => {
      if (!(e.target as HTMLElement)?.closest?.(".taskbox") && e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    window.addEventListener("dragover", guard);
    window.addEventListener("drop", guard);
    return () => {
      window.removeEventListener("dragover", guard);
      window.removeEventListener("drop", guard);
    };
  }, []);

  const count = contextPaths.value.size + attachments.value.length;
  return (
    <div
      class={`taskbox ${over ? "over" : ""}`}
      onDragOver={(e) => {
        const types = [...(e.dataTransfer?.types ?? [])];
        if (!types.includes(DRAG_TYPE) && !types.includes("Files")) return;
        e.preventDefault();
        e.dataTransfer!.dropEffect = "copy";
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false);
      }}
      onDrop={(e) => {
        setOver(false);
        const internal = e.dataTransfer?.getData(DRAG_TYPE);
        if (internal) {
          e.preventDefault(); // don't also paste the path into the text
          addContext(JSON.parse(internal));
          return;
        }
        if (!e.dataTransfer?.files.length) return;
        e.preventDefault();
        // Read synchronously: the DataTransfer is emptied once this handler returns.
        const items = [...e.dataTransfer.items].filter((i) => i.kind === "file");
        const files: File[] = [];
        const folders: string[] = [];
        [...e.dataTransfer.files].forEach((file, i) => {
          if (items[i]?.webkitGetAsEntry?.()?.isDirectory) folders.push(file.name);
          else files.push(file);
        });
        void addAttachments(files, folders);
      }}
    >
      <textarea
        ref={area}
        aria-label="Task"
        placeholder="e.g. Add rate limiting to the /login endpoint, with tests…"
        value={task.value}
        onInput={(e) => setTask(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onStart();
          }
        }}
      />
      <ContextChips />
      <div class="bar">
        <button class="btn ghost small" title="Attach files from your computer" onClick={() => fileInput.current?.click()}>
          📎 Attach
        </button>
        <button
          class="btn ghost small"
          title="Show repository files"
          aria-pressed={filesOpen.value}
          onClick={() => {
            filesOpen.value = !filesOpen.value;
            store.set("filesOpen", filesOpen.value ? "1" : "0");
          }}
        >
          📁 Files
        </button>
        <span class="hint">
          {count ? `${count} item${count === 1 ? "" : "s"} of context — agents read these before starting` : "Drag files here from the file list or Finder to give the agents context"}
        </span>
      </div>
      <div class="overlay">Drop to add as context</div>
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          void addAttachments([...(e.currentTarget.files ?? [])]);
          e.currentTarget.value = "";
        }}
      />
    </div>
  );
}

function ContextChips() {
  const remove = (path: string) => {
    const next = new Map(contextPaths.value);
    next.delete(path);
    contextPaths.value = next;
  };
  return (
    <div class="chips">
      {[...contextPaths.value.values()].map((c) => (
        <span key={c.path} class="chip-ctx" title={c.path}>
          <span class="n">
            {fileIcon(c.type)} {c.path}
            {c.type === "dir" ? "/" : ""}
          </span>
          <button type="button" title="Remove" aria-label={`Remove ${c.path}`} onClick={() => remove(c.path)}>
            ×
          </button>
        </span>
      ))}
      {attachments.value.map((a, i) => (
        <span key={`a${i}`} class="chip-ctx" title={a.name}>
          <span class="n">
            📎 {a.name} · {fmtSize(a.size)}
          </span>
          <button type="button" title="Remove" aria-label={`Remove ${a.name}`} onClick={() => (attachments.value = attachments.value.filter((x) => x !== a))}>
            ×
          </button>
        </span>
      ))}
    </div>
  );
}

export function addContext(item: ContextItem) {
  const next = new Map(contextPaths.value);
  next.set(item.path, { path: item.path, type: item.type });
  contextPaths.value = next;
}
function toggleContext(item: ContextItem) {
  const next = new Map(contextPaths.value);
  if (next.has(item.path)) next.delete(item.path);
  else next.set(item.path, { path: item.path, type: item.type });
  contextPaths.value = next;
}

/** Files from outside the repo (Finder, desktop, the Attach button). */
async function addAttachments(files: File[], folders: string[] = []) {
  contextError.value = folders.length ? `${folders.join(", ")} ${folders.length === 1 ? "is a folder" : "are folders"}. From outside the repo, add individual files.` : "";
  let total = attachments.value.reduce((sum, a) => sum + a.size, 0);
  const added = [];
  for (const file of files) {
    if (file.size > MAX_FILE) {
      contextError.value = `"${file.name}" is over 10 MB.`;
      continue;
    }
    if (total + file.size > MAX_TOTAL) {
      contextError.value = "Attached files must total under 25 MB.";
      break;
    }
    try {
      added.push({ name: file.name, size: file.size, data: await readBase64(file) });
      total += file.size;
    } catch {
      contextError.value = `Couldn't read "${file.name}".`;
    }
  }
  attachments.value = [...attachments.value, ...added];
}

// ---------------------------------------------------------------- team
function Team({ p, roles }: { p: PatternInfo; roles: Record<string, AgentId[]> }) {
  return (
    <div class="team">
      {p.roles.map((role) => {
        const selected = roles[role.id] ?? [];
        return (
          <div class="role" key={role.id}>
            <div>
              <div class="rl">
                {role.label}
                {role.multiple ? <span class="rd"> · pick several</span> : null}
              </div>
              <div class="rd">{role.description}</div>
            </div>
            <div class="pills">
              {agents.value.map((a) => {
                const on = selected.includes(a.id);
                return (
                  <button
                    key={a.id}
                    type="button"
                    class="pill"
                    aria-pressed={on}
                    disabled={!a.available}
                    title={a.available ? `${role.multiple ? "Toggle" : "Choose"} ${a.displayName}` : `${a.displayName} isn't installed`}
                    onClick={() => setRoles(p.id, role.id, role.multiple ? (on ? selected.filter((x) => x !== a.id) : [...selected, a.id]) : [a.id])}
                  >
                    <span class={`agent ${a.id}`}>{a.displayName}</span>
                  </button>
                );
              })}
              {role.optional ? (
                <button type="button" class="pill none" aria-pressed={!selected.length} onClick={() => setRoles(p.id, role.id, [])}>
                  Skip
                </button>
              ) : null}
            </div>
          </div>
        );
      })}
      <div class="team-summary">
        <span>▶</span>
        <span>{teamSentence(p, roles)}</span>
      </div>
    </div>
  );
}

function teamSentence(p: PatternInfo, roles: Record<string, AgentId[]>): string {
  const one = (r: string) => (roles[r]?.[0] ? SHORT[roles[r]![0]!] : "—");
  const many = (r: string) => {
    const n = (roles[r] ?? []).map((id) => SHORT[id]);
    return n.length ? (n.length === 1 ? n[0]! : `${n.slice(0, -1).join(", ")} and ${n.at(-1)}`) : "—";
  };
  const opts = optionsFor(p);
  const check = checkCmd.value.trim();
  const doneWhen = (check ? ` · done when “${check}” passes` : "") + (CHECKPOINTS[p.id] && approvePlan.value && (p.id !== "debate" || roles.builder?.length) ? ` · you approve ${CHECKPOINTS[p.id]} first` : "");
  switch (p.id) {
    case "pipeline":
      return `${one("planner")} plans → ${one("builder")} builds → ${one("reviewer")} reviews (up to ${opts.maxRounds} rounds of fixes)${doneWhen}`;
    case "race":
      return `${many("contestants")} each solve it separately → ${many("judge")} ${(roles.judge?.length ?? 0) > 1 ? "vote" : "picks"} the best, blind${doneWhen}`;
    case "debate":
      return `${many("debaters")} propose and debate → ${one("synthesizer")} writes the final plan${roles.builder?.length ? ` → ${one("builder")} builds it` : " (design only)"}${doneWhen}`;
    case "supervisor":
      return `${one("supervisor")} splits the work → ${many("workers")} build the parts in parallel → ${one("supervisor")} merges and reviews${doneWhen}`;
    case "tdd":
      return `${one("tester")} writes tests → ${one("builder")} makes them pass → ${one("tester")} tries to break it${doneWhen}`;
    case "loop": {
      const w = roles.workers ?? [];
      const handoff = w.length > 1 ? `, handing over to ${w.slice(1).map((id) => SHORT[id]).join(", then ")} if stuck` : "";
      return `${w.length ? SHORT[w[0]!] : "—"} fixes and code-flow re-runs “${check || "your check"}” until it passes${handoff} (max ${opts.maxRounds} rounds)`;
    }
    default:
      return p.summary;
  }
}

// ---------------------------------------------------------------- settings
function Settings({ p, roles }: { p: PatternInfo; roles: Record<string, AgentId[]> }) {
  const info = repoInfo.value;
  const used = new Set(Object.values(roles).flat());
  const models = [...used]
    .map((id) => {
      const s = agentSettings.value[id];
      return s?.model || s?.effort ? `${SHORT[id]}: ${[s.model, s.effort].filter(Boolean).join(" ")}` : null;
    })
    .filter(Boolean);
  const baseLabel = baseRef.value || (info?.current ? `HEAD (${info.current})` : "HEAD");
  const opts = optionsFor(p);
  return (
    <details class="settings">
      <summary>
        <span class="st">Settings</span>
        <span class="ss">
          from {baseLabel} · {models.length ? models.join(", ") : "default models"} · stops after {limits.value.maxMinutes} min or {limits.value.maxSteps} steps
        </span>
      </summary>
      <div class="settings-body">
        <div class="settings-grid">
          <div>
            <label class="lbl" for="baseRef">
              Start from branch
            </label>
            <select class="field" id="baseRef" value={baseRef.value} onChange={(e) => (baseRef.value = e.currentTarget.value)}>
              <option value="">{info?.current ? `Current HEAD (${info.current})` : "Current HEAD"}</option>
              {(
                [
                  ["local", "Branches"],
                  ["run", "Results of earlier runs"],
                  ["remote", "Remote branches"],
                ] as const
              ).map(([kind, label]) => {
                const items = info?.branches.filter((b) => b.kind === kind) ?? [];
                return items.length ? (
                  <optgroup key={kind} label={label}>
                    {items.map((b) => (
                      <option key={b.name} value={b.name}>
                        {b.name} · {b.updated}
                      </option>
                    ))}
                  </optgroup>
                ) : null;
              })}
            </select>
          </div>
          <div>
            <label class="lbl" for="branchPrefix">
              Result branch name
            </label>
            <input class="field" id="branchPrefix" placeholder="codeflow/<run-id>" spellcheck={false} autocomplete="off" value={branchPrefix.value} onInput={(e) => (branchPrefix.value = e.currentTarget.value)} />
            <div class="help">
              Results land on <code>name/build</code>, <code>name/candidate-a</code>…
            </div>
          </div>
          {p.options.map((o) => (
            <div key={o.id}>
              <label class="lbl" for={`opt-${o.id}`}>
                {o.label}
              </label>
              {o.type === "boolean" ? (
                <input type="checkbox" id={`opt-${o.id}`} checked={!!opts[o.id]} onChange={(e) => setOption(p, o.id, e.currentTarget.checked)} />
              ) : (
                <input class="field" type="number" id={`opt-${o.id}`} min={o.min} max={o.max} value={String(opts[o.id])} onInput={(e) => setOption(p, o.id, Number(e.currentTarget.value))} />
              )}
            </div>
          ))}
        </div>
        <div>
          <span class="lbl">Limits — the run stops when it reaches either</span>
          <div class="settings-grid">
            <div>
              <label class="lbl" for="maxMinutes">
                Minutes
              </label>
              <input class="field" type="number" id="maxMinutes" min={1} max={720} value={String(limits.value.maxMinutes)} onInput={(e) => setLimits({ maxMinutes: Number(e.currentTarget.value) || 60 })} />
            </div>
            <div>
              <label class="lbl" for="maxSteps">
                Agent steps
              </label>
              <input class="field" type="number" id="maxSteps" min={1} max={200} value={String(limits.value.maxSteps)} onInput={(e) => setLimits({ maxSteps: Number(e.currentTarget.value) || 40 })} />
            </div>
            <div>
              <label class="lbl" for="setupCmd">
                Setup each worktree
              </label>
              <input class="field mono" id="setupCmd" placeholder="optional, e.g. npm ci" spellcheck={false} autocomplete="off" value={setupCmd.value} onInput={(e) => setSetup(e.currentTarget.value)} />
            </div>
          </div>
          <div class="help">Work done before a limit is kept on its branch. Setup runs once in every new worktree before the agents start.</div>
        </div>
        <div>
          <span class="lbl">Models &amp; effort</span>
          {Object.keys(catalogs.value).length ? (
            [...agents.value]
              .filter((a) => a.available)
              .sort((a, b) => Number(used.has(b.id)) - Number(used.has(a.id)))
              .map((a) => <ModelRow key={a.id} agent={a} used={used.has(a.id)} />)
          ) : (
            <div class="help">Loading models…</div>
          )}
        </div>
        {info ? <div class="help">Each run works in git worktrees under {info.worktreeRoot}/ — your checkout is never touched.</div> : null}
      </div>
    </details>
  );
}

function ModelRow({ agent, used }: { agent: AgentInfo; used: boolean }) {
  const cat = catalogs.value[agent.id];
  const s = agentSettings.value[agent.id] ?? {};
  // Hooks before any early return; null = "derive from the saved model".
  const [customChoice, setCustom] = useState<boolean | null>(null);
  if (!cat || "error" in cat) {
    return (
      <div class={`model-row ${used ? "" : "unused"}`}>
        <AgentTag id={agent.id} />
        <div class="err">Uses the CLI's defaults (couldn't list models)</div>
      </div>
    );
  }
  const catalog = cat as ModelCatalog;
  const known = catalog.models.some((m) => m.id === s.model);
  const custom = customChoice ?? (!!s.model && !known);
  const model = catalog.models.find((m) => m.id === s.model);
  const efforts = model?.efforts?.length ? model.efforts : catalog.efforts;
  const fallbackEffort = model?.defaultEffort || catalog.defaultEffort;
  return (
    <div class={`model-row ${used ? "" : "unused"}`} title={used ? "" : "Not used by this team"}>
      <AgentTag id={agent.id} />
      <select
        class="field"
        aria-label={`${agent.displayName} model`}
        value={custom ? "__custom" : s.model ?? ""}
        onChange={(e) => {
          const v = e.currentTarget.value;
          setCustom(v === "__custom");
          const next = v === "__custom" ? "" : v;
          const nextModel = catalog.models.find((m) => m.id === next);
          const allowed = nextModel?.efforts?.length ? nextModel.efforts : catalog.efforts;
          setAgentSetting(agent.id, { model: next, effort: s.effort && allowed.includes(s.effort) ? s.effort : "" });
        }}
      >
        <option value="">{catalog.defaultModel ? `Default (${catalog.defaultModel})` : "Default model"}</option>
        {catalog.models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
        {catalog.allowCustom ? <option value="__custom">Other…</option> : null}
      </select>
      <select class="field" aria-label={`${agent.displayName} effort`} value={s.effort ?? ""} onChange={(e) => setAgentSetting(agent.id, { effort: e.currentTarget.value })}>
        <option value="">{fallbackEffort ? `Default (${fallbackEffort})` : "Default effort"}</option>
        {efforts.map((x) => (
          <option key={x} value={x}>
            {x}
          </option>
        ))}
      </select>
      {custom ? (
        <input class="field custom" type="text" placeholder="model id or alias" aria-label={`${agent.displayName} custom model`} value={s.model ?? ""} onInput={(e) => setAgentSetting(agent.id, { model: e.currentTarget.value.trim() })} />
      ) : null}
    </div>
  );
}

// ================================================================= files panel
export function FilesPanel({ open }: { open: boolean }) {
  const [entries, setEntries] = useState<TreeEntry[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [message, setMessage] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TreeEntry[] | null>(null);

  useEffect(() => {
    setQuery("");
    setResults(null);
    if (!repo.value) {
      setEntries(null);
      setMessage("Choose a repository to see its files.");
      return;
    }
    setMessage("Loading…");
    api<{ entries: TreeEntry[]; truncated: boolean }>(`/api/tree?repo=${enc(repo.value)}&path=`)
      .then((d) => {
        setEntries(d.entries);
        setTruncated(d.truncated);
        setMessage("");
      })
      .catch((err) => setMessage((err as Error).message));
  }, [repo.value]);

  useEffect(() => {
    const q = query.trim();
    if (!q || !repo.value) return setResults(null);
    const timer = setTimeout(async () => {
      try {
        setResults(await api<TreeEntry[]>(`/api/search?repo=${enc(repo.value)}&q=${enc(q)}`));
      } catch (err) {
        setMessage((err as Error).message);
      }
    }, 180);
    return () => clearTimeout(timer);
  }, [query]);

  return (
    <aside class={`files-panel ${open ? "open" : ""}`} aria-label="Repository files">
      <div class="files-head">
        <span class="ft">Files</span>
        <span class="fr">{repoInfo.value ? repoInfo.value.repo.split("/").pop() : ""}</span>
        <button
          class="btn ghost small"
          title="Hide files"
          onClick={() => {
            filesOpen.value = false;
            store.set("filesOpen", "0");
          }}
        >
          ✕
        </button>
      </div>
      <input type="search" class="field files-search" placeholder="Search files…" autocomplete="off" spellcheck={false} value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
      <div class="tree">
        {message ? <div class="tree-empty">{message}</div> : null}
        {results
          ? results.length
            ? results.map((r) => <TreeNode key={r.path} entry={r} depth={0} sub={r.path.includes("/") ? r.path.slice(0, r.path.lastIndexOf("/")) : ""} />)
            : <div class="tree-empty">No matching files</div>
          : entries?.map((e) => <TreeNode key={e.path} entry={e} depth={0} />)}
        {!results && truncated ? <div class="tree-empty">Showing the first 1000 — use search</div> : null}
      </div>
      <div class="files-foot">
        Drag into the task, or click <b>+</b>. <b style="color:var(--warn)">M</b> changed · <b style="color:var(--ok)">U</b> new
      </div>
    </aside>
  );
}

function TreeNode({ entry, depth, sub }: { entry: TreeEntry; depth: number; sub?: string }) {
  const [children, setChildren] = useState<TreeEntry[] | null>(null);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const added = contextPaths.value.has(entry.path);
  const statusName = entry.status ? ({ M: "changed", U: "new, not committed", A: "added" } as const)[entry.status] : "";
  const toggle = async () => {
    if (entry.type !== "dir") return;
    if (open) return setOpen(false);
    setOpen(true);
    if (children) return;
    setMessage("Loading…");
    try {
      const d = await api<{ entries: TreeEntry[] }>(`/api/tree?repo=${enc(repo.value)}&path=${enc(entry.path)}`);
      setChildren(d.entries);
      setMessage(d.entries.length ? "" : "Empty folder");
    } catch (err) {
      setMessage((err as Error).message);
    }
  };
  return (
    <div>
      <div
        class={`node ${added ? "added" : ""}`}
        draggable
        title={`${entry.path}${statusName ? ` — ${statusName}` : ""}\nDrag into the task, or click +`}
        style={`padding-left:${2 + depth * 14}px`}
        onClick={toggle}
        onDblClick={() => entry.type === "file" && addContext(entry)}
        onDragStart={(e) => {
          e.dataTransfer!.setData(DRAG_TYPE, JSON.stringify({ path: entry.path, type: entry.type }));
          e.dataTransfer!.setData("text/plain", entry.path);
          e.dataTransfer!.effectAllowed = "copy";
          e.currentTarget.classList.add("dragging");
        }}
        onDragEnd={(e) => e.currentTarget.classList.remove("dragging")}
      >
        <span class="tw">{entry.type === "dir" ? (open ? "▼" : "▶") : ""}</span>
        <span class={`lb ${entry.type}`}>
          {fileIcon(entry.type)} {entry.name}
        </span>
        {sub ? <span class="sub">{sub}</span> : null}
        <span class={`st ${entry.status ?? ""}`}>{entry.status ?? ""}</span>
        <button
          type="button"
          class="add"
          title={`Add ${entry.path} to the task`}
          aria-label={`Add ${entry.path} to the task`}
          onClick={(e) => {
            e.stopPropagation();
            toggleContext(entry);
          }}
        >
          +
        </button>
      </div>
      {open ? (
        <div>
          {message ? (
            <div class="tree-empty" style={`padding-left:${22 + depth * 14}px`}>
              {message}
            </div>
          ) : null}
          {children?.map((c) => <TreeNode key={c.path} entry={c} depth={depth + 1} />)}
        </div>
      ) : null}
    </div>
  );
}
