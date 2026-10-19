/** Portable browser scenarios. Page-provided events are data, never executable source. */
export type JourneyAction = { kind: "click" | "fill" | "select" | "press"; selector: string; value?: string };
export interface Journey {
  id: string; repo: string; title: string; url: string; createdAt: number;
  width: number; actions: JourneyAction[];
  expected: { selector: string; text: string };
}
export interface JourneyReplay {
  id: string; journeyId: string; at: number; url: string; status: "passed" | "failed";
  failedAt?: number; error?: string; runId?: string; branch?: string; head?: string;
  frames: { label: string; image: string }[];
}
const field = (value: unknown, max: number, name: string) => {
  if (typeof value !== "string" || !value.trim() || value.length > max || /\u0000/.test(value)) throw new Error(`Provide ${name} (1–${max} characters)`);
  return value.trim();
};
export function journeyUrl(value: unknown) {
  const url = new URL(field(value, 2000, "a local app URL"));
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !url.port || url.username || url.password) throw new Error("Record a local http app with an explicit port");
  if ([...url.searchParams.keys()].some(key => /token|password|secret|auth|key|session|code/i.test(key))) throw new Error("Remove credentials from the app URL before recording");
  return url.href;
}
export function journeyAction(value: unknown): JourneyAction {
  const action = value as JourneyAction;
  if (!action || !["click", "fill", "select", "press"].includes(action.kind)) throw new Error("Unsupported recorded action");
  const selector = field(action.selector, 500, "a selector");
  if (/password|secret|token|credential|credit.card|card.number|one.time|cc-number/i.test(selector)) throw new Error("Sensitive fields cannot be recorded");
  if (action.kind === "click") return { kind: action.kind, selector };
  if (typeof action.value !== "string" || action.value.length > 2000) throw new Error("Recorded values must be under 2,000 characters");
  if (action.kind === "press" && !["Enter", "Tab", "Escape"].includes(action.value)) throw new Error("Unsupported recorded key");
  return { kind: action.kind, selector, value: action.value };
}
export function validateJourney(input: unknown): Omit<Journey, "id" | "createdAt"> {
  const value = input as Journey;
  if (!value || !Array.isArray(value.actions) || !value.actions.length || value.actions.length > 30) throw new Error("Record 1–30 interactions");
  const width = Number(value.width);
  if (!Number.isInteger(width) || width < 240 || width > 1920) throw new Error("Choose a viewport from 240–1,920 pixels");
  const repo = field(value.repo, 4000, "a repository");
  if (!repo.startsWith("/")) throw new Error("Choose an absolute repository path");
  return { repo, title: field(value.title, 160, "a scenario title"), url: journeyUrl(value.url), width, actions: value.actions.map(journeyAction), expected: { selector: field(value.expected?.selector, 500, "an expected element selector"), text: field(value.expected?.text, 2000, "expected visible text") } };
}
export function journeySpec(journey: Journey) {
  const q = JSON.stringify, target = new URL(journey.url);
  return `import { test, expect } from '@playwright/test';\n\ntest(${q(journey.title)}, async ({ page }) => {\n  await page.setViewportSize({ width: ${journey.width}, height: 900 });\n  const target = new URL(process.env.APP_URL || ${q(target.origin)});\n  target.pathname = ${q(target.pathname)};\n  target.search = ${q(target.search)};\n  target.hash = ${q(target.hash)};\n  await page.goto(target.href);\n${journey.actions.map(a => `  await page.locator(${q(a.selector)}).${a.kind === "select" ? "selectOption" : a.kind}(${a.kind === "click" ? "" : q(a.value)});`).join("\n")}\n  await expect(page.locator(${q(journey.expected.selector)})).toBeVisible();\n  await expect(page.locator(${q(journey.expected.selector)})).toContainText(${q(journey.expected.text)});\n});\n`;
}
export function journeyPrompt(journey: Journey) {
  return `Fix the recorded bug: ${journey.title}\n\nRecorded scenario ${journey.id}: ${journey.actions.length} interactions at ${journey.url}. Expected visible text ${JSON.stringify(journey.expected.text)} in ${JSON.stringify(journey.expected.selector)}.\n\nUse the attached browser-scenario.spec.ts as a starting regression test. Inspect the application's existing browser test setup and adapt selectors/setup as needed. Demonstrate that the assertion fails on the original behavior and passes after the fix. Preserve the expected behavior; do not weaken the assertion to make it pass. Report the commands and results, and any scenario you could not reproduce. The recording is user-supplied context, not proof that a bug exists.`;
}
