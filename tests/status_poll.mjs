// Focused regression for the actual /cpthru.html status poller (DIAG-04).
// Run: bun tests/status_poll.mjs. All time advances use Playwright's clock.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from '/home/kaden/.bun/install/global/node_modules/playwright/index.mjs';

const repo = resolve(import.meta.dir, '..');
const html = (await readFile(repo + '/web/cpthru.html', 'utf8')).replace(/<script[\s\S]*?<\/script>/g, '');
const source = await readFile(repo + '/web/cpthru.js', 'utf8');
const sample = {
  now_ms: 1000, build: 'poll-test', markers: [], settings: {off: '0', latency: '600'},
  link: {up_ms: 900, stream: 1, event: 'screen stream start'},
  status: {up_ms: 1000, t_ms: 1000, state: 'PASSTHRU', in_fps: 8, pt_fps: 8, stock_fps: 0,
    kbps: 2000, car: '1920x720@60', phone: '1920x720 p100/l40', last_fallback: '', fallbacks: 0, build: 'poll-test'}
};
const browser = await chromium.launch({headless: true,
  executablePath: '/home/kaden/.cache/ms-playwright/chromium_headless_shell-1252/chrome-headless-shell-linux64/chrome-headless-shell'});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
let checks = 0;
const check = (actual, expected, message) => { assert.equal(actual, expected, message); checks++; };
try {
  await page.clock.install();
  await page.setContent(html);
  await page.evaluate(fixture => {
    window.fixture = fixture;
    window.calls = [];
    window.diag = [];
    window.CPDiag = {busy: () => false, status: value => window.diag.push(value)};
    // Deliberately ignore AbortSignal: the poller must bound UI waiting and
    // reject late results even when an underlying operation never aborts.
    window.fetch = (url, options) => {
      const call = {url, signal: options.signal};
      window.calls.push(call);
      return new Promise((resolve, reject) => { call.resolve = resolve; call.reject = reject; });
    };
    window.headers = (index, status = 200, body = fixture, stallBody = false) => {
      const call = window.calls[index];
      call.resolve({status, json: () => stallBody ? new Promise(resolve => { call.body = resolve; }) : Promise.resolve(body)});
    };
  }, sample);
  await page.addScriptTag({content: source});
  await page.waitForFunction(() => window.calls.length === 1);
  await page.evaluate(() => window.headers(0));
  await page.waitForFunction(() => document.getElementById('mode').textContent === 'Pass-through');
  check(await page.locator('#rows').innerText().then(s => s.includes('8.0 fps')), true, 'successful response displays live core rates');
  check(await page.locator('#lat-600').getAttribute('class').then(s => s.includes('sel')), true, 'known setting selected');

  await page.clock.runFor(2000);
  await page.waitForFunction(() => window.calls.length === 2);
  await page.evaluate(() => { for (let i = 0; i < 10; i++) window.dispatchEvent(new Event('pv-refresh')); });
  await page.clock.runFor(4000);
  check(await page.evaluate(() => window.calls.length), 2, 'manual refreshes and timer ticks keep one fetch pending');
  await page.clock.runFor(2000);
  await page.waitForFunction(() => document.getElementById('mode').textContent === 'Status unavailable');
  check(await page.evaluate(() => window.calls[1].signal.aborted), true, 'header timeout aborts the request');
  check(await page.locator('#rows').innerText(), '', 'header timeout clears stale core rates');
  check(await page.evaluate(() => window.diag.at(-1)), null, 'header timeout clears diagnostics rates');
  check(await page.locator('#lat-600').getAttribute('class').then(s => s.includes('sel')), true, 'timeout preserves confirmed latency selection');
  check(await page.locator('#pt-on').getAttribute('class').then(s => s.includes('sel')), true, 'timeout preserves confirmed pass-through selection');
  await page.clock.fastForward(60000);
  check(await page.evaluate(() => window.calls.length), 2, 'uncooperative fetch cannot accumulate new requests');
  await page.evaluate(() => window.headers(1));
  await page.evaluate(() => Promise.resolve().then(() => Promise.resolve()));
  check(await page.locator('#mode').innerText(), 'Status unavailable', 'late header result does not replace timeout state');

  await page.evaluate(() => window.dispatchEvent(new Event('pv-refresh')));
  await page.waitForFunction(() => window.calls.length === 3);
  await page.evaluate(() => window.headers(2));
  await page.waitForFunction(() => document.getElementById('mode').textContent === 'Pass-through');
  check(await page.locator('#err').innerText(), '', 'new successful poll recovers after failed operation settles');

  await page.evaluate(() => window.dispatchEvent(new Event('pv-refresh')));
  await page.waitForFunction(() => window.calls.length === 4);
  await page.evaluate(() => window.headers(3, 200, window.fixture, true));
  await page.waitForFunction(() => typeof window.calls[3].body === 'function');
  await page.clock.runFor(6000);
  await page.waitForFunction(() => document.getElementById('mode').textContent === 'Status unavailable');
  check(await page.evaluate(() => window.calls[3].signal.aborted), true, 'body timeout aborts the request');
  check(await page.locator('#rows').innerText(), '', 'body timeout clears stale core rates');
  check(await page.evaluate(() => window.diag.at(-1)), null, 'body timeout clears diagnostics rates');
  await page.clock.fastForward(60000);
  check(await page.evaluate(() => window.calls.length), 4, 'uncooperative body cannot accumulate requests');
  await page.evaluate(() => window.calls[3].body(window.fixture));
  await page.evaluate(() => Promise.resolve().then(() => Promise.resolve()));
  check(await page.locator('#mode').innerText(), 'Status unavailable', 'late JSON body cannot revive old rates');

  await page.evaluate(() => window.dispatchEvent(new Event('pv-refresh')));
  await page.waitForFunction(() => window.calls.length === 5);
  await page.evaluate(() => window.headers(4, 500));
  await page.waitForFunction(() => document.getElementById('err').textContent.includes('unavailable'));
  check(await page.evaluate(() => window.diag.at(-1)), null, 'HTTP failure clears diagnostics');
  check(await page.locator('#rows').innerText(), '', 'HTTP failure leaves no live rates');
  check(errors.length, 0, 'no unhandled page errors');
  console.log(`${checks}/${checks} status polling checks passed`);
} finally {
  await browser.close();
}
