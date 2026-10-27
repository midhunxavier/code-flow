import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { logError } from "./log.js";
import { validateJourney, type Journey, type JourneyReplay } from "./journeys.js";

export class ScenarioError extends Error { constructor(message: string, public status = 400) { super(message); } }
const missing = () => new ScenarioError("This scenario was deleted or could not be found.", 404);

/** Private immutable scenarios and bounded replay receipts, separate from streaming run logs. */
export class JourneyStore {
  private pending = Promise.resolve();
  constructor(private root: string) {}
  private path(id: string) { if (!/^[a-f0-9-]{36}$/.test(id)) throw new ScenarioError("Invalid scenario ID"); return join(this.root, `${id}.json`); }
  async get(id: string): Promise<Journey> {
    let text: string;
    try { text = await readFile(this.path(id), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw missing(); throw error; }
    try {
      const value = JSON.parse(text);
      if (!value || value.id !== id || !Number.isFinite(value.createdAt)) throw new Error("Invalid scenario metadata");
      return { ...validateJourney(value), id, createdAt: value.createdAt };
    } catch { throw new ScenarioError("This saved scenario is unreadable. Delete it or restore a valid backup.", 409); }
  }
  private async scan(): Promise<Journey[]> {
    const names = await readdir(this.root).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return []; throw e; });
    const records: Journey[] = [];
    for (const name of names.filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) {
      try { records.push(await this.get(name.slice(0, -5))); }
      catch (error) {
        if (error instanceof ScenarioError && error.status === 404) continue;
        if (error instanceof ScenarioError && error.status === 409) {
          const backup = `${join(this.root, name)}.corrupt-${Date.now()}-${randomUUID()}`;
          try { await rename(join(this.root, name), backup); }
          catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
          logError("An unreadable recorded scenario was moved aside; other scenarios remain available", error, { file: name });
          continue;
        }
        throw error;
      }
    }
    return records.sort((a, b) => b.createdAt - a.createdAt);
  }
  listAll(): Promise<Journey[]> { return this.serialize(() => this.scan()); }
  async list(repo: string): Promise<Journey[]> { return (await this.listAll()).filter(value => value.repo === repo); }
  private async write(path: string, value: unknown) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const data = JSON.stringify(value);
    if (Buffer.byteLength(data) > 16 * 1024 * 1024) throw new Error("Replay exceeded the 16 MiB evidence limit");
    const temp = `${path}.${randomUUID()}.tmp`;
    try { const file = await open(temp, "wx", 0o600); try { await file.writeFile(data); await file.sync(); } finally { await file.close(); } await rename(temp, path); const directory = await open(this.root, "r"); try { await directory.sync(); } finally { await directory.close(); } }
    finally { await rm(temp, { force: true }); }
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> { const next = this.pending.then(work); this.pending = next.then(() => {}, () => {}); return next; }
  async create(input: unknown) {
    const parsed = validateJourney(input);
    return this.serialize(async () => {
      const records = await this.scan();
      if (records.length >= 100) {
        const counts = new Map<string, number>(); for (const item of records) counts.set(item.repo, (counts.get(item.repo) ?? 0) + 1);
        const breakdown = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([repo, count]) => `${count} in ${repo.length > 180 ? "…" + repo.slice(-180) : repo}`).join("; ") + (counts.size > 3 ? `; ${counts.size - 3} other repositories` : "");
        throw new ScenarioError(`This computer's 100-scenario library is full (${breakdown}). Open All scenarios on this computer and delete an unused scenario first.`);
      }
      const journey = { ...parsed, id: randomUUID(), createdAt: Date.now() };
      await this.write(this.path(journey.id), journey); return journey;
    });
  }
  async replays(id: string): Promise<JourneyReplay[]> { await this.get(id); return JSON.parse(await readFile(this.path(id).replace(/\.json$/, ".replays.json"), "utf8").catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return "[]"; throw e; })); }
  async record(id: string, replay: JourneyReplay) { return this.serialize(async () => { const old = await this.replays(id); await this.write(this.path(id).replace(/\.json$/, ".replays.json"), [...old.slice(-3), replay]); return replay; }); }
  async delete(id: string) { return this.serialize(async () => { try { await rm(this.path(id)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw missing(); throw error; } await rm(this.path(id).replace(/\.json$/, ".replays.json"), { force: true }); }); }
}
