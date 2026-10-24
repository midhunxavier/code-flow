import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { DATA_LIMIT, integer, MlError, string } from "./model.js";
import type { Fingerprint } from "./schedule-model.js";

/** Read content, not timestamps: identical replacements do not trigger training. */
export async function fingerprintFile(raw: unknown): Promise<Fingerprint> {
  const path = string(raw, "dataset path", 4096);
  if (!isAbsolute(path)) throw new MlError("Use an absolute dataset path");
  const format = path.toLowerCase().endsWith(".csv") ? "csv" : path.toLowerCase().endsWith(".parquet") ? "parquet" : path.toLowerCase().endsWith(".jsonl") ? "jsonl" : undefined;
  if (!format) throw new MlError("Use a CSV, Parquet or JSONL dataset");
  const limit = format === "jsonl" ? 32 * 1024 * 1024 : DATA_LIMIT;
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await fd.stat();
    if (!before.isFile()) throw new MlError("Choose a regular dataset file");
    integer(before.size, 1, limit, "Dataset size");
    const hash = createHash("sha256"); let bytes = 0;
    for await (const chunk of fd.createReadStream({ autoClose: false })) {
      bytes += chunk.length; if (bytes > limit) throw new MlError("Dataset is too large"); hash.update(chunk);
    }
    const after = await fd.stat();
    if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new MlError("Dataset changed while reading; publish a complete file before checking again", 409);
    return { hash: hash.digest("hex"), bytes, format };
  } finally { await fd.close(); }
}
