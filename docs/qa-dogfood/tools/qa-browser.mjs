// Playwright helper for driving an isolated QA server with headless Chrome.
//   import { openApp } from "<QA>/qa-browser.mjs";
//   const { browser, page, errors, shot } = await openApp({ port: 4341, name: "chat" });
//   await page.goto(base + "/#/..."); await shot("after-send"); ... await browser.close();
// `errors` collects console errors, page errors and failed/5xx API responses.
import { chromium } from "/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/node_modules/playwright-core/index.mjs";
import { mkdirSync } from "node:fs";

const QA = "/private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa";

// profile: a name for a persistent browser profile (localStorage, drafts, cookies survive between scripts, like a
// developer's real browser). Omit it for a fresh, empty browser each time. `browser.close()` works either way.
export async function openApp({ port, name, path = "", viewport = { width: 1440, height: 900 }, headless = true, colorScheme = "light", profile } = {}) {
  const base = `http://127.0.0.1:${port}`;
  let browser, context;
  if (profile) {
    context = await chromium.launchPersistentContext(`${QA}/profiles/${profile}`, { channel: "chrome", headless, viewport, colorScheme });
    browser = { close: () => context.close() };
  } else {
    browser = await chromium.launch({ channel: "chrome", headless });
    context = await browser.newContext({ viewport, colorScheme });
  }
  const page = context.pages()[0] ?? await context.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("response", (r) => { if (r.url().includes("/api/") && r.status() >= 500) errors.push(`http ${r.status()} ${r.request().method()} ${r.url()}`); });
  await page.goto(`${base}/?token=qa-${name}-token`);
  if (path) await page.goto(base + path);
  const dir = `${QA}/shots/${name}`; mkdirSync(dir, { recursive: true });
  let n = 0;
  const shot = async (label) => { const file = `${dir}/${String(++n).padStart(3, "0")}-${label}.png`; await page.screenshot({ path: file, fullPage: false }); return file; };
  const api = async (p, body, method) => {
    const res = await fetch(base + p, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { authorization: `Bearer qa-${name}-token`, "content-type": "application/json", origin: base }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
  };
  return { browser, context, page, errors, shot, api, base };
}
