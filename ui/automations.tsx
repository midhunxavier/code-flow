import { signal } from "@preact/signals";
import { useEffect, useState } from "preact/hooks";
import { useDialog } from "./app.js";
import { AgentTag, CantRunNote, QrCode } from "./bits.js";
import { Icon } from "./icons.js";
import { ago, api, baseName, copy, post, showToast, STATUS_TEXT } from "./lib.js";
import { patterns, projects, route, runs, runState } from "./state.js";
import type { RunSummary } from "./types.js";

/** The project an automation's runs go in: the one it was saved with, or (deleted since) its repo's. */
const automationProject = (run: { project?: string; repo: string }) =>
  projects.value.find((p) => p.id === run.project) ?? projects.value.find((p) => p.repos.includes(run.repo));

export interface Automation {
  id: string;
  name: string;
  enabled: boolean;
  run: { repo: string; project?: string; pattern: string; task: string; roles: Record<string, string[]> };
  schedule?: { every: number } | { at: string; days?: number[] };
  scheduleText: string;
  webhook: boolean;
  token: string;
  hookPath: string;
  isolate: boolean;
  image?: string;
  nextAt?: number;
  lastFiredAt?: number;
  lastRunId?: string;
  lastError?: string;
  /** A recurring sweep: lists this kind of work and starts runs for new items. */
  sweep?: { kind: "issues" | "dependabot" | "alerts"; max: number };
  handled?: string[];
  /** Webhook events waiting for the running run to end. */
  queued?: unknown[];
}
interface RemoteInfo {
  enabled: boolean;
  lan: boolean;
  /** The phone link opens the whole app (on the Wi-Fi listener), not the read-only view. */
  control: boolean;
  /** The read-only view. */
  path: string;
  /** What the QR code opens: with full control, the sign-in link (a secret of its own). */
  phonePath: string;
  local: string;
  lanUrls: string[];
  /** Why the Wi-Fi listener isn't listening (its port is taken…): shown instead of a QR code. */
  lanError?: string;
}

export const automations = signal<Automation[]>([]);
export async function loadAutomations() {
  try {
    automations.value = await api<Automation[]>("/api/automations");
  } catch {
    // keep what we have
  }
}
/** Automation results waiting for your decision. */
export const inbox = () => [...runs.value.values()].filter((r) => r.triage?.state === "pending" && !r.archived).sort((a, b) => b.createdAt - a.createdAt);

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ---------------------------------------------------------------- page
export function AutomationsView() {
  useEffect(() => {
    void loadAutomations();
    const timer = setInterval(loadAutomations, 15_000);
    return () => clearInterval(timer);
  }, []);
  const pending = inbox();
  return (
    <div class="composer automations">
      <h1>Automations</h1>
      <p class="lede">
        Runs that start on a schedule or from a webhook. Their results wait in the inbox for you: approve, ask for changes, or reject. Nothing is ever merged automatically.
      </p>

      <div class="section">
        <div class="section-title">
          Inbox {pending.length ? <span class="count">{pending.length}</span> : null}
        </div>
        {pending.length ? pending.map((r) => <InboxItem key={r.id} run={r} />) : <p class="help">Nothing to review. Runs that changed nothing are archived on their own.</p>}
      </div>

      <div class="section">
        <div class="section-title">Your automations</div>
        {automations.value.length ? (
          automations.value.map((a) => <AutomationRow key={a.id} a={a} />)
        ) : (
          <p class="help">
            None yet. Set up a run in the composer — task, team, check — and choose <b>Save as automation…</b> next to Start run.
          </p>
        )}
      </div>

      <PhoneView />
    </div>
  );
}

function InboxItem({ run }: { run: RunSummary }) {
  const changed = run.artifacts.filter((a) => a.stat?.trim());
  return (
    <div class="inbox-item">
      <div class="ih">
        <span class={`dot ${runState(run)}`} />
        <a href={`#/run/${run.id}`} class="t">
          {run.task.split("\n")[0]}
          {/* Tasks leave an issue's title out (its author wrote it); it's still worth seeing here. */}
          {run.source?.title && !run.task.includes(run.source.title) ? ` — ${run.source.title}` : null}
        </a>
        <span class="help">
          {run.trigger?.via === "sweep" ? "▤" : "⏱"} {run.trigger?.name} · {STATUS_TEXT[run.status] ?? run.status}
          {run.verdict ? ` · check ${run.verdict}` : run.checkCantRun ? " · check couldn't run" : ""} · {baseName(run.repo)} · {ago(run.createdAt)}
        </span>
      </div>
      {run.checkCantRun ? <CantRunNote cantRun={run.checkCantRun} /> : null}
      {run.review ? <div class="help">Review: {run.review.verdict === "approve" ? "approve" : `${run.review.findings.length} findings`}</div> : null}
      {changed.map((a) => (
        <pre key={a.branch} class="stat">
          {a.label} · {a.branch}
          {"\n"}
          {a.stat}
        </pre>
      ))}
      {run.error ? <div class="msg err">{run.error}</div> : null}
      <TriageActions run={run} />
    </div>
  );
}

/** Approve (optionally opening a PR), ask for changes, or reject an automation's result. */
export function TriageActions({ run }: { run: RunSummary }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState("");
  const act = async (decision: "approve" | "revise" | "reject", extra: Record<string, unknown> = {}) => {
    if (decision === "reject" && !confirm("Reject this result? Its worktrees and branches are deleted.")) return;
    setBusy(decision);
    try {
      await post(`/api/runs/${run.id}/triage`, { decision, note, ...extra });
      showToast(
        decision === "approve"
          ? extra.pushPr
            ? `Approved — pushed to PR #${run.source?.number}`
            : extra.openPr
              ? "Approved — pull request opened"
              : "Approved"
          : decision === "revise"
            ? "Sent — the agent is revising it"
            : "Rejected and cleaned up",
      );
      setNote("");
    } catch (err) {
      showToast((err as Error).message, 5000);
    } finally {
      setBusy("");
    }
  };
  const hasChange = run.artifacts.some((a) => a.stat?.trim());
  const running = run.status === "running";
  // A fix for a pull request (Dependabot's, say) goes onto that PR, not into a new one.
  const toPr = run.source?.kind === "pr" && !run.source.isCrossRepository ? run.source : undefined;
  return (
    <div class="triage">
      <input class="field" placeholder="What should change? (for Revise)" value={note} onInput={(e) => setNote(e.currentTarget.value)} disabled={running} />
      <button class="btn small" disabled={running || !!busy || !note.trim()} onClick={() => act("revise")}>
        {busy === "revise" ? "Sending…" : "Revise"}
      </button>
      <button class="btn small primary" disabled={running || !!busy} onClick={() => act("approve")}>
        ✓ Approve
      </button>
      {hasChange && toPr ? (
        <button class="btn small" disabled={running || !!busy} title={`Approve and push the fix to ${toPr.headRefName}, updating PR #${toPr.number} (never forced)`} onClick={() => act("approve", { pushPr: true })}>
          {busy === "approve" ? "…" : `Approve & push to PR #${toPr.number}`}
        </button>
      ) : hasChange ? (
        <button class="btn small" disabled={running || !!busy} title="Approve, push the branch and open a pull request into the base branch" onClick={() => act("approve", { openPr: true })}>
          {busy === "approve" ? "…" : "Approve & open PR"}
        </button>
      ) : null}
      <button class="btn small danger" disabled={running || !!busy} onClick={() => act("reject")}>
        Reject
      </button>
    </div>
  );
}

function AutomationRow({ a }: { a: Automation }) {
  const [showHook, setShowHook] = useState(false);
  const last = a.lastRunId ? runs.value.get(a.lastRunId) : undefined;
  const update = (patch: object) => post<Automation>(`/api/automations/${a.id}`, patch).then(loadAutomations, (e) => showToast(e.message, 5000));
  const hookUrl = `${location.origin}${a.hookPath}`;
  return (
    <div class={`auto-row ${a.enabled ? "" : "off"}`}>
      <div class="ar-head">
        <label class="switch" title={a.enabled ? "Turn off" : "Turn on"}>
          <input type="checkbox" checked={a.enabled} onChange={(e) => update({ enabled: e.currentTarget.checked })} />
        </label>
        <b>{a.name}</b>
        <span class="help">
          {a.sweep ? `Sweep: up to ${a.sweep.max} new ${a.sweep.kind === "issues" ? "issues" : a.sweep.kind === "dependabot" ? "Dependabot PRs" : "alerts"} · ` : ""}
          {a.scheduleText}
          {a.webhook ? " · webhook" : ""}
          {a.isolate ? ` · checks in ${a.image || "node:22"}` : ""}
        </span>
        <span class="spacer" />
        <button
          class="btn small"
          onClick={() =>
            post<{ id?: string; ids?: string[] }>(`/api/automations/${a.id}/run`).then(
              ({ id, ids }) => {
                void loadAutomations();
                // A sweep can start several runs: stay here, where their results will arrive.
                if (ids && ids.length !== 1) showToast(`Started ${ids.length} runs — their results will wait in the inbox`);
                else if (id) route.value = { view: "run", id };
              },
              (e) => showToast(e.message, 5000),
            )
          }
        >
          ▶ Run now
        </button>
        {a.webhook ? (
          <button class="btn small" aria-pressed={showHook} onClick={() => setShowHook(!showHook)}>
            Webhook
          </button>
        ) : null}
        <button
          class="btn small danger"
          onClick={() => confirm(`Delete “${a.name}”? Its past runs are kept.`) && api(`/api/automations/${a.id}`, { method: "DELETE" }).then(loadAutomations, (e) => showToast(e.message))}
        >
          Delete
        </button>
      </div>
      <div class="ar-meta help">
        {patterns.value.find((p) => p.id === a.run.pattern)?.name ?? a.run.pattern} in {baseName(a.run.repo)}
        {automationProject(a.run) ? <> · <Icon name="project" class="inline-icon" /> {automationProject(a.run)!.name}</> : null}: “{a.run.task.split("\n")[0]}”
        {a.sweep && a.handled?.length ? ` · ${a.handled.length} handled so far` : ""}
        {Object.values(a.run.roles)
          .flat()
          .filter((x, i, all) => all.indexOf(x) === i)
          .map((id) => (id === "auto" ? <span key={id}> · Auto</span> : <span key={id}> · <AgentTag id={id as any} /></span>))}
      </div>
      <div class="ar-meta help">
        {a.enabled && a.nextAt ? `Next: ${new Date(a.nextAt).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : a.enabled ? "Runs when triggered" : "Off"}
        {a.lastFiredAt ? (
          <>
            {" · Last: "}
            {last ? <a href={`#/run/${last.id}`}>{ago(a.lastFiredAt)} ({last.triage?.state === "empty" ? "no changes" : STATUS_TEXT[last.status] ?? last.status})</a> : ago(a.lastFiredAt)}
          </>
        ) : null}
        {a.queued?.length ? ` · ${a.queued.length} webhook event${a.queued.length === 1 ? "" : "s"} waiting for the run to end` : null}
        {a.lastError ? <span class="msg err inline"> · couldn't start: {a.lastError}</span> : null}
      </div>
      {showHook ? (
        <div class="hook">
          <div>
            <span class="lbl">URL</span> <code>{hookUrl}</code>
          </div>
          <div>
            <span class="lbl">Secret</span> <code>{a.token.slice(0, 6)}…</code>{" "}
            <button class="btn small" onClick={() => copy(a.token, "Secret copied")}>
              Copy
            </button>
            <button class="btn small" onClick={() => confirm("Make a new secret? The old one stops working.") && update({ rotateToken: true })}>
              New secret
            </button>
          </div>
          <pre>{`curl -X POST ${hookUrl} \\\n  -H "Authorization: Bearer <secret>" \\\n  -H "Content-Type: application/json" \\\n  -d '{"details": "what happened", "source": {"kind": "pr", "number": 12}}'`}</pre>
          <div class="help">
            For a GitHub webhook, use this URL through a tunnel, content type <code>application/json</code>, and the secret above. Opened issues and pull requests, and failed workflow runs (with their logs), start a run;
            other events are ignored.
          </div>
        </div>
      ) : null}
    </div>
  );
}

function PhoneView() {
  const [info, setInfo] = useState<RemoteInfo | null>(null);
  useEffect(() => {
    api<RemoteInfo>("/api/remote").then(setInfo, () => setInfo(null));
  }, []);
  const set = (patch: object) => post<RemoteInfo>("/api/remote", patch).then(setInfo, (e) => showToast(e.message, 5000));
  if (!info) return null;
  const full = info.control && info.lan;
  const short = (u: string) => u.replace(/\/r\/(\w{6})\w+/, "/r/$1…");
  return (
    <div class="section">
      <div class="section-title">Phone</div>
      <label class="checkpoint">
        <input type="checkbox" checked={info.enabled} onChange={(e) => set({ enabled: e.currentTarget.checked })} />
        <span>
          <b>Phone link</b> — a secret link to what's running, what needs you, and each result. On its own it's a read-only view: nothing can be started, approved or merged from it.
        </span>
      </label>
      {info.enabled ? (
        <>
          <label class="checkpoint">
            <input type="checkbox" checked={info.lan} onChange={(e) => set({ lan: e.currentTarget.checked })} />
            <span>
              <b>Reachable from my Wi-Fi</b> — also serve it on your local network (plain HTTP, so only on networks you trust, or over a VPN like Tailscale).
            </span>
          </label>
          {info.lan ? (
            <label class={`checkpoint${info.control ? " danger" : ""}`}>
              <input type="checkbox" checked={info.control} onChange={(e) => set({ control: e.currentTarget.checked })} />
              <span>
                <b>Full control from my phone</b> — the link opens all of code-flow, the same as on this computer: start runs, answer questions, review, approve, merge and open pull requests.
                Anyone who gets the link can run agents and commands on this computer, so keep it to your own phone; <b>New link</b>, or turning this off, signs every phone out.
              </span>
            </label>
          ) : null}
          {info.lanError ? <p class="msg err">{info.lanError}</p> : null}
          <div class="phone-qr">
            {info.lanUrls[0] ? (
              <QrCode text={info.lanUrls[0]} />
            ) : (
              <div class="qr-off" aria-hidden="true">
                <Icon name="phone" />
              </div>
            )}
            <div class="phone-qr-text">
              <b>{info.lanUrls[0] ? "Scan with your phone" : "Scanning needs your Wi-Fi"}</b>
              <span class="help">
                {info.lanUrls[0]
                  ? `${full ? "Signs your phone in to code-flow" : "Opens the read-only view"} at ${short(info.lanUrls[0])} — your phone has to be on the same Wi-Fi (or VPN).${full ? " It stays signed in for up to 30 days, even after code-flow restarts." : ""}`
                  : info.lan && info.lanError
                    ? "No QR code while code-flow can't listen on your network."
                    : "The link below only opens on this computer. Turn on “Reachable from my Wi-Fi” to get a QR code your phone can open."}
              </span>
            </div>
          </div>
          <div class="hook">
            {/* With full control the phone gets the whole app, so a read-only preview here would mislead. */}
            {[...(full ? [] : [info.local]), ...info.lanUrls].map((u) => (
              <div key={u}>
                <code>{short(u)}</code>{" "}
                <button class="btn small" onClick={() => copy(u, "Link copied")}>
                  Copy link
                </button>
                <a class="btn small" href={u} target="_blank" rel="noreferrer">
                  Open
                </a>
              </div>
            ))}
            <div>
              <button class="btn small" onClick={() => confirm(full ? "Make a new link? The old one stops working, and phones signed in with it are signed out." : "Make a new link? The old one stops working.") && set({ rotate: true })}>
                New link
              </button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- save from the composer
type Kind = "every" | "daily" | "webhook";

export function SaveAutomationDialog({ body, onClose }: { body: Record<string, any>; onClose: () => void }) {
  const ref = useDialog(true, onClose);
  const [name, setName] = useState(String(body.task ?? "").split("\n")[0]!.slice(0, 50));
  const [kind, setKind] = useState<Kind>("daily");
  const [every, setEvery] = useState(60);
  const [at, setAt] = useState("07:00");
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [webhook, setWebhook] = useState(false);
  const [isolate, setIsolate] = useState(false);
  const [image, setImage] = useState("node:22");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const { attachments: _a, approvals: _p, branchPrefix: _b, ...run } = body;
      run.context = { paths: body.context?.paths ?? [] };
      await post("/api/automations", {
        name,
        run,
        schedule: kind === "every" ? { every } : kind === "daily" ? { at, days } : undefined,
        webhook: kind === "webhook" || webhook,
        isolate,
        image,
      });
      await loadAutomations();
      showToast("Automation saved");
      onClose();
      route.value = { view: "automations" };
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <dialog class="picker small-dialog" ref={ref}>
      <div class="picker-inner">
        <div class="picker-head">
          <h3>Save as automation</h3>
          <div class="help">Runs this task with this team and these settings, unattended. Results wait in your inbox; nothing merges by itself.</div>
        </div>
        <div class="dialog-body">
          <label class="lbl">Name</label>
          <input class="field" value={name} onInput={(e) => setName(e.currentTarget.value)} />
          <label class="lbl">When</label>
          <div class="segmented" role="radiogroup" aria-label="When">
            {(
              [
                ["daily", "At a time"],
                ["every", "Repeatedly"],
                ["webhook", "Only from a webhook"],
              ] as const
            ).map(([k, label]) => (
              <button key={k} type="button" role="radio" aria-checked={kind === k} class={kind === k ? "on" : ""} onClick={() => setKind(k)}>
                {label}
              </button>
            ))}
          </div>
          {kind === "daily" ? (
            <div class="row-inline">
              <input class="field inline" type="time" value={at} onInput={(e) => setAt(e.currentTarget.value)} />
              {DAYS.map((d, i) => (
                <button key={d} type="button" class="pill" aria-pressed={days.includes(i)} onClick={() => setDays(days.includes(i) ? days.filter((x) => x !== i) : [...days, i].sort())}>
                  {d}
                </button>
              ))}
            </div>
          ) : kind === "every" ? (
            <div class="row-inline">
              every <input class="field inline num" type="number" min={5} value={every} onInput={(e) => setEvery(Number(e.currentTarget.value) || 60)} /> minutes
            </div>
          ) : null}
          {kind !== "webhook" ? (
            <label class="check">
              <input type="checkbox" checked={webhook} onChange={(e) => setWebhook(e.currentTarget.checked)} /> Also start it from a webhook
            </label>
          ) : null}
          <label class="check">
            <input type="checkbox" checked={isolate} onChange={(e) => setIsolate(e.currentTarget.checked)} /> Run checks and setup in a Docker container
          </label>
          {isolate ? (
            <div class="row-inline">
              image <input class="field inline mono" value={image} onInput={(e) => setImage(e.currentTarget.value)} />
              <span class="help">Only the worktree is mounted; none of your environment or home folder.</span>
            </div>
          ) : null}
          {error ? <div class="msg err">{error}</div> : null}
        </div>
        <div class="picker-foot">
          <span class="ps" />
          <button class="btn" onClick={onClose}>
            Cancel
          </button>
          <button class="btn primary" disabled={saving || !name.trim()} onClick={save}>
            {saving ? "Saving…" : "Save automation"}
          </button>
        </div>
      </div>
    </dialog>
  );
}
