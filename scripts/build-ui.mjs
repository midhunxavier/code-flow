// Bundles ui/main.tsx with esbuild and inlines it, with ui/styles.css, into a single
// self-contained public/index.html (so any version of the server can serve it).
import * as esbuild from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { watch as watchFile } from "node:fs";

const watching = process.argv.includes("--watch");

async function assemble(js) {
  const [template, css] = await Promise.all([readFile("ui/index.html", "utf8"), readFile("ui/styles.css", "utf8")]);
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
