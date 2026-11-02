import { ProjectDraftStore } from "./project-context.js";

/** File bytes are stored once; text/model edits persist only small draft references. */
export const chatDraftFiles = new ProjectDraftStore<{ data: string }>("chat-attachment:");
