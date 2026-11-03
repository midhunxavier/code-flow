import { basename } from "node:path";
import type { Projects } from "../projects.js";
import type { TaskConversations } from "../conversational/service.js";
import type { Conversations } from "../conversational/chats.js";
import type { CliTeamsService } from "./service.js";
import { digest, fail } from "./model.js";

/** Adapts CLI work to the existing task/chat services; execution remains owned by core. */
export function connectCliWorkspace(core: CliTeamsService, tasks: TaskConversations, chats: Conversations, projects: Projects, browser: { url: (path: string) => string; open: (path: string) => Promise<boolean> }) {
  core.workspace = {
    ...browser,
    async resolve(repo, context, proposalId) {
      const previous = context.continueRunId ? core.manager.get(context.continueRunId) : undefined;
      if (previous && previous.repo !== repo) fail("scope_denied", "Continuation belongs to another repository");
      const inherited = previous?.cliTeam?.taskConversation?.chatId;
      if (inherited && context.chatId && inherited !== context.chatId) fail("scope_denied", "Continue work in its original chat");
      const chatId = context.chatId ?? inherited;
      if (chatId) {
        const chat = await chats.cliContext(chatId, repo);
        if (context.projectId && context.projectId !== chat.project) fail("scope_denied", "Chat belongs to another project");
        return { ...chat, taskId: proposalId };
      }
      let project = context.projectId ? projects.get(context.projectId) : projects.forRepo(repo);
      if (context.projectId && !project?.repos.includes(repo)) fail("scope_denied", "Choose a project containing this repository");
      project ??= await projects.create({ name: basename(repo), repos: [repo] });
      return { project: project.id, taskId: proposalId, chatId: digest(["cli-chat", proposalId]).slice(0, 32) };
    },
    async sync(proposal, event) {
      const task = await tasks.syncCliProposal(proposal, event);
      await chats.syncCliTask(task, event);
    },
    async describe(proposal) {
      const state = await chats.get(proposal.chatId!);
      const current = state.tasks.find(t => t.task.id === state.chat.activeTask);
      return {
        version: state.chat.version, activeTaskId: state.chat.activeTask,
        latestProposal: current?.proposal ? { proposalId: current.proposal.id, revision: current.proposal.revision, proposalHash: current.proposal.hash, runId: current.proposal.runId, task: current.proposal.task, definition: current.proposal.definition } : undefined,
        messagesTruncated: state.chat.events.length > 8,
        messages: state.chat.events.slice(-8).map(({ sequence, kind, body, taskId, runId }) => ({ sequence, kind, body: body?.slice(0, 2000), bodyTruncated: (body?.length ?? 0) > 2000, taskId, runId })),
        taskMessagesTruncated: (current?.task.messages.length ?? 0) > 8,
        taskMessages: current?.task.messages.slice(-8).map(({ role, body, runId, noteId }) => ({ role, body: body.slice(0, 2000), bodyTruncated: body.length > 2000, runId, noteId })),
      };
    },
  };
}
