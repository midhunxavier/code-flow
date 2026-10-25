/** Browser evidence travels with the message, but is presented separately from what the user types. */
export interface BrowserContext {
  version: 1;
  comment: string;
  url: string;
  selector: string;
  text: string;
  html?: string;
  viewport?: { w: number; h: number };
  rect?: { x: number; y: number; w: number; h: number };
  tried?: Record<string, string>;
  snapshot?: string;
  console?: string[];
  source?: "snapshot";
  selection?: number;
  snapshotPage?: { url: string; width: number; height: number; full: boolean };
}
export interface BrowserMessage { text: string; contexts: BrowserContext[] }

export function browserContextMessage(context: BrowserContext): string {
  // Keep the first line useful wherever a new run's title is derived from its task.
  const title = (context.comment || context.text || "Selected area").split("\n")[0]!.slice(0, 120);
  return `Browser comment: ${title}\n` + "```codeflow-browser-context\n" + JSON.stringify(context, null, 2) + "\n```";
}

function isContext(value: unknown): value is BrowserContext {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return item.version === 1 && ["comment", "url", "selector", "text"].every(key => typeof item[key] === "string")
    && ["html", "snapshot"].every(key => item[key] === undefined || typeof item[key] === "string");
}

export function parseBrowserMessage(message: string): BrowserMessage {
  const contexts: BrowserContext[] = [];
  let text = message.replace(/^(?:Browser comment: [^\n]*\r?\n)?```codeflow-browser-context\r?\n([\s\S]*?)\r?\n```(?=\r?\n|$)/gm, (raw, json: string) => {
    try {
      const value: unknown = JSON.parse(json);
      if (isContext(value)) {
        if (raw.startsWith("Browser comment:") && raw.split(/\r?\n/)[0] !== browserContextMessage(value).split("\n")[0]) return raw;
        contexts.push(value); return "";
      }
    } catch {}
    return raw; // Unknown or edited evidence stays visible; never discard user text.
  });
  // Messages sent before context cards existed. Match only the generated header and numbered selections.
  text = text.replace(/^From (?:the app in the browser(?: \([^\n]*\))?|a snapshot of [^\n]+):\r?\n(?:[^\n]+(?:\n|$))*/gm, raw => {
    const lines = raw.trimEnd().split("\n"), header = lines.shift()!;
    const url = header.match(/^From the app in the browser \((.*?)(?:, \d+px wide)?\):$/)?.[1]
      ?? header.match(/^From a snapshot of (.*?) \(/)?.[1] ?? "";
    const snapshot = header.match(/the boxes are numbered on ([^:]+):$/)?.[1];
    const found: BrowserContext[] = [];
    let current: BrowserContext | undefined, index = 0;
    for (; index < lines.length; index++) {
      const line = lines[index]!;
      const pin = line.match(/^\d+\. (`[^`]+`|an area .+?): (.*)$/);
      if (pin) {
        current = { version: 1, url, selector: pin[1]!.replace(/^`|`$/g, ""), comment: pin[2] === "(no comment)" ? "" : pin[2]!, text: "", snapshot };
        found.push(current); continue;
      }
      if (!current) break;
      const field = line.match(/^   (On|Text|HTML|Tried in the browser|Snapshot): (.*)$/);
      if (field) {
        const value = field[2]!;
        if (field[1] === "On") current.url = value;
        if (field[1] === "Text") current.text = value.replace(/^"|"$/g, "");
        if (field[1] === "HTML") current.html = value;
        if (field[1] === "Snapshot") current.snapshot = value;
        if (field[1] === "Tried in the browser") current.tried = { changes: value };
      } else if (line === "Console errors and failed requests:") {
        current.console = [];
        while (lines[index + 1]?.startsWith("- ")) current.console.push(lines[++index]!.slice(2));
      } else break;
    }
    if (!found.length) return raw;
    contexts.push(...found);
    return lines.slice(index).join("\n") + (raw.endsWith("\n") ? "\n" : "");
  });
  // The server appends staged paths. Collapse this generated footer only when every file belongs to a card.
  text = text.replace(/Attached, in this worktree \(not committed\):\s*((?:`[^`]+`(?:,\s*|\s*$))+)/gm, (raw, paths: string) => {
    const files = [...paths.matchAll(/`([^`]+)`/g)].map(match => match[1]!);
    return files.length && files.every(file => file.startsWith(".codeflow-context/") && contexts.some(c => c.snapshot && file.endsWith(`-${c.snapshot}`))) ? "" : raw;
  });
  return { text: contexts.length ? text.trim() : message, contexts };
}

export function composeBrowserMessage(text: string, contexts: BrowserContext[]): string {
  return [text, ...contexts.map(browserContextMessage)].filter(Boolean).join("\n\n");
}
export function editBrowserText(message: string, text: string): string {
  return composeBrowserMessage(text, parseBrowserMessage(message).contexts);
}
export function browserImageNames(message: string): Set<string> {
  return new Set(parseBrowserMessage(message).contexts.flatMap(c => c.snapshot ? [c.snapshot] : []));
}
