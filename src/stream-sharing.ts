import { createHmac, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** A restart with the same owner token keeps its broker; changing identity still retires it. */
export class StreamSharingIdentity {
  current!: { channelKey: string; lockId: string };
  private writes = Promise.resolve();
  private persistent = true;
  private constructor(private readonly file: string, private readonly token: string) {}
  static async load(file: string, token: string) {
    const identity = new StreamSharingIdentity(file, token);
    let nonce: string | undefined;
    try {
      const value = JSON.parse(await readFile(file, "utf8"));
      if (value?.version !== 1 || typeof value.nonce !== "string" || !/^[a-f0-9]{64}$/.test(value.nonce)) throw new Error("Invalid stream identity");
      nonce = value.nonce;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") identity.persistent = false;
    }
    if (nonce) identity.current = identity.derive(nonce);
    else {
      await identity.rotate();
      if (!identity.persistent) console.warn("Live-update identity storage is unavailable. Existing data was retained; browser tabs may reload after a restart. Restore stream-sharing.json or move it aside to recover persistence.");
    }
    return identity;
  }
  private derive(nonce: string) {
    const derive = (purpose: string) => createHmac("sha256", this.token).update(`${purpose}:${nonce}`).digest("hex");
    return { channelKey: derive("stream-channel"), lockId: derive("stream-lock").slice(0, 32) };
  }
  rotate(): Promise<void> {
    const next = this.writes.then(async () => {
      const nonce = randomBytes(32).toString("hex"), temporary = `${this.file}.${nonce}.tmp`;
      if (!this.persistent) { this.current = this.derive(nonce); return; }
      try { await mkdir(dirname(this.file), { recursive: true }); await writeFile(temporary, JSON.stringify({ version: 1, nonce }) + "\n", { flag: "wx", mode: 0o600 }); await rename(temporary, this.file); }
      catch {
        this.persistent = false;
        console.warn("Live-update identity could not be saved. Rotating in memory so sign-out still takes effect; browser tabs may reload after a restart.");
      }
      finally { await rm(temporary, { force: true }).catch(() => {}); }
      this.current = this.derive(nonce);
    });
    this.writes = next.catch(() => {}); return next;
  }
}
