import type { Run } from "./engine.js";
import { PR_BODY_LIMIT } from "./github.js";

/** Turn local checkout references into repository-relative evidence before publication. */
export function publicationText(text: string, roots: readonly string[]): string {
  const directories = [...new Set(roots.filter(Boolean).map(root => root.replace(/\\/g, "/").replace(/\/$/, "")))].sort((a, b) => b.length - a.length);
  const relative = (value: string) => {
    try {
      const url = new URL(value); if (url.protocol !== "file:" || url.host && url.host !== "localhost") return;
      const path = decodeURIComponent(url.pathname).replace(/\\/g, "/");
      const root = directories.find(root => path === root || path.startsWith(root + "/"));
      if (root) return encodeURI(path.slice(root.length).replace(/^\//, "") || ".") + url.hash;
    } catch { /* Invalid local URLs are omitted as well. */ }
  };
  let output = text.replace(/\[([^\]]*)\]\((file:\/\/[^)]+)\)/gi, (_match, label: string, url: string) => { const path = relative(url); return path ? `[${label}](${path})` : `${label} (local file omitted)`; });
  output = output.replace(/file:\/\/[^\s<>)]+/gi, url => relative(url) ?? "[local file omitted]");
  for (const root of directories) { output = output.split(root + "/").join(""); output = output.split(root.replace(/\//g, "\\") + "\\").join(""); }
  return output;
}

const clipped = (text: string, limit: number) => text.length <= limit ? text : text.slice(0, Math.max(0, limit - 60)).trimEnd() + "\n… (truncated; full text is available in code-flow)";

/** Keep issue closure and verification ahead of bounded summaries/evidence and optional task detail. */
export function pullRequestDescription(run: Run, patternName: string, visualBody: string): string {
  const roots = [run.repo, ...run.worktrees.map(tree => tree.path)];
  const clean = (text: string) => publicationText(text, roots);
  const agents = [...new Set(Object.values(run.roles).flat())].join(", ");
  const required = [
    run.source?.kind === "issue" ? `Closes #${run.source.number}` : run.source?.kind === "alert" ? `Fixes ${run.source.url}` : "",
    run.loop.check ? `Check: ${clipped(clean(run.loop.check), 2000)} — ${run.verdict === "passed" ? "passing" : run.verdict === "failing" ? "failing" : run.checkCantRun ? `can't run here (${clipped(clean(run.checkCantRun.reason), 1000)})` : "not run"}.` : "Check: not configured.",
    `Made by a code-flow team (${clipped(patternName, 200)}; agents: ${clipped(agents, 500)}).`,
  ].filter(Boolean).join("\n\n");
  const summary = run.summary?.trim() ? `## Summary\n\n${clipped(clean(run.summary), 20_000)}` : "";
  const visual = visualBody ? clipped(clean(visualBody), 20_000) : "";
  const start = [required, summary, visual].filter(Boolean).join("\n\n");
  const task = clean(run.projectTeam ? run.task.split("\n")[0]! : run.task);
  // Escaping keeps arbitrary task text from closing the collapsed details element.
  const escaped = task.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const open = "\n\n<details><summary>Task given to the agents</summary>\n\n<pre>", close = "</pre>\n</details>";
  return start + open + clipped(escaped, PR_BODY_LIMIT - start.length - open.length - close.length) + close;
}
