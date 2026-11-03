import { supportsToolFreeDiscussion } from "../adapters/tool-free.js";
import type { Pattern } from "../engine.js";
import { captureOutput } from "../adapters/process.js";
import { fail } from "../cli-teams/model.js";
export async function assertDiscussionProvider(provider: string) {
  if (provider !== "claude") fail("unsupported_settings", "Choose a repository for this provider. Repository-free discussion currently requires Claude with verified tool-disable controls.");
  const help = await captureOutput("claude", ["--help"], 5000);
  if (!supportsToolFreeDiscussion(provider, help)) fail("unsupported_settings", "Update Claude Code or choose a repository: the installed CLI cannot confirm tool-free discussion.");
}
export const discussionPattern: Pattern = {
  id: "chat-discussion", name: "Discussion", summary: "Repository-free discussion", description: "A bounded text conversation with provider tools disabled", roles: [], options: [],
  async run(ctx) {
    if (ctx.run.roles.agent?.length !== 1 || ctx.run.roles.agent[0] !== "claude" || ctx.run.project || !ctx.run.conversationId || !ctx.run.permissions?.required.includes("no-external-tools")) throw new Error("Discussion requires the internal tool-free conversation path");
    const reply = await ctx.ask({ title: "Discuss your question", role: "agent", agent: "claude", mode: "read", cwd: await ctx.worktree("discussion"), tools: false, planning: true, disableTools: true,
      prompt: `This is a repository-free discussion. All tools are disabled. Answer in readable Markdown using only this conversation and attached context. Do not claim to inspect, implement, run checks or involve other agents. If the user requests repository work, explain what you can discuss now and ask them to attach a project repository using Project and source before preparing an executable approach.\n\n${ctx.task}` });
    if (!reply.ok) throw new Error(reply.error || "The discussion provider did not complete the response");
    return reply.finalText;
  },
};
