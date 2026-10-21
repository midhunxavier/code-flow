import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Isolate Code Flow process bookkeeping; the provider CLIs retain their own existing login.
process.env.CODEFLOW_HOME = mkdtempSync(join(tmpdir(), "codeflow-live-runtime-"));
