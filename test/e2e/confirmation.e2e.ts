import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";

test("app confirmations support keyboard cancellation, focus, navigation and nested dialogs", async () => {
  const built = await build({
    stdin: {
      contents: `
        import { render } from "preact";
        import { signal } from "@preact/signals";
        import { ConfirmationHost } from "./confirm-dialog.js";
        import { confirmAction } from "./confirm-state.js";
        const accepted = signal(0);
        async function ask() {
          if (await confirmAction("Existing links will stop working.", { title: "Replace access link?", confirmLabel: "Replace link", danger: true })) accepted.value++;
        }
        function Fixture() { return <main>
          <button onClick={ask}>New link</button>
          <button onClick={() => document.querySelector("#outer").showModal()}>Open settings</button>
          <output aria-label="Accepted actions">{accepted.value}</output>
          <dialog id="outer" aria-label="Settings"><button onClick={ask}>Nested action</button></dialog>
          <ConfirmationHost />
        </main>; }
        render(<Fixture />, document.body);
      `,
      resolveDir: fileURLToPath(new URL("../../ui", import.meta.url)), loader: "tsx",
    },
    bundle: true, write: false, format: "iife", jsx: "automatic", jsxImportSource: "preact",
  });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const native: string[] = [], errors: string[] = [];
    page.on("dialog", dialog => { native.push(dialog.type()); void dialog.dismiss(); });
    page.on("pageerror", error => errors.push(error.message));
    await page.route("http://confirmation.test/**", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><html><body></body></html>" }));
    await page.goto("http://confirmation.test/");
    await page.addStyleTag({ content: await readFile(new URL("../../ui/styles.css", import.meta.url), "utf8") });
    await page.addScriptTag({ content: built.outputFiles[0]!.text });
    const modal = page.getByRole("dialog", { name: "Replace access link?", exact: true });
    const trigger = page.getByRole("button", { name: "New link", exact: true });
    await trigger.click();
    await modal.waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Cancel");
    await page.keyboard.press("Enter");
    await modal.waitFor({ state: "detached" });
    assert.equal(await page.getByLabel("Accepted actions").innerText(), "0");
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), "New link");
    await trigger.click();
    await page.keyboard.press("Escape");
    await modal.waitFor({ state: "detached" });
    await trigger.click();
    await modal.getByRole("button", { name: "Replace link", exact: true }).click();
    await modal.waitFor({ state: "detached" });
    assert.equal(await page.getByLabel("Accepted actions").innerText(), "1");
    await trigger.click();
    await page.goto("http://confirmation.test/#/another-page");
    await modal.waitFor({ state: "detached" });
    assert.equal(await page.getByLabel("Accepted actions").innerText(), "1");
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.getByRole("button", { name: "Nested action" }).click();
    await page.keyboard.press("Escape");
    await modal.waitFor({ state: "detached" });
    assert.equal(await page.getByRole("dialog", { name: "Settings", exact: true }).isVisible(), true);
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Nested action");
    await page.getByRole("button", { name: "Nested action" }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await modal.evaluate(element => element.scrollWidth <= element.clientWidth && element.getBoundingClientRect().right <= innerWidth), true);
    assert.deepEqual(native, []);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
