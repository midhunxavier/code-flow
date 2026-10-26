import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { settleFiniteAnimations } from './qa-animation-settlement.js';

test('animation readiness polls live frames, ignores only infinite effects and diagnoses a stalled finite effect', { timeout: 20000 }, async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<button id="target">Audit target</button>');
    await page.evaluate(() => {
      const target = document.querySelector('#target')!;
      const animation = target.animate([{ opacity: 0.2 }, { opacity: 1 }], { duration: 120, fill: 'forwards' });
      (window as any).finishedReads = 0;
      Object.defineProperty(animation, 'finished', { get() { (window as any).finishedReads++; return new Promise(() => {}); } });
      (window as any).finite = animation;
      (window as any).spinner = target.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: 1000, iterations: Infinity });
    });
    await settleFiniteAnimations(page, 2000);
    assert.deepEqual(await page.evaluate(() => ({ state: (window as any).finite.playState, reads: (window as any).finishedReads, spinner: (window as any).spinner.playState })), { state: 'finished', reads: 0, spinner: 'running' });
    await page.evaluate(() => {
      const animation = document.querySelector('#target')!.animate([{ opacity: 0.2 }, { opacity: 1 }], { duration: 1000 });
      animation.id = 'qa-stalled-finite'; animation.playbackRate = 0; (window as any).stalled = animation;
    });
    await assert.rejects(settleFiniteAnimations(page, 250), error => {
      assert.match(String(error), /did not settle within 250ms/);
      assert.match(String(error), /qa-stalled-finite/); assert.match(String(error), /"playbackRate":0/); assert.match(String(error), /"pending":/);
      return true;
    });
    await page.evaluate(() => { (window as any).stalled.cancel(); (window as any).spinner.cancel(); });
    await settleFiniteAnimations(page, 1000);
  } finally { await browser.close(); }
});
