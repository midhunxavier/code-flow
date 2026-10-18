// Bundles ui/main.tsx with esbuild and inlines it, with ui/styles.css, into a single
// self-contained public/index.html (so any version of the server can serve it).
import "./check-node.mjs";
import * as esbuild from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { watch as watchFile } from "node:fs";
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

async function assemble(js) {
  const [template, xtermCss, ownCss] = await Promise.all([readFile("ui/index.html", "utf8"), readFile(XTERM_CSS, "utf8"), readFile("ui/styles.css", "utf8").then(inlineFonts)]);
  const css = `${xtermCss}\n${ownCss}`;
  const html = template
    .replace("/*__CSS__*/", () => css)
    .replace("//__JS__", () => js.replace(/<\/script/gi, "<\\/script"));
  await mkdir("public", { recursive: true }); // not in git: a fresh checkout has no public/
  await writeFile("public/index.html", html);
}

const options = {
  entryPoints: ["ui/main.tsx"],
  bundle: true,
  format: "esm",
  target: "es2022",
  jsx: "automatic",
  jsxImportSource: "preact",
  loader: { ".png": "dataurl" }, // images are inlined like everything else
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
          await assemble(result.outputFiles[0].text);
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
