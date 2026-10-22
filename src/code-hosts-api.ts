import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { CodeHosts, CodeHostError } from "./code-hosts.js";
import { HttpError, readJson, send } from "./http.js";
import { RUNS_DIR, flushWrites } from "./store.js";
import type { StartRunInput, RunManager, Run } from "./engine.js";
import type { Integrations } from "./integrations.js";
import type { Projects } from "./projects.js";
import { validateVerificationProfile } from "./verification.js";
import { validateAgentContainer } from "./agent-container.js";

/** Confirm the initial trusted server provenance, rather than acknowledging a best-effort projection. */
export async function persistCodeHostRun(run: Run, directory = RUNS_DIR) {
  await flushWrites(); const handle = await open(join(directory, `${run.id}.jsonl`), constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
  try { const info = await handle.stat(); if (!info.isFile() || !info.size) throw new Error("Missing code review run receipt"); const buffer = Buffer.alloc(Math.min(info.size, 4 * 1024 * 1024)), read = await handle.read(buffer, 0, buffer.length, 0), end = buffer.subarray(0, read.bytesRead).indexOf(10); if (end < 0) throw new Error("Incomplete code review run receipt"); const first = JSON.parse(buffer.subarray(0, end).toString("utf8")), stored = first.type === "run" ? first.run as Run : undefined;
    if (!stored || stored.id !== run.id || stored.repo !== run.repo || stored.project !== run.project || stored.baseRef !== run.externalSource?.code?.head || JSON.stringify(stored.externalSource?.code) !== JSON.stringify(run.externalSource.code) || stored.externalSource?.integration !== run.externalSource.integration || stored.externalSource?.key !== run.externalSource.key || stored.trust !== "safe" || stored.loop.copy?.length || !stored.lockdown || stored.lockdownOnHost || stored.loop.container?.network !== false) throw new Error("The initial code review identity and isolated source policy were not saved"); await handle.sync();
  } finally { await handle.close(); }
  if (process.platform !== "win32") { const folder = await open(directory, "r"); try { await folder.sync(); } finally { await folder.close(); } }
}

/** Mount only behind owner authorization and the filesystem policy execution gate. */
export function createCodeHostsApi(options: { integrations: Integrations; manager: Pick<RunManager, "get" | "start" | "cancel" | "reviewCoverage" | "withIdleRepository">; projects: Pick<Projects, "get">; build: (body: any) => Promise<StartRunInput>; service?: CodeHosts; persist?: typeof persistCodeHostRun }) {
  const service = options.service ?? new CodeHosts(options), persist = options.persist ?? persistCodeHostRun;
  const text = (value: unknown, label: string, max = 250) => { if (typeof value !== "string" || !value || value.length > max) throw new HttpError(400, `Choose a valid ${label}`); return value; };
  const handle = async (req: IncomingMessage, res: ServerResponse, parts: string[]): Promise<boolean> => {
    if (parts[0] !== "code-hosts") return false;
    try {
      if (req.method === "GET" && parts.length === 1) { send(res, 200, { integrations: options.integrations.list().filter((item) => item.codeHost), history: service.history() }); return true; }
      if (req.method !== "POST") throw new HttpError(404, "Unknown code host operation");
      const body = await readJson(req, 256_000); let value: unknown;
      if (parts.length === 4 && parts[1] === "history" && parts[3] === "acknowledge") { if (body.acknowledge !== true) throw new HttpError(400, "Explicitly acknowledge inspecting this exact unknown operation"); send(res, 200, await service.acknowledge(text(parts[2], "unknown operation", 40))); return true; }
      if (parts.length === 2 && parts[1] === "preview") value = await service.preview({ integration: text(body.integration, "code host", 64), key: text(body.key, "PR number", 12), repo: text(body.repo, "local repository", 4096), ...(body.project ? { project: text(body.project, "project", 120) } : {}) });
      else if (parts.length === 2 && parts[1] === "create-preview") value = await service.createPreview({ integration: text(body.integration, "code host", 64), runId: text(body.runId, "owned run", 120), branch: text(body.branch, "owned result branch"), targetBranch: text(body.targetBranch, "target branch"), title: text(body.title, "PR title", 200), body: typeof body.body === "string" ? body.body : "" });
      else {
        const id = text(parts[1], "server preview", 40), action = parts[2]; if (parts.length !== 3) throw new HttpError(404, "Unknown code host operation");
        if (action === "fetch") value = await service.fetch(id);
        else if (action === "create") value = await service.create(id);
        else if (action === "review") value = await service.review(id, body);
        else if (action === "push-preview") value = await service.pushPreview(id, text(body.runId, "owned run", 120), text(body.branch, "owned result branch"));
        else if (action === "push") value = await service.push(id, text(body.planId, "push preview", 40));
        else if (action === "merge-preview") value = await service.mergePreview(id, text(body.runId, "owned run", 120), text(body.branch, "owned result branch"));
        else if (action === "merge") value = await service.merge(id, text(body.planId, "merge preview", 40));
        else if (action === "run") {
          const raw = body.run;
          if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.parentRunId || raw.source || raw.sourceReference || raw.externalSource || raw.context?.attachments?.length || raw.attachments?.length) throw new HttpError(400, "Code review runs use this server-fetched source and do not inherit parent runs or uploads");
          if (!raw.loop?.agentContainer) throw new HttpError(409, "Fetched PR code requires an explicitly prepared agent container image and optional in-container authentication volume. Native Safe mode is not filesystem isolation.");
          const agentContainer = validateAgentContainer(raw.loop.agentContainer), prepared = await service.prepareRun(id);
          const check = typeof raw.loop?.check === "string" ? raw.loop.check.trim() : ""; const verification = raw.loop?.verification ? validateVerificationProfile(raw.loop.verification) : check ? validateVerificationProfile({ name: "Code host review", checks: [{ id: "code-host-check", kind: "custom", command: check, required: true, timeoutMs: 120_000 }] }) : undefined;
          if (!verification?.checks.some((gate) => gate.required)) throw new HttpError(400, "Code review runs need at least one required verification command");
          const built = await options.build({ ...raw, repo: prepared.preview.repo, project: prepared.preview.project, baseRef: prepared.preview.head, trust: "safe", allowUntrusted: false, approvals: { tools: false, plan: false }, loop: { ...raw.loop, agentContainer, verification, copy: [], container: { ...(raw.loop?.container ?? { image: "node:22" }), network: false } } });
          value = await service.action(id, "run", async () => { const current = await service.prepareRun(id); if (current.preview.repo !== built.repo || current.preview.head !== prepared.preview.head || current.preview.target !== prepared.preview.target) throw new CodeHostError("The fetched source changed during run validation"); const run = await options.manager.start({ ...built, checkpointOnFinish: true, parentRunId: undefined, source: undefined, externalSource: current.source, baseRef: current.preview.head, trust: "safe", allowUntrusted: false, requireProjectRepo: !!current.preview.project, approvals: { tools: false, plan: false }, context: { ...built.context, attachments: [] }, loop: { ...built.loop, copy: [], container: { ...(built.loop?.container ?? { image: "node:22" }), network: false } } }); await service.recordRun(id, run.id); await persist(run); return { id: run.id }; }, (result) => ({ runId: result.id }));
        } else throw new HttpError(404, "Unknown code host operation");
      }
      send(res, 200, value); return true;
    } catch (error) { if (error instanceof CodeHostError) { send(res, error.status, { error: error.message, ambiguous: error.ambiguous }); return true; } throw error; }
  };
  return { service, handle };
}
