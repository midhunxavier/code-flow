import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readJson, send, HttpError } from "./http.js";
import { repoRoot, resolveCommit } from "./git.js";
import type { RunManager } from "./engine.js";
import { JourneyStore } from "./journey-store.js";
import { journeySpec, journeyUrl, type JourneyReplay } from "./journeys.js";
import { takeSnapshot } from "./snapshot.js";

const repository = (value: unknown) => { if (typeof value !== "string" || !value.startsWith("/")) throw new Error("Choose an absolute repository path"); return value; };

export function journeyApi(store: JourneyStore, manager: RunManager, forbiddenPorts: number[]) {
  let replaying = false;
  return async (req: IncomingMessage, res: ServerResponse, url: URL, parts: string[]) => {
    if (parts[1] !== "journeys") return false;
    try {
      const id = parts[2];
      if (!id && parts.length === 2 && req.method === "GET") { send(res, 200, await store.list(await repoRoot(repository(url.searchParams.get("repo"))))); return true; }
      if (!id && parts.length === 2 && req.method === "POST") {
        const body = await readJson(req, 128 * 1024);
        body.repo = await repoRoot(repository(body.repo));
        if (forbiddenPorts.includes(Number(new URL(journeyUrl(body.url)).port))) throw new Error("Record your app, not code-flow itself");
        send(res, 201, await store.create(body)); return true;
      }
      if (!id) throw new Error("Choose a saved scenario");
      const journey = await store.get(id);
      if (parts.length === 3 && req.method === "GET") { send(res, 200, { journey, replays: await store.replays(id), spec: journeySpec(journey) }); return true; }
      if (parts.length === 3 && req.method === "DELETE") { await store.delete(id); send(res, 200, { deleted: true }); return true; }
      if (parts.length === 4 && parts[3] === "replay" && req.method === "POST") {
        if (replaying) throw new HttpError(409, "A browser replay is already running. Wait for it to finish.");
        const body = await readJson(req);
        const target = new URL(journeyUrl(body.url ?? journey.url));
        if (forbiddenPorts.includes(Number(target.port))) throw new Error("Replays cannot target code-flow itself");
        const original = new URL(journey.url);
        target.pathname = original.pathname; target.search = original.search; target.hash = original.hash;
        const run = typeof body.runId === "string" ? manager.get(body.runId) : undefined;
        if (body.runId && (!run || run.repo !== journey.repo)) throw new Error("Choose a run in the scenario's repository");
        const tree = run?.worktrees.find(tree => tree.branch === body.branch);
        if (run && (!tree || run.status === "running")) throw new Error("Choose a finished run's result branch");
        if (run && !manager.devServers.list().some(server => server.key === `${run.id}/${tree!.name}` && server.status === "running" && new URL(server.url).port === target.port)) throw new Error("Start this result's app before replaying its scenario");
        if (replaying) throw new HttpError(409, "A browser replay is already running. Wait for it to finish.");
        replaying = true;
        try {
          const head = tree ? await resolveCommit(journey.repo, `refs/heads/${tree.branch}`) : undefined;
          const snapshot = await takeSnapshot({ url: target.href, width: journey.width, height: 900, journey }, { documentOrigin: target.origin, localApp: url => url.origin === target.origin });
          const receipt: JourneyReplay = { id: randomUUID(), journeyId: id, at: Date.now(), url: target.href, runId: run?.id, branch: tree?.branch, head, ...snapshot.replay! };
          if (tree && head !== await resolveCommit(journey.repo, `refs/heads/${tree.branch}`)) { receipt.status = "failed"; receipt.error = "The result branch moved during replay. Run the scenario again."; }
          send(res, 201, await store.record(id, receipt)); return true;
        } finally { replaying = false; }
      }
      throw new HttpError(404, "Unknown scenario operation");
    } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError((error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 400, (error as Error).message); }
  };
}
