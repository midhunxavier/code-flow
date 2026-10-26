import { CODEFLOW_HOME } from "../src/config.js";
import { compactRunLog, createEncryptedBackup, restoreEncryptedBackup, retainArchivedRuns, offline, newMaintenanceOutput, readMaintenanceInput } from "../src/maintenance.js";
import { RetentionPolicyStore, applyRetention, previewRetention, type RetentionPreview } from "../src/retention-policy.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);
const command = args.shift();
const value = (name: string) => {
  const at = args.indexOf(`--${name}`);
  const result = at >= 0 ? args[at + 1] : undefined;
  if (at >= 0 && (!result || result.startsWith("--"))) throw new Error(`--${name} needs a value.`);
  return result;
};
const required = (name: string) => { const result = value(name); if (!result) throw new Error(`Provide --${name}.`); return result; };
const help = `Offline code-flow maintenance (stop the server first):
  npx tsx scripts/maintenance.ts backup --output /path/backup.cfb [--home /data]
  npx tsx scripts/maintenance.ts restore --input /path/backup.cfb --destination /new/data
  npx tsx scripts/maintenance.ts retention --days 90 [--home /data]
  npx tsx scripts/maintenance.ts compact --id RUN_ID [--apply] [--home /data]
  npx tsx scripts/maintenance.ts retention-policy [--output /path/plan.json] [--home /data]
  npx tsx scripts/maintenance.ts retention-policy --plan /path/plan.json --apply [--home /data]
  npx tsx scripts/maintenance.ts retention-settings --input /path/settings.json [--home /data]

Set CODEFLOW_BACKUP_PASSWORD to a password of at least 12 characters for backup/restore.
Backups use authenticated AES-256-GCM encryption. Existing output/destination paths are rejected.
Legacy retention --days reports age-only candidates and cannot delete without an exact --plan.
Compaction previews changes unless --apply is passed.
Per-type retention-policy uses saved settings and requires an exact reviewed plan to apply.
Project knowledge, active/resumable/unarchived/pinned work and provenance sources are protected.`;
try {
  if (!command || command === "--help" || command === "help") { console.log(help); }
  else {
    const home = value("home") || CODEFLOW_HOME;
    let result;
    if (command === "backup") result = await createEncryptedBackup({ home, output: required("output"), password: process.env.CODEFLOW_BACKUP_PASSWORD ?? "" });
    else if (command === "restore") result = await restoreEncryptedBackup({ input: required("input"), destination: required("destination"), password: process.env.CODEFLOW_BACKUP_PASSWORD ?? "" });
    else if (command === "retention") {
      if (args.includes("--apply")) {
        if (!value("plan")) throw new Error("Age-only retention cannot delete data. Save a retention policy and review retention-policy --output PLAN.json, then use retention-policy --plan PLAN.json --apply.");
        result = await applyRetention({ home, plan: JSON.parse(await readMaintenanceInput(required("plan"), "Retention plan")) as RetentionPreview });
        if (result.failed.length) process.exitCode = 1;
      } else result = await retainArchivedRuns({ home, days: Number(required("days")) });
    }
    else if (command === "compact") result = await compactRunLog({ home, runId: required("id"), apply: args.includes("--apply") });
    else if (command === "retention-policy") {
      if (args.includes("--apply")) {
        const planFile = required("plan"); const plan = JSON.parse(await readMaintenanceInput(planFile, "Retention plan")) as RetentionPreview;
        result = await applyRetention({ home, plan });
        if (result.failed.length) process.exitCode = 1;
      } else {
        const requestedOutput = value("output");
        const output = requestedOutput ? await newMaintenanceOutput(requestedOutput, "Plan") : undefined;
        result = await offline(home, path => previewRetention({ home: path }));
        if (output) await writeFile(output, JSON.stringify(result, null, 2), { flag: "wx", mode: 0o600 }).catch((error: NodeJS.ErrnoException) => { if (error.code === "EEXIST") throw new Error("Plan file already exists. Choose a new path."); throw error; });
      }
    }
    else if (command === "retention-settings") {
      const input = required("input");
      result = await offline(home, async path => {
        const store = new RetentionPolicyStore(join(path, "retention-policy.json"));
        const previous = await store.get();
        return store.set(JSON.parse(await readMaintenanceInput(input, "Retention settings")), previous.revision);
      });
    }
    else throw new Error(`Unknown command: ${command}. Use --help.`);
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) { console.error((error as Error).message); process.exitCode = 1; }
