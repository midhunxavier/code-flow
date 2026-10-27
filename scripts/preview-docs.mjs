import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildDocs } from "./build-docs.mjs";
const requested = process.env.DOCS_PORT ?? "4319", port = Number(requested);
if (!/^\d+$/.test(requested) || !Number.isInteger(port) || port < 0 || port > 65535) { console.error("DOCS_PORT must be an integer from 0 to 65535 (0 chooses a free port)."); process.exit(2); }
await buildDocs();
const root = fileURLToPath(new URL("../dist/docs/", import.meta.url));
const server = createServer(async (req, res) => {
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
});
server.on("error", error => {
  console.error(error.code === "EADDRINUSE" ? `Documentation port ${port} is in use; set DOCS_PORT=<port> or DOCS_PORT=0 for a free port.` : `Documentation preview could not start (${error.code || "listen failed"}).`);
  process.exitCode = 1;
});
server.listen(port, "127.0.0.1", () => console.log(`Documentation preview: http://127.0.0.1:${server.address().port}`));
