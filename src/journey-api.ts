import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readJson, send, HttpError } from "./http.js";
import { repoRoot, resolveCommit } from "./git.js";
import type { RunManager } from "./engine.js";
import { logError } from "./log.js";
import { JourneyStore, ScenarioError } from "./journey-store.js";
import { journeySpec, journeyUrl, type JourneyReplay } from "./journeys.js";
import { takeSnapshot } from "./snapshot.js";

const repository = (value: unknown) => { if (typeof value !== "string" || !value.startsWith("/")) throw new Error("Choose an absolute repository path"); return value; };

export function journeyApi(store: JourneyStore, manager: RunManager, forbiddenPorts: number[]) {
  let replaying: string | undefined;
  return async (req: IncomingMessage, res: ServerResponse, url: URL, parts: string[]) => {
    if (parts[1] !== "journeys") return false;
    try {
      const id = parts[2];
      if (!id && parts.length === 2 && req.method === "GET") {
        if (url.searchParams.get("all") === "1") {
          const items = await store.listAll(), previews: Record<string, string> = {};
          for (const server of manager.devServers.list()) { const run = manager.get(server.key.split("/")[0]!); if (run && server.status === "running") previews[run.repo] = server.url; }
          send(res, 200, { items, total: items.length, limit: 100, previews });
        } else { const path = repository(url.searchParams.get("repo")); send(res, 200, await store.list(await repoRoot(path).catch(() => path))); }
        return true;
      }
      if (!id && parts.length === 2 && req.method === "POST") {
        const body = await readJson(req, 128 * 1024);
        body.repo = await repoRoot(repository(body.repo));
        if (forbiddenPorts.includes(Number(new URL(journeyUrl(body.url)).port))) throw new Error("Record your app, not code-flow itself");
        send(res, 201, await store.create(body)); return true;
      }
      if (!id) throw new Error("Choose a saved scenario");
      if (parts.length === 3 && req.method === "DELETE") {
        if (replaying === id) throw new HttpError(409, "This scenario is replaying. Wait for it to finish before deleting it.");
        await store.delete(id); send(res, 200, { deleted: true }); return true;
      }
      const journey = await store.get(id);
      if (parts.length === 3 && req.method === "GET") { send(res, 200, { journey, replays: await store.replays(id), spec: journeySpec(journey) }); return true; }
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
        replaying = id;
        try {
          const head = tree ? await resolveCommit(journey.repo, `refs/heads/${tree.branch}`) : undefined;
          const snapshot = await takeSnapshot({ url: target.href, width: journey.width, height: 900, journey }, { documentOrigin: target.origin, localApp: url => url.origin === target.origin });
          const receipt: JourneyReplay = { id: randomUUID(), journeyId: id, at: Date.now(), url: target.href, runId: run?.id, branch: tree?.branch, head, ...snapshot.replay! };
          if (tree && head !== await resolveCommit(journey.repo, `refs/heads/${tree.branch}`)) { receipt.status = "failed"; receipt.error = "The result branch moved during replay. Run the scenario again."; }
          send(res, 201, await store.record(id, receipt)); return true;
        } finally { replaying = undefined; }
      }
      throw new HttpError(404, "Unknown scenario operation");
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (error instanceof ScenarioError) throw new HttpError(error.status, error.message);
      if ((error as NodeJS.ErrnoException).code) { logError("Recorded scenario operation failed", error); throw new HttpError(503, "The recorded scenario library could not be accessed. Check its storage and try again."); }
      throw new HttpError(400, (error as Error).message);
    }
  };
}
