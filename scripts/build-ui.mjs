// Publish hashed ESM chunks before atomically replacing the HTML entry point.
// Older chunks remain available to tabs opened before a rebuild.
import "./check-node.mjs";
import { buildDocs } from "./build-docs.mjs";
await buildDocs();
import * as esbuild from "esbuild";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { watch as watchFile } from "node:fs";
import { basename } from "node:path";
import { createRequire } from "node:module";

const watching = process.argv.includes("--watch");

// Fonts referenced as url("fonts/<file>.woff") or .woff2 are inlined, so the page needs no network.
const FONT_URL = /url\("fonts\/([\w.-]+\.(woff2?))"\)/g;
async function inlineFonts(css) {
  const files = [...new Set([...css.matchAll(FONT_URL)].map((m) => m[1]))];
  const data = new Map(await Promise.all(files.map(async (f) => [f, (await readFile(`ui/fonts/${f}`)).toString("base64")])));
  return css.replace(FONT_URL, (_, f, type) => `url(data:font/${type};base64,${data.get(f)})`);
}

// The Terminal's xterm brings a stylesheet of its own; ours comes after it, to override it.
const XTERM_CSS = createRequire(import.meta.url).resolve("@xterm/xterm/css/xterm.css");

async function assemble(outputs) {
  const [template, xtermCss, ownCss] = await Promise.all([readFile("ui/index.html", "utf8"), readFile(XTERM_CSS, "utf8"), readFile("ui/styles.css", "utf8").then(inlineFonts)]);
  const css = (await esbuild.transform(`${xtermCss}\n${ownCss}`, { loader: "css", minify: !watching })).code;
  const cssName = `styles-${createHash("sha256").update(css).digest("hex").slice(0, 8).toUpperCase()}.css`;
  await mkdir("public/assets", { recursive: true });
  for (const output of outputs) {
    const path = `public/assets/${basename(output.path)}`;
    const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
    await writeFile(temporary, output.contents); await rename(temporary, path);
  }
  const cssTemporary = `public/assets/${cssName}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(cssTemporary, css); await rename(cssTemporary, `public/assets/${cssName}`);
  const entry = outputs.find((file) => /^main-.*\.js$/.test(basename(file.path)));
  if (!entry) throw new Error("Missing UI entry point");
  const html = template.replace("<style>\n/*__CSS__*/\n</style>", `<link rel="stylesheet" href="/assets/${cssName}" />`)
    .replace('<script type="module">\n//__JS__\n</script>', `<script type="module" src="/assets/${basename(entry.path)}"></script>`);
  // Servers and SSH packaging can read while another build is finishing.
  // Publish the complete page at once, never a truncated or partially written bundle.
  const temporary = `public/index.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temporary, html);
  await rename(temporary, "public/index.html");
  const manifest = `public/assets.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(manifest, JSON.stringify({ htmlHash: createHash("sha256").update(html).digest("hex"), files: [...outputs.map((output) => basename(output.path)), cssName] }));
  await rename(manifest, "public/assets.json");
}

const options = {
  entryPoints: ["ui/main.tsx"],
  bundle: true,
  splitting: true,
  outdir: "public/assets",
  entryNames: "[name]-[hash]",
  chunkNames: "[name]-[hash]",
  metafile: true,
  format: "esm",
  target: "es2022",
  jsx: "automatic",
  jsxImportSource: "preact",
  loader: { ".png": "dataurl", ".svg": "dataurl" }, // images are inlined like everything else
  minify: !watching,
  sourcemap: watching ? "inline" : false,
  write: false,
  logLevel: "warning",
  plugins: [
    {
      name: "assemble-html",
      setup(build) {
        build.onEnd(async (result) => {
          if (result.errors.length) return;
          await assemble(result.outputFiles);
          await writeFile("public/bundle-meta.json", JSON.stringify(result.metafile));
          if (watching) console.log(`[ui] rebuilt ${new Date().toLocaleTimeString()}`);
        });
      },
    },
  ],
};

if (watching) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  // esbuild only watches imported modules; the template and stylesheet are read separately.
  for (const file of ["ui/styles.css", "ui/index.html"]) watchFile(file, () => ctx.rebuild().catch(() => {}));
} else {
  await esbuild.build(options);
}
