import { test } from "node:test";
import assert from "node:assert/strict";
import { browserCommand, parseOptions } from "../../bin/launcher.mjs";

test("launcher validates flags and ports before starting a server", () => {
  assert.deepEqual(parseOptions([], {}), { open: true, port: "4317" });
  assert.deepEqual(parseOptions(["start", "--no-open", "--port", "5300"], {}), { open: false, port: "5300" });
  assert.equal(parseOptions([], { PORT: "5400" }).port, "5400");
  for (const value of ["0", "65535", "22.5", "bad", "", "-1", "1e3"]) assert.throws(() => parseOptions(["--port", value], {}), /integer port/);
  assert.throws(() => parseOptions(["--port"], {}), /integer port/);
  assert.throws(() => parseOptions(["--host", "0.0.0.0"], {}), /Unknown option/);
});

test("browser opening passes the local URL as data on macOS, Linux and WSL", () => {
  const url = "http://localhost:4317/?token=abc123";
  assert.deepEqual(browserCommand(url, "darwin", false), ["open", [url]]);
  assert.deepEqual(browserCommand(url, "linux", false), ["xdg-open", [url]]);
  const [program, args] = browserCommand(url, "linux", true);
  assert.equal(program, "powershell.exe");
  assert.equal(Buffer.from(args.at(-1), "base64").toString("utf16le"), `Start-Process -FilePath '${url}'`);
  for (const bad of ["https://example.com/", "file:///tmp/app", "http://user@localhost:4317/", "http://localhost.evil:4317/"]) assert.throws(() => browserCommand(bad), /local Code Flow/);
});
