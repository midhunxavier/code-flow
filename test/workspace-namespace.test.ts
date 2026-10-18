import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { RunManager } from "../src/engine.js";

process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "codeflow-workspace-namespace-home-"));
const { handleWorkspaceApi } = await import("../src/workspace-api.js");
const { HttpError } = await import("../src/http.js");

test("workspace routes identify owned paths before forged Git discovery and refuse mutations of a mismatched checkout", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codeflow-workspace-namespace-")), repo = join(directory, "repo"), worktree = join(directory, "owned"), foreign = join(directory, "foreign");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  try {
    for (const [path, text] of [[repo, "owned source\n"], [foreign, "foreign private content\n"]]) {
      mkdirSync(path!); git(path!, "init", "-q", "-b", "main"); writeFileSync(join(path!, "file.txt"), text!); git(path!, "add", "."); git(path!, "-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "initial");
    }
    const head = git(repo, "rev-parse", "HEAD"), foreignHead = git(foreign, "rev-parse", "HEAD"); git(repo, "worktree", "add", "-q", "-b", "owned-result", worktree, head);
    const run = { id: "owned-run", repo, status: "done", worktrees: [{ name: "result", path: worktree, branch: "owned-result" }] };
    const manager = { list: () => [run], get: (id: string) => id === run.id ? run : undefined, withIdleRepository: async (_repo: string, work: () => Promise<unknown>) => work() } as unknown as RunManager;
    const request = (path: string, method = "GET", body?: unknown) => {
      const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []) as unknown as IncomingMessage;
      Object.assign(req, { method, headers: { "content-type": "application/json" } });
      const url = new URL(path, "http://localhost");
      return handleWorkspaceApi(req, url, url.pathname.split("/").filter(Boolean), manager, new AbortController().signal);
    };
    git(foreign, "config", "core.worktree", foreign); writeFileSync(join(worktree, ".git"), `gitdir: ${join(foreign, ".git")}\n`);
    const file = await request(`/api/workspace/file?repo=${encodeURIComponent(worktree)}&path=file.txt`);
    assert.equal(file?.status, 200); assert.equal((file!.body as { text: string }).text, "owned source\n", "read repair uses the registered checkout folder, never foreign core.worktree");
    const history = await request(`/api/workspace/checkpoints?repo=${encodeURIComponent(worktree)}`);
    assert.equal((history!.body as { head: string }).head, head, "checkpoint reads use registered Git metadata");
    for (const [path, body] of [
      ["apply-checkpoint", { source: head, expectedHead: head, paths: ["file.txt"], runId: run.id }],
      ["file", { path: "file.txt", text: "must not save\n", expectedHash: (file!.body as { hash: string }).hash }],
    ] as const) await assert.rejects(request(`/api/workspace/${path}`, "POST", { ...body, repo: worktree }), (error: unknown) => error instanceof HttpError && error.status === 409 && /checkout code-flow expects/.test(error.message));
    assert.equal(readFileSync(join(worktree, "file.txt"), "utf8"), "owned source\n"); assert.equal(readFileSync(join(foreign, "file.txt"), "utf8"), "foreign private content\n"); assert.equal(git(foreign, "rev-parse", "HEAD"), foreignHead); assert.equal(git(repo, "rev-parse", "HEAD"), head);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
