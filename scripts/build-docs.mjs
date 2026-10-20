// One Markdown source, two destinations: /docs/ in the app and a portable Pages artifact.
import { Marked } from "marked";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, resolve, relative, posix } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFile(resolve(root, path), "utf8");
export const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const slug = (text) =>
  text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/ /g, "-");
export async function buildDocs() {
  const navigation = JSON.parse(await read("docs/site/navigation.json"));
  const entries = Object.entries(navigation).flatMap(([group, names]) =>
    names.map((name) => ({
      group,
      id: name === "README" ? "index" : name,
      source: `docs/${name}.md`,
    })),
  );
  entries.push({
    group: "Build and extend",
    id: "vscode",
    source: "integrations/vscode/README.md",
  });
  const known = new Map(entries.map((e) => [e.source, e.id]));
  const docs = await Promise.all(
    entries.map(async (e) => {
      const body = await read(e.source);
      return { ...e, body, title: /^# (.+)$/m.exec(body)?.[1] ?? e.id };
    }),
  );
  // Catch forgotten pages as part of every normal application build.
  for (const file of await readdir(resolve(root, "docs")))
    if (file.endsWith(".md") && !known.has(`docs/${file}`))
      throw new Error(`Add ${file} to docs/site/navigation.json`);
  const appCss = await read("ui/styles.css");
  if (!appCss.includes("  * { box-sizing: border-box; }"))
    throw new Error(
      "Update the docs theme boundary after changing the app stylesheet",
    );
  let theme = appCss.split("  * { box-sizing: border-box; }")[0];
  for (const match of [...theme.matchAll(/url\("fonts\/([^"/]+)"\)/g)])
    theme = theme.replaceAll(
      match[0],
      `url("data:font/woff;base64,${(await readFile(resolve(root, "ui/fonts", match[1]))).toString("base64")}")`,
    );
  const brand = `data:image/png;base64,${(await readFile(resolve(root, "ui/brand/vibesboard-mark.png"))).toString("base64")}`;
  const files = new Map([
    ["style.css", theme + (await read("docs/site/style.css"))],
    ["app.js", await read("docs/site/app.js")],
    ["search.json", JSON.stringify(docs)],
    [".nojekyll", ""],
    ["font-license.txt", await read("ui/fonts/OFL-1.1.txt")],
  ]);
  const hrefFor = (href, source) => {
    if (/^(?:https?:|mailto:|#)/i.test(href)) return href;
    if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//")) return "#";
    const [path, hash] = href.split("#");
    const target = posix.normalize(posix.join(posix.dirname(source), path));
    if (target === "README.md") return "index.html" + (hash ? `#${hash}` : "");
    if (known.has(target))
      return `${known.get(target)}.html${hash ? `#${hash}` : ""}`;
    return `https://github.com/midhunxavier/code-flow/blob/main/${target}${hash ? `#${hash}` : ""}`;
  };
  for (const [index, doc] of docs.entries()) {
    const toc = [],
      seen = new Map();
    const md = new Marked({
      gfm: true,
      renderer: {
        heading({ tokens, depth, text }) {
          const base = slug(text),
            count = seen.get(base) ?? 0;
          seen.set(base, count + 1);
          const id = base + (count ? `-${count}` : "");
          if (depth === 2 || depth === 3)
            toc.push({ id, depth, text: text.replace(/[`*]/g, "") });
          return `<h${depth} id="${escapeHtml(id)}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
        },
        link({ href, tokens }) {
          return `<a href="${escapeHtml(hrefFor(href, doc.source))}">${this.parser.parseInline(tokens)}</a>`;
        },
        image({ href, text }) {
          return `<img loading="lazy" src="${escapeHtml(href)}" alt="${escapeHtml(text)}">`;
        },
        table(token) {
          return `<div class="table-scroll" tabindex="0">${this.constructor.prototype.table.call(this, token)}</div>`;
        },
      },
    });
    // Inline screenshots: the remote-host package stores UTF-8 files and needs no binary protocol change.
    let body = doc.body;
    const images = [
      ...body.matchAll(
        /(?:src|srcset)="([^"]+)"|!\[[^\]]*\]\(([^)]+\.(?:png|jpg))\)/g,
      ),
    ];
    for (const match of images) {
      const path = match[1] ?? match[2];
      if (/^(https?:|data:)/.test(path)) continue;
      const file = resolve(root, dirname(doc.source), path);
      if (!relative(root, file).startsWith(".."))
        body = body.replaceAll(
          path,
          `data:image/${path.endsWith(".jpg") ? "jpeg" : "png"};base64,${(await readFile(file)).toString("base64")}`,
        );
    }
    const content = md
      .parse(body)
      .replaceAll(
        'media="(prefers-color-scheme: dark)"',
        'data-dark media="(prefers-color-scheme: dark)"',
      )
      .replace(
        /href="([^"#]+\.md(?:#[^"]*)?)"/g,
        (_, href) => `href="${escapeHtml(hrefFor(href, doc.source))}"`,
      );
    const nav = Object.keys(navigation)
      .map(
        (group) =>
          `<section><h2>${escapeHtml(group)}</h2>${docs
            .filter((e) => e.group === group)
            .map(
              (e) =>
                `<a href="${e.id}.html" ${e.id === doc.id ? 'aria-current="page"' : ""}>${escapeHtml(e.id === "index" ? "Overview" : e.title)}</a>`,
            )
            .join("")}</section>`,
      )
      .join("");
    const adjacent = [docs[index - 1], docs[index + 1]];
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="description" content="${escapeHtml(doc.title)} — code-flow guides and reference"><title>${escapeHtml(doc.title)} · code-flow</title><link rel="icon" href="${brand}"><link rel="stylesheet" href="style.css"><script src="app.js" defer></script></head>
<body data-page="${doc.id}"><a class="skip-link" href="#content">Skip to content</a>
<header class="topbar"><a class="brand" href="index.html"><img src="${brand}" width="30" height="30" alt=""><strong>Code Flow</strong><span>Docs</span></a><button class="search-trigger" id="open-search">Search documentation <kbd>⌘ K</kbd></button><div class="top-actions"><a href="https://github.com/midhunxavier/code-flow">GitHub ↗</a><button id="theme" aria-label="Change color theme">Theme</button><!--local-only--><button id="open-help" class="primary" hidden aria-expanded="false" aria-controls="help-panel">Ask code-flow</button><!--/local-only--><button id="menu" aria-label="Toggle documentation navigation" aria-expanded="false" aria-controls="sidebar">☰</button></div></header>
<div class="layout"><nav class="sidebar" id="sidebar" aria-label="Documentation">${nav}<a class="app-link" id="back-app" hidden href="/">← Back to app</a></nav>
<main id="content" tabindex="-1"><div class="breadcrumb">Documentation <span>/</span> ${escapeHtml(doc.group)}</div><article>${content}</article><footer><a href="https://github.com/midhunxavier/code-flow/blob/main/${doc.source}">Edit this page on GitHub ↗</a><span>code-flow · ${escapeHtml(JSON.parse(await read("package.json")).version)} · <a href="font-license.txt">Font license</a></span></footer><nav class="pagination" aria-label="Adjacent guides">${adjacent.map((e, n) => (e ? `<a href="${e.id}.html"><small>${n ? "Next →" : "← Previous"}</small>${escapeHtml(e.title)}</a>` : "<span></span>")).join("")}</nav></main>
<aside class="on-page" aria-label="On this page"><strong>On this page</strong>${toc.map((t) => `<a class="depth-${t.depth}" href="#${escapeHtml(t.id)}">${escapeHtml(t.text)}</a>`).join("")}</aside>
<!--local-only--><aside id="help-panel" hidden aria-labelledby="help-title"><div class="chat-heading"><div><span class="eyebrow">Your AI companion</span><h2 id="help-title">Ask code-flow</h2></div><button id="close-help" aria-label="Close AI companion">✕</button></div><div class="chat-toolbar"><span>Grounded in your docs</span><button id="new-chat">New chat</button></div><div id="help-messages" role="log" aria-label="Help conversation" aria-live="polite"><div id="chat-welcome"><span class="chat-mark" aria-hidden="true">✦</span><h3>What would you like to do?</h3><p>Let’s find your next step. Ask about setup, workflows or something that’s unclear.</p><div class="suggestions"><button type="button" data-question="How do I start my first run?">Start my first run ↗</button><button type="button" data-question="What should I do when a check fails?">Understand a failed check ↗</button></div></div></div><p id="help-status" role="status">Checking your installed CLIs…</p><button id="retry-help" hidden>Retry connection</button><form id="help-form" hidden><label class="sr-only" for="question">Your question</label><textarea id="question" rows="3" maxlength="4000" placeholder="Ask a question…" required></textarea><div class="composer-controls"><label class="sr-only" for="help-agent">Use your CLI</label><select id="help-agent"></select><button type="button" id="stop-help" hidden>Stop</button><button class="primary" id="send-help" aria-label="Send message">Send ↗</button></div><small>Uses your CLI login and quota. Shift + Enter for a new line.</small></form><a id="help-guide" href="help.html">About your local companion →</a></aside><!--/local-only--></div>
<dialog id="search-dialog" aria-labelledby="search-title"><div class="dialog-title"><h2 id="search-title">Search documentation</h2><button data-close="search-dialog" aria-label="Close search">✕</button></div><label class="sr-only" for="search">Search all guides</label><input id="search" type="search" placeholder="Search workflows, settings, troubleshooting…" autocomplete="off"><div id="search-results" aria-live="polite"></div></dialog>
</body></html>`;
    files.set(`${doc.id}.html`, html);
  }
  for (const directory of [resolve(root, "public/docs"), resolve(root, "dist/docs")]) {
    await mkdir(directory, { recursive: true });
    // Keep every published file readable during live or concurrent builds. Copying
    // over an existing destination can unlink it; direct writes can truncate it.
    for (const [name, content] of files) {
      const target = resolve(directory, name);
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        const published = name.endsWith(".html")
          ? directory === resolve(root, "dist/docs")
            ? content.replace(/<!--local-only-->[\s\S]*?<!--\/local-only-->/g, "")
                .replace(/(<a[^>]*href="help.html"[^>]*>)[^<]*(<\/a>)/g, "$1Local app help$2")
            : content.replace(/<!--\/?local-only-->/g, "")
          : content;
        await writeFile(temporary, published);
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true });
      }
    }
    for (const name of await readdir(directory))
      if (name.endsWith(".html") && !files.has(name))
        await rm(resolve(directory, name), { force: true });
  }
  console.log(
    `[docs] Built ${docs.length} guides in public/docs and dist/docs`,
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await buildDocs();
