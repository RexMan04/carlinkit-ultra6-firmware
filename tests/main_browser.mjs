// Browser integration tests for the 0.2 main page and the first-install
// bookmark (MAINPAGE_PLAN.md Verification), WebKit + Chromium, phone viewport,
// against tests/mock_adapter.mjs used as a never-forwarding proxy so the page
// origin is http://192.168.50.100.
//   bun tests/main_browser.mjs [--only NAME] [--browser webkit|chromium] [--out DIR]
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {chromium, webkit} from '/home/kaden/.bun/install/global/node_modules/playwright/index.mjs';
import {createAdapter, BASE} from './mock_adapter.mjs';

const arg = (n, d) => process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d;
const only = arg('--only', null), which = arg('--browser', 'both');
const out = arg('--out', BASE + '/review/mainpage-v020/browser');
await mkdir(out, {recursive: true});
const WEBKIT = '/home/kaden/.cache/ms-playwright/webkit-2359/pw_run.sh';
const CHROMIUM = '/home/kaden/.cache/ms-playwright/chromium_headless_shell-1252/chrome-headless-shell-linux64/chrome-headless-shell';
const REL = BASE + '/release/0.2.0-test.1/carlinkit-ultra6-0.2.0-test.1.swu';
const STOCK = BASE + '/v5_202610121756.swu';
const relBytes = await readFile(REL), relMeta = JSON.parse(await readFile(REL.replace(/\.swu$/, '.json'), 'utf8'));
const md5 = b => createHash('md5').update(b).digest('hex');
const sha = b => createHash('sha256').update(b).digest('hex');
const results = [];

async function open(browser, aopts = {}, viewport = {width: 390, height: 844}) {
  const A = await createAdapter({releaseImageMd5: relMeta.md5, restartMs: 2500, ...aopts});
  const ctx = await browser.newContext({viewport, proxy: {server: 'http://127.0.0.1:' + A.port}, acceptDownloads: true});
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_|net::|NetworkError|Load failed|status of 404/.test(m.text())) errors.push('console: ' + m.text()); });
  page.on('dialog', d => { errors.push('dialog: ' + d.message()); d.dismiss().catch(() => {}); });
  await page.goto('http://192.168.50.100/');
  return {A, ctx, page, errors, close: async () => { await ctx.close(); A.close(); }};
}
const msgOf = page => page.locator('#fw-panel .fw-msg').textContent();
async function waitMsg(page, re, ms = 240000) {
  await page.waitForFunction(r => new RegExp(r).test(document.querySelector('#fw-panel .fw-msg').textContent), re.source, {timeout: ms, polling: 250});
  return msgOf(page);
}
const chip = (page, key, text) => page.locator(`[id="st-${key}"] .chip`, {hasText: text});
async function noOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}

const scenarios = {
  async load(b, name) {
    for (const vp of [{width: 390, height: 844}, {width: 320, height: 640}]) {
      const t = await open(b, {}, vp);
      const {page} = t;
      await page.waitForFunction(() => document.getElementById('s-out').textContent === '8.0', null, {timeout: 15000});
      await page.waitForFunction(() => /0\.2\.0-test\.1/.test(document.getElementById('ident').textContent), null, {timeout: 15000});
      assert.equal(await page.locator('#mode').textContent(), 'Pass-through active');
      assert.equal(await page.locator('#s-kbps').textContent(), '2860');
      assert.match(await page.locator('#rows').textContent(), /1920x720@60/);
      assert.equal(await chip(page, 'persist.sys.wifi.channel', '149').getAttribute('class'), 'chip sel');
      assert.equal(await chip(page, 'persist.suding.wl.audio.latency', '600 ms').getAttribute('class'), 'chip sel');
      assert.match(await page.locator('#dev').textContent(), /TEST-SERIAL-0001/);
      assert.match(await page.locator('#cpd-panel').textContent(), /Prepare debug ZIP/);
      assert(await noOverflow(page), 'horizontal overflow at ' + vp.width);
      await page.screenshot({path: `${out}/${b.name}-${name}-${vp.width}.png`, fullPage: true});
      assert.deepEqual(t.errors, []);
      assert.deepEqual(t.A.S.unexpected, []);
      assert.equal(t.A.S.sets.length, 0, 'loading the page saved nothing');
      await t.close();
    }
  },
  async settings(b) {
    const t = await open(b), {page, A} = t;
    await chip(page, 'persist.sys.wifi.channel', '149').waitFor();
    await page.waitForFunction(() => document.querySelector('[id="st-persist.sys.wifi.channel"] .saved').textContent === 'Saved');
    await chip(page, 'persist.sys.wifi.channel', '44').click();
    assert.equal(A.S.sets.length, 0, 'one tap only arms');
    await chip(page, 'persist.sys.wifi.channel', 'Tap again').click();
    await page.waitForFunction(() => /Saved Hotspot channel/i.test(document.getElementById('msg').textContent) || /saved Hotspot/.test(document.getElementById('msg').textContent));
    assert.deepEqual(A.S.sets, [['persist.sys.wifi.channel', '44']]);
    assert.match(await page.locator('#msg').textContent(), /after the adapter restarts/);
    await page.waitForFunction(() => document.querySelector('[id="st-persist.sys.wifi.channel"] .chip.sel').textContent === '44');
    // recovery: stock video processing
    await page.locator('#rc-stock').click(); await page.locator('#rc-stock').click();
    await page.waitForFunction(() => /Stock video processing: saved/.test(document.getElementById('msg').textContent));
    assert.equal(A.S.props['persist.cpthru.off'], '1');
    await page.locator('#rc-reset').click(); await page.locator('#rc-reset').click();
    await page.waitForFunction(() => /Reset project settings: saved/.test(document.getElementById('msg').textContent));
    assert.equal(A.S.props['persist.cpthru.off'], '0'); assert.equal(A.S.props['persist.suding.wl.audio.latency'], '0');
    await page.locator('#rc-factory').click(); assert.equal(A.S.factory, 0);
    await page.locator('#rc-factory').click();
    await page.waitForFunction(() => /Factory reset sent/.test(document.getElementById('msg').textContent));
    assert.equal(A.S.factory, 1);
    assert.deepEqual(t.errors, []); await t.close();
  },
  async presets(b) {
    const t = await open(b), {page, A} = t;
    await page.waitForFunction(() => document.querySelector('[id="st-persist.sys.wifi.channel"] .saved').textContent === 'Saved');
    await page.fill('#preset-name', 'Kia daily');
    await page.click('#preset-save');
    await page.waitForFunction(() => /Saved preset "Kia daily"/.test(document.getElementById('msg').textContent));
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#cfg-export')]);
    const file = await dl.path();
    const exported = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(exported.format, 'carlinkit-ultra6-settings');
    assert.equal(exported.presets[0].name, 'Kia daily');
    assert.equal(exported.current['persist.sys.wifi.channel'], '149');
    assert.equal(exported.current['persist.sys.headunit.gps.disable'], '0', 'unset GPS exported as its default (on)');
    assert(!('persist.sys.carplay.audio.media.samplerate' in exported.current), 'unset with no known default is left out');
    assert.match(await page.locator('#msg').textContent(), /Not included \(no value to restore\): Audio stream mode/);
    // change a setting, then import the file and apply its "current" preset
    await chip(page, 'persist.sys.wifi.channel', '36').click(); await chip(page, 'persist.sys.wifi.channel', 'Tap again').click();
    await page.waitForFunction(() => document.querySelector('[id="st-persist.sys.wifi.channel"] .chip.sel').textContent === '36');
    const tampered = JSON.parse(JSON.stringify(exported));
    tampered.current['persist.sys.cp.showui'] = '1'; tampered.current['persist.sys.boot.delay'] = '7';
    await page.setInputFiles('#cfg-import', {name: 'settings.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(tampered))});
    await page.waitForFunction(() => /Imported 2 preset/.test(document.getElementById('msg').textContent));
    const m = await page.locator('#msg').textContent();
    assert.match(m, /Skipped: .*persist\.sys\.cp\.showui/); assert.match(m, /Skipped: .*persist\.sys\.boot\.delay="7"/);
    assert.match(m, /Nothing was changed on the adapter/);
    const sets = A.S.sets.length;
    const apply = page.locator('.preset', {hasText: 'Imported'}).locator('button', {hasText: 'Apply'});
    await apply.click();
    assert.equal(A.S.sets.length, sets, 'first tap only shows the diff');
    assert.match(await page.locator('.preset-diff').textContent(), /Will change: Hotspot channel: 36 \u2192 149\./);
    await page.locator('.preset', {hasText: 'Imported'}).locator('button', {hasText: 'Tap again'}).click();
    await page.waitForFunction(() => /Preset "Imported/.test(document.getElementById('msg').textContent));
    assert.deepEqual(A.S.sets.slice(sets), [['persist.sys.wifi.channel', '149']], 'only the differing, valid setting is written');
    // presets survive a reload (localStorage)
    await page.reload();
    await page.locator('.preset', {hasText: 'Kia daily (2)'}).waitFor();
    assert.equal(await page.locator('.preset').count(), 3);
    assert.deepEqual(t.errors, []); await t.close();
  },
  async upload_install(b, name) {
    const t = await open(b), {page, A} = t;
    await page.locator('#fw-panel .fw-file').setInputFiles(REL);
    await waitMsg(page, /Valid image/);
    const info = await page.locator('#fw-panel .fw-info').textContent();
    assert.match(info, new RegExp(relMeta.manifest.release_id)); assert.match(info, /cpthru\.swu/); assert.match(info, new RegExp(relMeta.sha256));
    assert.equal(await page.locator('#fw-panel .fw-inst').isVisible(), false);
    await page.screenshot({path: `${out}/${b.name}-${name}-validated.png`, fullPage: true});
    // settings and debug ZIP are refused while uploading
    let release;
    A.S.hooks.chunk = (i) => i === 40 ? new Promise(r => { release = r; }).then(() => null) : null;
    await page.locator('#fw-panel .fw-up').click();
    await page.waitForFunction(() => /Uploading 41\//.test(document.querySelector('#fw-panel .fw-msg').textContent));
    await chip(page, 'persist.sys.wifi.channel', '44').click();
    assert.match(await page.locator('#msg').textContent(), /Not saved: a firmware upload/);
    await page.locator('.cpd-prepare').click();
    assert.match(await page.locator('.cpd-state').textContent(), /Not started: a firmware upload/);
    assert.equal(A.S.minizip, 0);
    release();
    await waitMsg(page, /Uploaded and verified/);
    assert.equal(sha(A.S.staged.get('cpthru.swu')), relMeta.sha256, 'staged bytes are the genuine image');
    assert.equal(A.S.launches.length, 0, 'upload never installs');
    assert.match(await msgOf(page), /NOT installed yet/);
    await page.screenshot({path: `${out}/${b.name}-${name}-uploaded.png`, fullPage: true});
    const inst = page.locator('#fw-panel .fw-inst');
    await inst.click();
    assert.equal(A.S.launches.length, 0, 'one tap only arms install');
    assert.match(await inst.textContent(), /Tap again to install/);
    await inst.click();
    await waitMsg(page, /Installing|restarting|has not restarted/);
    await inst.click({force: true}).catch(() => {});
    await waitMsg(page, /Done: the adapter is back and runs what you installed/, 60000);
    assert.equal(A.S.launches.length, 1, 'exactly one install request');
    assert.match(await msgOf(page), new RegExp(relMeta.manifest.release_id));
    await page.screenshot({path: `${out}/${b.name}-${name}-installed.png`, fullPage: true});
    assert.deepEqual(t.errors, []); assert.deepEqual(A.S.unexpected, []); await t.close();
  },
  async interrupted(b) {
    const t = await open(b), {page, A} = t;
    await page.locator('#fw-panel .fw-file').setInputFiles(REL);
    await waitMsg(page, /Valid image/);
    // Wi-Fi drop: every request from chunk 60 on fails (browsers may resend a
    // POST once on a reused connection; that is not the page retrying).
    let outage = true;
    A.S.hooks.chunk = (i) => outage && i >= 60 ? 'drop' : null;
    await page.evaluate(() => {
      const f = window.fetch; window.__up = 0;
      window.fetch = function (u) { if (String(u).includes('downfile')) window.__up++; return f.apply(this, arguments); };
    });
    await page.locator('#fw-panel .fw-up').click();
    await waitMsg(page, /Upload stopped/);
    assert.equal(await page.locator('#fw-panel .fw-inst').isVisible(), false, 'no install after a failed upload');
    const n = A.S.chunks.length;
    await page.waitForTimeout(2000);
    assert.equal(A.S.chunks.length, n, 'the page sends nothing after a failure');
    assert.equal(await page.evaluate(() => window.__up), 61, 'the page itself sent each chunk once and stopped at the failed one');
    outage = false;
    assert.equal(await page.locator('#fw-panel .fw-up').textContent(), 'Upload again');
    A.S.hooks.chunk = null; A.S.chunks = [];
    await page.locator('#fw-panel .fw-up').click();
    await waitMsg(page, /Uploaded and verified/);
    assert.match(A.S.chunks[0], /cpthru\.swu\.0$/, 'restart begins with the clearing first chunk');
    assert.equal(sha(A.S.staged.get('cpthru.swu')), relMeta.sha256);
    // reload: reselect the same file, verify against the adapter's copy without re-uploading
    await page.reload();
    const before = A.S.chunks.length;
    await page.locator('#fw-panel .fw-file').setInputFiles(REL);
    await waitMsg(page, /Valid image/);
    await page.locator('#fw-panel .fw-reuse').click();
    await waitMsg(page, /staged copy matches this file/);
    assert.equal(A.S.chunks.length, before, 'no re-upload');
    // install refused when the staged copy changed underneath
    A.S.staged.get('cpthru.swu')[100] ^= 1;
    await page.locator('#fw-panel .fw-inst').click(); await page.locator('#fw-panel .fw-inst').click();
    await waitMsg(page, /Install refused before anything started: staged copy does not match/);
    assert.equal(A.S.launches.length, 0); assert.equal(A.S.marker, null);
    assert.deepEqual(t.errors, []); await t.close();
  },
  async rejects(b) {
    const t = await open(b), {page, A} = t;
    await page.locator('#fw-panel .fw-file').setInputFiles({name: 'random.swu', mimeType: 'application/octet-stream', buffer: Buffer.alloc(200000, 7)});
    await waitMsg(page, /Not accepted/);
    assert(await page.locator('#fw-panel .fw-up').isDisabled());
    const bad = Buffer.from(relBytes); bad[5000000] ^= 1;
    await page.locator('#fw-panel .fw-file').setInputFiles({name: 'flip.swu', mimeType: 'application/octet-stream', buffer: bad});
    await waitMsg(page, /Not accepted: The recovery part is damaged \(archive checksum\)/, 60000);
    await page.locator('#fw-panel .fw-file').setInputFiles(STOCK);
    const m = await waitMsg(page, /Valid stock firmware/);
    assert.match(m, /not been tested/);
    assert.match(await page.locator('#fw-panel .fw-info').textContent(), /v5_202610121756_STOCK_rollback\.swu/);
    assert.equal(A.S.chunks.length, 0);
    // debug ZIP first: the updater refuses while it is being prepared
    let release; A.S.holdMinizip = new Promise(r => { release = r; });
    await page.locator('.cpd-prepare').click();
    await page.waitForFunction(() => /4\/5/.test(document.querySelector('.cpd-state').textContent), null, {timeout: 30000});
    await page.locator('#fw-panel .fw-up').click();
    assert.match(await msgOf(page), /Not started: wait until the debug ZIP is ready/);
    release(); A.S.holdMinizip = null;
    await page.waitForFunction(() => /Ready/.test(document.querySelector('.cpd-state').textContent), null, {timeout: 60000});
    assert.equal(A.S.chunks.length, 0);
    assert.deepEqual(t.errors, []); await t.close();
  },
  async gateway_down(b) {
    const t = await open(b), {page, A} = t;
    await page.locator('#fw-panel .fw-file').setInputFiles(REL);
    await waitMsg(page, /Valid image/);
    await page.locator('#fw-panel .fw-up').click();
    await waitMsg(page, /Uploaded and verified/);
    A.S.hooks.state = () => 'drop';
    await page.locator('#fw-panel .fw-inst').click(); await page.locator('#fw-panel .fw-inst').click();
    await waitMsg(page, /Not installed: the adapter's updater did not answer/, 30000);
    assert.equal(A.S.launches.length, 0); assert.equal(A.S.submition || 0, 0, 'no fallback to the stock install URL');
    A.S.hooks.state = null;
    await page.locator('#fw-panel .fw-inst').click(); await page.locator('#fw-panel .fw-inst').click();
    await waitMsg(page, /Done: the adapter is back and runs what you installed/, 60000);
    assert.equal(A.S.launches.length, 1);
    assert.deepEqual(t.errors, []); await t.close();
  },
  async rollback_unknown(b) {
    const t = await open(b), {page, A} = t;
    await page.locator('#fw-panel .fw-file').setInputFiles(STOCK);
    await waitMsg(page, /Valid stock firmware/);
    await page.locator('#fw-panel .fw-up').click();
    await waitMsg(page, /Uploaded and verified/);
    A.S.hooks.release = () => 500;  // release file request fails after the restart
    await page.locator('#fw-panel .fw-inst').click(); await page.locator('#fw-panel .fw-inst').click();
    await waitMsg(page, /could not be identified yet/, 60000);
    await page.waitForTimeout(7000);
    assert.doesNotMatch(await msgOf(page), /Done/, 'no rollback claim while identity is unknown');
    assert(await page.evaluate(() => !!localStorage.getItem('cpthru.pendingInstall')), 'pending install kept');
    A.S.hooks.release = null;
    await waitMsg(page, /Done: the adapter is back and runs what you installed\. The adapter reports stock firmware/, 30000);
    assert.equal(A.S.launches.length, 1);
    assert.deepEqual(t.errors, []); await t.close();
  },
  async reinstall_no_outage(b) {
    // Same release again, restart too quick to observe: completion comes from the uptime reset.
    const t = await open(b, {restartMs: 0}), {page, A} = t;
    A.S.restartDelay = 0;
    await page.locator('#fw-panel .fw-file').setInputFiles(REL);
    await waitMsg(page, /Valid image/);
    await page.locator('#fw-panel .fw-up').click();
    await waitMsg(page, /Uploaded and verified/);
    A.S.down = false;
    await page.locator('#fw-panel .fw-inst').click(); await page.locator('#fw-panel .fw-inst').click();
    await waitMsg(page, /Done: the adapter is back and runs what you installed/, 60000);
    assert.equal(A.S.launches.length, 1);
    assert.deepEqual(t.errors, []); await t.close();
  },
  async bookmark(b, name) {
    // First install from the untouched stock page via the generic bookmark.
    const t = await open(b, {page: 'stock'}), {page, A} = t;
    const payload = (await readFile(new URL('../phone-upload-v2/loader.min.js', import.meta.url), 'utf8')).trim();
    const mark = (await readFile(new URL('../phone-upload-v2/bookmarklet.txt', import.meta.url), 'utf8')).trim();
    assert.equal(decodeURIComponent(mark.slice(11)), payload);
    await page.waitForTimeout(1500);
    await page.evaluate(payload);
    await page.locator('#carlinkit-local-upload .fw-file').setInputFiles(REL);
    await page.waitForFunction(() => /Valid image/.test(document.querySelector('#carlinkit-local-upload .fw-msg').textContent), null, {timeout: 120000});
    await page.locator('#carlinkit-local-upload .fw-up').click();
    await page.waitForFunction(() => /Uploaded and verified/.test(document.querySelector('#carlinkit-local-upload .fw-msg').textContent), null, {timeout: 300000});
    assert.equal(sha(A.S.staged.get('cpthru.swu')), relMeta.sha256);
    await page.screenshot({path: `${out}/${b.name}-${name}-stock-uploaded.png`, fullPage: false});
    await page.locator('#carlinkit-local-upload .fw-inst').click(); await page.locator('#carlinkit-local-upload .fw-inst').click();
    await page.waitForFunction(() => /Done: the adapter is back/.test(document.querySelector('#carlinkit-local-upload .fw-msg').textContent), null, {timeout: 60000});
    assert.deepEqual(A.S.launches.map(l => l.via + ':' + l.name), ['stock:cpthru.swu']);
    // Only the stock page's own vendor calls (version query, telemetry); none from the bookmark.
    assert.deepEqual(A.S.vendor.filter(u => !/120\.79\.59\.57|data\.carlinkit\.com/.test(u)), []);
    t.errors = t.errors.filter(e => !/stock|vendor|120\.79/.test(e));
    await t.close();
  }
};

const browsers = [];
if (which !== 'chromium') browsers.push(['webkit', await webkit.launch({headless: true, executablePath: WEBKIT})]);
if (which !== 'webkit') browsers.push(['chromium', await chromium.launch({headless: true, executablePath: CHROMIUM})]);
let failed = 0;
for (const [bn, br] of browsers) {
  br.name = bn;
  for (const [name, fn] of Object.entries(scenarios)) {
    if (only && !only.split(',').includes(name)) continue;
    const t0 = Date.now();
    try { await fn(br, name); results.push({browser: bn, name, ok: true, s: (Date.now() - t0) / 1000}); console.log(`ok   ${bn} ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`); }
    catch (e) { failed++; results.push({browser: bn, name, ok: false, error: String(e.stack || e).slice(0, 800)}); console.log(`FAIL ${bn} ${name}: ${String(e.message).slice(0, 400)}`); }
  }
  await br.close();
}
await writeFile(out + '/results.json', JSON.stringify(results, null, 1));
console.log(`${results.length - failed}/${results.length} browser scenarios passed; screenshots in ${out}`);
process.exit(failed ? 1 : 0);
