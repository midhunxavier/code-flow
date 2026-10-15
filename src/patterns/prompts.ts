import { adapters, type AgentId } from "../adapters/index.js";

/** Shared framing so every agent knows it is one member of a team. */
export function preamble(role: string, agent: AgentId, duty: string): string {
  return [
    `You are the ${role} on a team of AI coding agents (Claude Code, Codex, Antigravity) coordinated by code-flow.`,
    `You are running as ${adapters[agent].displayName}, non-interactively: nobody can answer questions, so make reasonable assumptions and state them.`,
    duty,
    "Do not run `git commit`, `git push` or change branches — code-flow commits your work after you finish.",
  ].join("\n");
}

export function section(title: string, body: string): string {
  return `\n## ${title}\n${body.trim()}\n`;
}

export function fence(body: string, lang = ""): string {
  return `\`\`\`${lang}\n${body}\n\`\`\``;
}

export const READ_ONLY = "You have read-only access: inspect code and run read-only commands, but do not modify any files.";
export const WRITE = "You may edit files and run build/test commands in the current directory, which is an isolated git worktree.";

export function jsonInstruction(shape: string): string {
  return `\nEnd your answer with a fenced \`\`\`json block exactly matching this shape:\n${fence(shape, "json")}`;
}

export const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
