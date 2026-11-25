// Run after sync:public with node tests/modal-scroll.browser.mjs and an external
// Playwright installation (PLAYWRIGHT_MODULE may point to its index.mjs).
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch();
const demo = 'http://demo.test';
const history = Array.from({length: 120}, (_, i) => 'Terminal output ' + i).join('\n');
const approval = command => history + '\nRequesting permission for:\n  ' + command
  + '\nRun this command?\n› 1. Yes, run command\n  2. No, cancel\n↑/↓ Navigate';
const short = approval('git status');
const long = approval('git diff ' + 'folder/file-name '.repeat(10));
try {
  for (const viewport of [{width: 1440, height: 900}, {width: 390, height: 844}]) {
    const page = await browser.newPage({viewport, serviceWorkers: 'block'});
    let capture = history;
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== demo) return route.abort();
      if (url.pathname === '/api/capture' && capture !== null) return route.fulfill({json: {screen: capture}});
      if (url.pathname.startsWith('/api/')) return route.fulfill({status: 503, body: ''});
      const path = url.pathname === '/demo' ? '/demo/index.html' : url.pathname;
      return route.fulfill({path: fileURLToPath(new URL('../public' + path, import.meta.url))});
    });
    await page.goto(demo + '/demo');
    await page.waitForFunction(() => document.querySelector('[data-agent-id]'));
    const seat = 'dev-check@core-platform';
    await page.evaluate(async seat => {
      openTerminalModal(seat);
      await fetchModalCapture();
    }, seat);
    const input = page.locator('#modalCmdInput');
    await input.fill('draft');
    const body = page.locator('#terminalModalBody');
    const gap = () => body.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop);
    for (const source of ['incoming', 'poll', 'fallback']) {
      const update = async screen => {
        capture = source === 'fallback' ? null : screen;
        await page.evaluate(async ({seat, source, screen}) => {
          if (source === 'incoming') return applyIncomingTmuxScreen(seat, screen);
          DEMO_SCREEN_OVERRIDES[seat] = screen;
          await fetchModalCapture();
        }, {seat, source, screen});
      };
      await update(history);
      await body.evaluate(el => { el.scrollTop = el.scrollHeight; });
      await update(history + '\nfollowing');
      assert.ok(await gap() <= 4, 'ordinary output follows at bottom');
      await body.evaluate(el => { el.scrollTop = 24; });
      await update(history + '\nreading');
      assert.equal(await body.evaluate(el => el.scrollTop), 24);
      await update(short);
      const shortGap = await gap();
      const shortHeight = await body.evaluate(el => el.clientHeight);
      await update(long);
      const longGap = await gap();
      assert.ok(await body.evaluate(el => el.clientHeight) < shortHeight, 'wrapped preview shrinks viewport');
      await body.evaluate(el => { el.scrollTop = 0; });
      await update(long);
      const repeatedGap = await gap();
      console.log(viewport.width, source, {shortGap, longGap, repeatedGap});
      if ([shortGap, longGap, repeatedGap].some(value => value > 4)) process.exitCode = 1;
      assert.equal(await input.inputValue(), 'draft');
      assert.ok(await input.evaluate(el => el === document.activeElement));
    }
    await page.close();
  }
} finally {
  await browser.close();
}
