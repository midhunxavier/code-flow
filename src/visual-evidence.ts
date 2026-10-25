import { git, resolveCommit } from "./git.js";

/** On-demand, ordinary reviewed files. Never upload arbitrary workspace or browser-session files. */
export const VISUAL_EVIDENCE_GUIDANCE = `If the user asks for screenshots, a screen recording or visual test evidence, test the relevant flow using the repository's browser tests or available browser tools. Capture real results, not generated illustrations. Keep it focused; backend-only work does not need visual tests unless requested. Save only the intended screenshots (.png, .jpg, .webp) and short recordings (.webm or .mp4) under .codeflow/evidence/, with a README.md describing the flow, commands, outcome and any limitations. Refresh evidence after changes to the tested flow. Exclude credentials, personal data and unrelated browser tabs. Keep each file under 20 MB, at most eight media files. These ordinary reviewable files travel with the result branch; when the user publishes through code-flow, screenshots and recording links are included in the PR. If publishing directly through GitHub tools at the user's request, include full repository blob links pinned to the published commit for these files. Respect the task's allowed paths; if evidence files are outside scope, report that limitation. Do not publish them yourself without the user's request. If capture is unavailable, explain the limitation instead of claiming it was tested.`;

export const wantsVisualEvidence = (text: string) => /\b(screenshots?|screen[ -]?record(?:ing)?|visual (?:test|evidence)|record(?:ing)? (?:the |this |a )?(?:flow|demo|browser)|video)\b/i.test(text);

export interface VisualEvidenceFile { path: string; kind: "screenshot" | "recording" | "notes"; size: number }

/** Inspect only regular committed blobs changed by this run, never symlinks or local file paths. */
export async function visualEvidenceFiles(repo: string, base: string, branch: string): Promise<{ head: string; files: VisualEvidenceFile[] }> {
  const head = await resolveCommit(repo, `refs/heads/${branch}`);
  const changed = await git(["diff", "--name-only", "--diff-filter=AM", "-z", base, head, "--", ".codeflow/evidence/"], repo);
  if (changed.code) throw new Error("Could not inspect visual evidence on this branch");
  const paths = new Set(changed.stdout.split("\0").filter(Boolean));
  if (!paths.size) return { head, files: [] };
  const tree = await git(["ls-tree", "-r", "-l", "-z", head, "--", ".codeflow/evidence/"], repo);
  if (tree.code) throw new Error("Could not read visual evidence files");
  const files: VisualEvidenceFile[] = [];
  for (const row of tree.stdout.split("\0")) {
    const entry = row.match(/^(100644|100755) blob [a-f0-9]+\s+(\d+)\t(.+)$/);
    if (!entry || !paths.has(entry[3]!)) continue;
    const path = entry[3]!, size = Number(entry[2]);
    if (size < 1 || size > 20 * 1024 * 1024 || !/^\.codeflow\/evidence\/[a-zA-Z0-9_./ -]+$/.test(path)) continue;
    const kind = /\.(png|jpe?g|webp)$/i.test(path) ? "screenshot" : /\.(webm|mp4)$/i.test(path) ? "recording" : path === ".codeflow/evidence/README.md" && size <= 64 * 1024 ? "notes" : undefined;
    if (kind) files.push({ path, kind, size });
  }
  const media = files.filter(file => file.kind !== "notes").slice(0, 8);
  return { head, files: media.length ? [...media, ...files.filter(file => file.kind === "notes")] : [] };
}

export function visualEvidenceMarkdown(repository: string, head: string, files: VisualEvidenceFile[]): string {
  if (!files.length) return "";
  const url = new URL(repository);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !/^\/[\w.-]+\/[\w.-]+\/?$/.test(url.pathname) || !/^[a-f0-9]{40,64}$/.test(head)) throw new Error("Invalid visual evidence repository or revision");
  const root = url.href.replace(/\/$/, "").replace(/\.git$/, "");
  return ["## Visual evidence", "Captured files included with this change. Test results are reported separately.", ...files.map(file => {
    const label = file.path.split("/").at(-1)!.replace(/[_-]/g, " ");
    const link = `${root}/blob/${head}/${file.path.split("/").map(encodeURIComponent).join("/")}`;
    return file.kind === "screenshot" ? `![${label}](${link}?raw=true)` : `[${file.kind === "recording" ? "Watch recording" : "Test steps and results"}: ${label}](${link})`;
  })].join("\n\n");
}
