import type { PrWatch, Run, RunManager } from "./engine.js";
import { git } from "./git.js";
import { CODEFLOW_MARKER, failedLogs, GH_AUTH_ERROR, ghAuthStatus, githubUser, prChecks, prStatus, safeFence } from "./github.js";
import { logWarn } from "./log.js";

const ACTIVE = new Set<PrWatch["state"]>(["watching", "fixing", "green"]);
/** Polls in a row that fail before a watch hands the PR back to you. */
export const FAILURES_BEFORE_NEEDS_YOU = 3;
/** The longest a failing watch waits between polls. */
const MAX_BACKOFF_MS = 30 * 60_000;

/** A watch whose polls keep failing (gh signed out, rate-limited, offline). */
interface Failing {
  count: number;
  /** Don't poll again before this. */
  nextAt: number;
  error: string;
}

/**
 * PR follow-through. Every interval, for each watched PR whose run is idle:
 * - merged or closed → stop watching;
 * - new comments from you (the account `gh` is signed in as) or people you allowed on this
 *   watch → one follow-up to the watch's agent. Anyone else's comments — even org members' —
 *   are logged and ignored: this runs unattended, so only people you named can direct agents;
 * - otherwise, failing CI on the PR's head → a "fix failing CI" follow-up with the failed jobs'
 *   logs, up to the watch's fix limit.
 * Each fix is committed and pushed to the PR by the follow-up. Nothing here ever merges.
 *
 * A poll that fails (gh signed out, rate-limited, no network) is retried with a growing wait.
 * After three in a row the watch needs you, with the reason; it keeps retrying at that pace
 * and goes back to watching once gh answers again.
 */
export class PrWatcher {
  private timer?: ReturnType<typeof setInterval>;
  private polling?: Promise<void>;
  /** Watches whose polls are failing, by `<run id>/<branch>`; forgotten on restart. */
  private readonly failing = new Map<string, Failing>();

  constructor(
    private readonly manager: RunManager,
    private readonly intervalMs = Number(process.env.CODEFLOW_WATCH_INTERVAL_MS) || 60_000,
  ) {}

  start() {
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass over every active watch; concurrent calls share the pass in progress. `now` is for tests. */
  poll(now?: number): Promise<void> {
    this.polling ??= this.pollAll(now).finally(() => (this.polling = undefined));
    return this.polling;
  }

  private async pollAll(now = Date.now()) {
    for (const run of this.manager.watchedRuns()) {
      for (const watch of Object.values(run.watches)) {
        const key = `${run.id}/${watch.branch}`;
        const failing = this.failing.get(key);
        // A watch handed back to you for failing polls is still retried, so it recovers on its own.
        const retrying = watch.state === "needs-you" && !!failing;
        if ((!ACTIVE.has(watch.state) && !retrying) || run.status === "running" || run.archived) {
          if (!retrying) this.failing.delete(key);
          continue;
        }
        if (failing && failing.nextAt > now) continue;
        try {
          await this.pollOne(run, watch);
          this.failing.delete(key);
        } catch (err) {
          await this.pollFailed(run, watch, key, err as Error, now);
        }
      }
    }
  }

  /** Count a failed poll and wait longer before the next; the third in a row hands the PR to you. */
  private async pollFailed(run: Run, watch: PrWatch, key: string, err: Error, now: number) {
    const count = (this.failing.get(key)?.count ?? 0) + 1;
    let error = err.message;
    // Name the likely cause once: an expired gh login looks like any other failure from here.
    if (count === 1 || GH_AUTH_ERROR.test(error)) {
      const auth = await ghAuthStatus(run.repo).catch(() => undefined);
      if (auth && !auth.ok) error = `gh isn't signed in — run \`gh auth login\`${auth.message ? ` (gh auth status: ${auth.message.slice(0, 200)})` : ""}`;
    }
    const wait = Math.min(MAX_BACKOFF_MS, this.intervalMs * 2 ** (count - 1));
    this.failing.set(key, { count, nextAt: now + wait, error });
    const detail = `Couldn't check the PR ${count} time${count === 1 ? "" : "s"} in a row: ${error}`;
    if (count >= FAILURES_BEFORE_NEEDS_YOU) {
      if (count === FAILURES_BEFORE_NEEDS_YOU) logWarn(`PR watch on ${watch.pr} keeps failing`, { run: run.id, error });
      this.manager.updateWatch(run.id, watch.branch, { state: "needs-you", detail, lastPolled: now });
    } else {
      this.manager.updateWatch(run.id, watch.branch, { detail, lastPolled: now });
    }
  }

  private async pollOne(run: Run, w: PrWatch) {
    const update = (patch: Partial<PrWatch>) => this.manager.updateWatch(run.id, w.branch, { lastPolled: Date.now(), ...patch });
    const status = await prStatus(run.repo, w.pr);
    if (status.state !== "OPEN") {
      return update({ state: "closed", detail: status.state === "MERGED" ? "The pull request was merged" : "The pull request was closed" });
    }
    if (w.state === "fixing" || run.status !== "done") {
      // A fix that never finished (e.g. code-flow restarted mid-way).
      return update({ state: "needs-you", detail: `The run is ${run.status}; resume it, then watch again` });
    }
    const worktree = run.worktrees.find((x) => x.branch === w.branch);
    if (!worktree) return update({ state: "needs-you", detail: "The branch's worktree is gone" });

    // Comments that were there when watching started are context, not instructions.
    const seen = new Set(w.seenComments ?? status.comments.filter((c) => Date.parse(c.createdAt) < w.startedAt).map((c) => c.id));
    const fresh = status.comments.filter((c) => !seen.has(c.id));
    const seenComments = [...seen, ...fresh.map((c) => c.id)];
    const me = await githubUser(run.repo).catch(() => "");
    const allowed = new Set([me, ...(w.allow ?? [])].filter(Boolean).map((login) => login.toLowerCase()));
    const actionable = fresh.filter((c) => !c.body.includes(CODEFLOW_MARKER) && allowed.has(c.author.toLowerCase()));
    for (const c of fresh) {
      if (!c.body.includes(CODEFLOW_MARKER) && !actionable.includes(c)) {
        this.manager.log(
          run.id,
          `Ignored a PR comment from @${c.author} (${c.association || "no association"}): only you${w.allow?.length ? ` and ${w.allow.map((a) => `@${a}`).join(", ")}` : ""} can direct agents on this watch`,
          "warn",
        );
      }
    }

    // Work only on top of what's on the PR: if someone else pushed, hand it back to you.
    const synced = (await git(["merge-base", "--is-ancestor", status.headRefOid, w.branch], run.repo)).code === 0;

    if (actionable.length) {
      if (!synced) return update({ seenComments, state: "needs-you", detail: "The PR has commits code-flow doesn't have" });
      if (w.fixes >= w.maxFixes) return update({ seenComments, state: "needs-you", detail: `New comments after ${w.fixes} fixes; over to you` });
      const who = [...new Set(actionable.map((c) => `@${c.author}`))].join(", ");
      update({ seenComments, state: "fixing", fixes: w.fixes + 1, detail: `Addressing ${actionable.length} new comment${actionable.length === 1 ? "" : "s"} from ${who}` });
      await this.manager.followUp(run.id, {
        kind: "comments",
        worktree: worktree.name,
        agent: w.agent,
        from: `${who} on the pull request`,
        message: actionable.map((c) => `@${c.author}:\n${safeFence(c.body.trim())}`).join("\n\n"),
        push: w.remoteBranch,
        watch: w.branch,
        trust: unattendedTrust(run),
      });
      return;
    }

    const checks = await prChecks(run.repo, w.pr);
    const failing = checks.filter((c) => c.bucket === "fail");
    const counts = {
      pass: checks.filter((c) => c.bucket === "pass" || c.bucket === "skipping").length,
      fail: failing.length,
      pending: checks.filter((c) => c.bucket === "pending").length,
    };
    if (counts.pending) return update({ seenComments, checks: counts, state: "watching", detail: `CI is running (${counts.pending} pending)` });
    if (!counts.fail) return update({ seenComments, checks: counts, state: "green", detail: checks.length ? "All checks pass" : "No CI checks reported" });
    if (w.fixedHeads.includes(status.headRefOid)) {
      return update({ seenComments, checks: counts, state: "needs-you", detail: "CI still fails on a commit code-flow already tried to fix" });
    }
    if (w.fixes >= w.maxFixes) return update({ seenComments, checks: counts, state: "needs-you", detail: `CI still fails after ${w.fixes} fixes; over to you` });
    if (!synced) return update({ seenComments, checks: counts, state: "needs-you", detail: "The PR has commits code-flow doesn't have" });

    const logs = await failedLogs(run.repo, checks, 8_000);
    update({
      seenComments,
      checks: counts,
      state: "fixing",
      fixes: w.fixes + 1,
      fixedHeads: [...w.fixedHeads, status.headRefOid],
      detail: `Fixing ${failing.map((c) => c.name).join(", ")} (fix ${w.fixes + 1} of ${w.maxFixes})`,
    });
    await this.manager.followUp(run.id, {
      kind: "ci-fix",
      worktree: worktree.name,
      agent: w.agent,
      message:
        `Failing checks:\n${failing.map((c) => `- ${c.name}${c.link ? ` (${c.link})` : ""}`).join("\n")}` +
        (logs ? `\n\nLogs of the failed jobs:\n${safeFence(logs)}` : "\n\n(No logs available; reproduce the failure locally.)"),
      push: w.remoteBranch,
      watch: w.branch,
      trust: unattendedTrust(run),
    });
  }
}

/** Nobody is watching a PR follow-up as it runs, so it never gets more than "standard" permissions. */
function unattendedTrust(run: Run): Run["trust"] {
  return run.trust === "trusted" ? "standard" : run.trust;
}
