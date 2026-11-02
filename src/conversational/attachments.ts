import { fail } from "../cli-teams/model.js";
import type { ChatAttachment } from "./chat-model.js";
import type { ChatFile } from "./chat-model.js";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { CODEFLOW_HOME } from "../config.js";
export function chatAttachments(value: unknown): ChatAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10) fail("validation_failed", "Attach up to ten files");
  let bytes = 0;
  for (const file of value) {
    if (!file || typeof file !== "object" || Object.keys(file).some(k => !["name", "data"].includes(k)) || typeof file.name !== "string" || !file.name.trim() || file.name.length > 200) fail("validation_failed", "Choose a valid attachment name");
    if (/[\\/\0]/.test(file.name) || /^(?:\.env(?:\.|$)|id_rsa|id_ed25519|credentials)/i.test(file.name)) fail("validation_failed", "Choose a regular attachment, excluding credential files");
    if (typeof file.data !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.data)) fail("validation_failed", "Attachments must contain base64 data");
    const size = Buffer.byteLength(file.data, "base64"); bytes += size;
    if (size > 1024 * 1024 || bytes > 4 * 1024 * 1024) fail("validation_failed", "Attach files up to 1 MB each and 4 MB in total");
  }
  return value as ChatAttachment[];
}
const directory = join(CODEFLOW_HOME, "chat-files");
export async function storeChatFiles(files: ChatAttachment[]): Promise<ChatFile[]> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const refs: ChatFile[] = [];
  for (const file of chatAttachments(files)) {
    const bytes = Buffer.from(file.data, "base64"), sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(join(directory, sha256), bytes, { mode: 0o600, flag: "wx" }).catch(error => { if (error.code !== "EEXIST") throw error; });
    refs.push({ name: file.name, sha256, bytes: bytes.length });
  }
  return refs;
}
export async function loadChatFiles(refs: ChatFile[] = []): Promise<ChatAttachment[]> {
  const files: ChatAttachment[] = [];
  for (const ref of refs) {
    if (!/^[a-f0-9]{64}$/.test(ref.sha256) || (await stat(join(directory, ref.sha256))).size > 1024 * 1024) fail("storage_unavailable", "An attached file needs repair");
    const bytes = await readFile(join(directory, ref.sha256));
    if (bytes.length !== ref.bytes || createHash("sha256").update(bytes).digest("hex") !== ref.sha256) fail("storage_unavailable", "An attached file changed; attach it again before continuing");
    files.push({ name: ref.name, data: bytes.toString("base64") });
  }
  return files;
}
