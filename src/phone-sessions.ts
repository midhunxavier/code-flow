import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CODEFLOW_HOME } from "./config.js";
import { HttpError } from "./http.js";
import { deviceLabel } from "./phone-device-label.js";

export interface PhoneDevice { id: string; label: string; createdAt: number; expiresAt: number; revokedAt?: number }
interface StoredDevice extends PhoneDevice { tokenHash: string; generation: string }
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const THIRTY_DAYS = 30 * 86_400_000;

/** Only hashes are retained. Rotating the pairing generation invalidates every old session. */
export class PhoneSessions {
  private records: StoredDevice[] = [];
  private loaded = false;
  private loading?: Promise<void>;
  private writes = Promise.resolve();
  constructor(private readonly file = join(CODEFLOW_HOME, "phone-devices.json")) {}

  load(): Promise<void> {
    return this.loading ??= (async () => {
      let raw: unknown;
      try { raw = JSON.parse(await readFile(this.file, "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new HttpError(503, "Phone sessions cannot be read; pairing is disabled"); }
      if (raw !== undefined) {
        const value = raw as { version?: number; devices?: StoredDevice[] };
        if (!value || value.version !== 1 || !Array.isArray(value.devices) || value.devices.length > 128 || value.devices.some((device) => !device || typeof device.id !== "string" || device.id.length > 128 || !/^[a-f0-9]{64}$/.test(device.tokenHash) || !/^[a-f0-9]{64}$/.test(device.generation) || typeof device.label !== "string" || device.label.length > 120 || !Number.isFinite(device.createdAt) || !Number.isFinite(device.expiresAt) || device.expiresAt <= device.createdAt || (device.revokedAt !== undefined && (!Number.isFinite(device.revokedAt) || device.revokedAt < device.createdAt)))) throw new HttpError(503, "Phone session storage is invalid; pairing is disabled");
        this.records = value.devices;
      }
      this.loaded = true;
    })();
  }

  valid(token: string, generation: string, now = Date.now()): boolean {
    if (!this.loaded || token.length > 128) return false;
    const tokenHash = digest(token), current = digest(generation);
    return this.records.some((device) => device.tokenHash === tokenHash && device.generation === current && !device.revokedAt && device.expiresAt > now);
  }

  list(generation: string, now = Date.now()): PhoneDevice[] {
    if (!this.loaded) throw new HttpError(503, "Phone sessions cannot be read; repair their storage and restart Code Flow");
    const current = digest(generation);
    return this.records.filter((device) => device.generation === current && !device.revokedAt && device.expiresAt > now).map(({ tokenHash: _, generation: __, ...device }) => ({ ...device, label: /^Mozilla\//i.test(device.label) ? deviceLabel(device.label) : device.label }));
  }

  async pair(label: string, generation: string, now = Date.now()) {
    await this.load();
    const token = randomBytes(32).toString("hex");
    const device: StoredDevice = { id: randomUUID(), label: label.replace(/[\x00-\x1f]/g, "").slice(0, 120) || "Phone", tokenHash: digest(token), generation: digest(generation), createdAt: now, expiresAt: now + THIRTY_DAYS };
    await this.change((records) => {
      const live = records.filter((record) => !record.revokedAt && record.expiresAt > now && record.generation === device.generation);
      if (live.length >= 32) throw new HttpError(409, "Too many paired devices; revoke an existing device first");
      return [...live, device];
    });
    const { tokenHash: _, generation: __, ...publicDevice } = device;
    return { token, device: publicDevice };
  }

  async revoke(id: string, generation: string): Promise<boolean> {
    await this.load();
    let changed = false;
    await this.change((records) => records.map((device) => {
      if (device.id !== id || device.generation !== digest(generation) || device.revokedAt) return device;
      changed = true; return { ...device, revokedAt: Date.now() };
    }));
    return changed;
  }

  private change(update: (records: StoredDevice[]) => StoredDevice[]) {
    const write = this.writes.catch(() => undefined).then(async () => {
      const records = update(this.records.map((record) => ({ ...record })));
      await mkdir(dirname(this.file), { recursive: true });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temp, "wx", 0o600);
        try { await handle.writeFile(JSON.stringify({ version: 1, devices: records })); await handle.sync(); }
        finally { await handle.close(); }
        await rename(temp, this.file);
        if (process.platform !== "win32") {
          const directory = await open(dirname(this.file), "r");
          try { await directory.sync(); } finally { await directory.close(); }
        }
      } finally { await rm(temp, { force: true }).catch(() => {}); }
      this.records = records;
    });
    this.writes = write;
    return write;
  }
}
