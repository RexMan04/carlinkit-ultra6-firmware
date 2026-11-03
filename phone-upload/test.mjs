// bun phone-upload/test.mjs                  tests phone-upload/ (original)
// bun phone-upload/test.mjs --dir DIR        tests a spec build (e.g. phone-upload-diag);
//     results go to DIR, the original phone-upload/ files are checked unchanged,
//     and one extra scenario runs on the passthru_diag main page.
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {chromium, webkit} from '/home/kaden/.bun/install/global/node_modules/playwright/index.mjs';

const here = import.meta.dir;
const argDir = process.argv.indexOf('--dir');
const dir = argDir >= 0 ? resolve(process.argv[argDir + 1]) : here;
const variant = dir !== resolve(here);
const base = '/home/kaden/models/staging/carlinkit-ultra6-fw';
const root = base + '/tier1/rootfs_stock_exact/etc/shttpd';
const WEBKIT = '/home/kaden/.cache/ms-playwright/webkit-2359/pw_run.sh';
const CHROMIUM = '/home/kaden/.cache/ms-playwright/chromium_headless_shell-1252/chrome-headless-shell-linux64/chrome-headless-shell';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const originals = async () => Object.fromEntries(await Promise.all(
  ['bookmarklet.txt', 'images.json', 'upload.min.js', 'test-results.json'].map(async n =>
    [n, existsSync(here + '/' + n) ? sha256(await readFile(here + '/' + n)) : null])));
const originalsBefore = await originals();
if (variant) assert.equal(originalsBefore['bookmarklet.txt'], 'f1d8b5523033e29bc642a5ff3a1760b9624ace96ac5c5fae7c1e3464c249a0ea');
// The passthru_diag main page (stock page + diagnostics script), for the
// extra scenario: later uploads will start from that page.
let diagIndex = null;
if (variant) {
  const out = (await mkdtemp(tmpdir() + '/cpd-index-')) + '/index.html';
  const r = spawnSync('python3', [resolve(here, '../build_fw.py'), '--patch-index', root, out], {encoding: 'utf8'});
  assert.equal(r.status, 0, 'patch-index failed: ' + r.stdout + r.stderr);
  diagIndex = await readFile(out);
}
const mark = (await readFile(dir + '/bookmarklet.txt', 'utf8')).trim();
const payload = (await readFile(dir + '/upload.min.js', 'utf8')).trim();
assert.equal(decodeURIComponent(mark.slice(11)), payload);
assert.equal('javascript:' + encodeURIComponent(payload), mark);
assert(payload.startsWith('void '));
assert(!/submition\.cgi/.test(payload));
const images = JSON.parse(await readFile(dir + '/images.json', 'utf8'));
const imageBytes = await Promise.all(images.map(i => readFile(base + '/' + i.path)));
const hash = bytes => createHash('md5').update(bytes).digest('hex');
const results = [];

async function scenario(browser, name, options = {}) {
  const requests = [], parts = [], errors = [], dialogs = [];
  const image = images[options.image || 0], expected = imageBytes[options.image || 0];
  let failure, releaseUpload, sawUpload;
  const uploadReached = new Promise(r => { sawUpload = r; });
  let exports = 0;
  // WebKit's inspector omits Blob payloads from postDataBuffer(). A loopback
  // HTTP proxy captures actual browser bytes and NEVER forwards any request.
  const server = createServer(async (req, res) => {
    const route = {
      abort: async () => { req.socket.destroy(); },
      fulfill: async ({status = 200, contentType = 'text/plain', headers = {}, body = ''}) => {
        res.writeHead(status, {'content-type': contentType, ...headers}); res.end(body);
      }
    };
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://' + req.headers.host);
      const request = {url: () => url.href, method: () => req.method,
        postDataBuffer: () => raw, headers: () => req.headers};
      if (['/cgi-bin/minizip.cgi', '/cgi-bin/cpthru_snapshot.cgi'].includes(url.pathname)) exports++;
      if (url.pathname === '/cgi-bin/downfile.cgi') {
        requests.push(request.url());
        assert.equal(request.method(), 'POST');
        const body = request.postDataBuffer();
        const ct = request.headers()['content-type'];
        const boundary = ct.slice(ct.indexOf('boundary=') + 9);
        assert(!boundary.includes('"'), 'getBoundaryStr uses raw unquoted boundary');
        const mime = Buffer.from('Content-Type: application/octet-stream');
        const typeAt = body.indexOf(mime);
        assert(typeAt >= 0);
        const filename = /filename="([^"]+)"/.exec(body.subarray(0, typeAt).toString())[1];
        const index = parts.length, total = Math.ceil(expected.length / 10240);
        const last = index === total - 1;
        const suffix = index === 0 ? '.0' : last ? ':' + image.md5 + '.2' : '.1';
        assert.equal(filename, image.name + suffix);
        assert.equal(Number(filename.at(-1)), index === 0 ? 0 : last ? 2 : 1);
        assert.equal((body.subarray(0, typeAt).toString().match(/Content-Disposition:/g) || []).length, 1);
        assert(body.subarray(0, typeAt).includes(Buffer.from('name="chunk"')));
        // Exact stock main() arithmetic, not a forgiving multipart parser.
        const length = body.length - (typeAt + mime.length) - boundary.length - 12;
        const dataAt = typeAt + mime.length + 4;
        const chunk = body.subarray(dataAt, dataAt + length);
        assert(body.subarray(typeAt + mime.length, dataAt).equals(Buffer.from('\r\n\r\n')));
        assert(body.subarray(dataAt + length).equals(Buffer.from('\r\n--' + boundary + '--\r\n')));
        const expectedChunk = expected.subarray(index * 10240, (index + 1) * 10240);
        if (!chunk.equals(expectedChunk)) {
          console.log(JSON.stringify({index, bodyLength: body.length, typeAt, boundaryLength: boundary.length,
            chunkLength: chunk.length, expectedLength: expectedChunk.length,
            first: chunk.subarray(0, 32).toString('hex'), expectedFirst: expectedChunk.subarray(0, 32).toString('hex'),
            mismatch: chunk.findIndex((value, offset) => value !== expectedChunk[offset])}));
        }
        assert(chunk.equals(expectedChunk), 'CGI stores exact source bytes');
        parts.push(Buffer.from(chunk));
        if (options.overlap && index === 2) {
          sawUpload(); await new Promise(r => { releaseUpload = r; });
        }
        if (parts.length % 1000 === 0) console.log(name + ': received ' + parts.length + '/' + total);
        if (options.mode === 'lost' && index === 1) return await route.abort();
        if (options.mode === 'http') return await route.fulfill({status: 500, body: 'failure'});
        if (options.mode === 'redirect') return await route.fulfill({status: 302, headers: {location: 'http://example.invalid/update'}});
        let path = image.name;
        if (options.mode === 'path') path = 'wrong.swu';
        let bodyText = 'Content-Type: text/html\n\n' +
          (last ? 'md5_str is ' + (options.mode === 'hash-echo' ? '0'.repeat(32) : image.md5) + '\n' : '') +
          'result is /mnt/UDISK/swupdate/' + path + '\nwrite data------success\nupload successful\n';
        if (options.mode === 'write') bodyText += 'write data failed------fail index:1\n';
        if (last) {
          assert.equal(hash(Buffer.concat(parts)), image.md5);
          bodyText += options.mode === 'final' ? 'file check fail\n' : 'file check success\n';
        }
        return await route.fulfill({status: 200, contentType: 'text/plain', body: bodyText});
      }
      if (url.pathname.includes('/cgi-bin/submition')) throw Error('FLASH REQUEST');
      if (url.hostname === 'example.invalid') throw Error('Redirect was followed');
      // Serve real extracted static files, with no requests ever reaching LAN.
      const path = url.pathname === '/' ? '/index.html' : url.pathname;
      if (options.page === 'diag' && path === '/index.html')
        return await route.fulfill({status: 200, contentType: 'text/html', body: diagIndex});
      if (options.page === 'diag' && path === '/cpthru_diag.js')
        return await route.fulfill({status: 200, contentType: 'text/javascript', body: await readFile(here + '/../web/cpthru_diag.js')});
      if (/^\/[A-Za-z0-9_.-]+$/.test(path)) {
        try {
          const body = await readFile(root + path);
          const contentType = path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('.json') ? 'application/json' : path.endsWith('.png') ? 'image/png' : 'text/html';
          return await route.fulfill({status: 200, contentType, body});
        } catch {}
      }
      await route.fulfill({status: 404, body: ''});
    } catch (error) {
      failure = error;
      await route.abort();
    }
  });
  server.on('connect', (_req, socket) => socket.destroy());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const context = await browser.newContext({viewport: {width: 390, height: 844},
    proxy: {server: 'http://127.0.0.1:' + server.address().port},
    deviceScaleFactor: 1, isMobile: true, hasTouch: true, serviceWorkers: 'block'});
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  // Keep actual stock scripts loaded, but suppress onload telemetry/version/log
  // operations. The local proxy also rejects every unhandled request.
  await page.addInitScript(() => {
    Object.defineProperty(window, 'onload', {get: () => null, set: () => {}});
    window.gpsselectitem = 0; // Normally assigned by stock getversion onload.
  });
  try {
    await page.goto(options.mode === 'origin' ? 'http://wrong.invalid/' : 'http://192.168.50.100/');
    const before = {url: page.url(), title: await page.title()};
    if (options.mode === 'active') await page.evaluate(() => { document.getElementById('download_btn').disabled = true; });
    // Exercise browser javascript: navigation and percent-decoding exactly.
    await page.evaluate(url => { location.href = url; }, mark);
    if (['origin', 'active'].includes(options.mode)) {
      await page.waitForFunction(() => !document.getElementById('carlinkit-local-upload'));
      assert(dialogs.length > 0);
      assert.equal(requests.length, 0);
    } else {
      const panel = page.locator('#carlinkit-local-upload');
      await panel.waitFor();
      assert.equal(page.url(), before.url);
      assert.equal(await page.title(), before.title);
      await page.evaluate(url => { location.href = url; }, mark);
      assert.equal(await panel.count(), 1);
      await page.evaluate(() => { program(); uploadChunks(); btnaddEv(); downloadAliFile(); });
      assert.equal(dialogs.length, 4);
      assert.equal(requests.length, 0);
      assert.equal(await panel.locator('input').getAttribute('accept'), null);
      if (options.mode === 'wrong-size') {
        await panel.locator('input').setInputFiles({name: 'wrong.swu', mimeType: 'application/octet-stream', buffer: Buffer.from('wrong')});
      } else if (options.mode === 'wrong-hash') {
        const wrong = Buffer.from(expected); wrong[0] ^= 1;
        await panel.locator('input').setInputFiles({name: 'wrong.swu', mimeType: 'application/octet-stream', buffer: wrong});
      } else {
        await panel.locator('input').setInputFiles(base + '/' + image.path);
      }
      assert.equal(requests.length, 0, 'Selecting a file never uploads');
      if (options.screenshot) await page.screenshot({path: dir + '/phone-ready.png'});
      if (options.mode === 'body-timeout') {
        await page.clock.install();
        await page.evaluate(() => {
          window.fetch = async (url, options) => {
            window.__testFetchCalls = (window.__testFetchCalls || 0) + 1;
            window.__testFetchUrl = url;
            return {status: 200, text: () => new Promise((_, reject) => {
              options.signal.addEventListener('abort', () => reject(Error('Body timeout')));
            })};
          };
        });
      }
      await panel.locator('button').click();
      // Exercise duplicate invocation immediately, even bypassing disabled DOM.
      await panel.locator('button').evaluate(el => el.onclick());
      if (options.overlap) {
        await uploadReached;
        await page.locator('#cpd-panel .cpd-prepare').click();
        assert.match(await page.locator('#cpd-panel .cpd-state').textContent(), /Not started: a firmware upload/);
        assert.equal(await page.evaluate(() => window.CPDiag.busy()), false);
        assert.equal(exports, 0, 'no diagnostic snapshot or ZIP during upload');
        releaseUpload();
      }
      if (options.mode === 'body-timeout') {
        await page.waitForFunction(() => window.__testFetchCalls === 1);
        await page.clock.fastForward(30001);
      }
      await page.waitForFunction(() => document.getElementById('carlinkit-local-upload').dataset.result, null, {timeout: 120000});
      if (failure) throw failure;
      const result = await panel.getAttribute('data-result');
      assert.equal(result, options.mode ? 'failure' : 'success');
      if (!options.mode) {
        assert.equal(requests.length, Math.ceil(expected.length / 10240));
        assert(Buffer.concat(parts).equals(expected));
        assert((await panel.textContent()).includes('NOT flashed'));
      } else if (['wrong-size', 'wrong-hash', 'body-timeout'].includes(options.mode)) {
        assert.equal(requests.length, 0);
        if (options.mode === 'body-timeout') assert.equal(await page.evaluate(() => window.__testFetchCalls), 1);
      } else {
        assert.equal(requests.length, options.mode === 'lost' ? 2 : ['final','hash-echo'].includes(options.mode) ? Math.ceil(expected.length / 10240) : 1);
        assert((await panel.textContent()).includes('Do NOT flash'));
      }
      if (options.screenshot) await page.screenshot({path: dir + '/phone-success.png'});
    }
    if (failure) throw failure;
    if (options.mode === 'redirect') {
      assert(errors.every(message => message.includes('/cgi-bin/downfile.cgi due to access control checks.')),
        'Only WebKit native redirect-denial diagnostics are expected');
    } else assert.deepEqual(errors, [], 'No browser JS errors');
    results.push({name, requests: requests.length, result: 'pass'});
    console.log('PASS ' + name + ' (' + requests.length + ' chunks)');
  } finally {
    try { await context.close(); } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
}

const browsers = [];
try {
  const wk = await webkit.launch({headless: true, executablePath: WEBKIT});
  browsers.push(wk);
  const first = images[0].label;
  await Promise.all([
    scenario(wk, 'WebKit actual ' + first, {screenshot: true}),
    scenario(wk, 'WebKit actual ' + images[1].label, {image: 1})
  ]);
  if (variant) await scenario(wk, 'WebKit actual ' + first + ' from the diagnostics main page', {page: 'diag', overlap: true});
  const modes = ['origin', 'active', 'wrong-size', 'wrong-hash', 'lost', 'http', 'redirect', 'path', 'write', 'final', 'hash-echo', 'body-timeout'];
  for (let start = 0; start < modes.length; start += 4) {
    await Promise.all(modes.slice(start, start + 4).map(mode => scenario(wk, 'WebKit ' + mode, {mode})));
  }
  const chrome = await chromium.launch({headless: true, executablePath: CHROMIUM}); browsers.push(chrome);
  await scenario(chrome, 'Chromium actual ' + first);
  await writeFile(dir + '/test-results.json', JSON.stringify({date: new Date().toISOString(),
    engines: {webkit: wk.version(), chromium: chrome.version()},
    images: images.map(({name, label, md5, sha256, size}) => ({name, label, md5, sha256, size})), results}, null, 2) + '\n');
} finally { await Promise.allSettled(browsers.map(browser => browser.close())); }
if (variant) {
  assert.deepEqual(await originals(), originalsBefore, 'original phone-upload/ files changed');
  console.log('original phone-upload/ files unchanged: ' + JSON.stringify(originalsBefore));
}
