import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildDocs } from "./build-docs.mjs";
await buildDocs();
const root = fileURLToPath(new URL("../dist/docs/", import.meta.url));
createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  if (!/^\/(?:[a-z\d-]+\.(?:html|css|js|json|txt))?$/.test(path)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  try {
    const data = await readFile(
      root + (path === "/" ? "index.html" : path.slice(1)),
    );
    const ext = path.split(".").pop();
    res.writeHead(200, {
      "content-type":
        {
          css: "text/css",
          js: "text/javascript",
          json: "application/json",
          txt: "text/plain; charset=utf-8",
        }[ext] || "text/html; charset=utf-8",
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}).listen(4319, "127.0.0.1", () =>
  console.log("Documentation preview: http://127.0.0.1:4319"),
);
