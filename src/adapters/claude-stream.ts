import type { AgentEvent } from "./types.js";

/** Reconcile Anthropic partial content with its authoritative completed message. */
export class ClaudeStream {
  private messageId = "";
  private blocks = new Map<number, { type: string; id?: string; name?: string; input: string; text: string }>();
  lastText = "";
  constructor(private emit: (event: AgentEvent) => void) {}

  partial(event: any): void {
    if (event?.type === "message_start") {
      this.messageId = event.message?.id ?? "";
      this.blocks.clear();
      return;
    }
    if (!this.messageId || !Number.isInteger(event?.index)) return;
    const messageId = `${this.messageId}:${event.index}`;
    if (event.type === "content_block_start") {
      const block = event.content_block;
      if (!block) return;
      this.blocks.set(event.index, { type: block.type, id: block.id, name: block.name, input: "", text: block.text ?? "" });
      if (block.type === "text") this.emit({ kind: "text", messageId, text: block.text ?? "" });
      if (block.type === "thinking") this.emit({ kind: "thinking", messageId, text: block.thinking ?? "" });
      if (block.type === "tool_use") this.emit({ kind: "tool_call", callId: block.id, name: block.name, input: JSON.stringify(block.input ?? {}) });
    } else if (event.type === "content_block_delta") {
      const block = this.blocks.get(event.index);
      const delta = event.delta;
      if (delta?.type === "text_delta") {
        if (block) { block.text += delta.text; this.lastText = [...this.blocks.values()].filter(b => b.type === "text").map(b => b.text).join("\n\n"); }
        this.emit({ kind: "text", messageId, text: delta.text, delta: true });
      }
      if (delta?.type === "thinking_delta") this.emit({ kind: "thinking", messageId, text: delta.thinking, delta: true });
      if (delta?.type === "input_json_delta" && block?.id && block.name) {
        block.input = (block.input + delta.partial_json).slice(0, 32_000);
        // The completed assistant block supplies authoritative arguments; emitting every growing
        // JSON fragment would duplicate large file contents in the event log.
      }
    }
  }

  complete(message: any): void {
    const content = Array.isArray(message?.content) ? message.content : [];
    const texts: string[] = [];
    for (const [index, block] of content.entries()) {
      const messageId = message.id ? `${message.id}:${index}` : undefined;
      if (block.type === "text" && typeof block.text === "string") {
        texts.push(block.text);
        this.emit({ kind: "text", text: block.text, ...(messageId ? { messageId } : {}) });
      } else if (block.type === "thinking" && typeof block.thinking === "string") {
        this.emit({ kind: "thinking", text: block.thinking, ...(messageId ? { messageId } : {}) });
      } else if (block.type === "tool_use") {
        this.emit({ kind: "tool_call", callId: block.id, name: block.name, input: JSON.stringify(block.input ?? {}).slice(0, 32_000) });
      }
    }
    if (texts.length) this.lastText = texts.join("\n\n");
  }
}
