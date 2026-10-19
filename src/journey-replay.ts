import type { Journey, JourneyReplay, JourneyAction } from "./journeys.js";

type PageCommand = (method: string, params?: Record<string, unknown>) => Promise<any>;
/** Runs only our fixed action vocabulary; values are JSON data inside a fixed function. */
function locate(action: JourneyAction | { kind: "expect"; selector: string; value: string }) {
  const elements = document.querySelectorAll(action.selector);
  if (elements.length !== 1) throw new Error(`Expected one element, found ${elements.length}: ${action.selector}`);
  const el = elements[0] as HTMLElement;
  if (!el || !el.getClientRects().length || getComputedStyle(el).visibility === "hidden") throw new Error("Element is not visible");
  if (action.kind === "expect") { if (!el.innerText.includes(action.value)) throw new Error("Expected visible text was not found"); return {}; }
  if ((el as HTMLInputElement).disabled) throw new Error("Element is disabled");
  if (/password|hidden|file/.test((el as HTMLInputElement).type ?? "") || /password|secret|token|cc-number|one-time-code/i.test(`${el.id} ${el.getAttribute("name")} ${el.getAttribute("autocomplete")}`)) throw new Error("Sensitive fields are excluded from replay");
  el.scrollIntoView({ block: "center", inline: "center" });
  el.focus();
  if (action.kind === "fill" || action.kind === "select") {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLInputElement ? HTMLInputElement.prototype : undefined;
    if (!proto) throw new Error("This element is not a supported form control");
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, action.value);
    el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  const rect = el.getBoundingClientRect();
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}
export async function replayJourney(page: PageCommand, journey: Journey): Promise<Pick<JourneyReplay, "status" | "error" | "failedAt" | "frames">> {
  const frames: JourneyReplay["frames"] = [];
  const capture = async (label: string) => { const shot = await page("Page.captureScreenshot", { format: "jpeg", quality: 45 }); if (typeof shot.data === "string" && shot.data.length < 400_000 && frames.reduce((n, f) => n + f.image.length, 0) + shot.data.length < 2_500_000) frames.push({ label, image: `data:image/jpeg;base64,${shot.data}` }); };
  let index = -1;
  try {
    await capture("Before the first interaction");
    const actions = [...journey.actions, { kind: "expect" as const, selector: journey.expected.selector, value: journey.expected.text }];
    for (index = 0; index < actions.length; index++) {
      const action = actions[index]!;
      const end = Date.now() + 4000;
      let result: any;
      while (true) {
        result = await page("Runtime.evaluate", { expression: `(${locate.toString()})(${JSON.stringify(action)})`, returnByValue: true });
        if (!result.exceptionDetails) break;
        if (Date.now() >= end) throw new Error(result.exceptionDetails.exception?.description?.split("\n")[0] ?? "The recorded element could not be used");
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (action.kind === "click") {
        const { x, y } = result.result.value;
        await page("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
        await page("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
      } else if (action.kind === "press") {
        const code = { Enter: 13, Tab: 9, Escape: 27 }[action.value!];
        await page("Input.dispatchKeyEvent", { type: "keyDown", key: action.value, code: action.value, windowsVirtualKeyCode: code, ...(action.value === "Enter" ? { text: "\r" } : {}) });
        await page("Input.dispatchKeyEvent", { type: "keyUp", key: action.value, code: action.value, windowsVirtualKeyCode: code });
      }
      await new Promise(resolve => setTimeout(resolve, 150));
      await capture(action.kind === "expect" ? "Expected result is visible" : `${index + 1}. ${action.kind} ${action.selector}`);
    }
    return { status: "passed", frames };
  } catch (error) {
    await capture("Replay stopped here").catch(() => {});
    return { status: "failed", failedAt: index, error: (error as Error).message.slice(0, 1000), frames };
  }
}
