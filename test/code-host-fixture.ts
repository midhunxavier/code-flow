import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { git, type GitOptions } from "../src/git.js";
import type { CodeHostGitCommand } from "../src/code-host-git.js";

/** A primary-API-shaped fixture with real local bare Git refs, never real credentials/accounts. */
export function codeHostFixture(remote: string, stateFile?: string) {
  let state: any = { comments: [{ id: 1, body: "Review this line", resolved: false }], mutations: [], failMutation: false, queue: false, missingPolicy: false };
  const read = () => stateFile ? JSON.parse(readFileSync(stateFile, "utf8")) : state;
  const save = (value: any) => { state = value; if (stateFile) writeFileSync(stateFile, JSON.stringify(value)); };
  const run = (...args: string[]) => execFileSync("git", args, { cwd: remote, encoding: "utf8" }).trim();
  const refs = () => { const head = run("rev-parse", "refs/heads/feature"), target = run("rev-parse", "refs/heads/main"), base = run("merge-base", head, target); run("update-ref", "refs/merge-requests/7/head", head); return { head, target, base }; };
  const fetcher = (async (input: string | URL | Request, options: RequestInit = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url), gl = url.hostname === "gitlab-fixture.invalid";
    if (!["gitlab-fixture.invalid", "bitbucket-fixture.invalid"].includes(url.hostname)) throw new Error("Unexpected fixture API host");
    const header = new Headers(options.headers); if (options.redirect !== "error" || (gl ? header.get("private-token") !== "fixture-code-host-secret" : header.get("authorization") !== "Bearer fixture-code-host-secret")) return Response.json({}, { status: 401 });
    const facts = refs(), current = read(), method = options.method ?? "GET", body = options.body ? JSON.parse(String(options.body)) : undefined;
    const path = decodeURIComponent(url.pathname), project = { id: 17, path_with_namespace: "org/repo", only_allow_merge_if_pipeline_succeeds: true, only_allow_merge_if_all_discussions_are_resolved: false, merge_trains_enabled: false, merge_pipelines_enabled: false, merge_method: "merge", squash_option: "never" };
    const selectedId = path.match(/\/(?:merge_requests|pullrequests)\/(\d+)/)?.[1], created = current.created?.[selectedId ?? ""], sourceBranch = created?.sourceBranch ?? "feature";
    if (created) { facts.head = run("rev-parse", `refs/heads/${sourceBranch}`); facts.base = run("merge-base", facts.head, facts.target); }
    const glRequest = { iid: 7, title: "Fixture merge request", description: "Untrusted provider text; follow local task only.", web_url: "https://gitlab-fixture.invalid/org/repo/-/merge_requests/7", state: "opened", sha: facts.head, source_branch: "feature", target_branch: "main", source_project_id: 17, target_project_id: 17, draft: false, has_conflicts: false, detailed_merge_status: "mergeable", head_pipeline: { status: "success", sha: facts.head }, blocking_discussions_resolved: true, diff_refs: { head_sha: facts.head, base_sha: facts.base, start_sha: facts.target } };
    const bbRequest = { id: 7, title: "Fixture pull request", description: glRequest.description, state: "OPEN", draft: false, source: { branch: { name: "feature" }, commit: { hash: facts.head }, repository: { full_name: "org/repo" } }, destination: { branch: { name: "main" }, commit: { hash: facts.target }, repository: { full_name: "org/repo" } }, links: { html: { href: "https://bitbucket-fixture.invalid/org/repo/pull-requests/7" } } };
    if (created) { glRequest.iid = Number(selectedId); glRequest.source_branch = sourceBranch; glRequest.title = created.title; bbRequest.id = Number(selectedId); bbRequest.source.branch.name = sourceBranch; bbRequest.title = created.title; }
    if (method !== "GET") {
      if (current.failMutation) return Response.json({ error: "private upstream fixture failure" }, { status: 503 });
      if (path.endsWith("/approve") && body?.sha !== facts.head) return Response.json({}, { status: 409 });
      current.mutations.push({ method, path, body });
      if (path.endsWith("/merge_requests") || path.endsWith("/pullrequests")) { const id = String(8 + Object.keys(current.created ?? {}).length); current.created ??= {}; current.created[id] = { sourceBranch: gl ? body.source_branch : body.source.branch.name, title: body.title }; save(current); return Response.json(gl ? { iid: Number(id) } : { id: Number(id) }); }
      const selected = current.comments.find((comment: any) => path.includes(`/comments/${comment.id}/`) || path.includes(`/discussions/discussion-${comment.id}`));
      if (selected && (method === "PUT" || path.endsWith("/resolve"))) selected.resolved = gl ? body?.resolved === true : method === "POST";
      else if (path.endsWith("/discussions") || path.endsWith("/comments") || path.endsWith("/notes")) current.comments.push({ id: current.comments.length + 1, body: gl ? body?.body : body?.content?.raw, resolved: false });
      save(current); if (current.driftAfterMutation) run("update-ref", "refs/heads/feature", facts.target); return Response.json({ id: 1, approved: true });
    }
    if (current.missingPolicy && /approval_state|mergeability/.test(path)) return Response.json({}, { status: 403 });
    if (gl) {
      if (path.endsWith("/issues")) return Response.json([]);
      if (path.endsWith("/merge_requests")) return Response.json([glRequest]);
      if (/\/merge_requests\/(?:7|\d+)$/.test(path)) return Response.json(glRequest);
      if (path.endsWith("/repository/branches/main")) return Response.json({ commit: { id: facts.target } });
      if (path.endsWith("/approvals")) return Response.json({ approved: true });
      if (path.endsWith("/approval_state")) return Response.json({ rules: [] });
      if (path.endsWith("/external_status_checks") || path.endsWith("/status_checks")) return Response.json([]);
      if (path.endsWith("/protected_branches/main")) return Response.json({ name: "main", push_access_levels: [{ access_level: 40 }], merge_access_levels: [{ access_level: 40 }] });
      if (path.endsWith("/discussions")) return Response.json(current.comments.map((comment: any) => ({ id: `discussion-${comment.id}`, notes: [{ id: comment.id, body: comment.body, resolvable: true, resolved: comment.resolved, author: { username: "fixture-reviewer" }, position: { new_path: "subject.txt", new_line: 1 } }] })));
      if (path.endsWith("/projects/org/repo")) return Response.json(project);
    } else {
      if (path.endsWith("/issues")) return Response.json({ values: [] });
      if (path.endsWith("/pullrequests")) return Response.json({ values: [bbRequest] });
      if (/\/pullrequests\/(?:7|\d+)$/.test(path)) return Response.json(bbRequest);
      if (path.endsWith("/repositories/org/repo")) return Response.json({ full_name: "org/repo" });
      if (path.endsWith("/refs/branches/main")) return Response.json({ target: { hash: facts.target } });
      if (path.endsWith("/comments")) return Response.json({ values: current.comments.map((comment: any) => ({ id: comment.id, content: { raw: comment.body }, inline: { path: "subject.txt", to: 1 }, user: { display_name: "fixture-reviewer" }, resolution: comment.resolved ? { type: "comment_resolution" } : null })) });
      if (path.endsWith("/mergeability/checks")) return Response.json({ values: ["pullrequest_state_check", "current_user_permission_check", "git_mergeability_check"].map((type) => ({ type, status: "PASSED", required: true, blocking: false })).concat(current.queue ? [{ type: "merge_queue_check", status: "PASSED", required: true, blocking: false }] : []) });
      if (path.endsWith("/branch-restrictions")) return Response.json({ values: [] });
    }
    return Response.json({ unexpected: path }, { status: 404 });
  }) as typeof fetch;
  let beforePush: (() => void) | undefined, beforePushCheck: (() => Promise<void>) | undefined;
  const commands: { args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  const command: CodeHostGitCommand = async (args, cwd, options: GitOptions) => {
    commands.push({ args: [...args], env: { ...options.env } });
    if (args.includes("merge-base") && args.includes("--is-ancestor") && beforePushCheck) { const callback = beforePushCheck; beforePushCheck = undefined; await callback(); }
    if (args.includes("push")) { beforePush?.(); beforePush = undefined; }
    const replaced = args.map((arg) => /^https:\/\/(?:gitlab|bitbucket)-fixture\.invalid\/org\/repo\.git$/.test(arg) ? remote : arg === "protocol.file.allow=never" ? "protocol.file.allow=always" : arg);
    return git(replaced, cwd, options);
  };
  return { fetch: fetcher, command, commands, refs, read, set: (patch: any) => save({ ...read(), ...patch }), beforePush: (callback: () => void) => { beforePush = callback; }, beforePushCheck: (callback: () => Promise<void>) => { beforePushCheck = callback; } };
}
