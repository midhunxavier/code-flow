import { spawn } from "node:child_process";
import type { FileHandle } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const rustBinary = fileURLToPath(new URL("./target/release/codeflow-transcript-experiment", import.meta.url));

/** Includes actual IPC and helper startup/termination costs, not an in-process Rust microbenchmark. */
export async function* rustReverseLines(file: FileHandle, end: number): AsyncGenerator<{ text: string; offset: number }> {
  const child = spawn(rustBinary, [String(end)], { stdio: ["ignore", "pipe", "pipe", file.fd] });
  let stderr = "", failure: Error | undefined;
  child.stderr!.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4096); });
  child.on("error", (error) => { failure = error; });
  const exited = new Promise<number | null>((resolve) => child.once("close", resolve));
  const timeout = setTimeout(() => { failure = new Error("Native transcript read timed out"); child.kill("SIGKILL"); }, 10_000);
  let carry: Buffer = Buffer.alloc(0);
  try {
    for await (const chunk of child.stdout!) {
      carry = carry.length ? Buffer.concat([carry, chunk]) : chunk as Buffer;
      while (carry.length >= 12) {
        const length = carry.readUInt32LE(8);
        if (length > 64 * 1024 * 1024) throw new Error("Native record exceeds limit");
        if (carry.length < length + 12) break;
        const offset = Number(carry.readBigUInt64LE(0));
        if (!Number.isSafeInteger(offset) || offset > end) throw new Error("Invalid native offset");
        const text = carry.subarray(12, 12 + length).toString("utf8");
        carry = carry.subarray(12 + length);
        yield { text, offset };
      }
    }
    const code = await exited;
    if (failure) throw failure;
    if (code !== 0 || carry.length) throw new Error(`Native transcript read failed: ${stderr || code}`);
  } finally { clearTimeout(timeout); child.kill(); await exited; }
}
