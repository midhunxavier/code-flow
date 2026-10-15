import { useEffect, useState } from "preact/hooks";
import { useDialog } from "./app.js";
import { api, enc } from "./lib.js";
import { applyTemplate, ghPicker, repo, setTask, source, task, templates, type SourcePick, type Template } from "./state.js";

interface Item {
  number: number;
  title: string;
  url: string;
  labels?: string[];
  headRefName?: string;
  baseRefName?: string;
  author?: string;
  isDraft?: boolean;
  isCrossRepository?: boolean;
}

/** Start from a GitHub issue or pull request (listed with your `gh` login). */
export function GitHubPicker() {
  const open = ghPicker.value;
  const ref = useDialog(!!open, () => (ghPicker.value = null));
  const [kind, setKind] = useState<"issue" | "pr">("issue");
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const template = open?.template;

  useEffect(() => {
    if (open) {
      setKind(open.kind);
      setFilter("");
    }
  }, [open]);
  useEffect(() => {
    if (!open || !repo.value) return;
    setItems(null);
    setError("");
    api<Item[]>(`/api/github/${kind === "issue" ? "issues" : "prs"}?repo=${enc(repo.value)}`).then(setItems, (e) => setError(e.message));
  }, [open, kind]);

  const pick = (item: Item) => {
    const chosen: SourcePick = {
      kind,
      number: item.number,
      title: item.title,
      url: item.url,
      headRefName: item.headRefName,
      baseRefName: item.baseRefName,
      isCrossRepository: item.isCrossRepository,
    };
    if (template) applyTemplate(template, chosen);
    else {
      source.value = { ...chosen, ciLogs: source.value?.ciLogs };
      if (!task.value.trim()) setTask(kind === "issue" ? `Fix issue #${item.number}: ${item.title}` : `Pull request #${item.number} (${item.title}): `);
    }
    ghPicker.value = null;
  };
  const q = filter.trim().toLowerCase();
  const shown = (items ?? []).filter((i) => !q || `#${i.number} ${i.title} ${(i.labels ?? []).join(" ")} ${i.author ?? ""}`.toLowerCase().includes(q));

  return (
    <dialog class="picker" ref={ref}>
      {open ? (
        <div class="picker-inner">
          <div class="picker-head">
            <h3>{template ? `${template.name}: pick ${kind === "issue" ? "an issue" : "a pull request"}` : "Start from GitHub"}</h3>
            {!template?.needs ? (
              <div class="segmented" role="radiogroup" aria-label="Issues or pull requests">
                <button type="button" role="radio" aria-checked={kind === "issue"} class={kind === "issue" ? "on" : ""} onClick={() => setKind("issue")}>
                  Issues
                </button>
                <button type="button" role="radio" aria-checked={kind === "pr"} class={kind === "pr" ? "on" : ""} onClick={() => setKind("pr")}>
                  Pull requests
                </button>
              </div>
            ) : null}
            <div class="row">
              <input class="field" placeholder="Filter by number, title, label…" value={filter} onInput={(e) => setFilter(e.currentTarget.value)} autoFocus />
            </div>
          </div>
          <div class="picker-list">
            {error ? <div class="msg err">{error}</div> : null}
            {!items && !error ? <div class="help pad">Loading from GitHub…</div> : null}
            {items && !shown.length ? <div class="help pad">No open {kind === "issue" ? "issues" : "pull requests"}{q ? " match" : ""}.</div> : null}
            {shown.map((i) => (
              <div key={i.number} class="dir gh-item" tabIndex={0} onClick={() => pick(i)} onKeyDown={(e) => e.key === "Enter" && pick(i)}>
                <span class="di">#{i.number}</span>
                <span class="dn">
                  {i.title}
                  {kind === "pr" ? (
                    <span class="gh-sub">
                      {i.headRefName} → {i.baseRefName}
                      {i.author ? ` · @${i.author}` : ""}
                      {i.isDraft ? " · draft" : ""}
                      {i.isCrossRepository ? " · from a fork (read-only)" : ""}
                    </span>
                  ) : i.labels?.length ? (
                    <span class="gh-sub">{i.labels.join(" · ")}</span>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
          <div class="picker-foot">
            <span class="ps">Listed with GitHub CLI (gh) using your own login.</span>
            <button class="btn" onClick={() => (ghPicker.value = null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </dialog>
  );
}

/** Template chips: pick one, then (if it needs one) an issue or PR. */
export function Templates() {
  if (!templates.value.length) return null;
  const choose = (t: Template) => {
    if (t.needs) ghPicker.value = { kind: t.needs, template: t };
    else applyTemplate(t);
  };
  return (
    <div class="templates">
      <span class="lbl">Start from</span>
      {templates.value.map((t) => (
        <button key={t.id} type="button" class="chip-tpl" title={t.description} onClick={() => choose(t)}>
          {t.needs === "pr" ? "⇄ " : t.needs === "issue" ? "◎ " : "✦ "}
          {t.name}
        </button>
      ))}
      <button type="button" class="chip-tpl ghost" title="Start from any open issue or pull request" onClick={() => (ghPicker.value = { kind: "issue" })}>
        GitHub…
      </button>
    </div>
  );
}

/** The issue or PR the next run starts from, shown in the task box. */
export function SourceChip() {
  const s = source.value;
  if (!s) return null;
  return (
    <span class="chip-ctx source" title={s.url}>
      <span class="n">
        {s.kind === "issue" ? "◎ Issue" : "⇄ PR"} #{s.number} · {s.title}
      </span>
      {s.kind === "pr" ? <span class="note">starts from {s.headRefName}</span> : null}
      {s.kind === "pr" ? (
        <label class="note" title="Give agents the PR's failing CI checks and their logs">
          <input type="checkbox" checked={!!s.ciLogs} onChange={(e) => (source.value = { ...s, ciLogs: e.currentTarget.checked })} /> CI logs
        </label>
      ) : null}
      <button type="button" title="Don't start from this" aria-label="Remove source" onClick={() => (source.value = null)}>
        ×
      </button>
    </span>
  );
}
