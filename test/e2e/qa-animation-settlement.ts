import type { Page } from 'playwright-core';

/** Audit the rendered final state without relying on individual Animation.finished promises. */
export async function settleFiniteAnimations(page: Page, timeoutMs = 5000): Promise<void> {
  try {
    await page.waitForFunction(() => {
      document.documentElement.getBoundingClientRect();
      return !document.getAnimations().some(animation =>
        (animation.playState === 'running' || animation.pending) && animation.effect?.getComputedTiming().endTime !== Infinity);
    }, undefined, { polling: 'raf', timeout: timeoutMs });
  } catch (cause) {
    const state = await page.evaluate(() => {
      const active = document.getAnimations().filter(animation =>
        (animation.playState === 'running' || animation.pending) && animation.effect?.getComputedTiming().endTime !== Infinity);
      return { visibility: document.visibilityState, count: active.length, animations: active.slice(0, 64).map(animation => {
        const target = (animation.effect as KeyframeEffect | null)?.target;
        return { type: animation.constructor.name, id: animation.id, playState: animation.playState, pending: animation.pending,
          currentTime: animation.currentTime, startTime: animation.startTime, playbackRate: animation.playbackRate,
          timing: animation.effect?.getComputedTiming(), target: target ? { tag: target.tagName, id: target.id, class: target.getAttribute('class') } : undefined };
      }) };
    }).catch(error => ({ unavailable: String(error) }));
    throw new Error(`Finite animations did not settle within ${timeoutMs}ms: ${JSON.stringify(state)}`, { cause });
  }
}
