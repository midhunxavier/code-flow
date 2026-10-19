import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { validateJourney, type Journey, type JourneyReplay } from "./journeys.js";

/** Private immutable scenarios and bounded replay receipts, separate from streaming run logs. */
export class JourneyStore {
  private pending = Promise.resolve();
  constructor(private root: string) {}
  private path(id: string) { if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid scenario ID"); return join(this.root, `${id}.json`); }
  async get(id: string): Promise<Journey> { return JSON.parse(await readFile(this.path(id), "utf8")); }
  async list(repo: string): Promise<Journey[]> {
    const names = await readdir(this.root).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return []; throw e; });
    const records: Journey[] = [];
    for (const name of names.filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) { const value = await this.get(name.slice(0, -5)); if (value.repo === repo) records.push(value); }
    return records.sort((a, b) => b.createdAt - a.createdAt);
  }
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
      const count = (await readdir(this.root).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return []; throw e; })).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).length;
      if (count >= 100) throw new Error("The 100-scenario library is full. Delete an unused scenario first.");
      const journey = { ...parsed, id: randomUUID(), createdAt: Date.now() };
      await this.write(this.path(journey.id), journey); return journey;
    });
  }
  async replays(id: string): Promise<JourneyReplay[]> { await this.get(id); return JSON.parse(await readFile(this.path(id).replace(/\.json$/, ".replays.json"), "utf8").catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return "[]"; throw e; })); }
  async record(id: string, replay: JourneyReplay) { return this.serialize(async () => { const old = await this.replays(id); await this.write(this.path(id).replace(/\.json$/, ".replays.json"), [...old.slice(-3), replay]); return replay; }); }
  async delete(id: string) { return this.serialize(async () => { await this.get(id); await rm(this.path(id)); await rm(this.path(id).replace(/\.json$/, ".replays.json"), { force: true }); }); }
}
