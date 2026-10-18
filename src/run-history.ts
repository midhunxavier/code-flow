export interface RunCursor { at: number; id: string }

export function encodeRunCursor(run: { createdAt: number; id: string }): string {
  return Buffer.from(JSON.stringify({ at: run.createdAt, id: run.id })).toString("base64url");
}

export function decodeRunCursor(value: string): RunCursor {
  if (!value || value.length > 1000 || !/^[\w-]+$/.test(value)) throw new Error("Invalid history cursor");
  let cursor: RunCursor;
  try { cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); }
  catch { throw new Error("Invalid history cursor"); }
  if (!cursor || !Number.isSafeInteger(cursor.at) || cursor.at < 0 || typeof cursor.id !== "string" || !cursor.id || cursor.id.length > 256) throw new Error("Invalid history cursor");
  return cursor;
}

/** A total order avoids skipping runs created in the same millisecond. */
export function compareRuns(a: { createdAt: number; id: string }, b: { createdAt: number; id: string }): number {
  return b.createdAt - a.createdAt || b.id.localeCompare(a.id);
}

export function afterRunCursor(run: { createdAt: number; id: string }, cursor: RunCursor): boolean {
  return compareRuns(run, { createdAt: cursor.at, id: cursor.id }) > 0;
}
