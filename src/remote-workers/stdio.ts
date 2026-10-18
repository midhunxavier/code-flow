import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { join } from "node:path";
import { git } from "../git.js";
import { chunks } from "./bundles.js";
import { MAX_FRAME_BYTES, RemoteWorkerError, validateWorkerRequest, type ClientFrame, type WorkerFrame, type WorkerRequest } from "./protocol.js";
import { ProvisionedWorker } from "./worker.js";

/** One bounded SSH channel. Accepted jobs are identified by durable receipts, never auto-relaunched. */
export async function serveWorker(worker: ProvisionedWorker) {
  const controller = new AbortController();
  let buffer = "", frames = 0, finished = false, executing = false;
  let request: WorkerRequest | undefined, source: Buffer | undefined, sourceOffset = 0;
  const context = new Map<string, Buffer>(), offsets = new Map<string, number>();
  let output = Promise.resolve();
  const write = async (frame: WorkerFrame) => {
    const line = JSON.stringify(frame) + "\n";
    if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new RemoteWorkerError("Worker response frame exceeds its bound");
    if (!process.stdout.write(line)) await once(process.stdout, "drain");
  };
  const send = (frame: WorkerFrame) => { const next = output.then(() => write(frame)); output = next.catch(() => undefined); return next; };
  const uploadDeadline = setTimeout(() => { void fail(new RemoteWorkerError("Worker channel did not complete its upload within 30 seconds")); }, 30_000);
  const close = () => { finished = true; clearTimeout(uploadDeadline); process.stdin.destroy(); };
  const fail = async (error: unknown) => { controller.abort(); await send({ v: 1, type: "error", message: (error as Error).message.slice(0, 2000) }).catch(() => undefined); close(); };
  const owned = (frame: { id: string; capability: string }) => { if (!request || frame.id !== request.id || frame.capability !== request.capability) throw new RemoteWorkerError("Frame does not own this scoped request"); };
  const handle = async (frame: ClientFrame) => {
    if (!frame || frame.v !== 1) throw new RemoteWorkerError("Invalid protocol version or excessive frames");
    if (frame.type === "probe") {
      const repo = frame.repoMapping ? worker.repo(frame.repoMapping) : undefined;
      const exists = async (commit?: string) => !!repo && !!commit && /^[a-f0-9]{40,64}$/i.test(commit) && !(await git(["cat-file", "-e", `${commit}^{commit}`], repo, { timeoutMs: 10_000 })).code;
      await send({ v: 1, type: "probe", capabilities: await worker.capabilities(frame.containerProfile), hasBase: await exists(frame.baseCommit), hasRepositoryBase: await exists(frame.repositoryBase) }); close(); return;
    }
    if (frame.type === "receipt" || frame.type === "cancel") {
      const receipt = frame.type === "receipt" ? await worker.receipt(frame.id, frame.capability) : await worker.cancel(frame.id, frame.capability);
      await send({ v: 1, type: "receipt", receipt });
      if (frame.type === "receipt" && frame.downloadArtifact !== false && receipt.artifact) {
        const artifact = receipt.artifact, file = join(worker.config.root, "requests", frame.id, "result.bundle");
        await send({ v: 1, type: "artifact", artifact }); for (const chunk of chunks(await readFile(file))) await send({ v: 1, type: "chunk", ...chunk });
      }
      if (!executing) close(); return;
    }
    if (frame.type === "begin") {
      if (request || executing) throw new RemoteWorkerError("Only one execution is allowed per channel");
      request = validateWorkerRequest(frame.request); if (request.source) source = Buffer.alloc(request.source.size);
      for (const file of request.context) { context.set(file.path, Buffer.alloc(file.size)); offsets.set(file.path, 0); } return;
    }
    owned(frame);
    if (frame.type === "source" || frame.type === "context") {
      if (executing || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data)) throw new RemoteWorkerError("Invalid binary transfer frame");
      const data = Buffer.from(frame.data, "base64"), target = frame.type === "source" ? source : context.get(frame.path ?? ""), offset = frame.type === "source" ? sourceOffset : offsets.get(frame.path ?? "");
      if (!target || frame.offset !== offset || !data.length || frame.offset + data.length > target.length) throw new RemoteWorkerError("Transfer offsets or file identity do not match the accepted manifest");
      target.set(data, frame.offset); if (frame.type === "source") sourceOffset += data.length; else offsets.set(frame.path!, frame.offset + data.length); return;
    }
    if (frame.type !== "execute" || executing || !request || source && sourceOffset !== source.length || request.context.some((file) => offsets.get(file.path) !== file.size)) throw new RemoteWorkerError("The accepted transfer is incomplete or already executing");
    executing = true; clearTimeout(uploadDeadline);
    void worker.execute(request, source, context, (event) => { void send({ v: 1, type: "event", event }).catch(() => controller.abort()); }, (receipt) => { void send({ v: 1, type: receipt.state === "accepted" ? "accepted" : "heartbeat", receipt }).catch(() => controller.abort()); }, controller.signal).then(async ({ result, receipt, artifact }) => {
      if (artifact) { const { file, ...manifest } = artifact; await send({ v: 1, type: "artifact", artifact: manifest }); for (const chunk of chunks(await readFile(file))) await send({ v: 1, type: "chunk", ...chunk }); }
      await send({ v: 1, type: "result", receipt, result }); close();
    }).catch(fail);
  };
  let queue = Promise.resolve();
  await send({ v: 1, type: "hello", protocol: 1 });
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (data: string) => {
    if (finished) return;
    buffer += data;
    if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES && !buffer.includes("\n")) { void fail(new RemoteWorkerError("Worker input frame exceeds its bound")); return; }
    let at: number;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      if (++frames > 1000 || Buffer.byteLength(line) > MAX_FRAME_BYTES) { void fail(new RemoteWorkerError("Worker frame limit exceeded")); return; }
      queue = queue.then(async () => { if (finished) return; if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new RemoteWorkerError("Worker input frame exceeds its bound"); await handle(JSON.parse(line)); }).catch(fail);
    }
  });
  process.stdin.on("end", () => { if (!finished) controller.abort(); });
  process.stdout.on("error", () => controller.abort());
  process.on("SIGTERM", () => controller.abort()); process.on("SIGHUP", () => controller.abort());
  return new Promise<void>((resolve) => { const timer = setInterval(() => { if (finished) { clearInterval(timer); resolve(); } }, 20); });
}
