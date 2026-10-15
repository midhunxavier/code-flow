import { useEffect, useReducer, useRef, useState } from "preact/hooks";
import { useDialog } from "./app.js";
import { AgentTag, Markdown } from "./bits.js";
import { TriageActions } from "./automations.js";
import { api, baseName, copy, duration, fmtSize, post, showToast, STATUS_TEXT } from "./lib.js";
import {
  agents,
  attachments,
  checkCmd,
  contextPaths,
  limits,
  markSeen,
  optionValues,
  patterns,
  repo,
  roleSel,
  route,
  runState,
  setPattern,
  setRepo,
  setTask,
  setupCmd,
  source,
  upsertRun,
} from "./state.js";
import type { AgentEvent, AgentId, Artifact, FollowUp, MergeOutcome, RepoInfo, RunEvent, RunSummary, Step } from "./types.js";

const STEP_ICON: Record<string, string> = { done: "✓", failed: "✕", cancelled: "■", interrupted: "⏸" };
const modelNote = (run: RunSummary | null, id?: AgentId) =>
  run && id ? [run.agentSettings?.[id]?.model, run.agentSettings?.[id]?.effort].filter(Boolean).join(" · ") : "";

interface RunData {
  steps: Map<string, Step>;
  events: Map<string, AgentEvent[]>;
  logs: { ts: number; level: string; text: string }[];
  seen: Set<number>;
}

export function RunView({ id }: { id: string }) {
  const [run, setRun] = useState<RunSummary | null>(null);
  const data = useRef<RunData>({ steps: new Map(), events: new Map(), logs: [], seen: new Set() });
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const [selected, setSelected] = useState<string | null>(null);
  const follow = useRef(true);
  const [archiving, setArchiving] = useState(false);

  useEffect(() => {
    const source = new EventSource(`/api/runs/${id}/events`);
    let scheduled = false;
    source.onmessage = (msg) => {
      const ev = JSON.parse(msg.data) as RunEvent;
      const d = data.current;
      if (d.seen.has(ev.seq)) return;
      d.seen.add(ev.seq);
      if (ev.type === "run") {
        setRun(ev.run);
        upsertRun(ev.run);
      } else if (ev.type === "step") {
        d.steps.set(ev.step.id, ev.step);
        if (follow.current && ev.step.status === "running") setSelected(ev.step.id);
      } else if (ev.type === "agent") {
        if (!d.events.has(ev.stepId)) d.events.set(ev.stepId, []);
        d.events.get(ev.stepId)!.push(ev.event);
      } else if (ev.type === "log") {
        d.logs.push(ev);
      }
      // Batch bursts of events into one render per frame.
      if (!scheduled) {
        scheduled = true;
        requestAnimationFrame(() => {
          scheduled = false;
          bump(0);
        });
      }
    };
    return () => source.close();
  }, [id]);

  useEffect(() => {
    if (run && run.status !== "running" && !run.seen && !document.hidden) void markSeen(run.id);
  }, [run?.status, run?.seen]);

  if (!run) return <div class="runview"><div class="run-head">Loading…</div></div>;
  const steps = [...data.current.steps.values()];
  const current = selected && data.current.steps.has(selected) ? selected : steps.at(-1)?.id ?? null;
  const finished = run.status !== "running";
  const p = patterns.value.find((x) => x.id === run.pattern);
  const state = runState(run);

  return (
    <div class="runview">
      <div class="run-head">
        <div class="run-title">
          <span class={`status-pill ${run.awaiting ? "awaiting" : state}`}>
            {run.awaiting ? "Waiting for you" : state === "failing" ? "Done · check failing" : STATUS_TEXT[run.status] ?? run.status}
          </span>
          <h2>{p?.name ?? run.pattern}</h2>
          <span class="spacer" />
          {["interrupted", "stopped", "failed", "cancelled"].includes(run.status) ? (
            <button
              class="btn primary"
              title={run.status === "interrupted" ? "Continue where it stopped; finished steps aren't redone" : "Continue with a fresh budget; finished steps aren't redone"}
              onClick={() => post(`/api/runs/${run.id}/resume`).catch((e) => showToast(e.message))}
            >
              ▶ Resume
            </button>
          ) : null}
          {finished ? (
            <button class="btn" onClick={() => editAndRerun(run)}>
              ✎ Edit &amp; run again
            </button>
          ) : null}
          {finished && !run.archived ? (
            <button class="btn" onClick={() => setArchiving(true)}>
              Archive…
            </button>
          ) : null}
          {run.archived ? (
            <button class="btn" onClick={() => post(`/api/runs/${run.id}/archive`, { archived: false }).then(() => showToast("Moved back to your runs"), (e) => showToast(e.message))}>
              Unarchive
            </button>
          ) : null}
          {!finished ? (
            <button
              class="btn danger"
              onClick={() => {
                if (confirm("Stop this run? Agents still working will be stopped; finished work stays on its branches.")) {
                  post(`/api/runs/${run.id}/cancel`).catch((e) => showToast(e.message));
                }
              }}
            >
              Stop run
            </button>
          ) : null}
        </div>
        <p class="run-task">{run.task}</p>
        {run.parentRunId ? (
          <a class="help" href={`#/run/${run.parentRunId}`}>
            ↩ continues an earlier run
          </a>
        ) : null}
        <RunChips run={run} />
        <RunMeta run={run} />
      </div>

      {run.awaiting ? <AwaitingCard run={run} /> : null}
      {run.triage?.state === "pending" && run.status !== "running" ? (
        <div class="awaiting-card">
          <div class="aw-head">
            <span class="status-pill awaiting">In your inbox</span>
            <b>From your automation “{run.trigger?.name}”</b>
            <span class="help">Approving never merges (it can open a pull request); rejecting deletes the worktrees and branches.</span>
          </div>
          <div class="aw-actions">
            <TriageActions run={run} />
          </div>
        </div>
      ) : null}
      {finished ? <ResultCard run={run} steps={steps} /> : null}

      <div class="run-body">
        <div class="timeline">
          {steps.length ? (
            steps.map((s) => (
              <button
                key={s.id}
                type="button"
                class={`tl-step ${s.id === current ? "selected" : ""}`}
                onClick={() => {
                  follow.current = false;
                  setSelected(s.id);
                }}
              >
                <span class={`ic ${s.status}`}>{STEP_ICON[s.status] ?? ""}</span>
                <span class="tt">{s.title}</span>
                <span class="tm">
                  <StepTag step={s} />
                  <span>{s.kind === "agent" ? s.role : s.finalText || "running…"}</span>
                  {s.endedAt ? <span>{duration(s.endedAt - s.startedAt)}</span> : null}
                </span>
              </button>
            ))
          ) : (
            <div class="tl-empty">Starting…</div>
          )}
        </div>
        <Transcript run={run} step={current ? data.current.steps.get(current) : undefined} events={current ? data.current.events.get(current) ?? [] : []} />
      </div>

      <ConversationBar run={run} steps={steps} />
      <details class="activity">
        <summary>Activity log ({data.current.logs.length})</summary>
        <div class="log">
          {data.current.logs.map((l, i) => (
            <div key={i} class={l.level}>
              {new Date(l.ts).toLocaleTimeString()} {l.text}
            </div>
          ))}
        </div>
      </details>
      {archiving ? <ArchiveDialog run={run} onClose={() => setArchiving(false)} /> : null}
    </div>
  );
}

function StepTag({ step, model }: { step: Step; model?: string }) {
  if ((step.kind ?? "agent") === "agent") return <AgentTag id={step.agent} note={model} />;
  return <span class="tag-cf">{step.kind === "check" ? "check" : "setup"}</span>;
}

function RunChips({ run }: { run: RunSummary }) {
  const ctx = run.context ?? { paths: [], attachments: [] };
  if (!ctx.paths.length && !ctx.attachments.length) return null;
  return (
    <div class="run-chips">
      {ctx.paths.map((c) => (
        <span key={c.path} class="chip-ctx" title={c.workingCopy ? `Your ${c.note} working copy was given to the agents` : c.path}>
          <span class="n">
            {c.type === "dir" ? "📁" : "📄"} {c.path}
            {c.type === "dir" ? "/" : ""}
          </span>
          {c.note ? <span class="note">{c.note}</span> : null}
        </span>
      ))}
      {ctx.attachments.map((a) => (
        <span key={a.name} class="chip-ctx">
          <span class="n">
            📎 {a.name} · {fmtSize(a.size)}
          </span>
        </span>
      ))}
    </div>
  );
}

function RunMeta({ run }: { run: RunSummary }) {
  const team = Object.entries(run.roles).filter(([, ids]) => ids.length);
  return (
    <div class="run-meta">
      <span title={run.repo}>📁 {baseName(run.repo)}</span>
      {run.trigger ? (
        <a class="src-link" href="#/automations" title={`Started by ${run.trigger.via === "schedule" ? "its schedule" : run.trigger.via === "webhook" ? "a webhook" : "Run now"}`}>
          ⏱ {run.trigger.name}
        </a>
      ) : null}
      {run.triage && run.triage.state !== "pending" ? <span class="badge">{run.triage.state === "empty" ? "no changes · archived" : run.triage.state}</span> : null}
      {run.source ? (
        <a class="src-link" href={run.source.url} target="_blank" rel="noreferrer" title={run.source.title}>
          {run.source.kind === "issue" ? "◎ issue" : "⇄ PR"} #{run.source.number} ↗
        </a>
      ) : null}
      <span>
        from {run.baseLabel} @ {run.baseRef.slice(0, 7)}
      </span>
      {run.loop?.check ? (
        <span title="code-flow runs this after every change">
          done when “{run.loop.check}” passes{run.lastCheck ? (run.lastCheck.ok ? " · last check ✓" : " · last check ✕") : ""}
        </span>
      ) : null}
      <span class="team-line">
        {team.map(([role, ids]) => (
          <span key={role}>
            {role}:{" "}
            {ids.map((agentId, i) => (
              <span key={agentId}>
                {i ? ", " : ""}
                <AgentTag id={agentId} note={modelNote(run, agentId)} />
              </span>
            ))}
          </span>
        ))}
      </span>
      {run.usage ? (
        <span class="usage">
          {run.usage.agentSteps}/{run.loop.maxSteps} agent steps · {duration((run.endedAt ?? Date.now()) - run.createdAt)} of {run.loop.maxMinutes} min
        </span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- result & shipping
function ResultCard({ run, steps }: { run: RunSummary; steps: Step[] }) {
  const state = runState(run);
  const titles: Record<string, string> = {
    done: run.verdict === "passed" ? "✓ Finished — the check passes" : "✓ Finished",
    failing: "⚠ Finished — but the check still fails",
    failed: "✕ Failed",
    cancelled: "■ Stopped by you",
    stopped: `■ Stopped at the ${run.stopReason ?? "limit"} — work so far is kept below`,
    interrupted: "■ Interrupted — press Resume to continue where it stopped",
  };
  return (
    <div class={`result ${state}`}>
      <div class="rh">{titles[state] ?? run.status}</div>
      {run.error ? (
        <div class="rb">
          <div class="ev error">{run.error}</div>
        </div>
      ) : run.review ? (
        <ReviewCard run={run} />
      ) : run.summary ? (
        <div class="rb">
          <Markdown text={run.summary} />
        </div>
      ) : null}
      {run.followUps?.length ? (
        <div class="followups">
          <div class="lbl">Follow-ups</div>
          {run.followUps.map((f) => (
            <div key={f.id} class={`followup ${f.status}`}>
              <span class={`ic ${f.status === "done" ? "done" : f.status === "failed" ? "failed" : ""}`}>{f.status === "done" ? "✓" : f.status === "failed" ? "✕" : "…"}</span>
              <AgentTag id={f.agent} /> {followUpLabel(f)} in {f.worktree}
              {f.pushed ? <span class="ok"> · pushed {f.pushed.slice(0, 7)}</span> : f.pushError ? <span class="note"> · push failed: {f.pushError}</span> : null}
              {f.checkPassed === false ? <span class="note"> · check fails</span> : f.checkPassed ? <span class="ok"> · check passes</span> : null}
            </div>
          ))}
        </div>
      ) : null}
      {run.artifacts.length ? (
        <div class="artifacts">
          {run.artifacts.map((a) => (
            <ArtifactCard key={a.branch + a.label} run={run} artifact={a} steps={steps} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

const followUpLabel = (f: FollowUp) =>
  f.kind === "resolve-conflicts"
    ? `resolve conflicts with ${f.mergeFrom}`
    : f.kind === "reply"
      ? "your reply"
      : f.kind === "ci-fix"
        ? "fix failing CI"
        : f.from
          ? `comments from ${f.from}`
          : "review comments";

/** A review council's result: findings ranked by how many reviewers agree, and a post button. */
function ReviewCard({ run }: { run: RunSummary }) {
  const review = run.review!;
  const [busy, setBusy] = useState(false);
  const pr = run.source?.kind === "pr" ? run.source : undefined;
  return (
    <div class="rb council">
      <div class="council-head">
        <span class={`badge ${review.verdict === "approve" ? "ok" : "warn"}`}>{review.verdict === "approve" ? "Approve" : "Changes requested"}</span>
        <span class="help">
          {review.reviewers.map((r, i) => (
            <span key={r.agent}>
              {i ? " · " : ""}
              <AgentTag id={r.agent} /> {r.verdict === "approve" ? "approves" : `${r.issues} issue${r.issues === 1 ? "" : "s"}`}
            </span>
          ))}
        </span>
        <span class="spacer" />
        {pr ? (
          review.postedTo ? (
            <a class="badge ok" href={review.postedTo} target="_blank" rel="noreferrer">
              Posted to PR #{pr.number} ↗
            </a>
          ) : (
            <button
              class="btn small primary"
              disabled={busy || run.status === "running"}
              onClick={async () => {
                if (!confirm(`Post this review as a comment on PR #${pr.number}? Everyone with access to the PR will see it.`)) return;
                setBusy(true);
                try {
                  await post(`/api/runs/${run.id}/post-review`);
                  showToast("Review posted");
                } catch (err) {
                  showToast((err as Error).message, 5000);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Posting…" : `Post to PR #${pr.number}`}
            </button>
          )
        ) : null}
        <button class="btn small" onClick={() => copy(review.markdown, "Review copied as Markdown")}>
          Copy
        </button>
      </div>
      {review.summary ? <p>{review.summary}</p> : null}
      {review.findings.length ? (
        <ol class="findings">
          {review.findings.map((f, i) => (
            <li key={i} class={`sev-${f.severity}`}>
              <div>
                <span class={`sev ${f.severity}`}>{f.severity}</span> <code>{f.file || "general"}</code> {f.problem}
              </div>
              <div class="help">Fix: {f.fix}</div>
              <div class="raised">
                {f.raisedBy.length > 1 ? <b>{f.raisedBy.length} reviewers agree · </b> : null}
                {f.raisedBy.map((a) => (
                  <AgentTag key={a} id={a} />
                ))}
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p class="help">No problems found.</p>
      )}
    </div>
  );
}

function ArtifactCard({ run, artifact, steps }: { run: RunSummary; artifact: Artifact; steps: Step[] }) {
  const [panel, setPanel] = useState<"merge" | "pr" | null>(null);
  const worktree = (run.worktrees ?? []).find((w) => w.branch === artifact.branch);
  const merged = run.merges?.filter((m) => m.branch === artifact.branch) ?? [];
  const pr = run.prs?.[artifact.branch];
  const canReview = run.status === "done" && !!worktree;
  const fromPr = run.source?.kind === "pr" ? run.source : undefined;
  const [pushing, setPushing] = useState(false);
  return (
    <div class="artifact">
      <div class="ah">
        <b>{artifact.label}</b>
        <code>{artifact.branch}</code>
        {merged.map((m) => (
          <span key={m.commit} class="badge ok">
            merged into {m.into}
          </span>
        ))}
        {pr ? (
          <a class="badge" href={pr} target="_blank" rel="noreferrer">
            PR ↗
          </a>
        ) : null}
        <span class="acts">
          {canReview ? (
            <button class="btn small primary" onClick={() => (route.value = { view: "review", id: run.id, branch: artifact.branch })}>
              Review changes
            </button>
          ) : null}
          {worktree ? (
            <button class="btn small" aria-pressed={panel === "merge"} onClick={() => setPanel(panel === "merge" ? null : "merge")}>
              Merge…
            </button>
          ) : null}
          {worktree && fromPr && !fromPr.isCrossRepository && run.status !== "running" ? (
            <button
              class="btn small primary"
              disabled={pushing}
              title={`Push this branch to ${fromPr.headRefName}, updating PR #${fromPr.number} (never forced)`}
              onClick={async () => {
                if (!confirm(`Push ${artifact.branch} to ${fromPr.headRefName}? This updates PR #${fromPr.number} on GitHub.`)) return;
                setPushing(true);
                try {
                  await post(`/api/runs/${run.id}/push-pr`, { branch: artifact.branch });
                  showToast(`Pushed to PR #${fromPr.number}`);
                } catch (err) {
                  showToast((err as Error).message, 6000);
                } finally {
                  setPushing(false);
                }
              }}
            >
              {pushing ? "Pushing…" : `Push to PR #${fromPr.number}`}
            </button>
          ) : null}
          {worktree && !fromPr ? (
            <button class="btn small" aria-pressed={panel === "pr"} onClick={() => setPanel(panel === "pr" ? null : "pr")}>
              Open PR…
            </button>
          ) : null}
          <button class="btn small" onClick={() => copy(`git diff ${run.baseRef.slice(0, 12)}...${artifact.branch}`, "Diff command copied")}>
            Copy diff cmd
          </button>
          <button class="btn small" onClick={() => copy(artifact.path, "Path copied")}>
            Copy path
          </button>
        </span>
      </div>
      {artifact.stat ? <pre>{artifact.stat}</pre> : <div class="help">No changes</div>}
      {worktree && existsHint(run) ? <WorkspaceTools run={run} worktree={worktree.name} /> : null}
      {panel === "merge" && worktree ? <MergePanel run={run} branch={artifact.branch} worktree={worktree.name} steps={steps} /> : null}
      {panel === "pr" ? <PrPanel run={run} branch={artifact.branch} /> : null}
      {pr && worktree ? <WatchPanel run={run} branch={artifact.branch} steps={steps} worktree={worktree.name} /> : null}
    </div>
  );
}

const WATCH_TEXT: Record<string, string> = {
  watching: "Watching",
  fixing: "Fixing",
  green: "CI green",
  "needs-you": "Needs you",
  closed: "PR closed",
  stopped: "Not watching",
};

/** PR follow-through: fix failing CI and collaborators' comments, push; never merge. */
function WatchPanel({ run, branch, steps, worktree }: { run: RunSummary; branch: string; steps: Step[]; worktree: string }) {
  const watch = run.watches?.[branch];
  const active = watch && ["watching", "fixing", "green"].includes(watch.state);
  const [agent, setAgent] = useState<AgentId>(watch?.agent ?? lastAgentIn(steps, worktree) ?? "claude");
  const [maxFixes, setMaxFixes] = useState(watch?.maxFixes ?? 3);
  const call = (body: object) => post(`/api/runs/${run.id}/watch`, { branch, ...body }).catch((e) => showToast(e.message, 5000));
  return (
    <div class={`watch ${watch?.state ?? "off"}`}>
      {watch ? (
        <div class="row">
          <span class={`badge ${watch.state === "green" ? "ok" : watch.state === "needs-you" ? "warn" : ""}`}>{WATCH_TEXT[watch.state]}</span>
          <span class="detail">{watch.detail}</span>
          {watch.checks ? (
            <span class="help">
              CI: {watch.checks.pass} ✓ · {watch.checks.fail} ✕{watch.checks.pending ? ` · ${watch.checks.pending} running` : ""}
            </span>
          ) : null}
          <span class="help">
            {watch.fixes}/{watch.maxFixes} fixes{watch.lastPolled ? ` · checked ${new Date(watch.lastPolled).toLocaleTimeString()}` : ""}
          </span>
          <span class="spacer" />
          {active ? (
            <button class="btn small" onClick={() => call({ stop: true })}>
              Stop watching
            </button>
          ) : null}
        </div>
      ) : null}
      {!active && watch?.state !== "closed" ? (
        <div class="row">
          <span class="lbl">Follow through</span>
          <span>When CI fails or a collaborator comments,</span>
          <AgentPicker value={agent} onChange={setAgent} />
          <span>fixes it and pushes — up to</span>
          <input class="field inline num" type="number" min={1} max={10} value={maxFixes} onInput={(e) => setMaxFixes(Number(e.currentTarget.value) || 3)} />
          <span>times. Never merges.</span>
          <button class="btn small primary" onClick={() => call({ agent, maxFixes })}>
            {watch ? "Watch again" : "Watch PR"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Branches you could merge a result into: local ones, with the run's base first. */
function useTargetBranches(run: RunSummary): { branches: string[]; initial: string } {
  const [info, setInfo] = useState<RepoInfo | null>(null);
  useEffect(() => {
    api<RepoInfo>(`/api/branches?repo=${encodeURIComponent(run.repo)}`).then(setInfo, () => setInfo(null));
  }, [run.repo]);
  const branches = (info?.branches ?? []).filter((b) => b.kind === "local").map((b) => b.name);
  const initial = run.baseLabel !== "HEAD" && branches.includes(run.baseLabel) ? run.baseLabel : info?.current ?? branches[0] ?? "";
  return { branches, initial };
}

const lastAgentIn = (steps: Step[], worktree: string): AgentId | undefined =>
  [...steps].reverse().find((s) => (s.kind ?? "agent") === "agent" && s.worktree === worktree && s.mode === "write")?.agent;

function MergePanel({ run, branch, worktree, steps }: { run: RunSummary; branch: string; worktree: string; steps: Step[] }) {
  const { branches, initial } = useTargetBranches(run);
  const [into, setInto] = useState("");
  const [archiveAfter, setArchiveAfter] = useState(true);
  const [busy, setBusy] = useState(false);
  const [conflicts, setConflicts] = useState<string[] | null>(null);
  const [agent, setAgent] = useState<AgentId>(lastAgentIn(steps, worktree) ?? "claude");
  const target = into || initial;
  const merge = async () => {
    setBusy(true);
    setConflicts(null);
    try {
      const outcome = await post<MergeOutcome>(`/api/runs/${run.id}/merge`, { branch, into: target, archiveAfter });
      if (outcome.ok) showToast(`Merged into ${target}${archiveAfter ? " and archived the run" : ""}`, 3000);
      else setConflicts(outcome.conflicts);
    } catch (err) {
      showToast((err as Error).message, 5000);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="ship-panel">
      <div class="row">
        <label class="lbl">Merge into</label>
        <select class="field" value={target} onChange={(e) => setInto(e.currentTarget.value)}>
          {branches.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
        <label class="check">
          <input type="checkbox" checked={archiveAfter} onChange={(e) => setArchiveAfter(e.currentTarget.checked)} /> archive the run afterwards (removes its worktrees, keeps branches)
        </label>
        <button class="btn primary small" disabled={busy || !target} onClick={merge}>
          {busy ? "Merging…" : `Merge into ${target || "…"}`}
        </button>
      </div>
      <div class="help">If {target || "the branch"} is checked out, code-flow merges there only when it has no uncommitted changes, and aborts cleanly on conflicts.</div>
      {conflicts ? (
        <div class="conflicts">
          <div class="msg warn">
            Merging would conflict in {conflicts.length} file{conflicts.length === 1 ? "" : "s"}: {conflicts.join(", ")}
          </div>
          <div class="row">
            <span>Ask</span>
            <AgentPicker value={agent} onChange={setAgent} />
            <span>
              to merge {target} into this branch and resolve them, then merge again.
            </span>
            <button
              class="btn small"
              onClick={() =>
                post(`/api/runs/${run.id}/followups`, { kind: "resolve-conflicts", worktree, agent, mergeFrom: target }).then(
                  () => showToast("Sent — the agent is resolving the conflicts"),
                  (e) => showToast(e.message, 5000),
                )
              }
            >
              Ask to resolve
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function PrPanel({ run, branch }: { run: RunSummary; branch: string }) {
  const { branches, initial } = useTargetBranches(run);
  const [into, setInto] = useState("");
  const [busy, setBusy] = useState(false);
  const target = into || initial;
  return (
    <div class="ship-panel">
      <div class="row">
        <label class="lbl">Pull request into</label>
        <select class="field" value={target} onChange={(e) => setInto(e.currentTarget.value)}>
          {branches.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
        <button
          class="btn primary small"
          disabled={busy || !target}
          onClick={async () => {
            setBusy(true);
            try {
              const { url } = await post<{ url: string }>(`/api/runs/${run.id}/pr`, { branch, into: target });
              showToast("Pull request opened", 3000);
              window.open(url, "_blank", "noreferrer");
            } catch (err) {
              showToast((err as Error).message, 6000);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Opening…" : "Push & open PR"}
        </button>
      </div>
      <div class="help">
        This pushes <code>{branch}</code> to <code>origin</code> and opens a pull request with GitHub CLI (<code>gh</code>), using the run's task and summary as the description.
      </div>
    </div>
  );
}

const existsHint = (run: RunSummary) => !run.archived; // archived runs may have had their worktrees removed

/** Try a result: open its worktree in your tools, or run the app from it. */
function WorkspaceTools({ run, worktree }: { run: RunSummary; worktree: string }) {
  const base = `/api/runs/${run.id}/worktrees/${encodeURIComponent(worktree)}`;
  const [server, setServer] = useState<{ url: string; status: string; logs: string[]; command: string; exitCode?: number | null } | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const [command, setCommand] = useState(run.app?.command ?? "");
  useEffect(() => {
    let alive = true;
    const poll = () => api(base + "/serve").then((s) => alive && setServer(s), () => {});
    poll();
    const timer = setInterval(poll, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [base]);
  const open = (target: string) =>
    post<{ openedWith: string }>(`${base}/open`, { target }).then((r) => showToast(`Opened in ${r.openedWith}`), (e) => showToast(e.message, 5000));
  return (
    <div class="ws-tools">
      <span class="lbl">Try it</span>
      <button class="btn small" onClick={() => open("terminal")}>
        Terminal
      </button>
      <button class="btn small" onClick={() => open("editor")}>
        Editor
      </button>
      <button class="btn small" onClick={() => open("finder")}>
        Folder
      </button>
      {server?.status === "running" ? (
        <>
          <a class="btn small primary" href={server.url} target="_blank" rel="noreferrer">
            Open {server.url.replace("http://", "")} ↗
          </a>
          <button class="btn small" onClick={() => setShowLogs(!showLogs)}>
            {showLogs ? "Hide logs" : "Logs"}
          </button>
          <button class="btn small danger" onClick={() => api(base + "/serve", { method: "DELETE" }).then(() => setServer(null))}>
            Stop app
          </button>
        </>
      ) : (
        <>
          <input class="field inline mono" placeholder="npm run dev" value={command} onInput={(e) => setCommand(e.currentTarget.value)} title="How to start the app; it gets a free port in $PORT" />
          <button
            class="btn small"
            disabled={!command.trim()}
            onClick={() => post(base + "/serve", { command }).then(setServer, (e) => showToast(e.message, 5000))}
          >
            ▶ Run app
          </button>
          {server?.status === "exited" ? <span class="msg warn">exited ({server.exitCode})</span> : null}
        </>
      )}
      {showLogs && server ? <pre class="serve-logs">{server.logs.slice(-80).join("\n") || "(no output yet)"}</pre> : null}
    </div>
  );
}

export function AgentPicker({ value, onChange }: { value: AgentId; onChange: (id: AgentId) => void }) {
  return (
    <select class="field inline" value={value} onChange={(e) => onChange(e.currentTarget.value as AgentId)}>
      {agents.value
        .filter((a) => a.available)
        .map((a) => (
          <option key={a.id} value={a.id}>
            {a.displayName}
          </option>
        ))}
    </select>
  );
}

function ArchiveDialog({ run, onClose }: { run: RunSummary; onClose: () => void }) {
  const [cleanup, setCleanup] = useState(true);
  const [deleteBranches, setDeleteBranches] = useState(false);
  const ref = useDialog(true, onClose);
  return (
    <dialog class="picker small-dialog" ref={ref}>
      <div class="picker-inner">
        <div class="picker-head">
          <h3>Archive this run</h3>
        </div>
        <div class="dialog-body">
          <label class="check">
            <input type="checkbox" checked={cleanup} onChange={(e) => setCleanup(e.currentTarget.checked)} /> Remove its {(run.worktrees ?? []).length} worktree
            {(run.worktrees ?? []).length === 1 ? "" : "s"} (uncommitted changes in them are lost)
          </label>
          <label class="check">
            <input type="checkbox" checked={deleteBranches} disabled={!cleanup} onChange={(e) => setDeleteBranches(e.currentTarget.checked)} /> Also delete its branches
            {run.merges?.length ? "" : " (nothing from this run has been merged yet)"}
          </label>
          <div class="help">Kept branches can be resumed or merged later; Resume re-attaches them.</div>
        </div>
        <div class="picker-foot">
          <span class="ps" />
          <button class="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            class="btn primary"
            onClick={() =>
              post(`/api/runs/${run.id}/archive`, { cleanup, deleteBranches }).then(
                () => {
                  showToast("Archived");
                  onClose();
                },
                (e) => showToast(e.message, 5000),
              )
            }
          >
            Archive
          </button>
        </div>
      </div>
    </dialog>
  );
}

// ---------------------------------------------------------------- talking to the team
function AwaitingCard({ run }: { run: RunSummary }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const answer = async (decision: "approve" | "revise" | "reject") => {
    if (decision === "reject" && !confirm("Reject and end the run? Nothing will be built.")) return;
    setBusy(true);
    try {
      await post(`/api/runs/${run.id}/answer`, { decision, note });
      setNote("");
    } catch (err) {
      showToast((err as Error).message, 4000);
    } finally {
      setBusy(false);
    }
  };
  const awaiting = run.awaiting!;
  return (
    <div class="awaiting-card">
      <div class="aw-head">
        <span class="status-pill awaiting">Waiting for you</span>
        <b>{awaiting.title}</b>
        <span class="help">The run is paused, and so is its time budget.</span>
      </div>
      <div class="aw-body">
        <Markdown text={awaiting.content} />
      </div>
      <div class="aw-actions">
        <textarea class="field" rows={2} placeholder="What should change? (needed for “Ask for changes”, optional otherwise)" value={note} onInput={(e) => setNote(e.currentTarget.value)} />
        <div class="row">
          <button class="btn primary" disabled={busy} onClick={() => answer("approve")}>
            ✓ Approve
          </button>
          <button class="btn" disabled={busy || !note.trim()} onClick={() => answer("revise")} title={note.trim() ? "" : "Write what should change first"}>
            Ask for changes
          </button>
          <button class="btn danger" disabled={busy} onClick={() => answer("reject")}>
            Reject
          </button>
        </div>
      </div>
    </div>
  );
}

/** While running: message the team. After it finishes: reply to an agent, or the whole team. */
function ConversationBar({ run, steps }: { run: RunSummary; steps: Step[] }) {
  const [text, setText] = useState("");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const running = run.status === "running";
  // Who you can talk to after the run: each agent that wrote code, in its worktree.
  const writers = [
    ...new Map(
      steps.filter((s) => (s.kind ?? "agent") === "agent" && s.mode === "write" && s.agent && s.worktree).map((s) => [`${s.agent}@${s.worktree}`, s]),
    ).values(),
  ];
  const teamAgents = [...new Set(Object.values(run.roles).flat())];
  const defaultTarget = running ? "" : writers.at(-1) ? `${writers.at(-1)!.agent}@${writers.at(-1)!.worktree}` : "team";
  const chosen = target || defaultTarget;
  if (!running && run.status !== "done") return null;

  const send = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      if (running) {
        await post(`/api/runs/${run.id}/notes`, { text, agent: chosen || undefined });
        showToast(chosen ? `Queued for ${chosen}'s next turn` : "Queued for the next agent's turn");
      } else if (chosen === "team") {
        const base = run.artifacts[0]?.branch ?? run.baseLabel;
        const { id } = await post<{ id: string }>("/api/runs", {
          repo: run.repo,
          task: `${run.task}\n\n## Feedback on the previous attempt\n${text.trim()}`,
          pattern: run.pattern,
          roles: run.roles,
          options: run.options,
          baseRef: base === "HEAD" ? "" : base,
          context: { paths: (run.context?.paths ?? []).map((c) => ({ path: c.path })) },
          agentSettings: run.agentSettings,
          loop: run.loop,
          approvals: run.approvals,
          parentRunId: run.id,
        });
        route.value = { view: "run", id };
      } else {
        const [agent, worktree] = chosen.split("@");
        await post(`/api/runs/${run.id}/followups`, { kind: "reply", agent, worktree, message: text });
        showToast("Sent — the agent is on it");
      }
      setText("");
    } catch (err) {
      showToast((err as Error).message, 5000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="convo">
      {running && run.notes?.length ? (
        <div class="notes">
          {run.notes.map((n) => (
            <span key={n.id} class={`chip-ctx note-chip ${n.status}`} title={n.text}>
              <span class="n">
                {n.status === "delivered" ? `✓ delivered to ${n.deliveredTo?.agent}` : `⏳ queued for ${n.agent ?? "next agent"}`}: {n.text}
              </span>
            </span>
          ))}
        </div>
      ) : null}
      <div class="convo-row">
        <span class="lbl">{running ? "Message the team" : "Reply"}</span>
        <select class="field inline" value={chosen} onChange={(e) => setTarget(e.currentTarget.value)}>
          {running ? (
            <>
              <option value="">next agent to take a turn</option>
              {teamAgents.map((a) => (
                <option key={a} value={a}>
                  {a}'s next turn
                </option>
              ))}
            </>
          ) : (
            <>
              {writers.map((s) => (
                <option key={`${s.agent}@${s.worktree}`} value={`${s.agent}@${s.worktree}`}>
                  {s.agent} in {s.worktree} (continues its session)
                </option>
              ))}
              <option value="team">the whole team again (new run from this result)</option>
            </>
          )}
        </select>
        <input
          class="field"
          placeholder={running ? "e.g. Use the existing logger instead of console.log" : "e.g. Also handle the empty-input case"}
          value={text}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button class="btn primary" disabled={busy || !text.trim()} onClick={send}>
          Send
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- transcript
function Transcript({ run, step, events }: { run: RunSummary; step?: Step; events: AgentEvent[] }) {
  const body = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    if (stick.current && body.current) body.current.scrollTop = body.current.scrollHeight;
  });
  if (!step) {
    return (
      <div class="transcript">
        <div class="tr-head">Select a step to see what the agent is doing</div>
      </div>
    );
  }
  const items = transcriptItems(events, step.agent === "agy");
  return (
    <div class="transcript">
      <div class="tr-head">
        <span class="tt">{step.title}</span>
        <StepTag step={step} model={modelNote(run, step.agent)} />
        <span>{(step.kind ?? "agent") === "agent" ? (step.mode === "write" ? "can edit files" : "read-only") : "run by code-flow"}</span>
        <span>worktree {step.worktree}</span>
        <span class={`status-pill ${step.status}`}>{STATUS_TEXT[step.status] ?? step.status}</span>
      </div>
      <div
        class="tr-body"
        ref={body}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        {items.map((item, i) => {
          switch (item.kind) {
            case "text":
              return (
                <div key={i} class="ev text">
                  {item.text}
                </div>
              );
            case "thinking":
              return (
                <div key={i} class="ev thinking">
                  {item.text.slice(0, 800)}
                </div>
              );
            case "tool":
              return (
                <details key={i} class={`ev tool ${item.isError ? "err" : ""}`}>
                  <summary>
                    <b>{item.name}</b> {item.input.replace(/\s+/g, " ").slice(0, 140)}
                  </summary>
                  <pre>{item.input}</pre>
                  {item.output !== undefined ? <pre>{item.output || "(no output)"}</pre> : null}
                </details>
              );
            case "status":
              return (
                <div key={i} class="ev status">
                  {item.text}
                </div>
              );
            case "error":
              return (
                <div key={i} class="ev error">
                  {item.text}
                </div>
              );
          }
        })}
      </div>
    </div>
  );
}

type Item =
  | { kind: "text" | "thinking" | "status" | "error"; text: string }
  | { kind: "tool"; name: string; input: string; output?: string; isError?: boolean };

function transcriptItems(events: AgentEvent[], streamsDeltas: boolean): Item[] {
  const items: Item[] = [];
  const tools = new Map<string, Extract<Item, { kind: "tool" }>>();
  for (const e of events) {
    const last = items.at(-1);
    switch (e.kind) {
      case "text":
        // agy streams small deltas; the other CLIs send whole blocks.
        if (streamsDeltas && last?.kind === "text") last.text += e.text;
        else items.push({ kind: "text", text: e.text });
        break;
      case "thinking":
        items.push({ kind: "thinking", text: e.text });
        break;
      case "tool_call": {
        const tool = { kind: "tool" as const, name: e.name, input: e.input };
        tools.set(e.callId, tool);
        items.push(tool);
        break;
      }
      case "tool_result": {
        const tool = tools.get(e.callId);
        if (tool) {
          tool.output = e.output;
          tool.isError = e.isError;
        }
        break;
      }
      case "status":
        items.push({ kind: "status", text: e.text });
        break;
      case "error":
        items.push({ kind: "error", text: e.message });
        break;
      case "usage": {
        const parts = [e.inputTokens && `${e.inputTokens.toLocaleString()} in`, e.outputTokens && `${e.outputTokens.toLocaleString()} out`].filter(Boolean);
        if (parts.length) items.push({ kind: "status", text: `tokens: ${parts.join(" · ")}` });
        break;
      }
    }
  }
  return items;
}

// ---------------------------------------------------------------- edit & run again
function editAndRerun(run: RunSummary) {
  setPattern(run.pattern);
  roleSel.value = { ...roleSel.value, [run.pattern]: { ...(roleSel.value[run.pattern] ?? {}), ...run.roles } };
  optionValues.value = { ...optionValues.value, [run.pattern]: { ...run.options } };
  setTask(run.task);
  const restore = () => {
    contextPaths.value = new Map((run.context?.paths ?? []).map((c) => [c.path, { path: c.path, type: c.type }]));
    attachments.value = [];
    if (run.context?.attachments?.length) showToast("Attached files aren't kept — attach them again if needed", 4000);
    checkCmd.value = run.loop?.check ?? "";
    setupCmd.value = run.loop?.setup ?? "";
    limits.value = { maxMinutes: run.loop?.maxMinutes ?? 60, maxSteps: run.loop?.maxSteps ?? 40 };
    source.value = run.source
      ? {
          kind: run.source.kind,
          number: run.source.number,
          title: run.source.title,
          url: run.source.url,
          headRefName: run.source.headRefName,
          baseRefName: run.source.baseRefName,
          isCrossRepository: run.source.isCrossRepository,
          ciLogs: !!run.source.ci,
        }
      : null;
  };
  route.value = { view: "composer" };
  if (run.repo !== repo.value) void setRepo(run.repo).then(restore);
  else restore();
}
