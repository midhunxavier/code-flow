import { scrollBehavior } from "./lib.js";
import { useMessageDraft } from "./message-draft.js";
import { appendDraftText, conversationAnswer, recoveryMessage, replySignInIssue } from "./conversation-feedback.js";
import { runTitle } from "../src/run-title.js";
import { planRejected, failedWork, dispatchLabel } from "../src/run-outcome.js";
import { BrowserMessage, BrowserDraftCards } from "./browser-context-cards.js";
import { browserImageNames, editBrowserText, parseBrowserMessage } from "./browser-context.js";
import { chatTaskId } from "../src/chat-family.js";
import { TaskTeamControl, TaskTeamActivity, TaskTeamStatus } from "./task-team.js";
import { TeamTemplateLibrary } from "./team-template-library.js";
import { templateFromPlan, type TeamTemplate } from "../src/team-templates.js";
import { confirmAction } from "./confirm-state.js";
import { pendingApprovals } from "./approval-inbox.js";
import { DEFAULT_EXECUTION_BUDGET, coordinatorInvocationLimit } from "../src/execution-budget.js";
import { localAppUrls } from "../src/local-app-url.js";
import { intentDraft, LiveProgress, ResultStudio } from "./experience.js";
import { PREVIEW_REQUEST } from "./result-preview.js";
import { journeyDraft } from "./journeys.js";
import { rerunDraft } from "./rerun-draft.js";
import { setContextBudget } from "./context-budget.js";
import { nextRunAction, executionLabel, agentReviewLabel, declinedUnasked, chatProvider, branchesGone, runStateBadges, integrityFor, replyTargets } from "./run-experience.js";
import { IntegrityNote, MergeValidationGates, RunEvidence, VerificationEvidence } from "./run-evidence.js";
import { ArchiveDialog, DeleteRunDialog } from "./run-actions.js";
import { MissionRunNote, MissionTask, missionBrief, missionHref } from "./mission-brief.js";
import { Menu, MenuItem, MenuTitle, Strip } from "./panel-bits.js";
import { Component } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { useDialog } from "./app.js";
import { AgentTag, CantRunNote, Markdown } from "./bits.js";
import { TriageActions } from "./automations.js";
import { ChatControls, type ChatSettings, type ChatPermissions } from "./chat-controls.js";
import { runProviderProblem, narrowerTrust } from "../src/run-permissions.js";
import { Icon } from "./icons.js";
import { ago, api, ApiError, baseName, copy, duration, enc, fmtCost, fmtSize, fmtTokens, onPhone, post, safeHref, SHORT, showToast, showError, plural, agentName, STATUS_TEXT, usePoll } from "./lib.js";
import { loadLocalAttempts, localAttempts } from "./collab-state.js";
import {
  agents,
  loadAgentChats,
  rememberAgentTab,
  agentTabClosed,
  setAgentTabClosed,
  runs,
  agentSettings,
  optionValues,
  roleModels,
  baseRef,
  branchPrefix,
  externalSource,
  route,
  setAcceptanceCriteria,
  setApprovePlan,
  trust,
  chooseForDraft,
  RERUN_ORIGIN,
  unsentDraft,
  healthOpen,
  health,
  refreshProviders, providersRefreshing,
  attachments,
  setRunCheck,
  setRunSetup,
  setRunLimits,
  contextPaths,
  markSeen,
  patterns,
  repo,
  repoInfo,
  runState,
  setPattern,
  setRoles,
  setTask,
  source,
  projectFor,
  openComposer,
  composerRunOptions,
  composerLoading,
  draftsReady,
  navigate,
  openSideChat,
  openSide,
  openBrowserPage,
  chatDrafts,
  takeDrafts,
  rememberSide,
  sideMemo,
} from "./state.js";
import { ProjectChip } from "./projects.js";
import { AutoTeam, TeamQuestionCard } from "./team.js";
import { ProjectMemory } from "./memory.js";
import { GithubReviewThreadsPanel } from "./github-review-threads.js";
import { RemoteStepReceipt } from "./remote-workers.js";
import type { MergeValidation } from "../src/merge-validation.js";
import { loadStepTranscript, transcriptVersion, useRunStream, type RunData } from "./run-feed.js";
import { defaultFollowupCalls, followupMinimumCalls, teamAwaitingAnswer, teamNeedsResume, teamStatusLabel, wholeMinutes } from "./team-state.js";
import type { AgentEvent, AgentId, Artifact, Attachment, CheckedReview, FindingCheck, FollowUp, MergeMethod, MergeOutcome, Note, PrMergeInfo, Proof, RepoInfo, RunSummary, Step } from "./types.js";

const STEP_ICON: Record<string, string> = { done: "✓", failed: "✕", cancelled: "■", interrupted: "⏸" };
const openedAppTurns = new Set<string>();
const chatScroll = new Map<string, { top: number; follow: boolean }>();
const modelNote = (run: RunSummary | null, id?: AgentId, settings?: ChatSettings) => {
  const value = settings ?? (id ? run?.agentSettings?.[id] : undefined);
  return [value?.model, value?.effort].filter(Boolean).join(" · ");
};

export { useRunStream, type RunData } from "./run-feed.js";

export function RunView({ id }: { id: string }) {
  /** The step whose transcript is open; "" when you closed it. */
  const [selected, setSelected] = useState<string | null>(null);
  /** The work section: open while running and closed once there's a result, unless you toggled it. */
  const [workOpen, setWorkOpen] = useState<boolean | null>(null);
  const follow = useRef(true);
  /** The steps the timeline shows, in order: what [ and ] step through. */
  const listed = useRef<string[]>([]);
  const chatNavigation = useRef(false);
  const turnCursor = useRef<string>();
  const [archiving, setArchiving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [savingStrategy, setSavingStrategy] = useState<TeamTemplate | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [resumeBudget, setResumeBudget] = useState<{ id: string; maxSteps: number; maxMinutes: number } | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const followChat = useRef(true);
  const { run, problem, data, persistence, version } = useRunStream(id, (step) => {
    // A side chat's turn isn't in the timeline: following it would close the step you're watching.
    if (follow.current && step.status === "running" && !sideWork(step)) setSelected(step.id);
  });

  const [providerTime, setProviderTime] = useState(Date.now());
  useEffect(() => {
    const reset = run?.providerLimit?.resetsAt;
    if (!reset || reset <= providerTime) return;
    const now = Date.now();
    if (reset <= now) { setProviderTime(now); return; }
    const timer = setTimeout(() => setProviderTime(Date.now()), Math.min(30_000, reset - now + 1));
    return () => clearTimeout(timer);
  }, [run?.providerLimit?.resetsAt, providerTime]);
  useEffect(() => {
    if (run && run.status !== "running" && !run.seen && !document.hidden) void markSeen(run.id);
  }, [run?.status, run?.seen]);
  useEffect(() => {
    if (!run) return;
    if (run.pattern === "solo") rememberAgentTab(run);
    if (run.pattern === "solo" || !runs.value.has(id)) void loadAgentChats(id).catch(error => showError(`Could not load this task’s chats: ${error.message}`));
  }, [id, run?.pattern]);
  // A run started from the team board links back to its task: the runner's own records say which attempt it executes (the engine knows nothing of tasks).
  useEffect(() => { void loadLocalAttempts(); }, [id]);
  const teamTask = localAttempts.value.find((entry) => entry.runId === id)?.taskId;

  // [ and ] step through the visible timeline or the conversation’s agent turns.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== "[" && e.key !== "]") || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      if ((e.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable=true], dialog")) return;
      if (chatNavigation.current) {
        const turns = [...(scroll.current?.querySelectorAll<HTMLElement>("[data-agent-turn]") ?? [])];
        if (!turns.length) return;
        const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-agent-turn]")?.dataset.agentTurn;
        const at = turns.findIndex(turn => turn.dataset.agentTurn === (focused ?? turnCursor.current));
        const next = turns[Math.max(0, Math.min(turns.length - 1, (at < 0 ? turns.length - 1 : at) + (e.key === "]" ? 1 : -1)))]!;
        e.preventDefault(); followChat.current = false; turnCursor.current = next.dataset.agentTurn;
        (next.querySelector<HTMLElement>(".show-work") ?? next).focus({ preventScroll: true });
        next.scrollIntoView({ block: "nearest", behavior: scrollBehavior() });
        return;
      }
      const ids = listed.current;
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

  useLayoutEffect(() => {
    turnCursor.current = undefined;
    const saved = chatScroll.get(id); followChat.current = saved?.follow ?? true;
    if (scroll.current && saved) scroll.current.scrollTop = saved.top;
  }, [id, !!run]);
  useEffect(() => { if (scroll.current && run?.pattern === "solo" && followChat.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [id, version]);

  if (!run)
    return (
      <div class="runview">
        <div class="run-scroll">
          {problem ? (
            <div class="thread">
              <p class="msg err">{problem}</p>
              <p>
                <a href="#/">← Back to a new run</a>
              </p>
            </div>
          ) : (
            <div class="thread help">Loading…</div>
          )}
        </div>
      </div>
    );
  // Side chats' turns (and the checks after them) are in the side panel; the timeline is the team's work.
  const steps = teamSteps(run, data.current.steps.values());
  listed.current = steps.map((s) => s.id);
  const current = selected === "" ? null : selected && listed.current.includes(selected) ? selected : steps.at(-1)?.id ?? null;
  const finished = run.status !== "running";
  const liveSteps = [...data.current.steps.values()].filter((step) => step.status === "running");
  const checking = !finished && liveSteps.some((step) => step.kind === "check") && !liveSteps.some((step) => step.kind === "agent");
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
  /** A tool approval or a question of this run waits in the approval inbox. */
  const approvalPending = run.status === "running" && pendingApprovals.value.some((record) => record.runId === run.id);
  const awaitingInput = !!run.awaiting || teamAwaitingAnswer(run) || approvalPending;
  /** A conversation with one agent (Single agent): the turns are the thread, not a list of steps. */
  const chat = !!p?.chat && !run.checkpointOnFinish;
  chatNavigation.current = chat;

  const next = nextRunAction(run);
  const brief = run.projectTeam ? missionBrief(run.task) : undefined;
  const hasResult = finished && !run.archived && run.worktrees.some(tree => run.artifacts.some(artifact => artifact.branch === tree.branch));
  const allocation = resumeBudget?.id === run.id ? resumeBudget : { id: run.id, maxSteps: Math.min(run.loop.maxSteps, run.loop.maxInvocations ?? run.loop.maxSteps), maxMinutes: wholeMinutes(run.loop.maxMinutes) };
  const minimumCalls = run.pattern === "auto-team" ? 4 : 1;
  const allocationValid = Number.isSafeInteger(allocation.maxSteps) && allocation.maxSteps >= minimumCalls && allocation.maxSteps <= 200 && Number.isFinite(allocation.maxMinutes) && allocation.maxMinutes >= 1 && allocation.maxMinutes <= 720;
  const focusSection = (id: string) => {
    const section = document.getElementById(id);
    section?.scrollIntoView({ block: "center", behavior: scrollBehavior() });
    (section?.querySelector<HTMLElement>("textarea, button, summary") ?? section)?.focus({ preventScroll: true });
  };
  const resume = async () => {
    if (actionBusy || !allocationValid) return;
    setActionBusy(true); setActionError("");
    try {
      const turn = run.teamTurns?.at(-1), child = turn && runs.value.get(turn.executionId);
      if (chat && child && child.status !== "done" && (runs.value.get(chatTaskId(run)) ?? run).taskTeam?.enabled) await post(`/api/runs/${run.id}/team-resume`, { execution: child.id });
      else await post(`/api/runs/${run.id}/resume`, { budget: { maxSteps: allocation.maxSteps, maxInvocations: allocation.maxSteps, maxMinutes: allocation.maxMinutes } });
    }
    catch (error) { setActionError((error as Error).message); }
    finally { setActionBusy(false); }
  };
  const act = () => {
    if (!next) return;
    if (next.kind === "resume") void resume();
    else if (next.kind === "provider" || next.kind === "provider-limit") healthOpen.value = true;
    else if (next.kind === "rerun") void editAndRerun(run);
    else if (next.kind === "check") setRecovering(true);
    else if (next.kind === "review" && next.branch) navigate({ view: "review", id: run.id, branch: next.branch });
    else if (next.kind === "mission" && run.project) navigate({ view: "project", id: run.project, section: "automation", kind: "missions" });
    else if (next.kind === "revise") {
      chatDrafts.value = [...chatDrafts.value, { to: `main:${run.id}`, text: `Investigate and fix the failing checks (${run.loop.check || "the configured verification profile"}). Preserve the existing work and report fresh verification evidence.`, images: [] }];
    } else focusSection(`run-${next.kind}`);
  };
  return (
    <div class="runview">
      {chat ? <AgentTabs run={run} /> : null}
      <div class="run-scroll" ref={scroll} onScroll={event => {
        const el = event.currentTarget; followChat.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
        chatScroll.set(id, { top: el.scrollTop, follow: followChat.current });
      }}>
        {run.projectTeam && <p class="help">Project mission {run.projectTeam.phase} · <a href={missionHref(run)}>Review the opportunity, approve this result, or request a bounded team revision</a></p>}
        <header class="run-head">
          <div class="run-title">
            {/* OntoLab's page head: a status line above the heading, the actions beside it */}
            <div class="run-name">
              <div class="run-kicker">
                <span class={`status-pill ${awaitingInput ? "awaiting" : dispatchLabel(run, steps) === "Dispatch paused" ? "stopped" : state}`}>
                  {approvalPending ? executionLabel(run, true) : dispatchLabel(run, steps) ?? executionLabel(run)}
                </span>
                {runStateBadges(run).map((label) => <span key={label} class="status-pill run-state" title={label}>{label}</span>)}
                {run.chatLink?.kind !== "side" ? <ProjectChip run={run} /> : null}
                <span class="run-pattern">{p?.name ?? run.pattern}</span>
                {run.permissions?.antigravityExecution === "native" ? <span class="badge warn run-unrestricted" title="Antigravity turns in this run use your normal profile and settings without Code Flow's sandbox">Unrestricted Antigravity</span> : null}
                {teamTask ? <a class="run-team-task" href={`#/team/task/${enc(teamTask)}`} title="This run executes a task of the team board">Team task</a> : null}
              </div>
              <h2 title={run.task}>{runTitle(run)}</h2>
            </div>
            <div class="run-actions">
              {finished && !chat ? <Menu label="More run actions" icon="more">{close => <>
                <MenuItem onClick={() => { close(); try {
                  const common = { id: `strategy-${Date.now().toString(36)}`, name: run.task.split("\n")[0]!.slice(0, 80), scope: run.project ? "project" as const : "personal" as const, ...(run.project ? { project: run.project } : {}) };
                  setSavingStrategy(run.team ? templateFromPlan(run.team, common) : { schemaVersion: 1, ...common, version: 1, description: "Saved workflow. Parameterize inputs before reuse.", autoEnabled: false, parameters: ["task"], roles: [], tasks: [], contracts: [], workflow: run.pattern, task: "{{task}}", criteria: [] });
                } catch (e) { showError((e as Error).message); } }}>Save as team template…</MenuItem>
                {!run.projectTeam ? <MenuItem disabled={!draftsReady.value || composerLoading.value} onClick={() => { close(); void editAndRerun(run); }}>Edit &amp; run again</MenuItem> : null}
                <MenuItem onClick={() => { close(); if (run.archived) void post(`/api/runs/${run.id}/archive`, { archived: false }).catch(e => showError(e.message)); else setArchiving(true); }}>{run.archived ? "Unarchive" : "Archive…"}</MenuItem>
                <MenuItem onClick={() => { close(); setDeleting(true); }}>Delete…</MenuItem>
              </>}</Menu> : null}
              {!finished ? (
                <button
                  class="btn danger"
                  onClick={async () => {
                    if (chat || await confirmAction(checking ? "Stop the running checks? Finished work stays on its branch; verification will be incomplete." : "Stop this run? Agents still working will be stopped; finished work stays on its branches.", {"title":"Stop current work?","confirmLabel":"Stop work","danger":true})) {
                      post(`/api/runs/${run.id}/cancel`).catch((e) => showError(e.message));
                    }
                  }}
                >
                  <Icon name="stop" /> {checking ? "Stop checks" : chat ? "Stop" : "Stop run"}
                </button>
              ) : null}
            </div>
          </div>
        </header>

        <div class="thread">
          {persistence?.state === "saving" ? <p class="help" role="status">Saving run…</p> : persistence?.state === "error" ? <div class="banner bad" role="alert"><p>{persistence.error || "Run changes have not been saved."}</p></div> : null}
          {/* Your task, as the message that started the conversation. */}
          <div class="msg-you">
            <div class="bubble">
              <div class="run-task" tabIndex={0} role="region" aria-label="Your task">
                {run.projectTeam && brief ? <MissionTask brief={brief} /> : <BrowserMessage text={run.task} />}
              </div>
              {run.parentRunId ? (
                <a class="help" href={`#/run/${run.parentRunId}`}>
                  ↩ previous conversation
                </a>
              ) : null}
              {run.parentRunId && run.supersededBy ? <span class="help" aria-hidden="true"> · </span> : null}
              {run.supersededBy ? <a class="help" href={`#/run/${run.supersededBy}`}>Continue with the revised goal →</a> : null}
            </div>
          </div>

          {!chat && next && !(hasResult && next.kind === "review") ? <section class={`next-action ${["resume", "provider", "provider-limit", "check", "revise"].includes(next.kind) ? "needs-attention" : ""}`} aria-label="Next action">
            <div><h3>{next.title}</h3><p>{next.detail}</p>
              {next.kind === "resume" ? <div class="resume-budget" role="group" aria-label="Resume budget">
                <div class="resume-budget-fields">
                  <label>Maximum calls<input class="field" aria-label="Resume maximum calls" type="number" min={minimumCalls} max={200} value={allocation.maxSteps} disabled={actionBusy} onInput={(event) => setResumeBudget({ ...allocation, maxSteps: Number(event.currentTarget.value) })} /></label>
                  <label>Maximum minutes<input class="field" aria-label="Resume maximum minutes" type="number" min={1} max={720} value={allocation.maxMinutes} disabled={actionBusy} onInput={(event) => setResumeBudget({ ...allocation, maxMinutes: Number(event.currentTarget.value) })} /></label>
                  <button class="btn small" disabled={actionBusy} onClick={() => setResumeBudget({ id: run.id, ...DEFAULT_EXECUTION_BUDGET })}>Use extended budget</button>
                </div>
                <p class="help">New allowance: {plural(allocation.maxSteps, "call")} · {allocation.maxMinutes} minutes.{run.team ? ` Up to ${plural(coordinatorInvocationLimit(allocation.maxSteps), "coordinator call")}.` : ""} Earlier usage is retained.</p>
                {!allocationValid ? <p class="msg err" role="alert">Choose {minimumCalls}–200 calls and 1–720 minutes.</p> : null}
              </div> : null}
              {finished && run.worktrees.length ? <p class="help">Saved work: {run.worktrees.length} {run.worktrees.length === 1 ? "worktree" : "worktrees"}. Branches and files are kept.</p> : null}
            </div>
            <div class="next-action-buttons"><button class="btn primary" disabled={actionBusy || next.kind === "resume" && !allocationValid} onClick={act}>{actionBusy ? "Resuming…" : next.label}</button>
              {next.kind === "provider" || next.kind === "provider-limit" ? <button class="btn" disabled={actionBusy || !allocationValid || next.kind === "provider-limit" && (run.providerLimit?.resetsAt ?? 0) > providerTime} onClick={() => void resume()}>{next.kind === "provider-limit" ? "Resume after reset" : "Resume after reconnecting"}</button> : null}
            </div>
          </section> : null}
          {actionError ? <p class="msg err" role="alert">{actionError}</p> : null}
          {finished && !run.archived && branchesGone(run) ? <p class="help" role="note">{run.deletedWorktrees!.length === 1 ? "This run's branch was" : "This run's branches were"} deleted, so its changes are gone. Start a new run to continue from here.</p> : null}
          {!chat && !finished ? <LiveProgress run={run} steps={steps} /> : null}
          {run.source?.kind === "pr" && !Object.values(run.prs ?? {}).includes(run.source.url) ? <GithubReviewThreadsPanel runId={run.id} /> : null}
          {run.lockdown ? (
            <div class="lockdown" role="note">
              <b>Locked down.</b> {run.lockdown}, so agents run in Safe mode, files like .env aren't copied in, and checks{" "}
              {run.loop.container ? "run in Docker without network" : "run on this machine because you allowed it"}.
            </div>
          ) : null}


          {run.taskExecution ? <a class="btn" href={`#/run/${run.taskExecution.chatId}`}>Back to conversation</a> : null}
          {run.awaiting ? <div id="run-approval" tabIndex={-1}><AwaitingCard run={run} /></div> : null}
          {teamAwaitingAnswer(run) ? <div id="run-question" tabIndex={-1}><TeamQuestionCard run={run} /></div> : null}
          {run.team ? <details class="team-details"><summary>Team activity · {teamStatusLabel(run)}</summary><AutoTeam run={run} steps={steps} />{run.project ? <ProjectMemory projectId={run.project} repo={run.repo} refreshKey={`${run.status}:${run.team.revision}`} /> : null}</details> : null}
          {run.triage?.state === "pending" && run.status !== "running" ? (
            <div class="awaiting-card" id="run-triage" tabIndex={-1}>
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

          {chat ? (
            <><ChatThread run={run} steps={steps} data={data.current} />{["failed", "stopped", "interrupted", "cancelled"].includes(run.status) ? <div class="chat-recovery" role="status"><p>{next?.kind === "provider-limit" ? next.detail : recoveryMessage(run, steps)}</p>{next?.kind === "provider" || next?.kind === "provider-limit" ? <button class="btn small" onClick={() => { healthOpen.value = true; }}>{next.label}</button> : null}<button class="btn small" disabled={actionBusy || next?.kind === "provider-limit" && (run.providerLimit?.resetsAt ?? 0) > providerTime} onClick={() => planRejected(run) ? void editAndRerun(run) : void resume()}>{actionBusy ? "Resuming…" : planRejected(run) ? "Edit & run again" : next?.kind === "provider-limit" ? "Resume after reset" : run.providerRecovery ? "Retry reply" : "Resume"}</button>{actionError ? <p class="help" role="alert">{actionError}</p> : null}</div> : null}</>
          ) : (
            /* The agents' work: one disclosure, each step opening inline to its transcript. */
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
                        aria-description={`${s.title}: ${s.outcome === "warning" ? "Warning" : s.outcome === "expected" ? "Expected failure" : STATUS_TEXT[s.status] ?? s.status}`}
                        onClick={() => toggleStep(s.id)}
                      >
                        <span class={`ic ${s.outcome === "warning" ? "warn" : s.status}`} aria-hidden="true">
                          {s.outcome === "warning" ? "⚠" : STEP_ICON[s.status] ?? ""}
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
          )}


          {!chat && run.patternDone && (run.patternSummary || run.summary) ? <div class="workflow-answer"><div class="lbl">{run.pattern === "solo" ? "Agent" : "Team"}</div><Markdown text={run.patternSummary ?? run.summary ?? ""} /></div> : null}
          {chat ? null : <FollowUpThread run={run} data={data.current} />}
          {hasResult ? <ResultStudio run={run} /> : null}
          {finished && run.review && !run.artifacts.length ? <section id="run-publish-review" aria-label="Council review"><ReviewCard run={run} /></section> : null}
          {finished && !chat && (run.status !== "done" || failedWork(steps).length > 0) ? <ResultCard run={run} steps={steps} onSelectStep={selectStep} /> : null}
          {!chat ? <details class="result-details"><summary>{run.testRun ? "Test details" : "Details and publishing"}</summary>
          {!chat ? <RunEvidence run={run} checking={checking} /> : null}
          {run.teamTemplate || run.team?.templateUses?.length ? <details class="settings"><summary>Template provenance</summary><div class="settings-body">{run.teamTemplate ? <p>Selected: {run.teamTemplate.template.name} v{run.teamTemplate.template.version}</p> : null}{run.team?.templateUses?.map(use => <p key={use.id}>{use.id}: {use.templateId} v{use.version}{use.instructions ? ` · adaptation: ${use.instructions}` : ""}</p>)}<p class="help">Definitions and inputs are pinned to this run. Library edits do not change this execution.</p></div></details> : null}
          {!chat && run.permissions ? <details class="settings"><summary>Run permissions · {run.permissions.trust}{run.permissions.antigravityExecution === "native" ? " · Unrestricted Antigravity" : ""}</summary><div class="settings-body"><p>{run.permissions.antigravityExecution === "native" ? "Unrestricted Antigravity uses the existing login and normal provider settings. Its read-only requests are advisory; terminal, browser, MCP, hooks and native agents are unrestricted by Code Flow, including child usage outside the worker budget. Other providers inherit the run policy." : "Workers inherit this run’s policy. Planning and review turns use narrower access. Native agent delegation is disabled; Code Flow schedules the team."}</p>{[...data.current.steps.values()].filter(step => step.permissions).map(step => <p key={step.id}>{step.title}: {step.permissions!.trust} · {step.permissions!.mode} · {step.permissions!.isolation} · command network {step.permissions!.commandNetwork} · external tools {step.permissions!.externalTools}{step.permissions!.implementation ? <><br /><span class="help">{step.permissions!.implementation}: {step.permissions!.limitations.join(" ")}</span></> : null}</p>)}<p class="help">Worktrees do not restrict reads. External browser/MCP tools retain their provider permissions unless explicitly disabled. Setup, checks and previews use their separately configured execution environment.</p></div></details> : null}
          {finished && run.status === "done" && !failedWork(steps).length ? <ResultCard run={run} steps={steps} onSelectStep={selectStep} /> : null}
          <RunMeta run={run} /><RunChips run={run} />
          <ActivityLog logs={data.current.logs} count={data.current.logs.length} />
          </details> : null}
        </div>
      </div>

      {run.projectTeam && run.status !== "running" ? <MissionRunNote run={run} /> : <ConversationBar key={run.id} run={run} steps={steps} chat={chat} />}
      {recovering ? <RecoveryCheckDialog run={run} onClose={() => setRecovering(false)} /> : null}
      {savingStrategy ? <SaveStrategyDialog template={savingStrategy} onClose={() => setSavingStrategy(null)} /> : null}
      {deleting ? <DeleteRunDialog run={run} onClose={() => setDeleting(false)} /> : null}
      {archiving ? <ArchiveDialog run={run} onClose={() => setArchiving(false)} /> : null}
    </div>
  );
}

/** Main conversations on a task; closing a tab preserves its history, drafts and execution. */
function AgentTabs({ run }: { run: RunSummary }) {
  const workspace = run.chatLink?.workspaceId ?? run.id;
  const tabs = [...runs.value.values()].filter(other => other.pattern === "solo" && !other.archived && other.chatLink?.kind !== "side" && (other.chatLink?.workspaceId ?? other.id) === workspace);
  if (!tabs.some(other => other.id === run.id)) tabs.push(run);
  tabs.sort((a, b) => a.createdAt - b.createdAt);
  const opened = tabs.filter(tab => tab.id === run.id || !agentTabClosed(tab));
  const pick = (tab: RunSummary) => { rememberAgentTab(tab); navigate({ view: "run", id: tab.id }); };
  const close = (id: string) => {
    const at = opened.findIndex(tab => tab.id === id);
    const tab = opened[at];
    if (!tab) return;
    setAgentTabClosed(tab, true);
    if (id === run.id) {
      const next = opened[at + 1] ?? opened[at - 1];
      if (next) pick(next); else navigate({ view: "composer" });
    }
    if (tab.status === "running") showToast("Tab closed. The agent continues working; reopen it from this task.", 5000);
  };
  return <Strip label="Agent chats" active={run.id} items={opened.map(tab => ({ key: tab.id, label: `${SHORT[(tab.conversationAgent ?? tab.roles.agent?.[0]) ?? "claude"]} · ${tab.task.split("\n")[0]!.slice(0, 45)}`, title: tab.task, agent: (tab.conversationAgent ?? tab.roles.agent?.[0]), state: tab.status === "running" ? "working" : undefined }))} onPick={id => pick(tabs.find(tab => tab.id === id)!)} onClose={close} closeTitle="Close tab — keeps history and any running work">
    <Menu label="All chats" icon="menu" align="end" title="All chats on this task, including closed tabs">
      {done => <>
        <MenuTitle>Chats on this task</MenuTitle>
        {tabs.map(tab => <MenuItem key={tab.id} on={tab.id === run.id} sub={`${SHORT[(tab.conversationAgent ?? tab.roles.agent?.[0]) ?? "claude"]} · ${STATUS_TEXT[tab.status] ?? tab.status}${agentTabClosed(tab) ? " · Closed tab" : ""}`} onClick={() => { done(); pick(tab); }}>{tab.task.split("\n")[0]}</MenuItem>)}
      </>}
    </Menu>
  </Strip>;
}

function WorkSummary({ run, steps }: { run: RunSummary; steps: Step[] }) {
  const live = steps.filter((s) => s.status === "running");
  const failed = failedWork(steps).length;
  const warnings = steps.filter(step => step.outcome === "warning").length;
  const who = [...new Set(steps.map((s) => s.agent).filter((a): a is AgentId => !!a))];
  const took = duration((run.endedAt ?? Date.now()) - run.createdAt);
  return (
    <>
      <span class={`work-ic ${dispatchLabel(run, steps) === "Dispatch paused" ? "interrupted" : runState(run)}`} aria-hidden="true" />
      <span class="work-title">
        {run.status === "running" ? (live.length ? `Working — ${live.map((s) => s.title).join(", ")}` : dispatchLabel(run, steps) ?? "Working…") : `${steps.length} step${steps.length === 1 ? "" : "s"}`}
      </span>
      <span class="work-meta">
        {run.status === "running" ? `${steps.length} step${steps.length === 1 ? "" : "s"} so far · ${took}` : took}
        {failed ? <span class="warn"> · {failed} failed</span> : null}{warnings ? <span class="warn"> · {warnings} warning{warnings === 1 ? "" : "s"}</span> : null}
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
  return <span class="tag-cf">{step.kind === "check" ? "Check" : "Setup"}</span>;
}

/** "approved" → "Approved": state words from the server, shown in sentence case. */
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function RunChips({ run }: { run: RunSummary }) {
  const ctx = run.context ?? { paths: [], attachments: [] };
  if (!ctx.paths.length && !ctx.attachments.length) return null;
  return (
    <div class="run-chips">
      {ctx.paths.map((c) => (
        <span key={c.path} class="chip-ctx" title={c.workingCopy ? `Your ${c.note} working copy was given to the agents` : c.path}>
          <Icon name={c.type === "dir" ? "folder" : "files"} />
          <span class="n">
            {c.path}
            {c.type === "dir" ? "/" : ""}
          </span>
          {c.note ? <span class="note">{c.note}</span> : null}
        </span>
      ))}
      {ctx.attachments.map((a) => (
        <span key={a.name} class="chip-ctx">
          <Icon name="attach" />
          <span class="n">{a.name}</span>
          <span class="size">{fmtSize(a.size)}</span>
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
        <a class="src-link with-ic" href="#/automations" title={`Started by ${run.trigger.via === "schedule" ? "its schedule" : run.trigger.via === "webhook" ? "a webhook" : run.trigger.via === "sweep" ? "a sweep" : "Run now"}`}>
          <Icon name={run.trigger.via === "sweep" ? "layers" : "clock"} /> {run.trigger.name}
        </a>
      ) : null}
      {run.triage && run.triage.state !== "pending" ? <span class="badge">{run.triage.state === "empty" ? "No changes · archived" : cap(run.triage.state)}</span> : null}
      {run.source ? (
        <a class="src-link with-ic" href={safeHref(run.source.url)} target="_blank" rel="noreferrer" title={run.source.title}>
          {run.source.kind === "pr" ? <Icon name="pull" /> : null}
          {run.source.kind === "issue"
            ? `Issue #${run.source.number}`
            : run.source.kind === "pr"
              ? `PR #${run.source.number}`
              : `⚠ ${run.source.alert?.tool === "dependabot" ? "Dependabot" : "Code scanning"} alert ${(run.source.alert?.numbers ?? [run.source.number]).map((n) => `#${n}`).join(", ")}`}
          <Icon name="external" />
        </a>
      ) : null}
      <span>
        From {run.baseLabel} @ <code>{run.baseRef.slice(0, 7)}</code>
      </span>
      {run.loop?.check ? (
        <span title="code-flow runs this after every change">
          Done when <code>{run.loop.check}</code> passes{run.checkCantRun ? " · can't run here" : run.lastCheck ? (run.lastCheck.ok ? " · last check ✓" : " · last check ✕") : ""}
        </span>
      ) : null}
      <span class="team-line">
        {team.map(([role, ids]) => (
          <span key={role}>
            {cap(role)}:{" "}
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
        <a class="src-link with-ic" href={`#/insights/${encodeURIComponent(run.group.id)}`} title="Started together with other setups on the same task">
          <Icon name="compare" /> Comparison: {run.group.label}
        </a>
      ) : null}
      {run.trust === "full" ? (
        <span class="full-access" title="Agents could run any command, with no sandbox">
          ⚠ Full access
        </span>
      ) : null}
      {run.conventions ? (
        <span class="with-ic" title="The repo's AGENTS.md, CLAUDE.md… are given to every agent">
          <Icon name="files" /> Conventions
        </span>
      ) : null}
      {run.lessons?.length ? (
        <span class="with-ic" title={`Problems reviewers raised in earlier runs here, given to every agent:\n${run.lessons.map((l) => `• ${l}`).join("\n")}`}>
          <Icon name="sparkle" /> {run.lessons.length} lesson{run.lessons.length === 1 ? "" : "s"}
        </span>
      ) : null}
      {run.usage ? (
        <span class="usage">
          {run.usage.agentSteps}/{run.loop.maxSteps} agent steps · {duration((run.endedAt ?? Date.now()) - run.createdAt)} of {wholeMinutes(run.loop.maxMinutes)} min
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
    .map(([agent, u]) => `${agentName(agent)}: ${plural(u!.steps, "step")}, ${fmtTokens(u!.inputTokens + u!.outputTokens)} tokens${u!.costUsd ? `, ≈${fmtCost(u!.costUsd)}` : ""}, ${duration(u!.ms)}`)
    .join("\n");

// ---------------------------------------------------------------- result & shipping
/** In a chat, the answers are already in the thread: the card is about the branch (and the check). */
function ResultCard({ run, steps, onSelectStep, chat }: { run: RunSummary; steps: Step[]; onSelectStep: (id: string) => void; chat?: boolean }) {
  const state = runState(run);
  const failedSteps = failedWork(steps);
  const titles: Record<string, string> = {
    done: "✓ Finished — the check passes",
    unverified: "Finished — no independent check passed",
    failing: "⚠ Finished — but the check still fails",
    unchecked: "⚠ Finished — but the check couldn't run, so nothing was tested",
    failed: "✕ Failed",
    cancelled: planRejected(run) ? "■ Plan rejected" : "■ Stopped by you",
    stopped: teamNeedsResume(run) ? "■ Paused with unresolved work — press Resume to continue" : `■ Stopped at the ${run.stopReason ?? "limit"} — work so far is kept below`,
    interrupted: "■ Interrupted — press Resume to continue where it stopped",
  };
  if (chat) Object.assign(titles, { done: "✓ The check passes", unverified: "No independent check passed", failing: "⚠ The check fails", unchecked: "⚠ The check couldn't run, so nothing was tested" });
  const flagged = state === "done" && !!run.artifacts[0] && integrityFor(run, run.artifacts[0].branch).length > 0;
  const title = state === "done" && agentReviewLabel(run) === "Changes requested" ? "Checks passed · review needs changes" : flagged ? `⚠ ${chat ? "The" : "Finished — the"} check passes only with changes to the tests` : titles[state] ?? run.status;
  return (
    <div class={`result ${state}${flagged ? " flagged" : ""}${chat ? " chat" : ""}`}>
      {/* A revised goal stopped this run on purpose: say where the work went on, not that it stopped. */}
      {state === "cancelled" && run.supersededBy ? <div class="rh">■ Goal revised · <a href={`#/run/${run.supersededBy}`}>continued in the revised run →</a></div> : title ? <div class="rh">{title}</div> : null}
      {run.checkCantRun ? <CantRunNote cantRun={run.checkCantRun} /> : null}
      <VerificationEvidence run={run} />
      {failedSteps.length ? (
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
      ) : run.review && run.artifacts.length ? (
        <ReviewCard run={run} />
      ) : run.summary && !chat ? (
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
function FollowUpThread({ run, data }: { run: RunSummary; data: RunData }) {
  if (!run.followUps?.length) return null;
  return (
    <>
      {run.followUps.map((f) => {
        // A side chat lives in the side panel; a change it made gets a line here, so the history is whole.
        if (f.side) return f.side.mode === "change" && f.status !== "pending" ? <SideNote key={f.id} run={run} f={f} /> : null;
        const step = f.stepId ? data.steps.get(f.stepId) : undefined;
        return (
          <div key={f.id} class="fu">
            {f.kind === "reply" || (f.kind === "comments" && !f.from) ? (
              <div class="msg-you">
                <div class="bubble">
                  <RunMessage text={f.message} />
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
                <FollowUpBadges f={f} run={run} />
              </div>
              {step ? <TurnBody run={run} step={step} data={data} answer={f.status === "pending" ? undefined : f.result} /> : f.result ? <Markdown text={f.result} /> : null}
            </div>
          </div>
        );
      })}
    </>
  );
}

/** A change a side chat made on the run's branch, as one line in the run's thread; its link shows the chat. */
function SideNote({ run, f }: { run: RunSummary; f: FollowUp }) {
  return (
    <div class="fu-sent help side-note">
      <AgentTag id={f.agent} /> {f.status === "done" ? "changed" : "tried to change"} {f.worktree} from the side chat{" "}
      <button type="button" class="link" onClick={() => openSideChat(run.id, f.side!.chat)}>
        “{f.side!.title}”
      </button>
      <FollowUpBadges f={f} />
    </div>
  );
}

/**
 * How a follow-up went: still working, didn't finish, pushed, the check, test changes. Given its
 * run, one still pending on a run that has stopped says so instead of "Working…": it won't move
 * until the run is resumed (interrupted keeps it for the resume; a failure or a stop leaves it
 * unfinished). A done run isn't stopped: a new reply is pending there for a moment before it starts.
 */
export function FollowUpBadges({ f, run }: { f: FollowUp; run?: RunSummary }) {
  const halted = f.status === "pending" && !!run && run.status !== "running" && run.status !== "done";
  return (
    <>
      {halted ? (
        run!.status === "interrupted" ? (
          <span class="note" title="code-flow stopped before this turn finished. Resume the run to continue it.">
            Interrupted
          </span>
        ) : (
          <span class="err">✕ Didn't finish</span>
        )
      ) : f.status === "pending" ? (
        <span class="fu-live">Working…</span>
      ) : f.status === "failed" ? (
        <span class="err">✕ Didn't finish</span>
      ) : null}
      {f.pushed ? <span class="ok">Pushed {f.pushed.slice(0, 7)}</span> : f.pushError ? <span class="note" title={f.pushError}>Push failed: {f.pushError}</span> : null}
      {f.checkPassed === false ? <span class="note">check fails</span> : f.checkPassed ? <span class="ok">check passes</span> : null}
      {f.integrity?.length ? (
        <span class="note" title={f.integrity.map((i) => `${i.file}: ${i.detail}`).join("\n")}>
          ⚠ Changed tests
        </span>
      ) : null}
    </>
  );
}

/**
 * An agent's turn in the thread: its live transcript while it works, then its answer, with the
 * work (tool calls, thinking) folded away behind "Show work".
 */
export function TurnBody({ run, step, data, answer }: { run: RunSummary; step: Step; data: RunData; answer?: string }) {
  const [open, setOpen] = useState(false);
  const version = data.events.get(step.id)?.length ?? 0;
  const text = conversationAnswer(answer ?? step.finalText, step.error);
  const latestTurn = [...data.steps.values()].filter(value => (value.kind ?? "agent") === "agent" && !sideWork(value)).sort((a, b) => a.startedAt - b.startedAt).at(-1)?.id;
  useEffect(() => {
    const identity = `${run.id}:${step.id}:${step.endedAt}`;
    if (onPhone || step.id !== latestTurn || step.status !== "done" || !text || openedAppTurns.has(identity)) return;
    const urls = localAppUrls(text, location.href);
    if (!urls.length) return;
    const stop = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = Date.now() + 15_000;
    const check = async () => {
      for (const url of urls) {
        if (stop.signal.aborted || openedAppTurns.has(identity)) return;
        const result = await api<{ ready: boolean }>("/api/preview/status", { method: "POST", body: JSON.stringify({ url, runId: run.id }), signal: stop.signal }).catch(() => null);
        if (stop.signal.aborted || openedAppTurns.has(identity)) return;
        if (result?.ready) { openedAppTurns.add(identity); openBrowserPage(url, run.id); return; }
      }
      if (!stop.signal.aborted && Date.now() < deadline) timer = setTimeout(() => void check(), 1000);
      else openedAppTurns.add(identity);
    };
    void check();
    return () => { stop.abort(); clearTimeout(timer); };
  }, [run.id, step.id, step.status, step.endedAt, text, latestTurn]);
  if (step.status === "running") return <Transcript run={run} step={step} data={data} version={version} />;
  const items = itemsFor(data, step);
  const tools = items.filter((i) => i.kind === "tool").length;
  // What code-flow declined for the agent without asking you: the answer may leave it out, or call it yours.
  const unasked = items.filter((i): i is Extract<Item, { text: string }> => i.kind === "status" && declinedUnasked(i.text));
  return (
    <div class="turn-body">
      <button type="button" class="show-work" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "Hide work" : `Show work${tools ? ` · ${tools} tool call${tools === 1 ? "" : "s"}` : ""}`}
        {step.endedAt ? ` · ${duration(step.endedAt - step.startedAt)}` : ""}
      </button>
      {open ? <>{step.teamResponseFor ? [...data.steps.values()].filter(previous => previous.teamResponseFor === step.teamResponseFor && previous.id !== step.id).map(previous => <p class="help" key={previous.id}>{SHORT[previous.agent ?? "claude"]}: {previous.error ?? previous.status}. Continued with {SHORT[step.agent ?? "claude"]}.</p>) : null}<Transcript run={run} step={step} data={data} version={version} /></> : null}
      {text ? <Markdown text={text} /> : step.status !== "done" && !step.error && !open ? <Transcript run={run} step={step} data={data} version={version} /> : null}
      {!open && (text || step.status === "done") ? unasked.map((item, n) => <p key={n} class="ev declined" role="note">{item.text}</p>) : null}
      {step.error ? <div class="ev error" role="status">{step.error}</div> : null}
    </div>
  );
}

/**
 * A conversation with one agent: your task, then each turn in order, each of your later messages
 * right before the turn that answered it. A message that never got a turn (still waiting, or it
 * failed before the agent started) keeps its place, with what happened to it.
 */
export function ChatThread({ run, steps, data }: { run: RunSummary; steps: Step[]; data: RunData }) {
  const followUps = run.followUps.filter((f) => !f.side); // side chats show in the side panel
  const byStep = new Map(followUps.filter((f) => f.stepId).map((f) => [f.stepId!, f]));
  const sideSteps = sideStepIds(run);
  const responseSteps = new Map(steps.filter(step => step.teamResponseFor).map(step => [step.teamResponseFor, step.id]));
  const turns = steps.filter((s) => (s.kind ?? "agent") === "agent" && !sideSteps.has(s.id) && (!s.teamResponseFor || responseSteps.get(s.teamResponseFor) === s.id));
  // The task's own turn: not a reply's (also one whose link to its message is still on its way), not a question to the lead.
  const opening = (step: Step) => !byStep.has(step.id) && !step.leadQuestion && step.role !== "follow-up";
  const stepless = followUps.filter((f) => !f.stepId || !data.steps.has(f.stepId));
  // A change a side chat made gets a line, where its turn ran, so the history is whole.
  const sideChanges = run.followUps.filter((f) => f.side?.mode === "change" && f.status !== "pending");
  // A reply's turn sits where its message was sent: a stopped team answers it on resume, after newer messages.
  // The task's own turn comes first, whenever it ran.
  const thread: { at: number; step?: Step; followUp?: FollowUp; side?: FollowUp }[] = [
    ...turns.filter(opening).map((step) => ({ at: step.startedAt, step })),
    ...[
      ...turns.filter((step) => !opening(step)).map((step) => ({ at: byStep.get(step.id)?.at ?? step.startedAt, step })),
      ...stepless.map((followUp) => ({ at: followUp.at, followUp })),
      ...sideChanges.map((side) => ({ at: (side.stepId && data.steps.get(side.stepId)?.startedAt) || side.at, side })),
    ].sort((a, b) => a.at - b.at),
  ];
  // The run's last check is the first turn's while nothing that changes the branch came after it (a side Ask doesn't).
  // A side change that started (working, done, or failed after its turn) is about to set, or has set, the
  // run's last check: the first turn's badge isn't its to show. One that never started (still queued, or
  // ended before its turn) hasn't touched the branch.
  const nothingAfter = followUps.length === 0 && !run.followUps.some((f) => f.side?.mode === "change" && !!f.stepId);
  const agent = Object.values(run.roles).flat()[0];
  const corrections = (followUp?: FollowUp) => {
    const start = followUp?.at ?? run.createdAt;
    const end = followUps.find(next => next.at > start)?.at ?? Infinity;
    return run.notes.filter(note => note.teamDelivery && note.at >= start && note.at < end);
  };
  // The engine's durable ask key identifies the message that delegated this work.
  // Keep its progress and approval beside that message, including after reload.
  const teamTurns = (followUp?: FollowUp) => (run.teamTurns ?? []).filter(turn => followUp ? turn.key.includes(`|follow-up ${followUp.id}#`) : turn.key.startsWith("agent|"));
  const teamWorking = (followUp?: FollowUp) => teamTurns(followUp).some(turn => !turn.report);
  const teamActivity = (followUp?: FollowUp) => {
    const turns = teamTurns(followUp);
    const active = turns.map(turn => runs.value.get(turn.executionId)).find(child => child?.status === "running");
    return <>
      {active?.awaiting ? <AwaitingCard run={active} compact /> : null}
      {active && teamAwaitingAnswer(active) ? <TeamQuestionCard run={active} replyChatId={run.id} /> : null}
      <TaskTeamActivity run={run} turns={turns} />
    </>;
  };
  const correctionBubble = (note: Note) => <div key={note.id} class="team-question-history">{note.question ? <div class="msg-agent"><div class="help">{note.question.sender} asked</div><Markdown text={note.question.body} /></div> : null}<div class="msg-you"><div class="bubble"><BrowserMessage text={note.text} /><div class="help" role="status">{note.control ? "Stopped · work saved. Resume when you’re ready." : note.teamDelivery?.state === "applied" ? note.requestId ? "Answer sent" : note.teamDelivery.taskIds?.length ? `Updated ${note.teamDelivery.taskIds.join(", ")}` : "Added to the team request" : note.teamDelivery?.state === "not_applied" ? "Saved for your agent" : "Received · updating the team…"}</div></div></div></div>;
  return (
    <>
      {/* Until the task's own turn has a step, its corrections and team (question, approval, progress) sit under your task, whatever came after. */}
      {!turns.some(opening) ? <>{corrections().map(correctionBubble)}{teamActivity()}</> : null}
      {thread.map(({ step: s, followUp, side }) => {
        if (side) return <SideNote key={side.id} run={run} f={side} />;
        if (!s) {
          const f = followUp!;
          return (
            <div key={f.id} class="fu">
              <div class="msg-you">
                <div class="bubble">
                  <RunMessage text={f.message} />
                </div>
              </div>
              {corrections(f).map(correctionBubble)}
              {teamActivity(f)}
              {!teamWorking(f) ? <div class="fu-answer">
                <div class="fu-head">
                  <AgentTag id={f.agent} />
                  {f.status === "pending" && (run.status === "running" || run.status === "done") ? (
                    <span class="fu-live">{run.status === "running" ? "Up next…" : "Waiting…"}</span>
                  ) : (
                    <FollowUpBadges f={f} run={run} />
                  )}
                </div>
                {f.status === "pending" || !f.result ? null : f.status === "failed" ? <div class="ev error">{f.result}</div> : <Markdown text={f.result} />}
              </div> : null}
            </div>
          );
        }
        const f = byStep.get(s.id);
        // A question to the lead, or a reply's turn not yet linked to its message, has no team of its own here.
        const own = !!f || opening(s);
        // Messages a turn took when it started, or while it ran (Codex takes them mid-turn).
        const notes = run.notes.filter((n) => n.deliveredTo?.stepId === s.id && !n.followUp);
        return (
          <div key={s.id} class="fu" data-agent-turn={s.id} tabIndex={-1} role="article" aria-label={`Agent turn: ${s.title}`}>
            {f ? (
              <div class="msg-you">
                <div class="bubble">
                  <RunMessage text={f.message} />
                </div>
              </div>
            ) : null}
            {own ? corrections(f).map(correctionBubble) : null}
            {notes.map((n) => (
              <div key={n.id} class="msg-you">
                <div class="bubble">
                  <BrowserMessage text={n.text} />
                  {n.deliveredTo?.midTurn ? <div class="help">Sent while it worked</div> : null}
                </div>
              </div>
            ))}
            {own ? teamActivity(f) : null}
            <div class="fu-answer">
              <div class="fu-head">
                <AgentTag id={s.agent} note={modelNote(run, s.agent, s.settings)} />
                {f ? <FollowUpBadges f={f} run={run} /> : s.status === "running" ? <span class="fu-live">Working…</span> : s.status === "failed" ? <span class="err">✕ Didn't finish</span> : null}
                {!f && s.status !== "running" && run.lastCheck && nothingAfter ? (
                  run.lastCheck.ok ? <span class="ok">check passes</span> : <span class="note">check fails</span>
                ) : null}
              </div>
              <TurnBody run={run} step={s} data={data} />
            </div>
          </div>
        );
      })}
      {run.status === "running" ? steps.filter((step) => step.kind === "check" && step.status === "running").map((step) => {
        const command = data.events.get(step.id)?.find((event) => event.kind === "tool_call" && event.name === "$");
        return <details key={step.id} class="chat-check">
          <summary><span class="spin" aria-hidden="true" /><span><strong>Running checks</strong><span class="help">{turns.every((turn) => turn.status !== "running") ? "The agent has finished. Verification is still running." : "Verifying the work."}</span><code>{command?.kind === "tool_call" ? command.input : run.loop.check || step.title}</code></span><span class="help">Show output</span></summary>
          <Transcript run={run} step={step} data={data} version={data.events.get(step.id)?.length ?? 0} />
        </details>;
      }) : null}
      {!turns.length && !teamWorking() && run.status === "running" ? (
        <div class="fu-answer">
          <div class="fu-head">
            <AgentTag id={agent} />
            <span class="fu-live">Starting…</span>
          </div>
        </div>
      ) : null}
    </>
  );
}

function RunMessage({ text }: { text: string }) {
  if (text === PREVIEW_REQUEST) return <><p>Set up a preview of this result.</p><details class="preview-request-details"><summary>Setup instructions</summary><Markdown text={text} /></details></>;
  return <BrowserMessage text={text} />;
}

/** The steps that answered side chats: they show in the side panel, not in the run's thread. */
export const sideStepIds = (run: RunSummary) => new Set(run.followUps.filter((f) => f.side && f.stepId).map((f) => f.stepId!));
/**
 * A side chat's work, known from the step alone (it can arrive before the run says whose it is): its
 * turn, the check after it, a proof it set off. Runs from before steps said so go by role and title.
 */
const sideWork = (s: Step) => !!s.sideOf || s.role === "side chat" || /^Check after side chat /.test(s.title);
/** The run's own steps, in order, without side chats' turns and the work that came of them. */
export function teamSteps(run: RunSummary, steps: Iterable<Step>): Step[] {
  const side = sideStepIds(run);
  return [...steps].filter((s) => !side.has(s.id) && !sideWork(s));
}

const followUpLabel = (f: FollowUp) =>
  f.side
    ? "side chat"
    : f.kind === "resolve-conflicts"
    ? `resolve conflicts with ${f.mergeFrom}`
    : f.kind === "reply"
      ? "your reply"
      : f.kind === "ci-fix"
        ? "fix failing CI"
        : f.from
          ? `comments from ${f.from}`
          : "review comments";

/** A review council's result: findings ranked by severity, then by whether a test confirms them, then by agreement; and a post button. */
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
            <a class="badge ok" href={safeHref(review.postedTo)} target="_blank" rel="noreferrer">
              Posted to PR #{pr.number} <Icon name="external" />
            </a>
          ) : (
            <button
              class="btn small primary"
              disabled={busy || run.status === "running"}
              onClick={async () => {
                if (!await confirmAction(`Post this review as a comment on PR #${pr.number}? Everyone with access to the PR will see it.`, {"title":"Post review to GitHub?","confirmLabel":"Post review","danger":false})) return;
                setBusy(true);
                try {
                  await post(`/api/runs/${run.id}/post-review`);
                  showToast("Review posted");
                } catch (err) {
                  showError((err as Error).message, 5000);
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
      {review.proof ? <ProofNote proof={review.proof} /> : null}
      {review.summary ? <p>{review.summary}</p> : null}
      {review.findings.length ? (
        <ol class="findings">
          {review.findings.map((f, i) => (
            <li key={i} class={`sev-${f.severity}`}>
              <div>
                <span class={`sev ${f.severity}`}>{f.severity}</span> <code>{f.file || "general"}</code> {f.problem}
              </div>
              <div class="help">Fix: {f.fix}</div>
              <CheckNote severity={f.severity} check={f.check} />
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

export function ArtifactCard({ run, artifact, steps, reviewing = false, initialPanel }: { run: RunSummary; artifact: Artifact; steps: Step[]; reviewing?: boolean; initialPanel?: "pr" }) {
  const worktree = (run.worktrees ?? []).find((w) => w.branch === artifact.branch);
  // Its branch is gone: nothing left to review, merge or open a pull request from.
  const deleted = !worktree && !!run.deletedWorktrees?.some((w) => w.branch === artifact.branch);
  const merged = run.merges?.filter((m) => m.branch === artifact.branch) ?? [];
  const pr = run.prs?.[artifact.branch];
  const canReview = (run.status === "done" || teamNeedsResume(run)) && !!worktree;
  const fromPr = run.source?.kind === "pr" ? run.source : undefined;
  const [panel, setPanel] = useState<"merge" | "pr" | null>(() => initialPanel && worktree && !run.testRun && !fromPr ? initialPanel : null);
  const [actionsOpen, setActionsOpen] = useState(!!panel);
  const [pushing, setPushing] = useState(false);
  return (
    <div class="artifact">
      <div class="ah">
        <b>{artifact.label}</b>
        <code>{artifact.branch}</code>
        {merged.map((m) => (
          <span key={m.commit} class="badge ok">
            {m.pr ? "PR merged into" : "Merged into"} {m.into}
          </span>
        ))}
        {pr ? (
          <a class="badge" href={safeHref(pr)} target="_blank" rel="noreferrer">
            PR <Icon name="external" />
          </a>
        ) : null}
        {deleted ? <span class="badge" title="Its branch was deleted, so these changes are gone">Branch deleted</span> : null}
        {!deleted ? <details class="artifact-actions" open={actionsOpen} onToggle={event => setActionsOpen(event.currentTarget.open)}><summary>Actions</summary><div class="acts">
          {canReview && !reviewing ? (
            <button class="btn small" onClick={() => navigate({ view: "review", id: run.id, branch: artifact.branch })}>
              Review changes
            </button>
          ) : null}
          {worktree && !run.testRun ? (
            <button class="btn small" aria-pressed={panel === "merge"} onClick={() => setPanel(panel === "merge" ? null : "merge")}>
              {pr ? "Merge PR…" : "Merge…"}
            </button>
          ) : null}
          {!run.testRun && worktree && fromPr && !fromPr.isCrossRepository && run.status !== "running" ? (
            <button
              class="btn small primary"
              disabled={pushing}
              title={`Push this branch to ${fromPr.headRefName}, updating PR #${fromPr.number} (never forced)`}
              onClick={async () => {
                if (!await confirmAction(`Push ${artifact.branch} to ${fromPr.headRefName}? This updates PR #${fromPr.number} on GitHub.`, {"title":"Push changes to GitHub?","confirmLabel":"Push changes","danger":false})) return;
                setPushing(true);
                try {
                  const result = await post<{ warning?: string }>(`/api/runs/${run.id}/push-pr`, { branch: artifact.branch });
                  showToast(result.warning || `Pushed to PR #${fromPr.number}`, result.warning ? 8000 : 5000);
                } catch (err) {
                  showError((err as Error).message, 6000);
                } finally {
                  setPushing(false);
                }
              }}
            >
              {pushing ? "Pushing…" : `Push to PR #${fromPr.number}`}
            </button>
          ) : null}
          {!run.testRun && worktree && !fromPr ? (
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
        </div></details> : null}
      </div>
      {!reviewing && integrityFor(run, artifact.branch).length ? <IntegrityNote issues={integrityFor(run, artifact.branch)} /> : null}
      {run.proofs?.[artifact.branch] ? <ProofNote proof={run.proofs[artifact.branch]!} /> : null}
      {run.findings?.[artifact.branch]?.findings.length ? <FindingsNote review={run.findings[artifact.branch]!} /> : null}
      {/* focusable: a long stat scrolls (max-height), and keyboard users need to reach it to scroll it */}
      {!reviewing ? artifact.stat ? <pre tabIndex={0}>{artifact.stat}</pre> : <div class="help">No changes</div> : null}
      {!reviewing && worktree && existsHint(run) ? <details class="artifact-tools"><summary>Open in your tools</summary><WorkspaceTools run={run} worktree={worktree.name} /></details> : null}
      {!run.testRun && panel === "merge" && worktree ? (
        pr ? <PrMergePanel run={run} branch={artifact.branch} worktree={worktree.name} steps={steps} /> : <MergePanel run={run} branch={artifact.branch} worktree={worktree.name} steps={steps} onMerged={() => setPanel(null)} />
      ) : null}
      {!run.testRun && panel === "pr" ? <PrPanel run={run} branch={artifact.branch} focusOnOpen={initialPanel === "pr"} /> : null}
      {pr ? <GithubReviewThreadsPanel runId={run.id} branch={artifact.branch} /> : null}
      {!run.testRun && pr && worktree && !merged.some((m) => m.pr === pr) ? <WatchPanel run={run} branch={artifact.branch} steps={steps} worktree={worktree.name} /> : null}
    </div>
  );
}

/** Fail-to-pass: does a test in this change fail without it? code-flow ran its tests on the base code. */
function ProofNote({ proof }: { proof: Proof }) {
  const tests = proof.tests.length ? `this change's tests (${proof.tests.join(", ")})` : "the existing tests";
  return (
    <div class={`proof ${proof.status}`} role="note">
      {proof.status === "proven" ? (
        <>
          <b>✓ Proven: a test fails without this change</b>
          <span class="help">
            {" "}
            — <code>{proof.command}</code> fails on the base code with {tests}, and passes with the change.
          </span>
          <details>
            <summary>How it fails without the change</summary>
            <pre>{proof.detail}</pre>
          </details>
        </>
      ) : proof.status === "weak" ? (
        <>
          <b>⚠ Weak proof: the tests fail without this change only because they can't load</b>
          <span class="help">
            {" "}
            — <code>{proof.command}</code> fails on the base code with {tests}, but on an import or build error, not on what the tests check. Check a test covers the behaviour before merging.
          </span>
          <details>
            <summary>How it fails without the change</summary>
            <pre>{proof.detail}</pre>
          </details>
        </>
      ) : proof.status === "unproven" ? (
        <>
          <b>⚠ Not proven: no test fails without this change</b>
          <span class="help">
            {" "}
            — <code>{proof.command}</code> passes on the base code too, with {tests}. Check the change is tested before merging.
          </span>
        </>
      ) : (
        <>
          <b>Couldn't prove a test fails without this change</b>
          <span class="help"> — {proof.detail}.</span>
        </>
      )}
    </div>
  );
}

/** The latest review of a result: its findings, which block approval, and what code-flow found running the reviewer's tests. */
function FindingsNote({ review }: { review: CheckedReview }) {
  const blocking = review.findings.filter((f) => f.blocking).length;
  return (
    <div class={`review-findings${blocking && !review.stale ? " blocking" : ""}`} role="note">
      <b>{review.stale ? "Review outdated — the result changed after this review" : blocking ? `⚠ ${blocking} review finding${blocking === 1 ? " blocks" : "s block"} approval` : "✓ No review finding blocks approval"}</b>
      <span class="help">
        {" "}
        — <AgentTag id={review.reviewer} /> {review.round > 1 ? `round ${review.round}` : "review"}. High and medium findings block; a high one (a bug) only when its test fails.
      </span>
      <ol class="findings">
        {review.findings.map((f, i) => (
          <li key={i} class={`sev-${f.severity}`}>
            <div>
              <span class={`sev ${f.severity}`}>{f.severity}</span> <code>{f.file || "general"}</code> {f.problem}{" "}
              {review.stale ? <span class="help">Historical finding</span> : f.blocking ? <span class="badge warn">Blocks</span> : f.severity === "low" ? <span class="help">Suggestion</span> : null}
            </div>
            {f.fix ? <div class="help">Fix: {f.fix}</div> : null}
            <CheckNote severity={f.severity} check={f.check} />
          </li>
        ))}
      </ol>
    </div>
  );
}

/** What code-flow found running a finding's repro: confirmed (with how it fails), a false alarm, or not shown by a test. */
function CheckNote({ severity, check }: { severity: string; check?: FindingCheck }) {
  if (!check) return null;
  const test = check.path ? <code>{check.path}</code> : "test";
  if (check.status === "confirmed") {
    return (
      <div class="finding-check confirmed">
        <b>✓ Confirmed</b>
        <span class="help">
          {" "}
          — the reviewer's {test} fails with <code>{check.command}</code>.
        </span>
        <details>
          <summary>How it fails</summary>
          <pre>{check.detail}</pre>
        </details>
        {check.contents ? (
          <details>
            <summary>The reviewer's test</summary>
            <pre>{check.contents}</pre>
          </details>
        ) : null}
      </div>
    );
  }
  if (check.status === "refuted") {
    return (
      <div class="finding-check refuted">
        <b>✗ Not confirmed</b>
        <span class="help">
          {" "}
          — the reviewer's {test} passes with <code>{check.command}</code>: a false alarm.
        </span>
      </div>
    );
  }
  if (severity === "low") return null;
  if (check.status === "unverified") {
    return (
      <div class="finding-check unverified">
        <b>Couldn't run the reviewer's test</b>
        <span class="help"> — {check.detail}.</span>
      </div>
    );
  }
  return (
    <div class="finding-check unconfirmed">
      <b>{severity === "high" ? "⚠ Unconfirmed" : "Not shown by a test"}</b>
      <span class="help"> — {check.detail}.</span>
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
  const provider = chatProvider(run);
  const [picked, setAgent] = useState<AgentId>(watch?.agent ?? lastAgentIn(steps, worktree) ?? "claude");
  const agent = provider ?? picked;
  const [maxFixes, setMaxFixes] = useState(String(watch?.maxFixes ?? 3));
  const validMaxFixes = /^\d+$/.test(maxFixes) && Number(maxFixes) >= 1 && Number(maxFixes) <= 10;
  const [allow, setAllow] = useState((watch?.allow ?? []).map((a) => `@${a}`).join(", "));
  const call = (body: object) => post(`/api/runs/${run.id}/watch`, { branch, ...body }).catch((e) => showError(e.message, 5000));
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
      {!active ? (
        <div class="row">
          <span class="lbl">Follow through</span>
          <span>When CI fails or you comment,</span>
          <AgentPicker value={agent} fixed={!!provider} onChange={setAgent} label="Agent that fixes CI failures and comments" />
          <span>fixes it and pushes — up to</span>
          <input class="field inline num" type="number" min={1} max={10} value={maxFixes} aria-label="Most fixes" aria-invalid={!validMaxFixes} onInput={(e) => setMaxFixes(e.currentTarget.value)} />
          <span>times. Never merges.</span>
          {!validMaxFixes ? <span role="alert">Most fixes must be an integer from 1 to 10.</span> : null}
          <button
            class="btn small primary"
            disabled={!validMaxFixes}
            onClick={() =>
              call({
                agent,
                maxFixes: Number(maxFixes),
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
      {!active ? (
        <div class="row">
          <span class="help">Also act on comments from</span>
          <input class="field inline" placeholder="@teammate, @reviewer" value={allow} aria-label="Other GitHub users whose comments the agent acts on" onInput={(e) => setAllow(e.currentTarget.value)} />
          <span class="help">— nobody else's, since these fixes are pushed without anyone reviewing them first.</span>
        </div>
      ) : null}
    </div>
  );
}

/** Branches you could merge a result into: local ones, never a run's result, with the run's base first. */
function useTargetBranches(run: RunSummary): { branches: string[]; initial: string } {
  const [info, setInfo] = useState<RepoInfo | null>(null);
  useEffect(() => {
    api<RepoInfo>(`/api/branches?repo=${encodeURIComponent(run.repo)}`).then(setInfo, () => setInfo(null));
  }, [run.repo]);
  const branches = (info?.branches ?? []).filter((b) => b.kind === "local" && !run.worktrees.some((tree) => tree.branch === b.name)).map((b) => b.name);
  const initial = run.baseLabel !== "HEAD" && branches.includes(run.baseLabel) ? run.baseLabel : info?.current ?? branches[0] ?? "";
  return { branches, initial };
}

const lastAgentIn = (steps: Step[], worktree: string): AgentId | undefined =>
  [...steps].reverse().find((s) => (s.kind ?? "agent") === "agent" && s.worktree === worktree && s.mode === "write")?.agent;

function MergePanel({ run, branch, worktree, steps, onMerged }: { run: RunSummary; branch: string; worktree: string; steps: Step[]; onMerged: () => void }) {
  const { branches, initial: base } = useTargetBranches(run);
  // A branch it was already merged into isn't the next target.
  const mergedInto = new Set(run.merges?.filter((m) => m.branch === branch).map((m) => m.into));
  const initial = mergedInto.has(base) ? branches.find((b) => !mergedInto.has(b)) ?? base : base;
  const [into, setInto] = useState("");
  const [archiveAfter, setArchiveAfter] = useState(true);
  const [busy, setBusy] = useState(false);
  const [validating, setValidating] = useState(false);
  const [conflicts, setConflicts] = useState<string[] | null>(null);
  const [requireValidation, setRequireValidation] = useState(!!run.loop.verification);
  const [posted, setPosted] = useState<MergeValidation | null>(null);
  const [warning, setWarning] = useState("");
  const provider = chatProvider(run);
  const [picked, setAgent] = useState<AgentId>(lastAgentIn(steps, worktree) ?? "claude");
  const agent = provider ?? picked;
  const target = into || initial;
  // The server keeps the latest validation with the run: it outlives this panel and a reload.
  const saved = run.mergeValidation?.branch === branch ? run.mergeValidation : null;
  const validation = validating ? null : saved && (!posted || saved.at >= posted.at) ? saved : posted;
  const validated = validation?.branch === branch && validation.into === target && validation.report?.state === "verified" && !validation.conflicts.length;
  // The latest work on this branch was a conflict resolution that failed (and committed nothing).
  const latest = [...run.followUps].reverse().find((f) => f.worktree === worktree && !f.side && f.status !== "pending");
  const resolving = latest?.kind === "resolve-conflicts" && latest.status === "failed" ? latest : undefined;
  const validateTarget = async (allowUntrusted = false) => {
    setBusy(true);
    setValidating(true);
    setPosted(null);
    try { setPosted(await post(`/api/runs/${run.id}/validate-merge`, { branch, into: target, allowUntrusted })); }
    catch (error) {
      if (error instanceof ApiError && error.confirm === "allowUntrusted" && await confirmAction(`${error.message}\n\nRun validation on this computer?`, {"title":"Run validation locally?","confirmLabel":"Run validation","danger":true})) { setBusy(false); await validateTarget(true); return; }
      showError((error as Error).message, 5000);
    } finally { setBusy(false); setValidating(false); }
  };
  const merge = async (allowConflictMarkers = false) => {
    setBusy(true);
    setConflicts(null);
    setWarning("");
    try {
      const outcome = await post<MergeOutcome>(`/api/runs/${run.id}/merge`, { branch, into: target, archiveAfter, requireValidation, ...(allowConflictMarkers ? { allowConflictMarkers } : {}) });
      if (outcome.ok) {
        // Its verification was for the target before the merge.
        setPosted(null);
        // Merged, but with something to look at (git stopped while a hook ran): said where it's seen,
        // so the panel stays open with it.
        if (outcome.warning) { setWarning(outcome.warning); showToast(`${outcome.warning}${archiveAfter ? " The run was archived." : ""}`, 12000); }
        else {
          showToast(`Merged into ${target}${archiveAfter ? " and archived the run" : ""}`, 3000);
          // Done: the card shows "Merged into".
          onMerged();
        }
      } else setConflicts(outcome.conflicts);
    } catch (err) {
      // Lines that look like conflict markers but belong there (a test fixture, a documented example).
      if (err instanceof ApiError && err.confirm === "allowConflictMarkers") {
        setBusy(false);
        if (await confirmAction(`${err.message}\n\nMerge into ${target} with those lines in?`, { title: "Merge with conflict markers?", confirmLabel: "Merge anyway", danger: true })) await merge(true);
        return;
      }
      showError((err as Error).message, 5000);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="ship-panel">
      <div class="row">
        <label class="lbl">Merge into</label>
        <select class="field" aria-label="Merge into" value={target} onChange={(e) => setInto(e.currentTarget.value)}>
          {branches.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
        <label class="check">
          <input type="checkbox" checked={archiveAfter} onChange={(e) => setArchiveAfter(e.currentTarget.checked)} /> Archive the run afterwards (removes its worktrees, keeps branches)
        </label>
        <button class="btn primary small" disabled={busy || !target || requireValidation && !validated} onClick={() => merge()}>
          {busy && !validating ? "Merging…" : `Merge into ${target || "…"}`}
        </button>
      </div>
      {run.loop.check || run.loop.verification ? <div class="row"><label class="check"><input type="checkbox" checked={requireValidation} onChange={(event) => setRequireValidation(event.currentTarget.checked)} /> Require verification of the current merge target</label><button class="btn small" disabled={busy || !target} onClick={() => validateTarget()}>{validating ? "Validating…" : "Validate merge result"}</button>{validation?.into === target ? <span role="status" class="help">{validation.conflicts.length ? `Conflicts: ${validation.conflicts.join(", ")}` : `Merge verification: ${validation.report?.state ?? "unchecked"}`} · target {validation.target.slice(0, 12)}{validation.report ? ` · ${validation.report.checks.length} gate${validation.report.checks.length === 1 ? "" : "s"}` : ""} · validated {ago(validation.at)}</span> : null}</div> : null}
      {validation?.into === target && validation.report && validation.report.state !== "verified" ? <MergeValidationGates report={validation.report} /> : null}
      {mergedInto.has(target) ? <div class="help">Already merged into {target}: merging again brings only what's new on {branch} since.</div> : null}
      {resolving ? <div class="msg warn">Resolving the conflicts with {resolving.mergeFrom} failed{resolving.result ? `: ${resolving.result}` : "."}</div> : null}
      {warning ? <div class="msg warn" role="status">{warning}</div> : null}
      <div class="help">If {target || "the branch"} is checked out, code-flow merges there only when it has no uncommitted changes, and aborts cleanly on conflicts.</div>
      {conflicts ? (
        <div class="conflicts">
          <div class="msg warn">
            Merging would conflict in {conflicts.length} file{conflicts.length === 1 ? "" : "s"}: {conflicts.join(", ")}
          </div>
          <div class="row">
            <span>Ask</span>
            <AgentPicker value={agent} fixed={!!provider} onChange={setAgent} />
            <span>
              to merge {target} into this branch and resolve them, then merge again.
            </span>
            <button
              class="btn small"
              onClick={() =>
                post(`/api/runs/${run.id}/followups`, { kind: "resolve-conflicts", worktree, agent, mergeFrom: target }).then(
                  () => showToast("Sent — the agent is resolving the conflicts"),
                  (e) => showError(e.message, 5000),
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

const MERGE_METHOD_TEXT: Record<MergeMethod, string> = { merge: "Create a merge commit", squash: "Squash and merge", rebase: "Rebase and merge" };
const CI_TEXT = { pass: "CI passing", fail: "CI failing", pending: "CI still running", none: "no CI checks" } as const;

/** Merge the branch's pull request on GitHub (or, if you'd rather, into a local branch). */
function PrMergePanel({ run, branch, worktree, steps }: { run: RunSummary; branch: string; worktree: string; steps: Step[] }) {
  const [info, setInfo] = useState<PrMergeInfo | null>(null);
  const [error, setError] = useState("");
  const [method, setMethod] = useState<MergeMethod | "">("");
  const [archiveAfter, setArchiveAfter] = useState(true);
  const [busy, setBusy] = useState(false);
  const [local, setLocal] = useState(false);
  useEffect(() => {
    api<PrMergeInfo>(`/api/runs/${run.id}/pr-merge?branch=${encodeURIComponent(branch)}`).then(setInfo, (e) => setError((e as Error).message));
  }, [run.id, branch]);
  const how = method || info?.methods[0] || "merge";
  const name = info ? `PR #${info.number}` : "the PR";
  const open = info?.state === "OPEN";
  const merge = async () => {
    if (!info || !await confirmAction(`${MERGE_METHOD_TEXT[how]}: merge ${name} into ${info.baseRefName} on GitHub?`, {"title":"Merge pull request?","confirmLabel":"Merge pull request","danger":true})) return;
    setBusy(true);
    try {
      const outcome = await post<{ merged: boolean; already?: boolean; into: string; warning?: string }>(`/api/runs/${run.id}/merge-pr`, { branch, method: how, archiveAfter });
      if (!outcome.merged) showToast(`GitHub accepted the merge; ${name} merges once the repository's requirements are met`, 6000);
      else showToast(`${outcome.already ? `${name} was already merged` : `Merged ${name}`} into ${outcome.into} on GitHub${archiveAfter ? " and archived the run" : ""}${outcome.warning ? `. ${outcome.warning}` : ""}`, outcome.warning ? 10000 : 4000);
      setInfo({ ...info, state: outcome.merged ? "MERGED" : info.state });
    } catch (err) {
      showError((err as Error).message, 6000);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div class="ship-panel">
        <div class="row">
          <label class="lbl">Merge pull request</label>
          {info ? (
            <a href={safeHref(info.url)} target="_blank" rel="noreferrer">
              #{info.number} into {info.baseRefName} <Icon name="external" />
            </a>
          ) : (
            <span class="help">{error ? "—" : "Asking GitHub…"}</span>
          )}
          {open ? (
            <>
              <select class="field" value={how} aria-label="How to merge" onChange={(e) => setMethod(e.currentTarget.value as MergeMethod)}>
                {info!.methods.map((m) => (
                  <option key={m} value={m}>
                    {MERGE_METHOD_TEXT[m]}
                  </option>
                ))}
              </select>
              <label class="check">
                <input type="checkbox" checked={archiveAfter} onChange={(e) => setArchiveAfter(e.currentTarget.checked)} /> Archive the run afterwards (removes its worktrees, keeps branches)
              </label>
              <button class="btn primary small" disabled={busy || info!.isDraft} onClick={merge}>
                {busy ? "Merging…" : `Merge ${name}`}
              </button>
            </>
          ) : null}
        </div>
        {error ? <div class="msg err">{error}</div> : null}
        {info?.state === "MERGED" ? <div class="msg">{name} is merged into {info.baseRefName}.</div> : null}
        {info?.state === "CLOSED" ? <div class="msg warn">{name} is closed. Reopen it on GitHub to merge it.</div> : null}
        {open && info!.isDraft ? <div class="msg warn">{name} is a draft. Mark it ready for review on GitHub, then merge.</div> : null}
        {open && info!.mergeable === "CONFLICTING" ? <div class="msg warn">GitHub says {name} conflicts with {info!.baseRefName}: merge {info!.baseRefName} into the branch and resolve them first.</div> : null}
        {open ? (
          <div class="help">
            {CI_TEXT[info!.ci]}. code-flow merges it on GitHub only while it's exactly the branch you reviewed here, and deletes no branches.{" "}
            <button class="linkish" onClick={() => setLocal(!local)}>
              {local ? "Hide local merge" : "Merge into a local branch instead…"}
            </button>
          </div>
        ) : null}
      </div>
      {local || error ? <MergePanel run={run} branch={branch} worktree={worktree} steps={steps} onMerged={() => setLocal(false)} /> : null}
    </>
  );
}

function PrPanel({ run, branch, focusOnOpen = false }: { run: RunSummary; branch: string; focusOnOpen?: boolean }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => { if (focusOnOpen) { panel.current?.scrollIntoView({ block: "center" }); panel.current?.focus({ preventScroll: true }); } }, []);
  // Only branches that are on GitHub now: the run's starting branch may have been merged and deleted.
  const [targets, setTargets] = useState<{ branches: string[]; initial: string; runBranches?: string[] } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<{ branches: string[]; initial: string; runBranches?: string[] }>(`/api/runs/${run.id}/pr-targets?branch=${encodeURIComponent(branch)}`).then(setTargets, (e) => setError((e as Error).message));
  }, [run.id, branch]);
  const [into, setInto] = useState("");
  const [busy, setBusy] = useState(false);
  const [published, setPublished] = useState("");
  const target = into || targets?.initial || "";
  return (
    <div class="ship-panel" ref={panel} tabIndex={-1} aria-label="Create pull request">
      <div class="row">
        <label class="lbl">Pull request into</label>
        <select class="field" aria-label="Pull request into" value={target} disabled={!targets} onChange={(e) => setInto(e.currentTarget.value)}>
          {targets ? null : <option value="">{error ? "—" : "Asking GitHub…"}</option>}
          {(targets?.branches ?? []).filter((b) => b !== branch).map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
          {targets?.runBranches?.length ? <optgroup label="Other code-flow run branches">{targets.runBranches.filter(b => b !== branch).map(b => <option key={b} value={b}>{b}</option>)}</optgroup> : null}
        </select>
        <button
          class="btn primary small"
          disabled={busy || !target}
          onClick={async () => {
            setBusy(true);
            try {
              const { url } = await post<{ url: string }>(`/api/runs/${run.id}/pr`, { branch, into: target });
              setPublished(url);
              showToast("Pull request created — use View pull request to open it", 5000);
            } catch (err) {
              showError((err as Error).message, 6000);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Opening…" : "Push & open PR"}
        </button>
      </div>
      {published ? <p class="msg ok" role="status">Pull request ready. <a href={safeHref(published)} target="_blank" rel="noreferrer">View pull request <Icon name="external" /></a></p> : null}
      {error ? <div class="msg warn">{error}</div> : null}
      <div class="help">
        This pushes <code>{branch}</code> to <code>origin</code> and creates a pull request with the run's title, summary and check evidence. The task appears in a collapsed section.
      </div>
    </div>
  );
}

const existsHint = (run: RunSummary) => !run.archived; // archived runs may have had their worktrees removed

/** Try a result: open its worktree in your tools, or run the app from it. */
/** An app a run started, as a page of the side panel's Browser (for the run the panel shows). */
function showInPanel(url: string) {
  openBrowserPage(url);
}

function WorkspaceTools({ run, worktree }: { run: RunSummary; worktree: string }) {
  const base = `/api/runs/${run.id}/worktrees/${encodeURIComponent(worktree)}`;
  const [server, setServer] = useState<{ url: string; status: string; logs: string[]; command: string; exitCode?: number | null } | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const [command, setCommand] = useState(run.app?.command ?? "");
  usePoll((current) => api(base + "/serve").then((s) => current() && setServer(s), () => {}), 2000, [base]);
  const open = (target: string) =>
    post<{ openedWith: string }>(`${base}/open`, { target }).then((r) => showToast(`Opened in ${r.openedWith}${onPhone ? " on your computer" : ""}`), (e) => showError(e.message, 5000));
  /** Start the app; for a locked-down run, only once you've said to run that code here. It opens in the side panel's Browser. */
  const runApp = async () => {
    try {
      const started = await post<NonNullable<typeof server>>(base + "/serve", { command });
      setServer(started);
      if (!onPhone) showInPanel(started.url);
    } catch (e) {
      if (!(e instanceof ApiError) || e.confirm !== "allowUntrusted") return showError((e as Error).message, 5000);
      if (!await confirmAction(`${e.message}\n\nRun it on this computer anyway?`, {"title":"Run repository code locally?","confirmLabel":"Run app","danger":true})) return;
      await post(base + "/serve", { command, allowUntrusted: true }).then(setServer, (err) => showError(err.message, 5000));
    }
  };
  // From the phone, the app is on the computer's Wi-Fi address — reachable if it listens there.
  const appUrl = server && onPhone ? server.url.replace("//localhost:", `//${location.hostname}:`) : server?.url;
  return (
    <div class="ws-tools">
      <span class="lbl">{onPhone ? "On your computer" : "Try it"}</span>
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
          <a
            class="btn small primary"
            href={safeHref(appUrl)}
            target="_blank"
            rel="noreferrer"
            title={onPhone ? "Opens only if the app listens on your network too (e.g. vite --host)" : undefined}
          >
            Open {appUrl!.replace("http://", "")} <Icon name="external" />
          </a>
          {onPhone ? null : (
            <button class="btn small" title="Show it in the side panel's Browser, where you can annotate it" onClick={() => showInPanel(server.url)}>
              Show in panel
            </button>
          )}
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
            onClick={() => void runApp()}
          >
            Run app
          </button>
          {server?.status === "exited" ? <span class="msg warn">exited ({server.exitCode})</span> : null}
        </>
      )}
      {showLogs && server ? <pre class="serve-logs">{server.logs.slice(-80).join("\n") || "(no output yet)"}</pre> : null}
    </div>
  );
}

/**
 * A select of the available agents; named "Agent" unless told otherwise (several sit inline in a sentence, with no label of their own).
 * With no value it shows `placeholder`, chosen by nobody, so picking any agent (the first one too) is a choice. `fixed`: an Agent
 * chat keeps its provider, so it's named rather than offered.
 */
export function AgentPicker({ value, onChange, label = "Agent", placeholder = "Choose an agent…", fixed = false }: { value: AgentId | undefined; onChange: (id: AgentId) => void; label?: string; placeholder?: string; fixed?: boolean }) {
  if (fixed && value) return <span class="agent-fixed" title="This chat keeps its provider. Open a provider tab to switch providers.">{agents.value.find((a) => a.id === value)?.displayName ?? value}</span>;
  return (
    <select class="field inline" aria-label={label} value={value ?? ""} onChange={(e) => onChange(e.currentTarget.value as AgentId)}>
      {value ? null : <option value="" disabled>{placeholder}</option>}
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

// ---------------------------------------------------------------- talking to the team
function AwaitingCard({ run, compact = false }: { run: RunSummary; compact?: boolean }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const answer = async (decision: "approve" | "revise" | "reject") => {
    if (decision === "reject" && !await confirmAction("Reject and end the run? Nothing will be built.", {"title":"Reject this plan?","confirmLabel":"Reject plan","danger":true})) return;
    setBusy(true);
    try {
      await post(`/api/runs/${run.id}/answer`, { decision, note });
      setNote("");
    } catch (err) {
      showError((err as Error).message, 4000);
    } finally {
      setBusy(false);
    }
  };
  const awaiting = run.awaiting!;
  if (compact) return <section class="conversation-approval" aria-label="Team plan approval">
    <div class="conversation-approval-heading"><span class="task-team-dot" /><b>Your team has a plan</b></div>
    {run.team?.rationale ? <p>{run.team.rationale.slice(0, 280)}</p> : <p>Review the proposed work before the team starts.</p>}
    {run.team?.tasks.length ? <ul>{run.team.tasks.slice(0, 3).map(task => <li key={task.id}>{task.title}</li>)}{run.team.tasks.length > 3 ? <li>And {run.team.tasks.length - 3} more in the full plan</li> : null}</ul> : null}
    <details class="conversation-plan-details"><summary>Review full plan</summary><Markdown text={awaiting.content} /><label class="lbl">Changes to the plan<textarea class="field" rows={2} value={note} onInput={event => setNote(event.currentTarget.value)} /></label><div class="row"><button class="btn small" disabled={busy || !note.trim()} onClick={() => answer("revise")}>Ask for changes</button><button class="btn ghost small" disabled={busy} onClick={() => answer("reject")}>Reject plan</button></div></details>
    <div class="conversation-approval-actions"><button class="btn primary" disabled={busy} onClick={() => answer("approve")}>{busy ? "Sending…" : "Approve plan"}</button><span class="help">You can also send changes in the chat.</span></div>
  </section>;
  return (
    <div class="awaiting-card">
      <div class="aw-head">
        <span class="status-pill awaiting">Waiting for you</span>
        <b>{awaiting.title}</b>
        <span class="help">The run is paused, and so is its time budget.</span>
      </div>
      <div class="aw-body" tabIndex={0} role="region" aria-label="Proposed plan">
        <Markdown text={awaiting.content} />
      </div>
      <div class="aw-actions">
        <textarea class="field" rows={2} placeholder="What should change? (needed for “Ask for changes”, optional otherwise)" value={note} onInput={(e) => setNote(e.currentTarget.value)} />
        <div class="row">
          <button class="btn primary" disabled={busy} onClick={() => answer("approve")}>
            ✓ Approve
          </button>
          <button class="btn" disabled={busy || !note.trim() || !!run.teamRerun} onClick={() => answer("revise")} title={run.teamRerun ? "Reject this pinned rerun and create another selection to change its tasks or instructions" : note.trim() ? "" : "Write what should change first"}>
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
/** Snapshots waiting to go with a message, each with a way to drop it. */
export function DraftImages({ images, onRemove, message = "" }: { images: Attachment[]; onRemove: (i: number) => void; message?: string }) {
  const browserImages = browserImageNames(message);
  if (!images.length) return null;
  return (
    <div class="draft-images">
      {images.map((im, i) => browserImages.has(im.name) ? null : (
        <span key={i} class="draft-img" title={im.name}>
          <img src={`data:image/png;base64,${im.data}`} alt={im.name} />
          <span class="di-name">{im.name}</span>
          <button type="button" class="icon-btn" aria-label={`Don't send ${im.name}`} onClick={() => onRemove(i)}>
            <Icon name="close" />
          </button>
        </span>
      ))}
    </div>
  );
}

function UndeliveredNotes({ notes, onRestore }: { notes: Note[]; onRestore?: (note: Note) => void }) {
  return <div class="notes undelivered-notes" aria-label="Undelivered messages">{notes.map(note => <div key={note.id} class="chip-ctx note-chip undelivered"><span class="n">Not delivered — the run finished first: {parseBrowserMessage(note.text).text || "Browser context"}</span>{onRestore ? <button type="button" class="btn small" onClick={() => onRestore(note)}>Put in reply box</button> : <span>Resume the run to send this message.</span>}</div>)}</div>;
}

export function ConversationBar({ run, steps, chat, onOpenChat }: { run: RunSummary; steps: Step[]; chat: boolean; onOpenChat?: (id: string) => void }) {
  const { text, setText, images, setImages, ready: draftReady, warning: draftWarning } = useMessageDraft(`main:${run.id}`, `agent-draft:${run.id}`);
  const [target, setTarget] = useState("");
  const [handoff, setHandoff] = useState<{ agent: AgentId; settings: ChatSettings } | null>(null);
  const openChat = onOpenChat ?? (id => navigate({ view: "run", id }));
  const [replySettings, setReplySettings] = useState<Record<string, ChatSettings>>({});
  const [replyPermissions, setReplyPermissions] = useState<ChatPermissions | null>(null);
  const [busy, setBusy] = useState(false);
  // Only what you change is kept: until then the budget follows the run and the target you pick.
  const [editedSteps, setEditedSteps] = useState<number | null>(null);
  const [followupMinutes, setFollowupMinutes] = useState(() => wholeMinutes(run.loop.maxMinutes));
  const area = useRef<HTMLTextAreaElement>(null);
  // Pins sent here from the side panel's Browser land in the box, to add a line to before sending.
  // Without a box (a run that failed or stopped) they wait in the queue, for when it's resumed.
  const takes = run.status === "running" || run.status === "done" || chat && run.worktrees.length > 0;
  useEffect(() => {
    if (!takes || !draftReady) return;
    const drafts = takeDrafts(`main:${run.id}`);
    if (!drafts.length) return;
    setText((t) => appendDraftText(t, drafts.map(d => d.text)));
    setImages((i) => [...i, ...drafts.flatMap((d) => d.images)]);
    area.current?.focus();
  }, [chatDrafts.value, run.id, takes, draftReady]);
  // The box grows with what you type, up to a limit (then it scrolls).
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    // In a hidden tab the box measures 0: leave it at its natural height rather than shrink it to nothing.
    if (el.scrollHeight) el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);
  // Only side chats working (the team is done): what you send here is a reply that waits for them, not a
  // message for the team, which no side turn would take.
  const pending = run.followUps.filter((f) => f.status === "pending");
  const sideOnly = run.status === "running" && !!run.patternDone && pending.length > 0 && pending.every((f) => f.side);
  // A new run starts from the result's branch as it is now: it would miss a side Change still to land
  // there. (An Ask changes nothing, and a change on another branch never reaches the new run anyway.)
  const resultBranch = run.artifacts[0]?.branch;
  const waitForSide = sideOnly && !!resultBranch && pending.some((f) => f.side?.mode === "change" && run.worktrees.find((w) => w.name === f.worktree)?.branch === resultBranch);
  const running = run.status === "running" && !sideOnly;
  // Who you can talk to after the run: each agent that wrote code, in its worktree, and a team's lead in
  // its result; not where the branch was deleted (nothing is left to continue from there).
  const writers = replyTargets(run, steps);
  const teamAgents = [...new Set(Object.values(run.roles).flat())];
  const coordinator = run.team?.members.find((member) => member.role === "coordinator");
  const soloAgent = run.pattern === "solo" ? run.conversationAgent ?? run.roles.agent?.[0] : undefined;
  const soloWriter = soloAgent ? writers.find((step) => step.agent === soloAgent) : undefined;
  const defaultTarget = !running && soloAgent && run.worktrees.some(tree => tree.name === "solo") ? `${soloAgent}@solo` : running ? coordinator && coordinator.status !== "retired" ? `member:${coordinator.id}` : "" : run.team ? "team" : writers.at(-1) ? `${writers.at(-1)!.agent}@${writers.at(-1)!.worktree}` : "team";
  const targets = running ? run.team ? run.team.members.filter((member) => member.status !== "retired").map((member) => `member:${member.id}`) : teamAgents : ["team", ...writers.map((step) => `${step.agent}@${step.worktree}`)];
  const chosen = target && targets.includes(target) ? target : defaultTarget;
  const targetProvider = chosen.includes("@") ? chosen.split("@")[0] as AgentId : undefined;
  const replyAgent = soloAgent ?? targetProvider;
  const lastReply = run.followUps.filter((turn) => !turn.side && turn.agent === replyAgent).at(-1);
  const selectedSettings = replyAgent ? replySettings[replyAgent] ?? lastReply?.settings ?? run.agentSettings[replyAgent] ?? {} : {};
  const selectedPermissions = replyPermissions ?? { trust: lastReply?.trust ?? run.trust, tools: lastReply?.tools ?? !!run.approvals.tools };
  const memberId = chosen.startsWith("member:") ? chosen.slice(7) : undefined;
  const member = run.team?.members.find((item) => item.id === memberId);
  const minimumCalls = followupMinimumCalls(!!run.team, running, chosen);
  const followupSteps = editedSteps ?? defaultFollowupCalls(run.loop, minimumCalls);
  const budgetValid = Number.isInteger(followupSteps) && followupSteps >= minimumCalls && followupSteps <= 200 && Number.isFinite(followupMinutes) && followupMinutes >= 1 && followupMinutes <= 720;
  const undelivered = (run.notes ?? []).filter(note => note.status === "undelivered");
  const signedOut = !running ? replySignInIssue(run, replyAgent, health.value) : undefined;
  const latestReply = !running ? run.followUps.filter(turn => !turn.side).at(-1) : undefined;
  const latestReplyFailed = latestReply?.status === "failed";
  const authFailed = !run.loop.remoteWorker && !run.loop.agentContainer && latestReplyFailed && steps.find(step => step.id === latestReply?.stepId)?.errorKind === "auth";
  if (!takes) return undelivered.length ? <div class="convo"><UndeliveredNotes notes={undelivered} /></div> : null;

  const send = async () => {
    if (!draftReady || !text.trim() || busy || (!running && !budgetValid)) return;
    setBusy(true);
    try {
      const files = images.map(({ name, data }) => ({ name, data }));
      if (running) {
        const note = await post<Note>(`/api/runs/${run.id}/notes`, { text, agent: memberId ? undefined : chosen || undefined, memberId });
        if (images.length) showToast("Sent. The snapshots stay here: they go with a reply once the run has finished", 6000);
        else if (note.requestId) showToast("Answer sent to the team");
        else if (note.control) showToast("Stopped — work is saved");
        else if (note.teamDelivery) showToast("Received — updating the team with your message");
        else if (note.deliveredTo?.midTurn) showToast(`Sent into ${agentName(note.deliveredTo.agent)}'s running turn`);
        else showToast(chosen ? `Queued for ${member?.name ?? agentName(chosen)}'s next turn` : "Queued for the next agent's turn");
        setText("");
        return;
      } else if (chosen === "team") {
        if (waitForSide) {
          showToast("Wait for the side chat to finish: a new run would start without its change", 6000);
          return;
        }
        // From the result, or where the run started if its branch was deleted.
        const result = run.artifacts[0]?.branch;
        const base = result && !run.deletedWorktrees?.some((d) => d.branch === result && !run.worktrees.some((w) => w.branch === result)) ? result : run.baseLabel;
        const { id } = await post<{ id: string }>("/api/runs", {
          repo: run.repo,
          task: `${run.task}\n\n## Feedback on the previous attempt\n${text.trim()}`,
          pattern: run.pattern,
          roles: run.roles,
          options: run.options,
          baseRef: base === "HEAD" ? "" : base,
          context: { paths: (run.context?.paths ?? []).map((c) => ({ path: c.path })), attachments: files },
          agentSettings: run.agentSettings,
          roleSettings: run.roleSettings,
          trust: run.trust,
          project: run.project,
          loop: { ...run.loop, maxSteps: followupSteps, maxInvocations: followupSteps, maxMinutes: followupMinutes },
          approvals: run.approvals,
          parentRunId: run.id,
        });
        navigate({ view: "run", id });
      } else {
        const [targetAgent, worktree] = chosen.split("@");
        const agent = replyAgent ?? targetAgent;
        await post(`/api/runs/${run.id}/followups`, { kind: "reply", agent, settings: selectedSettings, trust: selectedPermissions.trust, tools: selectedPermissions.tools, worktree, message: text, attachments: files, budget: { maxSteps: followupSteps, maxInvocations: followupSteps, maxMinutes: followupMinutes } });
        showToast(sideOnly ? "Queued: it goes once the side chat is done" : "Sent — the agent is on it");
      }
      setText("");
      setImages([]);
      setEditedSteps(null); // that reply's allocation was used; the next one starts from the defaults again
    } catch (err) {
      showError((err as Error).message, 5000);
    } finally {
      setBusy(false);
    }
  };

  const reviseGoal = async () => {
    if (!running || !run.team || !text.trim() || busy || !budgetValid) return;
    setBusy(true);
    try {
      const { id } = await post<{ id: string }>(`/api/runs/${run.id}/revise-goal`, { message: text.trim(), budget: { maxSteps: followupSteps, maxInvocations: followupSteps, maxMinutes: followupMinutes } });
      setText(""); navigate({ view: "run", id });
    } catch (error) { showError((error as Error).message, 5000); }
    finally { setBusy(false); }
  };

  const [agentId, worktree] = chosen.split("@") as [AgentId, string | undefined];
  const name = member?.name ?? SHORT[agentId] ?? agentId;
  const direct = writers.find((target) => `${target.agent}@${target.worktree}` === chosen);
  /** In a chat there's one agent to talk to, so no "To"; a message it can't take now is its next turn. */
  const chatName = SHORT[(soloAgent ?? writers.at(-1)?.agent ?? teamAgents[0])!] ?? "the agent";
  const hint = chat
    ? running
      ? `Goes into ${chatName}'s running turn if it takes messages, otherwise it's sent as soon as the turn ends`
      : chosen === "team"
        ? waitForSide
          ? "Starts again from this result: wait for the side chat to finish first"
          : "Starts again from this result"
        : `Continues ${chatName}'s session on its branch${sideOnly ? ", once the side chat is done" : ""}`
    : running
      ? chosen
        ? memberId ? `Sent to ${name}'s next turn` : `Steered into ${name}'s running turn if it takes messages, otherwise its next turn`
        : "Goes to the next agent that takes a turn"
      : chosen === "team"
        ? `${run.team ? "Builds a revised team and plan from this result, with your approval settings" : "Starts a new run with the same team, from this result"}${waitForSide ? ": wait for the side chat to finish first" : ""}`
        : run.team
          // A provider-addressed reply never borrows a member's private session.
          ? direct?.delivered
            ? `${name} changes the delivered result in ${worktree}; the team's review then no longer covers it, so run the whole team again to verify${sideOnly ? ". Goes once the side chat is done" : ""}`
            : `${name} changes only ${worktree}'s branch, which isn't part of the delivered result${sideOnly ? ". Goes once the side chat is done" : ""}`
          : `Continues ${name}'s session on its branch, in ${worktree}${sideOnly ? ", once the side chat is done" : ""}`;
  const placeholder = chat ? `Message ${chatName}…` : running ? "Message the team…" : chosen === "team" ? "Tell the team what to change…" : `Reply to ${name}…`;
  // In a chat, what you said is already in the thread; only what's still on its way shows here.
  const liveSteps = new Set(steps.filter((s) => s.status === "running").map((s) => s.id));
  const shownNotes = (run.notes ?? []).filter((n) => !chat || n.status === "queued" || (n.deliveredTo && liveSteps.has(n.deliveredTo.stepId) && !n.followUp));
  const pendingNotes = shownNotes.filter((note) => note.status === "queued");
  const sentNotes = shownNotes.filter((note) => note.status === "delivered");
  const noteChip = (n: Note) => (
    <span key={n.id} class={`chip-ctx note-chip ${n.status}`} title={n.text}>
      <span class="n">
        {n.followUp
          ? "✓ Sent as your next message"
          : n.requestId ? "✓ Answered the team's question" : n.status === "delivered"
            ? `✓ Delivered to ${run.team?.members.find((item) => item.id === n.memberId)?.name ?? agentName(n.deliveredTo?.agent) ?? "the team"}${noteStep(n, steps)}`
            : chat
              ? "Sent when this turn ends"
              : `Queued for ${run.team?.members.find((item) => item.id === n.memberId)?.name ?? agentName(n.agent) ?? "next agent"}`}
        : {parseBrowserMessage(n.text).text || parseBrowserMessage(n.text).contexts.map(context => context.comment || "Browser selection").join(" · ")}
      </span>
    </span>
  );

  return (
    <div class="convo">
      <div class="convo-inner">
        {chat ? <TaskTeamStatus run={run} /> : null}
        {handoff ? <ProviderChatDialog run={run} initialAgent={handoff.agent} initialSettings={handoff.settings} initialPermissions={selectedPermissions} initialMessage={text} attachments={images} onClose={() => setHandoff(null)} onOpenChat={openChat} /> : null}
        {!budgetValid ? <p class="msg err" role="alert">Send is off until the budget below allows {minimumCalls}–200 calls and 1–720 minutes.</p> : null}
        {!chat && (!running || run.team) ? <details class="followup-budget"><summary>{running ? "Goal revision budget" : "New execution budget"} · {followupSteps} {followupSteps === 1 ? "call" : "calls"} · {followupMinutes} min</summary><div class="at-row"><label>Maximum calls<input class="field" aria-label="Follow-up maximum calls" type="number" min={minimumCalls} max={200} value={followupSteps} onInput={(event) => setEditedSteps(Number(event.currentTarget.value))} /></label><label>Maximum minutes<input class="field" aria-label="Follow-up maximum minutes" type="number" min={1} max={720} value={followupMinutes} onInput={(event) => setFollowupMinutes(Number(event.currentTarget.value))} /></label></div><p class="help">{sideOnly ? "A reply queued behind a side chat joins the running execution's allowance; this budget applies when a reply starts a new execution. " : "This is a new allocation. "}The result branch, project memory and applicable context are retained. Earlier spend remains in lifetime usage.</p></details> : null}
        {running && sentNotes.length ? <details key={run.id} class="activity note-history">
          <summary>Sent messages ({sentNotes.length})</summary>
          <div class="notes">{sentNotes.map(noteChip)}</div>
        </details> : null}
        {running && pendingNotes.length ? <div class="notes">{pendingNotes.map(noteChip)}</div> : null}
        {!draftReady ? <p class="help" role="status">Restoring reply draft…</p> : draftWarning ? <p class="msg warn" role="status">{draftWarning}</p> : null}
        {undelivered.length ? <UndeliveredNotes notes={undelivered} onRestore={note => { setText(value => appendDraftText(value, [note.text])); area.current?.focus(); }} /> : null}
        {signedOut || authFailed ? <p class="msg warn reply-provider-warning" role="alert">{latestReplyFailed ? "The latest reply didn't finish. " : ""}{signedOut ? `${signedOut.name} isn't signed in` : `The latest reply couldn't sign in to ${agentName(replyAgent)}`} — <a href="#/settings/agents">open Settings → Agents &amp; models</a>. After signing in, send your reply again. <button type="button" class="btn small" disabled={providersRefreshing.value} onClick={() => void refreshProviders()}>{providersRefreshing.value ? "Checking…" : "Recheck sign-in"}</button></p> : latestReplyFailed ? <p class="help" role="status">The latest reply didn't finish. Work is saved; send another reply to continue.</p> : null}
        <BrowserDraftCards text={text} onText={setText} images={images} onImages={setImages} />
        <DraftImages message={text} images={images} onRemove={(i) => setImages(images.filter((_, j) => j !== i))} />
        <div class="chatbox">
          <textarea
            disabled={!draftReady}
            ref={area}
            rows={1}
            aria-label={chat ? "Message agent" : running ? "Message the team" : "Reply"}
            placeholder={placeholder}
            value={parseBrowserMessage(text).text}
            onInput={(e) => setText(editBrowserText(text, e.currentTarget.value))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div class="chatbox-bar chatbox-configurable">
            {chat ? null : (
              <label class="to">
                <span class="to-lbl">To</span>
                <select aria-label="Who gets this" value={chosen} onChange={(e) => setTarget(e.currentTarget.value)}>
                  {running ? (
                    <>
                      {run.team ? run.team.members.filter((item) => item.status !== "retired").map((item) => <option key={item.id} value={`member:${item.id}`}>{item.name} · {item.id} ({SHORT[item.provider]})</option>) : <><option value="">Next agent</option>{teamAgents.map((a) => <option key={a} value={a}>{SHORT[a] ?? a}</option>)}</>}
                    </>
                  ) : (
                    <>
                      {run.team ? (
                        <>
                          {writers.some((s) => s.delivered) ? (
                            <optgroup label="Change the result">
                              {writers.filter((s) => s.delivered).map((s) => (
                                <option key={`${s.agent}@${s.worktree}`} value={`${s.agent}@${s.worktree}`}>
                                  {SHORT[s.agent] ?? s.agent} · result ({s.worktree})
                                </option>
                              ))}
                            </optgroup>
                          ) : null}
                          {writers.some((s) => !s.delivered) ? (
                            <optgroup label="Worker branches (not in the result)">
                              {writers.filter((s) => !s.delivered).map((s) => (
                                <option key={`${s.agent}@${s.worktree}`} value={`${s.agent}@${s.worktree}`}>
                                  {SHORT[s.agent] ?? s.agent} · {s.worktree}
                                </option>
                              ))}
                            </optgroup>
                          ) : null}
                        </>
                      ) : writers.length ? (
                        <optgroup label="Continue a session">
                          {writers.map((s) => (
                            <option key={`${s.agent}@${s.worktree}`} value={`${s.agent}@${s.worktree}`}>
                              {SHORT[s.agent] ?? s.agent} · {s.worktree}
                            </option>
                          ))}
                        </optgroup>
                      ) : null}
                      <optgroup label="Start again">
                        <option value="team" disabled={waitForSide}>
                          Whole team · new run{waitForSide ? " (once the side chat is done)" : ""}
                        </option>
                      </optgroup>
                    </>
                  )}
                </select>
              </label>
            )}
            {!running && chosen !== "team" && replyAgent && !(chat && (runs.value.get(chatTaskId(run)) ?? run).taskTeam?.enabled) ? <ChatControls showPermissions={run.chatLink?.kind !== "side"} providers={run.chatLink?.kind === "side" ? agents.value.filter(item => item.id === "claude" || item.id === "codex" || item.id === "agy") : undefined} agent={replyAgent} onAgent={chat && draftReady ? agent => setHandoff({ agent, settings: agent === replyAgent ? selectedSettings : replySettings[agent] ?? {} }) : undefined} resetPermissionsOnAgentChange={!chat} settings={selectedSettings} onSettings={(value) => setReplySettings({ ...replySettings, [replyAgent]: value })} permissions={selectedPermissions} onPermissions={setReplyPermissions} restricted={!!run.lockdown || !!run.trigger} approvalsAvailable={!run.loop.remoteWorker && !run.loop.agentContainer} unrestricted={replyAgent === "agy" && run.permissions?.antigravityExecution === "native"} /> : null}
            {chat && soloAgent ? <TaskTeamControl run={run} lead={soloAgent} /> : null}
            {run.chatLink?.kind === "side" ? <span class="help">Read only</span> : null}
            <span class="chatbox-hint" title={hint}>
              {hint}
            </span>
            <button class="send" aria-label="Send" title="Send (↵ — ⇧↵ for a new line)" disabled={!draftReady || busy || !text.trim() || !running && !budgetValid} onClick={send}>
              <Icon name="send" />
            </button>
          </div>
        </div>
        {running && run.team && !run.awaiting ? <div class="goal-revision-action"><button class="btn small" disabled={!draftReady || busy || !text.trim() || !budgetValid} onClick={reviseGoal}>Revise goal</button><span class="help">Uses this message to stop the current execution and build a new team plan from integrated work, with your approval settings. Send keeps it as a member note.</span></div> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- transcript
/** Only the latest items are rendered at first: a long step can have thousands. */
const PAGE = 200;

function Transcript({ run, step, data }: { run: RunSummary; step?: Step; data: RunData; version: number }) {
  transcriptVersion(run.id);
  const body = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [shown, setShown] = useState(PAGE);
  const page = step ? data.pages?.get(step.id) : undefined;
  useEffect(() => { if (step && data.pagedTranscript && !data.pages.get(step.id)?.loaded) void loadStepTranscript(run.id, step.id); }, [run.id, step?.id, data.pages, data.pagedTranscript]);
  useEffect(() => setShown(PAGE), [step?.id]);
  useEffect(() => {
    if (stick.current && body.current) body.current.scrollTop = body.current.scrollHeight;
  });
  if (!step) return null;
  const items = itemsFor(data, step);
  const hidden = Math.max(0, items.length - shown);
  const model = modelNote(run, step.agent, step.settings);
  return (
    <div class="transcript" role="group" aria-label={`Transcript of ${step.title}`}>
      {step.remote ? <RemoteStepReceipt key={`${run.id}/${step.id}`} runId={run.id} step={step} /> : null}
      <div class="tr-head">
        {page ? <span class="row"><button class="btn small" disabled={page.loading || !page.before} onClick={() => { setShown(PAGE); void loadStepTranscript(run.id, step!.id, page.before); }}>Earlier events</button><button class="btn small" disabled={page.loading} onClick={() => { setShown(PAGE); void loadStepTranscript(run.id, step!.id); }}>Latest events</button>{page.loading ? <span role="status">Loading transcript…</span> : null}{page.historical ? <span>Viewing earlier events</span> : null}{page.error ? <span role="alert">{page.error}</span> : null}</span> : null}
        {model ? <span>{model}</span> : null}
        <span>{(step.kind ?? "agent") === "agent" ? (step.mode === "write" ? "can edit files" : "read-only") : "run by code-flow"}</span>
        <span>worktree {step.worktree}</span>
        {step.usage ? <span title={usageTitle(step.usage)}>{fmtTokens(step.usage.inputTokens + step.usage.outputTokens)} tokens{step.usage.costUsd ? ` · ≈${fmtCost(step.usage.costUsd)}` : ""}</span> : null}
        {step.contextInput ? <span title={`Measured assembled invocation input. Excludes: ${step.contextInput.excluded.join(", ")}. Input hash ${step.contextInput.hash}`}>{step.contextInput.bytes.toLocaleString()} input bytes · ≈{step.contextInput.approximateTokens.toLocaleString()} input tokens{step.contextInput.exceeded ? ` · ${step.contextInput.policy === "block" ? "blocked" : "budget warning"}` : ""}{step.contextInput.resumed ? " · earlier history excluded" : ""}</span> : null}
        {step.outcome === "warning" ? <span class="status-pill warn">Warning</span> : step.status !== "done" ? <span class={`status-pill ${step.status}`}>{STATUS_TEXT[step.status] ?? step.status}</span> : null}
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
            disabled={shown >= 1000}
            title={shown >= 1000 ? data.pagedTranscript ? "Use Earlier events to read more history in bounded pages" : "Update the remote server to browse more history in bounded pages" : undefined}
            onClick={() => {
              stick.current = false;
              setShown(Math.min(1000, shown + PAGE * 5));
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
    const key = ["command", "cmd", "file_path", "filePath", "path", "pattern", "url", "query", "description"].find((k) => typeof args[k] === "string" && args[k]);
    if (key) {
      value = args[key] as string;
      // Paths inside a worktree read best from the repo root.
      if (key === "file_path" || key === "filePath" || key === "path") value = value.replace(/^.*\/\.worktrees\/[^/]+\/[^/]+\//, "");
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

export interface Built {
  items: Item[];
  tools: Map<string, Extract<Item, { kind: "tool" }>>;
  messages?: Map<string, Extract<Item, { text: string }>>;
  /** Events already turned into items. */
  count: number;
}

/** The step's transcript, extended with only the events that arrived since the last render. */
export function itemsFor(data: RunData, step: Step): Item[] {
  const events = data.events.get(step.id) ?? [];
  let built = data.built.get(step.id);
  if (!built) {
    built = { items: [], tools: new Map(), count: 0 };
    data.built.set(step.id, built);
  }
  for (; built.count < events.length; built.count++) addItem(built, events[built.count]!, step.agent === "agy" || step.agent?.startsWith("acp:") === true);
  return built.items;
}

function addItem(built: Built, e: AgentEvent, streamsDeltas: boolean) {
  const { items, tools } = built;
  const last = items.at(-1);
  if ((e.kind === "text" || e.kind === "thinking") && e.messageId) {
    const messages = built.messages ??= new Map();
    const key = `${e.kind}:${e.messageId}`;
    let item = messages.get(key);
    if (!item) { item = { kind: e.kind, text: "", v: 0 }; messages.set(key, item); items.push(item); }
    item.text = e.delta ? item.text + e.text : e.text;
    item.v++;
    return;
  }
  switch (e.kind) {
    case "text":
      // ACP and agy stream small deltas; the other CLIs send whole blocks.
      if (streamsDeltas && last?.kind === "text" && last.text.length + e.text.length <= 32 * 1024) {
        last.text += e.text;
        last.v++;
      } else items.push({ kind: "text", text: e.text, v: 0 });
      break;
    case "thinking":
      if (streamsDeltas && last?.kind === "thinking" && last.text.length + e.text.length <= 32 * 1024) {
        last.text += e.text;
        last.v++;
      } else items.push({ kind: "thinking", text: e.text, v: 0 });
      break;
    case "tool_call": {
      const existing = tools.get(e.callId);
      if (existing) {
        existing.name = e.name;
        existing.input = e.input;
        existing.v++;
        break;
      }
      const tool = { kind: "tool" as const, name: e.name, input: e.input, v: 0 };
      tools.set(e.callId, tool);
      items.push(tool);
      break;
    }
    case "tool_result": {
      let tool = tools.get(e.callId);
      if (!tool) {
        tool = { kind: "tool", name: "Tool result (call in an earlier page)", input: "", v: 0 };
        tools.set(e.callId, tool); items.push(tool);
      }
      if (tool) {
        tool.output = e.delta ? (tool.output ?? "") + e.output : e.output;
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
        <span>
          Activity log ({logs.length}){warnings ? <span class="warn"> · {warnings} warning{warnings === 1 ? "" : "s"}</span> : null}
        </span>
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
let rerunRequest = 0;
export async function editAndRerun(run: RunSummary) {
  if (run.projectTeam) {
    showToast("Use the project mission's revision controls to revise this result.", 4000);
    if (run.project) navigate({ view: "project", id: run.project, section: "automation", kind: "missions" });
    return;
  }
  const request = ++rerunRequest;
  const origin = route.value;
  const destination = projectFor(run);
  // One draft per project: what you were writing there is replaced only when you say so.
  const unsent = await unsentDraft(destination?.id ?? "");
  const clipped = unsent && unsent.task.length > 80 ? `${unsent.task.slice(0, 80)}…` : unsent?.task;
  if (unsent && !await confirmAction(`Edit & run again puts this run's task and settings in the ${destination ? `${destination.name} draft` : "unassigned draft"}. Your unsent draft${clipped ? ` “${clipped}”` : ""} will be replaced.\n\nSend or copy it first to keep it.`, { title: "Replace your unsent draft?", confirmLabel: "Replace draft" })) return;
  if (request !== rerunRequest || route.value !== origin) return;
  if (!await openComposer(destination?.id ?? "", { repository: run.repo, stay: true })) return;
  if (request !== rerunRequest || route.value !== origin || repo.value !== run.repo) return;
  rerunDraft.value = structuredClone({ id: run.id, repo: run.repo, loop: run.loop, approvals: run.approvals ?? {}, source: run.source, checkpointOnFinish: run.checkpointOnFinish, baseRef: run.baseRef, task: run.task, contextPaths: (run.context?.paths ?? []).map(c => ({ path: c.path, type: c.type })) });
  composerRunOptions.value = {
    remoteWorker: run.loop.remoteWorker,
    container: { enabled: !!run.loop.agentContainer, image: run.loop.agentContainer?.image ?? "", authVolume: run.loop.agentContainer?.authVolume ?? "" },
    verification: run.loop.verification ? "restored" : "",
    verificationProfile: run.loop.verification ?? null,
    toolApprovals: run.approvals?.tools === true,
    antigravityExecution: run.permissions?.antigravityExecution,
    permissionRequirements: [...(run.permissions?.required ?? [])],
  };
  intentDraft.value = run.intent;
  journeyDraft.value = undefined;
  externalSource.value = null;
  setAcceptanceCriteria([]);
  branchPrefix.value = "";
  // The original commit, permissions, commands and limits are this retry's own: they aren't
  // remembered for later drafts, and the draft returns to its defaults once the retry starts.
  baseRef.value = run.baseRef ?? "";
  trust.value = run.trust ?? "standard";
  chooseForDraft("trust", RERUN_ORIGIN);
  setApprovePlan(run.approvals?.plan === true, run.pattern);
  agentSettings.value = structuredClone(run.agentSettings ?? {});
  roleModels.value = { ...roleModels.value, [run.pattern]: structuredClone(run.roleSettings ?? {}) };
  setContextBudget(run.loop.contextBudget, "Original run");
  setPattern(run.pattern);
  for (const [role, ids] of Object.entries(run.roles)) setRoles(run.pattern, role, ids);
  optionValues.value = { ...optionValues.value, [run.pattern]: structuredClone(run.options ?? {}) };
  setTask(run.task);
  contextPaths.value = new Map((run.context?.paths ?? []).map((c) => [c.path, { path: c.path, type: c.type }]));
  attachments.value = [];
  if (run.context?.attachments?.length) showToast("Attached files aren't kept — attach them again if needed", 4000);
  setRunCheck(run.loop?.check ?? "", RERUN_ORIGIN);
  setRunSetup(run.loop?.setup ?? "", RERUN_ORIGIN);
  setRunLimits({ maxMinutes: run.loop?.maxMinutes ?? 60, maxSteps: run.loop?.maxSteps ?? 40, maxTokens: run.loop.maxTokens, maxCostUsd: run.loop.maxCostUsd }, RERUN_ORIGIN);
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
  // Back in the run's project, so the new run goes there too.
  navigate({ view: "composer", project: destination?.id ?? "" });
}

function RecoveryCheckDialog({ run, onClose }: { run: RunSummary; onClose: () => void }) {
  const [check, setCheck] = useState(run.loop.check ?? "");
  const [setup, setSetup] = useState(run.loop.setup ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ref = useDialog(true, onClose, () => !busy);
  const branches = run.artifacts.filter(a => run.worktrees.some(w => w.branch === a.branch));
  const [branch, setBranch] = useState(branches[0]?.branch ?? run.baseRef);
  return <dialog ref={ref} class="picker small-dialog" aria-labelledby="recovery-check-title"><div class="picker-inner">
    <div class="picker-head"><h3 id="recovery-check-title">Fix check command</h3></div>
    <div class="dialog-body"><p>Start a continuation from the saved branch with corrected commands. The original run and its evidence are kept.</p>
      <label>Continue from<select class="field" value={branch} onChange={event => setBranch(event.currentTarget.value)}>{branches.length ? branches.map(a => <option key={a.branch} value={a.branch}>{a.label} · {a.branch}</option>) : <option value={run.baseRef}>Original base · {run.baseRef.slice(0, 12)}</option>}</select></label>
      <label>Setup command<input class="field" value={setup} placeholder="e.g. npm ci" onInput={event => setSetup(event.currentTarget.value)} /></label>
      <label>Check command<input class="field" value={check} placeholder="e.g. npm test" onInput={event => setCheck(event.currentTarget.value)} /></label>
      <p class="help">Uses a single check and this run's team and permissions. New allowance: {plural(run.loop.maxInvocations ?? run.loop.maxSteps, "call")} · {run.loop.maxMinutes} minutes.</p>
      {error ? <p class="msg err" role="alert">{error}</p> : null}
    </div><div class="picker-foot"><button class="btn" disabled={busy} onClick={onClose}>Cancel</button><button class="btn primary" disabled={busy || !check.trim()} onClick={async () => {
      if (busy) return;
      setBusy(true); setError("");
      try {
        const child = await post<{ id: string }>("/api/runs", { repo: run.repo, project: run.project, parentRunId: run.id, baseRef: branch, task: `${run.task}\n\nVerify the preserved work using the corrected setup and check commands. Fix any remaining failures and report the evidence.`, pattern: run.pattern, roles: run.roles, options: run.options, agentSettings: run.agentSettings, roleSettings: run.roleSettings, trust: run.trust, approvals: run.approvals, context: { paths: (run.context?.paths ?? []).map(c => ({ path: c.path })) }, loop: { ...run.loop, verification: undefined, check: check.trim(), setup: setup.trim() } });
        onClose(); navigate({ view: "run", id: child.id });
      } catch (err) { setError((err as Error).message); }
      finally { setBusy(false); }
    }}>{busy ? "Starting…" : "Start continuation"}</button></div>
  </div></dialog>;
}

const TRUST_NAMES = { safe: "Safe", standard: "Approve for me", trusted: "Trusted", full: "Full access" } as const;
const asksForApproval = (id: AgentId) => id === "codex" || id === "claude" || id.startsWith("acp:");

function ProviderChatDialog({ run, initialAgent, initialSettings, initialPermissions, initialMessage, attachments, onClose, onOpenChat }: {
  run: RunSummary; initialAgent: AgentId; initialSettings: ChatSettings; initialPermissions: ChatPermissions; initialMessage: string; attachments: Attachment[];
  onClose: () => void; onOpenChat: (id: string) => void;
}) {
  const side = run.chatLink?.kind === "side";
  const choices = side ? agents.value.filter(item => item.id === "claude" || item.id === "codex" || item.id === "agy") : agents.value;
  const [agent, setAgent] = useState(initialAgent);
  const [settings, setSettings] = useState(initialSettings);
  // The new chat starts with the reply box's choice, within this chat's current level: a child
  // never gets more access than its source, and only a source that asks for approval passes it on.
  const approvalsAvailable = !!run.approvals.tools && !run.loop.remoteWorker && !run.loop.agentContainer;
  const [permissions, setPermissions] = useState<ChatPermissions>(() => ({ trust: narrowerTrust(run.trust, initialPermissions.trust), tools: initialPermissions.tools && approvalsAvailable && asksForApproval(initialAgent) }));
  const [message, setMessage] = useState(initialMessage);
  const [images, setImages] = useState(attachments);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const ref = useDialog(true, onClose, () => !busy);
  const raised = !side && narrowerTrust(run.trust, permissions.trust) !== permissions.trust;
  const problem = runProviderProblem(agent, choices.find(item => item.id === agent)?.displayName) || (raised ? `This chat runs with ${TRUST_NAMES[run.trust]}, and a new chat can't have more access. Choose ${TRUST_NAMES[run.trust]} or lower, or reply here with ${TRUST_NAMES[permissions.trust]} first.` : "");
  const unrestricted = !side && agent === "agy" && run.permissions?.antigravityExecution === "native";
  const start = async () => {
    if (busy || problem || !message.trim() || !choices.some(item => item.id === agent && item.available)) return;
    setBusy(true); setError("");
    try {
      const next = await post<{ id: string }>(`/api/runs/${run.id}/provider-chat`, { agent, settings, message: message.trim(), kind: run.chatLink?.kind ?? "tab", attachments: images.map(({ name, data }) => ({ name, data })), ...(side ? {} : { trust: permissions.trust, tools: permissions.tools }) });
      onClose(); onOpenChat(next.id);
    } catch (error) { setError((error as Error).message); setBusy(false); }
  };
  return <dialog class="picker small-dialog" ref={ref} aria-labelledby="provider-chat-title"><div class="picker-inner">
    <div class="picker-head"><h3 id="provider-chat-title">Fork chat</h3></div>
    <div class="dialog-body">
      <p class="help">Send a message to start a new chat with this conversation’s context. Chats share the workspace.{side ? "" : " The new chat runs with the permissions chosen below."}</p>
      <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0 }}>
        <label>Message<textarea class="field" rows={4} maxLength={20000} autoFocus value={parseBrowserMessage(message).text} onInput={(event) => setMessage(editBrowserText(message, event.currentTarget.value))} placeholder="What should the new chat do?" /></label>
        <BrowserDraftCards text={message} onText={setMessage} images={images} onImages={setImages} />
        <DraftImages message={message} images={images} onRemove={index => setImages(images.filter((_, i) => i !== index))} />
        <ChatControls agent={agent} onAgent={(value) => { setAgent(value); setSettings({}); }} providers={choices} settings={settings} onSettings={setSettings} permissions={permissions} onPermissions={setPermissions} showPermissions={!side} restricted={!!run.lockdown || !!run.trigger} approvalsAvailable={approvalsAvailable} approvalsUnavailableReason={!run.approvals.tools ? "The source chat doesn't ask for approval. A fork can ask only when its source does." : undefined} unrestricted={unrestricted} />
      </fieldset>
      {unrestricted ? <p class="full-warn" role="alert"><b>Unrestricted Antigravity.</b> This chat's run allows it, so the new chat uses your normal Antigravity profile and settings without Code Flow's sandbox.</p>
        : !side && !raised && permissions.trust === "full" && !permissions.tools ? <p class="full-warn" role="alert"><b>Full access: no sandbox.</b> The new chat can run commands and change files outside its worktree with your credentials.</p> : null}
      {problem ? <p class="msg warn" role="alert">{problem}</p> : null}
      {error ? <p class="msg err" role="alert">{error}</p> : null}
    </div>
    <div class="picker-foot"><span class="ps" /><button class="btn" disabled={busy} onClick={onClose}>Cancel</button><button class="btn primary" disabled={busy || !!problem || !message.trim() || !choices.some((item) => item.id === agent && item.available)} title={problem || undefined} onClick={() => void start()}>{busy ? "Sending…" : "Send"}</button></div>
  </div></dialog>;
}

function SaveStrategyDialog({ template, onClose }: { template: TeamTemplate; onClose: () => void }) {
  const ref = useDialog(true, onClose);
  return <dialog ref={ref} class="picker" aria-labelledby="save-strategy-title"><div class="picker-inner"><div class="picker-head"><h3 id="save-strategy-title">Save reusable team strategy</h3></div><div class="dialog-body"><p>Review and parameterize the instructions below, removing any sensitive or task-specific values. Session handles, result records, and permission grants are excluded.</p><TeamTemplateLibrary initial={template} focused onPublished={saved => { showToast(`Saved ${saved.name} v${saved.version}`); onClose(); }} /></div><div class="picker-foot"><button class="btn" onClick={onClose}>Close</button></div></div></dialog>;
}
