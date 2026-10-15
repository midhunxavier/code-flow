import { spawn } from "node:child_process";
import { git } from "./git.js";

/**
 * GitHub through the `gh` CLI (your own login): issues and PRs to start runs from, a PR's
 * branch, its CI checks and comments, and posting a comment you asked for. code-flow never
 * merges a pull request.
 */

export interface Issue {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  author: string;
  isDraft: boolean;
  /** From a fork: code-flow can review it but can't push to it. */
  isCrossRepository: boolean;
}

export interface Check {
  name: string;
  state: string;
  bucket: "pass" | "fail" | "pending" | "skipping" | "cancel";
  link: string;
}

export interface PrComment {
  id: string;
  author: string;
  association: string;
  body: string;
  createdAt: string;
}

export interface PrStatus {
  state: "OPEN" | "CLOSED" | "MERGED";
  headRefOid: string;
  comments: PrComment[];
}

/** What a run was started from; its text goes to every agent along with the task. */
export interface RunSource {
  kind: "issue" | "pr";
  number: number;
  url: string;
  title: string;
  body: string;
  headRefName?: string;
  baseRefName?: string;
  isCrossRepository?: boolean;
  /** Failing CI checks and their logs when the run started ("Fix failing CI"). */
  ci?: { failing: string[]; logs: string };
}

/** Associations whose comments code-flow acts on; anyone else's comment is only logged. */
export const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
/** Marks comments code-flow posted, so a PR watch doesn't act on its own words. */
export const CODEFLOW_MARKER = "<!-- code-flow -->";

const PR_FIELDS = "number,title,body,url,headRefName,baseRefName,author,isDraft,isCrossRepository";

export async function listIssues(repo: string): Promise<Issue[]> {
  const raw = await gh(repo, ["issue", "list", "--state", "open", "--limit", "50", "--json", "number,title,body,url,labels"]);
  return JSON.parse(raw).map(toIssue);
}

export async function viewIssue(repo: string, number: number): Promise<Issue> {
  return toIssue(JSON.parse(await gh(repo, ["issue", "view", String(number), "--json", "number,title,body,url,labels"])));
}

export async function listPullRequests(repo: string): Promise<PullRequest[]> {
  const raw = await gh(repo, ["pr", "list", "--state", "open", "--limit", "50", "--json", PR_FIELDS]);
  return JSON.parse(raw).map(toPr);
}

export async function viewPullRequest(repo: string, pr: string | number): Promise<PullRequest> {
  return toPr(JSON.parse(await gh(repo, ["pr", "view", String(pr), "--json", PR_FIELDS])));
}

/**
 * Make a PR's head available locally as `codeflow-pr/<n>` (forks too, via `pull/<n>/head`)
 * and update `origin/<base>` so the PR's changes can be told apart from its base.
 */
export async function fetchPullRequest(repo: string, number: number): Promise<{ branch: string; pr: PullRequest }> {
  const pr = await viewPullRequest(repo, number);
  const branch = `codeflow-pr/${number}`;
  const fetched = await git(
    ["fetch", "--force", "origin", `+refs/pull/${number}/head:refs/heads/${branch}`, `+refs/heads/${pr.baseRefName}:refs/remotes/origin/${pr.baseRefName}`],
    repo,
  );
  if (fetched.code !== 0) throw new Error(`Couldn't fetch pull request #${number}: ${fetched.stderr.trim().split("\n").pop()}`);
  return { branch, pr };
}

export async function prStatus(repo: string, pr: string): Promise<PrStatus> {
  const data = JSON.parse(await gh(repo, ["pr", "view", pr, "--json", "state,headRefOid,comments,reviews"]));
  const comments: PrComment[] = [];
  for (const c of data.comments ?? []) {
    comments.push({ id: String(c.id), author: c.author?.login ?? "", association: c.authorAssociation ?? "", body: c.body ?? "", createdAt: c.createdAt ?? "" });
  }
  // A review's summary is a comment too; line comments live in its threads (not fetched).
  for (const r of data.reviews ?? []) {
    if (!r.body?.trim()) continue;
    comments.push({ id: String(r.id), author: r.author?.login ?? "", association: r.authorAssociation ?? "", body: r.body, createdAt: r.submittedAt ?? "" });
  }
  comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { state: data.state, headRefOid: data.headRefOid, comments };
}

export async function prChecks(repo: string, pr: string): Promise<Check[]> {
  // Exits non-zero while checks fail or are pending; the JSON is printed either way.
  const res = await ghRaw(repo, ["pr", "checks", pr, "--json", "name,state,bucket,link"]);
  if (!res.stdout.trim()) {
    if (/no checks reported/i.test(res.stderr)) return [];
    throw new Error(res.stderr.trim() || "gh pr checks failed");
  }
  return JSON.parse(res.stdout);
}

/** Logs of the failed GitHub Actions jobs behind `checks`, trimmed (from the end) to fit a prompt. */
export async function failedLogs(repo: string, checks: Check[], maxChars = 15_000): Promise<string> {
  const runIds = [...new Set(checks.filter((c) => c.bucket === "fail").map((c) => c.link.match(/\/actions\/runs\/(\d+)/)?.[1]).filter(Boolean))] as string[];
  const parts: string[] = [];
  for (const id of runIds) {
    const res = await ghRaw(repo, ["run", "view", id, "--log-failed"]);
    parts.push(res.stdout.trim() || res.stderr.trim());
  }
  const text = parts.filter(Boolean).join("\n\n");
  return text.length > maxChars ? `…\n${text.slice(-maxChars)}` : text;
}

export async function commentOnPr(repo: string, pr: string, body: string): Promise<void> {
  await gh(repo, ["pr", "comment", pr, "--body-file", "-"], `${body}\n\n${CODEFLOW_MARKER}`);
}

/** Push a local branch to `origin/<remote>`; never forced, so it fails if the PR moved on. */
export async function pushBranch(repo: string, local: string, remote: string): Promise<string> {
  const res = await git(["push", "origin", `refs/heads/${local}:refs/heads/${remote}`], repo);
  if (res.code !== 0) {
    const why = res.stderr.trim();
    throw new Error(
      /rejected|non-fast-forward|fetch first/i.test(why)
        ? `${remote} has commits code-flow doesn't have; pull them into the run's branch first`
        : `Pushing to ${remote} failed: ${why.split("\n").pop()}`,
    );
  }
  return (await git(["rev-parse", local], repo)).stdout.trim();
}

/** The repo's default branch (origin/HEAD if known, else main or master). */
export async function defaultBranch(repo: string): Promise<string | undefined> {
  const head = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repo);
  if (head.code === 0 && head.stdout.trim()) return head.stdout.trim();
  for (const name of ["main", "master"]) {
    if ((await git(["show-ref", "--verify", "--quiet", `refs/heads/${name}`], repo)).code === 0) return name;
  }
  return undefined;
}

export async function mergeBase(repo: string, a: string, b: string): Promise<string | undefined> {
  const res = await git(["merge-base", a, b], repo);
  return res.code === 0 ? res.stdout.trim() : undefined;
}

/** The source as a prompt section (issue text, PR description, CI failures). */
export function sourcePrompt(source: RunSource | undefined): string {
  if (!source) return "";
  const what = source.kind === "issue" ? `GitHub issue #${source.number}` : `Pull request #${source.number}`;
  const parts = [`\n\n## ${what}: ${source.title}\n${source.url}`];
  if (source.kind === "pr") parts.push(`Branch \`${source.headRefName}\` into \`${source.baseRefName}\`.`);
  if (source.body.trim()) parts.push(source.body.trim().slice(0, 8_000));
  if (source.ci) {
    parts.push(`### Failing CI checks\n${source.ci.failing.map((n) => `- ${n}`).join("\n") || "(none reported)"}`);
    if (source.ci.logs) parts.push(`### Logs of the failed jobs\n\`\`\`\n${source.ci.logs}\n\`\`\``);
  }
  return parts.join("\n\n");
}

/** Resolve a run's source: fetch the issue or PR (and, if asked, its failing CI logs). */
export async function loadSource(repo: string, input: { kind: "issue" | "pr"; number: number; ciLogs?: boolean }): Promise<{ source: RunSource; branch?: string }> {
  if (input.kind === "issue") {
    const issue = await viewIssue(repo, input.number);
    return { source: { kind: "issue", number: issue.number, url: issue.url, title: issue.title, body: issue.body } };
  }
  const { branch, pr } = await fetchPullRequest(repo, input.number);
  const source: RunSource = {
    kind: "pr",
    number: pr.number,
    url: pr.url,
    title: pr.title,
    body: pr.body,
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    isCrossRepository: pr.isCrossRepository,
  };
  if (input.ciLogs) {
    const checks = await prChecks(repo, String(pr.number));
    const failing = checks.filter((c) => c.bucket === "fail");
    source.ci = { failing: failing.map((c) => c.name), logs: failing.length ? await failedLogs(repo, checks) : "" };
  }
  return { source, branch };
}

const toIssue = (i: any): Issue => ({ number: i.number, title: i.title, body: i.body ?? "", url: i.url, labels: (i.labels ?? []).map((l: any) => l.name) });
const toPr = (p: any): PullRequest => ({
  number: p.number,
  title: p.title,
  body: p.body ?? "",
  url: p.url,
  headRefName: p.headRefName,
  baseRefName: p.baseRefName,
  author: p.author?.login ?? "",
  isDraft: !!p.isDraft,
  isCrossRepository: !!p.isCrossRepository,
});

async function gh(cwd: string, args: string[], input?: string): Promise<string> {
  const res = await ghRaw(cwd, args, input);
  if (res.code !== 0) {
    const message = res.stderr.trim() || res.stdout.trim();
    if (res.code === 127) throw new Error("GitHub CLI (gh) isn't installed — brew install gh, then gh auth login");
    if (/not logged|auth login/i.test(message)) throw new Error("GitHub CLI isn't signed in — run `gh auth login`");
    if (/no git remotes|none of the git remotes|not a github/i.test(message)) throw new Error("This repository has no GitHub remote");
    throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${message.split("\n")[0]}`);
  }
  return res.stdout;
}

function ghRaw(cwd: string, args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("gh", args, {
      cwd,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1", GH_NO_UPDATE_NOTIFIER: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (d) => (stdout += d));
    child.stderr!.on("data", (d) => (stderr += d));
    if (input !== undefined) child.stdin!.end(input);
    const timer = setTimeout(() => child.kill("SIGTERM"), 60_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}
