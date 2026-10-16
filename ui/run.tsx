import { Component } from "preact";
import { useEffect, useReducer, useRef, useState } from "preact/hooks";
import { useDialog } from "./app.js";
import { AgentTag, Markdown } from "./bits.js";
import { TriageActions } from "./automations.js";
import { Icon } from "./icons.js";
import { api, baseName, copy, duration, fmtCost, fmtSize, fmtTokens, post, SHORT, showToast, STATUS_TEXT } from "./lib.js";
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
import type { AgentEvent, AgentId, Artifact, FollowUp, IntegrityIssue, MergeOutcome, Note, RepoInfo, RunEvent, RunSummary, Step } from "./types.js";

const STEP_ICON: Record<string, string> = { done: "✓", failed: "✕", cancelled: "■", interrupted: "⏸" };
const modelNote = (run: RunSummary | null, id?: AgentId) =>
  run && id ? [run.agentSettings?.[id]?.model, run.agentSettings?.[id]?.effort].filter(Boolean).join(" · ") : "";

interface RunData {
  steps: Map<string, Step>;
  events: Map<string, AgentEvent[]>;
  /** Transcript items per step, built incrementally as events arrive (see itemsFor). */
  built: Map<string, Built>;
  logs: { ts: number; level: string; text: string }[];
  seen: Set<number>;
}

export function RunView({ id }: { id: string }) {
  const [run, setRun] = useState<RunSummary | null>(null);
  const data = useRef<RunData>({ steps: new Map(), events: new Map(), built: new Map(), logs: [], seen: new Set() });
  const [, bump] = useReducer((x: number) => x + 1, 0);
  /** The step whose transcript is open; "" when you closed it. */
  const [selected, setSelected] = useState<string | null>(null);
  /** The work section: open while running and closed once there's a result, unless you toggled it. */
  const [workOpen, setWorkOpen] = useState<boolean | null>(null);
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
      // Batch bursts of events into one render per frame. Browsers pause animation frames in
      // background tabs and hidden panes, so a timer renders there too (throttled, but it renders).
      if (!scheduled) {
        scheduled = true;
        const flush = () => {
          if (!scheduled) return;
          scheduled = false;
          bump(0);
        };
        requestAnimationFrame(flush);
        setTimeout(flush, 250);
      }
    };
    return () => source.close();
  }, [id]);

  useEffect(() => {
    if (run && run.status !== "running" && !run.seen && !document.hidden) void markSeen(run.id);
  }, [run?.status, run?.seen]);

  // [ and ] step through the timeline.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== "[" && e.key !== "]") || e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.target as HTMLElement | null)?.closest("input, textarea, select, dialog")) return;
      const ids = [...data.current.steps.keys()];
      if (!ids.length) return;
      e.preventDefault();
      follow.current = false;
      setWorkOpen(true);
      setSelected((cur) => {
        const at = ids.indexOf(cur ?? ids.at(-1)!);
        return ids[Math.min(ids.length - 1, Math.max(0, (at < 0 ? ids.length - 1 : at) + (e.key === "]" ? 1 : -1)))]!;
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // Bring a step you picked (or the live one being followed) into view; not on load.
  useEffect(() => {
    if (selected) document.querySelector(".tl-step.selected")?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  if (!run)
    return (
      <div class="runview">
        <div class="run-scroll">
          <div class="thread help">Loading…</div>
        </div>
      </div>
    );
  const steps = [...data.current.steps.values()];
  const current = selected === "" ? null : selected && data.current.steps.has(selected) ? selected : steps.at(-1)?.id ?? null;
  const finished = run.status !== "running";
  const showWork = workOpen ?? !finished;
  /** Open a step's transcript (from the result card, say), opening the work section too. */
  const selectStep = (stepId: string) => {
    follow.current = false;
    setWorkOpen(true);
    setSelected(stepId);
  };
  const toggleStep = (stepId: string) => {
    follow.current = false;
    setSelected(stepId === current ? "" : stepId);
  };
  const p = patterns.value.find((x) => x.id === run.pattern);
  const state = runState(run);

  return (
    <div class="runview">
      <div class="run-scroll">
        <header class="run-head">
          <div class="run-title">
            <span class={`status-pill ${run.awaiting ? "awaiting" : state}`}>
              {run.awaiting ? "Waiting for you" : state === "failing" ? "Done · check failing" : STATUS_TEXT[run.status] ?? run.status}
            </span>
            <h2 title={run.task}>{run.task.split("\n")[0] || "(no task)"}</h2>
            <span class="run-pattern">{p?.name ?? run.pattern}</span>
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
        </header>

        <div class="thread">
          <RunMeta run={run} />
          {run.lockdown ? (
            <div class="lockdown" role="note">
              🔒 <b>Locked down.</b> {run.lockdown}, so agents run in Safe mode, files like .env aren't copied in, and checks{" "}
              {run.loop.container ? "run in Docker without network" : "run on this machine because you allowed it"}.
            </div>
          ) : null}

          {/* Your task, as the message that started the conversation. */}
          <div class="msg-you">
            <div class="bubble">
              <div class="run-task">
                <Markdown text={run.task} />
              </div>
              <RunChips run={run} />
              {run.parentRunId ? (
                <a class="help" href={`#/run/${run.parentRunId}`}>
                  ↩ continues an earlier run
                </a>
              ) : null}
            </div>
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

          {/* The agents' work: one disclosure, each step opening inline to its transcript. */}
          <details class={`work ${finished ? "" : "live"}`} open={showWork}>
            <summary
              onClick={(e) => {
                e.preventDefault();
                setWorkOpen(!showWork);
              }}
            >
              <WorkSummary run={run} steps={steps} />
            </summary>
            <div class="steps" role="list" aria-label="Steps ([ and ] to move)">
              {steps.length ? (
                steps.map((s) => (
                  <div key={s.id} role="listitem" class={`step ${s.id === current ? "open" : ""}`}>
                    <button
                      type="button"
                      class={`tl-step ${s.id === current ? "selected" : ""}`}
                      aria-expanded={s.id === current}
                      aria-label={`${s.title}: ${STATUS_TEXT[s.status] ?? s.status}`}
                      onClick={() => toggleStep(s.id)}
                    >
                      <span class={`ic ${s.status}`} aria-hidden="true">
                        {STEP_ICON[s.status] ?? ""}
                      </span>
                      <span class="tt">{s.title}</span>
                      <span class="tm">
                        <StepTag step={s} />
                        <span>{(s.kind ?? "agent") === "agent" ? s.role : s.finalText || "running…"}</span>
                        {s.endedAt ? <span>{duration(s.endedAt - s.startedAt)}</span> : null}
                        {s.usage ? <span title={usageTitle(s.usage)}>{fmtTokens(s.usage.inputTokens + s.usage.outputTokens)} tok</span> : null}
                        {s.retries ? <span title="Retried after a passing failure (overloaded, network)">↻{s.retries}</span> : null}
                      </span>
                    </button>
                    {/* The data is mutated in place; `version` changes as events arrive so the transcript re-renders. */}
                    {s.id === current ? <Transcript run={run} step={s} data={data.current} version={data.current.events.get(s.id)?.length ?? 0} /> : null}
                  </div>
                ))
              ) : (
                <div class="tl-empty">Starting…</div>
              )}
            </div>
          </details>

          {finished ? <ResultCard run={run} steps={steps} onSelectStep={selectStep} /> : null}
          <FollowUpThread run={run} />
          <ActivityLog logs={data.current.logs} count={data.current.logs.length} />
        </div>
      </div>

      <ConversationBar run={run} steps={steps} />
      {archiving ? <ArchiveDialog run={run} onClose={() => setArchiving(false)} /> : null}
    </div>
  );
}

/** One line for the work section: what's happening now, or how the work went. */
function WorkSummary({ run, steps }: { run: RunSummary; steps: Step[] }) {
  const live = steps.filter((s) => s.status === "running");
  const failed = steps.filter((s) => s.status === "failed").length;
  const who = [...new Set(steps.map((s) => s.agent).filter((a): a is AgentId => !!a))];
  const took = duration((run.endedAt ?? Date.now()) - run.createdAt);
  return (
    <>
      <span class={`work-ic ${run.status === "running" ? "running" : ""}`} aria-hidden="true" />
      <span class="work-title">
        {run.status === "running" ? (live.length ? `Working — ${live.map((s) => s.title).join(", ")}` : "Working…") : `${steps.length} step${steps.length === 1 ? "" : "s"}`}
      </span>
      <span class="work-meta">
        {run.status === "running" ? `${steps.length} step${steps.length === 1 ? "" : "s"} so far · ${took}` : took}
        {failed ? <span class="warn"> · {failed} failed</span> : null}
      </span>
      <span class="work-agents">
        {who.map((a) => (
          <AgentTag key={a} id={a} />
        ))}
      </span>
      <span class="work-chev" aria-hidden="true" />
    </>
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
      <span title={run.repo} class="repo-line">
        <Icon name="folder" /> {baseName(run.repo)}
      </span>
      {run.trigger ? (
        <a class="src-link" href="#/automations" title={`Started by ${run.trigger.via === "schedule" ? "its schedule" : run.trigger.via === "webhook" ? "a webhook" : run.trigger.via === "sweep" ? "a sweep" : "Run now"}`}>
          {run.trigger.via === "sweep" ? "▤" : "⏱"} {run.trigger.name}
        </a>
      ) : null}
      {run.triage && run.triage.state !== "pending" ? <span class="badge">{run.triage.state === "empty" ? "no changes · archived" : run.triage.state}</span> : null}
      {run.source ? (
        <a class="src-link" href={run.source.url} target="_blank" rel="noreferrer" title={run.source.title}>
          {run.source.kind === "issue"
            ? `◎ issue #${run.source.number}`
            : run.source.kind === "pr"
              ? `⇄ PR #${run.source.number}`
              : `⚠ ${run.source.alert?.tool === "dependabot" ? "Dependabot" : "code scanning"} alert ${(run.source.alert?.numbers ?? [run.source.number]).map((n) => `#${n}`).join(", ")}`}{" "}
          ↗
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
      {run.group ? (
        <a class="src-link" href={`#/insights/${encodeURIComponent(run.group.id)}`} title="Started together with other setups on the same task">
          ⚖ comparison: {run.group.label}
        </a>
      ) : null}
      {run.conventions ? <span title="The repo's AGENTS.md, CLAUDE.md… are given to every agent">📘 conventions</span> : null}
      {run.lessons?.length ? (
        <span title={`Problems reviewers raised in earlier runs here, given to every agent:\n${run.lessons.map((l) => `• ${l}`).join("\n")}`}>🧠 {run.lessons.length} lesson{run.lessons.length === 1 ? "" : "s"}</span>
      ) : null}
      {run.usage ? (
        <span class="usage">
          {run.usage.agentSteps}/{run.loop.maxSteps} agent steps · {duration((run.endedAt ?? Date.now()) - run.createdAt)} of {run.loop.maxMinutes} min
          {run.usage.inputTokens || run.usage.outputTokens ? (
            <span title={agentUsageTitle(run)}>
              {" "}
              · {fmtTokens((run.usage.inputTokens ?? 0) + (run.usage.outputTokens ?? 0))} tokens
              {run.usage.costUsd ? ` · ≈${fmtCost(run.usage.costUsd)} API-equivalent` : ""}
            </span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

const usageTitle = (u: NonNullable<Step["usage"]>) =>
  `${u.inputTokens.toLocaleString()} input · ${u.outputTokens.toLocaleString()} output · ${u.cacheReadTokens.toLocaleString()} cached${u.costUsd ? ` · ≈${fmtCost(u.costUsd)}` : ""}`;

const agentUsageTitle = (run: RunSummary) =>
  Object.entries(run.usage.byAgent ?? {})
    .map(([agent, u]) => `${agent}: ${u!.steps} steps, ${fmtTokens(u!.inputTokens + u!.outputTokens)} tokens${u!.costUsd ? `, ≈${fmtCost(u!.costUsd)}` : ""}, ${duration(u!.ms)}`)
    .join("\n");

// ---------------------------------------------------------------- result & shipping
function ResultCard({ run, steps, onSelectStep }: { run: RunSummary; steps: Step[]; onSelectStep: (id: string) => void }) {
  const state = runState(run);
  const failedSteps = steps.filter((s) => s.status === "failed");
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
      {failedSteps.length && run.status !== "done" ? (
        <div class="failures">
          <div class="lbl">What went wrong</div>
          {failedSteps.slice(-5).map((s) => (
            <button key={s.id} type="button" class="failure" onClick={() => onSelectStep(s.id)}>
              <span class="ic failed" aria-hidden="true">
                ✕
              </span>
              <b>{s.title}</b> <StepTag step={s} />
              <span class="fe">{(s.error ?? s.finalText ?? "").split("\n")[0]!.slice(0, 200)}</span>
            </button>
          ))}
        </div>
      ) : null}
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

/** What was sent back after the run and what the agent answered, as the rest of the conversation. */
function FollowUpThread({ run }: { run: RunSummary }) {
  if (!run.followUps?.length) return null;
  return (
    <>
      {run.followUps.map((f) => (
        <div key={f.id} class="fu">
          {f.kind === "reply" || (f.kind === "comments" && !f.from) ? (
            <div class="msg-you">
              <div class="bubble">
                <Markdown text={f.message} />
              </div>
            </div>
          ) : (
            <div class="fu-sent help">
              {f.kind === "resolve-conflicts" ? `Sent ${f.mergeFrom}'s merge conflicts to` : f.kind === "ci-fix" ? "Sent the pull request's failing CI to" : `Sent ${f.from}'s comments to`}{" "}
              <AgentTag id={f.agent} />
            </div>
          )}
          <div class={`fu-answer ${f.status}`}>
            <div class="fu-head">
              <AgentTag id={f.agent} />
              <span>
                {followUpLabel(f)} in {f.worktree}
              </span>
              {f.status === "pending" ? <span class="fu-live">working…</span> : f.status === "failed" ? <span class="err">✕ didn't finish</span> : null}
              {f.pushed ? <span class="ok">pushed {f.pushed.slice(0, 7)}</span> : f.pushError ? <span class="note">push failed: {f.pushError}</span> : null}
              {f.checkPassed === false ? <span class="note">check fails</span> : f.checkPassed ? <span class="ok">check passes</span> : null}
              {f.integrity?.length ? (
                <span class="note" title={f.integrity.map((i) => `${i.file}: ${i.detail}`).join("\n")}>
                  ⚠ changed tests
                </span>
              ) : null}
            </div>
            {f.result ? <Markdown text={f.result} /> : null}
          </div>
        </div>
      ))}
    </>
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
      {run.integrity?.[artifact.branch]?.length ? <IntegrityNote issues={run.integrity[artifact.branch]!} /> : null}
      {artifact.stat ? <pre>{artifact.stat}</pre> : <div class="help">No changes</div>}
      {worktree && existsHint(run) ? <WorkspaceTools run={run} worktree={worktree.name} /> : null}
      {panel === "merge" && worktree ? <MergePanel run={run} branch={artifact.branch} worktree={worktree.name} steps={steps} /> : null}
      {panel === "pr" ? <PrPanel run={run} branch={artifact.branch} /> : null}
      {pr && worktree ? <WatchPanel run={run} branch={artifact.branch} steps={steps} worktree={worktree.name} /> : null}
    </div>
  );
}

/** Test changes that could make the check pass without fixing anything: look before merging. */
function IntegrityNote({ issues }: { issues: IntegrityIssue[] }) {
  return (
    <div class="integrity" role="note">
      <b>⚠ Changes to tests to check before merging</b>
      <span class="help"> — they can make the check pass without a real fix.</span>
      <ul>
        {issues.map((i, n) => (
          <li key={n}>
            <span class={`sev ${i.severity}`}>{i.severity}</span> {i.file ? <code>{i.file}</code> : null} {i.detail}
          </li>
        ))}
      </ul>
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

/** PR follow-through: fix failing CI and comments from you (or people you name), push; never merge. */
function WatchPanel({ run, branch, steps, worktree }: { run: RunSummary; branch: string; steps: Step[]; worktree: string }) {
  const watch = run.watches?.[branch];
  const active = watch && ["watching", "fixing", "green"].includes(watch.state);
  const [agent, setAgent] = useState<AgentId>(watch?.agent ?? lastAgentIn(steps, worktree) ?? "claude");
  const [maxFixes, setMaxFixes] = useState(watch?.maxFixes ?? 3);
  const [allow, setAllow] = useState((watch?.allow ?? []).map((a) => `@${a}`).join(", "));
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
            {` · acts on comments from you${watch.allow?.length ? `, ${watch.allow.map((a) => `@${a}`).join(", ")}` : ""}`}
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
          <span>When CI fails or you comment,</span>
          <AgentPicker value={agent} onChange={setAgent} />
          <span>fixes it and pushes — up to</span>
          <input class="field inline num" type="number" min={1} max={10} value={maxFixes} aria-label="Most fixes" onInput={(e) => setMaxFixes(Number(e.currentTarget.value) || 3)} />
          <span>times. Never merges.</span>
          <button
            class="btn small primary"
            onClick={() =>
              call({
                agent,
                maxFixes,
                allow: allow
                  .split(/[\s,]+/)
                  .map((a) => a.replace(/^@/, ""))
                  .filter(Boolean),
              })
            }
          >
            {watch ? "Watch again" : "Watch PR"}
          </button>
        </div>
      ) : null}
      {!active && watch?.state !== "closed" ? (
        <div class="row">
          <span class="help">Also act on comments from</span>
          <input class="field inline" placeholder="@teammate, @reviewer" value={allow} aria-label="Other GitHub users whose comments the agent acts on" onInput={(e) => setAllow(e.currentTarget.value)} />
          <span class="help">— nobody else's, since these fixes are pushed without anyone reviewing them first.</span>
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
  // Only branches that are on GitHub now: the run's starting branch may have been merged and deleted.
  const [targets, setTargets] = useState<{ branches: string[]; initial: string } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<{ branches: string[]; initial: string }>(`/api/runs/${run.id}/pr-targets`).then(setTargets, (e) => setError((e as Error).message));
  }, [run.id]);
  const [into, setInto] = useState("");
  const [busy, setBusy] = useState(false);
  const target = into || targets?.initial || "";
  return (
    <div class="ship-panel">
      <div class="row">
        <label class="lbl">Pull request into</label>
        <select class="field" value={target} disabled={!targets} onChange={(e) => setInto(e.currentTarget.value)}>
          {targets ? null : <option value="">{error ? "—" : "Asking GitHub…"}</option>}
          {(targets?.branches ?? []).filter((b) => b !== branch).map((b) => (
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
      {error ? <div class="msg warn">{error}</div> : null}
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

/** Which step a delivered note reached, and whether it arrived during the turn. */
function noteStep(note: Note, steps: Step[]): string {
  const step = steps.find((s) => s.id === note.deliveredTo?.stepId);
  if (!step) return "";
  return note.deliveredTo?.midTurn ? ` mid-turn (${step.title})` : ` (${step.title})`;
}

/** While running: message the team. After it finishes: reply to an agent, or the whole team. */
function ConversationBar({ run, steps }: { run: RunSummary; steps: Step[] }) {
  const [text, setText] = useState("");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  // The box grows with what you type, up to a limit (then it scrolls).
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);
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
        const note = await post<Note>(`/api/runs/${run.id}/notes`, { text, agent: chosen || undefined });
        if (note.deliveredTo?.midTurn) showToast(`Sent into ${note.deliveredTo.agent}'s running turn`);
        else showToast(chosen ? `Queued for ${chosen}'s next turn` : "Queued for the next agent's turn");
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

  const [agentId, worktree] = chosen.split("@") as [AgentId, string | undefined];
  const name = SHORT[agentId] ?? agentId;
  const hint = running
    ? chosen
      ? `Steered into ${name}'s running turn if it takes messages, otherwise its next turn`
      : "Goes to the next agent that takes a turn"
    : chosen === "team"
      ? "Starts a new run with the same team, from this result"
      : `Continues ${name}'s session on its branch, in ${worktree}`;
  const placeholder = running ? "Message the team…" : chosen === "team" ? "Tell the team what to change…" : `Reply to ${name}…`;

  return (
    <div class="convo">
      <div class="convo-inner">
        {running && run.notes?.length ? (
          <div class="notes">
            {run.notes.map((n) => (
              <span key={n.id} class={`chip-ctx note-chip ${n.status}`} title={n.text}>
                <span class="n">
                  {n.status === "delivered" ? `✓ delivered to ${n.deliveredTo?.agent}${noteStep(n, steps)}` : `⏳ queued for ${n.agent ?? "next agent"}`}: {n.text}
                </span>
              </span>
            ))}
          </div>
        ) : null}
        <div class="chatbox">
          <textarea
            ref={area}
            rows={1}
            aria-label={running ? "Message the team" : "Reply"}
            placeholder={placeholder}
            value={text}
            onInput={(e) => setText(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div class="chatbox-bar">
            <label class="to">
              <span class="to-lbl">To</span>
              <select aria-label="Who gets this" value={chosen} onChange={(e) => setTarget(e.currentTarget.value)}>
                {running ? (
                  <>
                    <option value="">Next agent</option>
                    {teamAgents.map((a) => (
                      <option key={a} value={a}>
                        {SHORT[a] ?? a}
                      </option>
                    ))}
                  </>
                ) : (
                  <>
                    {writers.length ? (
                      <optgroup label="Continue a session">
                        {writers.map((s) => (
                          <option key={`${s.agent}@${s.worktree}`} value={`${s.agent}@${s.worktree}`}>
                            {SHORT[s.agent!] ?? s.agent} · {s.worktree}
                          </option>
                        ))}
                      </optgroup>
                    ) : null}
                    <optgroup label="Start again">
                      <option value="team">Whole team · new run</option>
                    </optgroup>
                  </>
                )}
              </select>
            </label>
            <span class="chatbox-hint" title={hint}>
              {hint}
            </span>
            <button class="send" aria-label="Send" title="Send (↵ — ⇧↵ for a new line)" disabled={busy || !text.trim()} onClick={send}>
              <Icon name="send" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- transcript
/** Only the latest items are rendered at first: a long step can have thousands. */
const PAGE = 200;

function Transcript({ run, step, data }: { run: RunSummary; step?: Step; data: RunData; version: number }) {
  const body = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [shown, setShown] = useState(PAGE);
  useEffect(() => setShown(PAGE), [step?.id]);
  useEffect(() => {
    if (stick.current && body.current) body.current.scrollTop = body.current.scrollHeight;
  });
  if (!step) return null;
  const items = itemsFor(data, step);
  const hidden = Math.max(0, items.length - shown);
  const model = modelNote(run, step.agent);
  return (
    <div class="transcript" aria-label={`Transcript of ${step.title}`}>
      <div class="tr-head">
        {model ? <span>{model}</span> : null}
        <span>{(step.kind ?? "agent") === "agent" ? (step.mode === "write" ? "can edit files" : "read-only") : "run by code-flow"}</span>
        <span>worktree {step.worktree}</span>
        {step.usage ? <span title={usageTitle(step.usage)}>{fmtTokens(step.usage.inputTokens + step.usage.outputTokens)} tokens{step.usage.costUsd ? ` · ≈${fmtCost(step.usage.costUsd)}` : ""}</span> : null}
        {step.status !== "done" ? <span class={`status-pill ${step.status}`}>{STATUS_TEXT[step.status] ?? step.status}</span> : null}
      </div>
      <div
        class="tr-body"
        ref={body}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        {hidden ? (
          <button
            type="button"
            class="btn small show-earlier"
            onClick={() => {
              stick.current = false;
              setShown(shown + PAGE * 5);
            }}
          >
            Show earlier ({hidden.toLocaleString()} hidden)
          </button>
        ) : null}
        {items.slice(hidden).map((item, i) => (
          <TranscriptRow key={hidden + i} item={item} v={item.v} />
        ))}
        {!items.length ? <div class="ev status">{step.status === "running" ? "Starting…" : "Nothing was recorded for this step."}</div> : null}
      </div>
    </div>
  );
}

/** One transcript entry; re-rendered only when it changes (text streamed in, a tool's output arrived). */
class TranscriptRow extends Component<{ item: Item; v: number }> {
  shouldComponentUpdate(next: { item: Item; v: number }) {
    return next.item !== this.props.item || next.v !== this.props.v;
  }
  render() {
    const { item } = this.props;
    switch (item.kind) {
      case "text":
        return (
          <div class="ev text">
            <Markdown text={item.text} />
          </div>
        );
      case "thinking":
        return (
          <details class="ev thinking">
            <summary>
              Thinking <span class="peek">{item.text.replace(/\s+/g, " ").slice(0, 120)}</span>
            </summary>
            <div class="think-body">{item.text}</div>
          </details>
        );
      case "tool":
        return (
          <details class={`ev tool ${item.isError ? "err" : ""}`}>
            <summary>
              <b>{item.name}</b> <span class="arg">{toolArg(item.input)}</span>
              {item.isError ? <span class="sr-only"> (failed)</span> : null}
            </summary>
            <pre>{item.input}</pre>
            {item.output !== undefined ? <pre>{item.output || "(no output)"}</pre> : null}
          </details>
        );
      case "status":
        return <div class="ev status">{item.text}</div>;
      case "error":
        return (
          <div class="ev error" role="alert">
            {item.text}
          </div>
        );
    }
  }
}

/** A tool call's one-line gist: its command, file, pattern or URL rather than the raw JSON. */
function toolArg(input: string): string {
  let value = input;
  try {
    const args = JSON.parse(input) as Record<string, unknown>;
    const key = ["command", "cmd", "file_path", "path", "pattern", "url", "query", "description"].find((k) => typeof args[k] === "string" && args[k]);
    if (key) {
      value = args[key] as string;
      // Paths inside a worktree read best from the repo root.
      if (key === "file_path" || key === "path") value = value.replace(/^.*\/\.worktrees\/[^/]+\/[^/]+\//, "");
    }
  } catch {
    // not JSON: show it as it is
  }
  return value.replace(/\s+/g, " ").slice(0, 200);
}

type Item = (
  | { kind: "text" | "thinking" | "status" | "error"; text: string }
  | { kind: "tool"; name: string; input: string; output?: string; isError?: boolean }
) & { /** bumped when the item changes in place */ v: number };

interface Built {
  items: Item[];
  tools: Map<string, Extract<Item, { kind: "tool" }>>;
  /** Events already turned into items. */
  count: number;
}

/** The step's transcript, extended with only the events that arrived since the last render. */
function itemsFor(data: RunData, step: Step): Item[] {
  const events = data.events.get(step.id) ?? [];
  let built = data.built.get(step.id);
  if (!built) {
    built = { items: [], tools: new Map(), count: 0 };
    data.built.set(step.id, built);
  }
  for (; built.count < events.length; built.count++) addItem(built, events[built.count]!, step.agent === "agy");
  return built.items;
}

function addItem(built: Built, e: AgentEvent, streamsDeltas: boolean) {
  const { items, tools } = built;
  const last = items.at(-1);
  switch (e.kind) {
    case "text":
      // agy streams small deltas; the other CLIs send whole blocks.
      if (streamsDeltas && last?.kind === "text") {
        last.text += e.text;
        last.v++;
      } else items.push({ kind: "text", text: e.text, v: 0 });
      break;
    case "thinking":
      items.push({ kind: "thinking", text: e.text, v: 0 });
      break;
    case "tool_call": {
      const tool = { kind: "tool" as const, name: e.name, input: e.input, v: 0 };
      tools.set(e.callId, tool);
      items.push(tool);
      break;
    }
    case "tool_result": {
      const tool = tools.get(e.callId);
      if (tool) {
        tool.output = e.output;
        tool.isError = e.isError;
        tool.v++;
      }
      break;
    }
    case "status":
      items.push({ kind: "status", text: e.text, v: 0 });
      break;
    case "error":
      items.push({ kind: "error", text: e.message, v: 0 });
      break;
    case "usage": {
      const parts = [
        e.inputTokens && `${e.inputTokens.toLocaleString()} in`,
        e.outputTokens && `${e.outputTokens.toLocaleString()} out`,
        e.cacheReadTokens && `${e.cacheReadTokens.toLocaleString()} cached`,
        e.costUsd && `≈${fmtCost(e.costUsd)}`,
      ].filter(Boolean);
      if (parts.length) items.push({ kind: "status", text: `tokens: ${parts.join(" · ")}`, v: 0 });
      break;
    }
  }
}

/** The run's log; long ones show the latest lines until you ask for all. */
function ActivityLog({ logs }: { logs: RunData["logs"]; count: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? logs : logs.slice(-300);
  const warnings = logs.filter((l) => l.level === "warn").length;
  return (
    <details class="activity">
      <summary>
        Activity log ({logs.length}){warnings ? <span class="warn"> · {warnings} warning{warnings === 1 ? "" : "s"}</span> : null}
      </summary>
      <div class="log">
        {shown.length < logs.length ? (
          <button type="button" class="linkish" onClick={() => setAll(true)}>
            Show all {logs.length.toLocaleString()} lines
          </button>
        ) : null}
        {shown.map((l, i) => (
          <div key={i} class={l.level}>
            {new Date(l.ts).toLocaleTimeString()} {l.text}
          </div>
        ))}
      </div>
    </details>
  );
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
          tool: run.source.alert?.tool,
          numbers: run.source.alert?.numbers,
        }
      : null;
  };
  route.value = { view: "composer" };
  if (run.repo !== repo.value) void setRepo(run.repo).then(restore);
  else restore();
}
