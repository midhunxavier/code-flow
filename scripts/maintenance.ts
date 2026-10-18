import { CODEFLOW_HOME } from "../src/config.js";
import { compactRunLog, createEncryptedBackup, restoreEncryptedBackup, retainArchivedRuns } from "../src/maintenance.js";

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
  npx tsx scripts/maintenance.ts retention --days 90 [--apply] [--home /data]
  npx tsx scripts/maintenance.ts compact --id RUN_ID [--apply] [--home /data]

Set CODEFLOW_BACKUP_PASSWORD to a password of at least 12 characters for backup/restore.
Backups use authenticated AES-256-GCM encryption. Existing output/destination paths are rejected.
Retention and compaction preview changes unless --apply is passed. Retention removes only old,
archived terminal run logs/journals; attachments, memory, projects and Git worktrees are kept.`;
try {
  if (!command || command === "--help" || command === "help") { console.log(help); }
  else {
    const home = value("home") || CODEFLOW_HOME;
    let result;
    if (command === "backup") result = await createEncryptedBackup({ home, output: required("output"), password: process.env.CODEFLOW_BACKUP_PASSWORD ?? "" });
    else if (command === "restore") result = await restoreEncryptedBackup({ input: required("input"), destination: required("destination"), password: process.env.CODEFLOW_BACKUP_PASSWORD ?? "" });
    else if (command === "retention") result = await retainArchivedRuns({ home, days: Number(required("days")), apply: args.includes("--apply") });
    else if (command === "compact") result = await compactRunLog({ home, runId: required("id"), apply: args.includes("--apply") });
    else throw new Error(`Unknown command: ${command}. Use --help.`);
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) { console.error((error as Error).message); process.exitCode = 1; }
