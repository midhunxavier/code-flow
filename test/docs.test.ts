import { before, test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
before(() =>
  execFileSync(process.execPath, ["scripts/build-docs.mjs"], { cwd: root }),
);
test("all documentation pages produce portable links, anchors and no local assistant marker", async () => {
  const directory = resolve(root, "dist/docs");
  const pages = new Map<string, string>();
  for (const file of await readdir(directory))
    if (file.endsWith(".html"))
      pages.set(file, await readFile(resolve(directory, file), "utf8"));
  assert.ok(pages.size >= 54);
  const broken: string[] = [];
  for (const [file, html] of pages) {
    assert.doesNotMatch(html, /data-local-docs/);
    for (const [, href] of html.matchAll(/href="([^"]+)"/g)) {
      if (/^(?:https?:|data:|mailto:|\/)/.test(href!)) continue;
      const [target, anchor] = href!.split("#");
      if (target && !target.endsWith(".html")) continue;
      const destination = pages.get(target || file);
      if (!destination) {
        broken.push(`${file} → ${href}`);
        continue;
      }
      if (anchor && !destination.includes(`id="${anchor}"`))
        broken.push(`${file} → ${href} (anchor)`);
    }
  }
  assert.deepEqual(broken, []);
  assert.match(pages.get("index.html")!, /href="getting-started.html"/);
  const css = await readFile(resolve(directory, "style.css"), "utf8");
  assert.match(css, /--bg: #f8f7f3/);
  assert.match(css, /data:font\/woff;base64/);
});
test("relative Markdown and image references resolve in the repository", async () => {
  const docs = JSON.parse(
    await readFile(resolve(root, "dist/docs/search.json"), "utf8"),
  ) as { source: string; body: string }[];
  docs.push({
    source: "README.md",
    body: await readFile(resolve(root, "README.md"), "utf8"),
  });
  const broken: string[] = [];
  for (const doc of docs)
    for (const match of doc.body.matchAll(
      /(?:\]\(|(?:src|srcset|href)=")([^\s"<>)]*)/g,
    )) {
      const link = match[1]!;
      if (/^(?:[a-z]+:|#|\/)/i.test(link)) continue;
      const path = link.split("#")[0];
      if (!path || !/(?:\.md|\.png|\.txt)$/.test(path)) continue;
      try {
        await readFile(resolve(root, dirname(doc.source), path));
      } catch {
        broken.push(`${doc.source} → ${path}`);
      }
    }
  assert.deepEqual(broken, []);
});
test("concurrent rebuilds keep published pages and search assets complete and readable", async () => {
  const paths = ["public/docs", "dist/docs"].flatMap((directory) =>
    ["index.html", "getting-started.html", "search.json", "style.css", "app.js"].map(
      (name) => resolve(root, directory, name),
    ),
  );
  const expected = await Promise.all(paths.map((path) => readFile(path, "utf8")));
  const failures = new Set<string>();
  let building = true;
  let reads = 0;
  const builds = Promise.allSettled(
    Array.from({ length: 2 }, () =>
      promisify(execFile)(process.execPath, ["scripts/build-docs.mjs"], { cwd: root }),
    ),
  ).finally(() => { building = false; });
  while (building) {
    await Promise.all(paths.map(async (path, index) => {
      try {
        if (await readFile(path, "utf8") !== expected[index])
          failures.add(`Partial or changed content: ${path}`);
      } catch {
        failures.add(`Temporarily unavailable: ${path}`);
      }
      reads++;
    }));
  }
  for (const result of await builds)
    assert.equal(result.status, "fulfilled", JSON.stringify(result));
  assert.ok(reads > 0);
  assert.deepEqual([...failures], []);
});
