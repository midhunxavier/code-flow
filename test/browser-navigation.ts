import type { Page } from "playwright-core";

export async function setArchivedHistory(root: Pick<Page, "getByRole">, visible: boolean) {
  await root.getByRole("button", { name: /^Application menu:/ }).click();
  await root.getByRole("menuitem", { name: new RegExp(`^${visible ? "Show" : "Hide"} archived chats`) }).click();
}
