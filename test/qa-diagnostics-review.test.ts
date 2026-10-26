// Independent cluster31 review: synthetic credentials only; keep app imports inside a scratch home.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "qa-diagnostics-review-"));
const home = join(root, "home");
await mkdir(home);
process.env.CODEFLOW_HOME = home;
const { redactText } = await import("../src/privacy.js");
const { newMaintenanceOutput } = await import("../src/maintenance.js");
after(() => rm(root, { recursive: true, force: true }));

const noMarkers = (text: string, input: string) => {
  assert.doesNotMatch(text, /MARKERONE|MARKERTWO|MARKERTHREE/, input);
  assert.equal(redactText(text, []), text, `redaction is idempotent: ${input}`);
};

test("quoted credential strings preserve neighbors through six JSON escape depths", () => {
  for (const key of ["api_key", "password", "Authorization", "GITHUB_TOKEN", "aws_secret_access_key", "x-api-key", "client-secret"]) {
    for (const value of ["MARKERONE trailingMARKERTWO", 'MARKERONE " innerMARKERTWO " tailMARKERTHREE', "MARKERONE ' quotedMARKERTWO ' tailMARKERTHREE", "MARKERONE\\slashMARKERTWO\\", 'MARKERONE\\"slashquoteMARKERTWO\\"endMARKERTHREE', "MARKERONE\nlineMARKERTWO\ttailMARKERTHREE", "MARKERONE🥪MARKERTWO"]) {
      let text = JSON.stringify({ [key]: value, kept: "KEEPTHIS", inputTokens: 23 });
      for (let depth = 0; depth < 6; depth++) {
        const result = redactText(text, []);
        noMarkers(result, `${key}, depth ${depth}, ${value}`);
        assert.ok(result.includes("KEEPTHIS"), `${key}, depth ${depth} preserves adjacent data`);
        assert.ok(result.includes("inputTokens"));
        text = JSON.stringify({ error: text });
      }
    }
  }
});

test("Digest and quoted Cookie header values cannot terminate credential redaction", () => {
  for (const header of ['Authorization: Digest username="MARKERONE", realm="MARKERTWO", nonce="MARKERTHREE"', 'Cookie: session="MARKERONE"; csrf="MARKERTWO"', 'Set-Cookie: session="MARKERONE"; Path=/; HttpOnly']) {
    let text = header;
    for (let depth = 0; depth < 4; depth++) {
      noMarkers(redactText(text, []), text);
      text = JSON.stringify({ error: text });
    }
  }
});

test("unquoted credential backslashes and nested JSON values do not leak suffixes", () => {
  for (const input of ["password=MARKERONE\\MARKERTWO", JSON.stringify({ password: { raw: "MARKERONE" }, kept: "KEEPTHIS" }), JSON.stringify({ password: ["MARKERONE", "MARKERTWO"], kept: "KEEPTHIS" }), JSON.stringify({ Authorization: { nested: ["MARKERONE", { key: 'MARKERTWO\\"MARKERTHREE' }] }, kept: "KEEPTHIS" })]) {
    let text = input;
    for (let depth = 0; depth < 4; depth++) {
      const result = redactText(text, []);
      noMarkers(result, text);
      if (text.includes("KEEPTHIS")) assert.ok(result.includes("KEEPTHIS"), "structured assignments preserve adjacent data");
      text = JSON.stringify({ error: text });
    }
  }
});

test("a regular file used as the backup parent gets a friendly output-folder error", async () => {
  const file = join(root, "parent-file");
  await writeFile(file, "not a folder");
  await assert.rejects(newMaintenanceOutput(join(file, "backup"), "Backup"), error => {
    assert.match(String(error), /folder.*(?:does not exist|directory)|not a directory/i);
    assert.doesNotMatch(String(error), /ENOTDIR|lstat|realpath/);
    return true;
  });
});
