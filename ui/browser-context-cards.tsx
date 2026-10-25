import { Markdown } from "./bits.js";
import { Icon } from "./icons.js";
import { composeBrowserMessage, parseBrowserMessage, type BrowserContext } from "./browser-context.js";
import type { Attachment } from "./types.js";

function pageLabel(url: string) {
  try { const page = new URL(url); return page.host + (page.pathname === "/" ? "" : page.pathname); } catch { return "Browser selection"; }
}

function ContextCard({ context, image, onRemove }: { context: BrowserContext; image?: Attachment; onRemove?: () => void }) {
  const title = context.text || (context.source === "snapshot" ? "Selected area" : "Browser selection");
  return <article class="browser-context-card" aria-label="Browser context">
    <div class="browser-context-heading">
      {image ? <img class="browser-context-thumb" src={`data:image/png;base64,${image.data}`} alt="Selected area of the page" /> : <span class="browser-context-icon"><Icon name="globe" /></span>}
      <div class="browser-context-source"><strong title={title}>{title.length > 65 ? `${title.slice(0, 65)}…` : title}</strong><span title={context.url}>{pageLabel(context.url)}</span></div>
      {onRemove ? <button type="button" class="icon-btn" aria-label="Remove browser context" onClick={onRemove}><Icon name="close" /></button> : null}
    </div>
    {context.comment ? <div class="browser-context-comment">{context.comment}</div> : null}
    <details class="browser-context-details"><summary>Page details</summary><pre>{JSON.stringify(context, null, 2)}</pre></details>
  </article>;
}

export function BrowserMessage({ text }: { text: string }) {
  const message = parseBrowserMessage(text);
  return <>{message.text ? <Markdown text={message.text} /> : null}{message.contexts.length ? <div class="browser-context-cards">{message.contexts.map((context, index) => <ContextCard key={index} context={context} />)}</div> : null}</>;
}

export function BrowserDraftCards({ text, onText, images, onImages }: { text: string; onText: (text: string) => void; images: Attachment[]; onImages: (images: Attachment[]) => void }) {
  const message = parseBrowserMessage(text);
  if (!message.contexts.length) return null;
  return <div class="browser-context-cards browser-context-draft" aria-label="Browser context to send">{message.contexts.map((context, index) => <ContextCard key={index} context={context} image={images.find(image => image.name === context.snapshot)} onRemove={() => {
    const remaining = message.contexts.filter((_, i) => i !== index);
    onText(composeBrowserMessage(message.text, remaining));
    onImages(images.filter(image => image.name !== context.snapshot || remaining.some(item => item.snapshot === image.name)));
  }} />)}</div>;
}
