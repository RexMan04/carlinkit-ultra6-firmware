// Browser tests for the diagnostics panel (NEXT_TEST_PLAN.md Verification 3).
//
//   bun tests/diag_browser.mjs [--fixture STOCK_LOGS_ZIP] [--out DIR]
//
// Serves the passthru_diag main page (the exact stock page patched by
// build_fw.py --patch-index, with its real stock scripts, onload NOT
// suppressed) and /cpthru.html from a loopback-only HTTP proxy that never
// forwards anything: vendor hosts are recorded and refused. The stock log
// exporter is answered with real minizip bytes (default: the fixture made by
// the actual stock minizip.cgi; tests/ns_test.py writes a fresh one), and the
// panel's ZIP is checked with Python's zipfile. Cached WebKit and Chromium
// builds are used explicitly. Screenshots of the phone layout go to DIR.
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {chromium, webkit} from '/home/kaden/.bun/install/global/node_modules/playwright/index.mjs';

const arg = (name, def) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : def;
const repo = resolve(import.meta.dir, '..');
const base = '/home/kaden/models/staging/carlinkit-ultra6-fw';
const shttpd = base + '/tier1/rootfs_stock_exact/etc/shttpd';
const fixturePath = resolve(arg('--fixture', repo + '/.local-work/reference/stock-logs.zip'));
const outDir = resolve(arg('--out', base + '/review/diag-browser'));
const WEBKIT = '/home/kaden/.cache/ms-playwright/webkit-2359/pw_run.sh';
const CHROMIUM = '/home/kaden/.cache/ms-playwright/chromium_headless_shell-1252/chrome-headless-shell-linux64/chrome-headless-shell';
const ADAPTER = '192.168.50.100';
const ORDER = ['stock-logs.zip', 'status.json', 'system.txt', 'manifest.json', 'README.txt'];
await mkdir(outDir, {recursive: true});

const fixture = await readFile(fixturePath);
assert.equal(fixture.subarray(0, 2).toString('latin1'), 'PK', 'fixture is not a ZIP');
const work = await mkdtemp(tmpdir() + '/cpd-browser-');
const patch = spawnSync('python3', [repo + '/build_fw.py', '--patch-index', shttpd, work + '/index.html'], {encoding: 'utf8'});
assert.equal(patch.status, 0, 'patch-index failed: ' + patch.stdout + patch.stderr);
const pages = {
  diag: await readFile(work + '/index.html'),
  stock: await readFile(shttpd + '/index.html')
};
const web = name => readFile(repo + '/web/' + name);

// ---- adapter fixtures -----------------------------------------------------
const getversion = ['system_version:202610121756C', 'get_delay_timer:0', 'get_wifi_channel:36', 'get_showui:0',
  'get_cargps:1', 'bluetoothPhoneMode:0', 'autoDisplay:0', 'get_audiorate:44100', 'audioLatency:600', 'uuid:test-uuid',
  'product_Model:U2W', 'get_manufacturer:TestCar', 'get_model:TestModel', 'get_srcVersion:2020', 'platform:v553',
  'custom:yunlianAm', 'isActivate:1', ''].join('\n');
const stat = (avg, max, n) => ({n, avg, max, sum: Math.round(avg * n)});
const win = seq => ({seq, gen: 3, t0: 74000 + 5000 * seq, len_ms: 5000, calls: 41, first: 0, v_ok: 40, v_fail: 0,
  v_gate: 1, c_ok: 0, c_fail: 0, c_gate: 0, slow16: 2, slow33: 1, slow100: 0, cb: stat(3.2, 41, 41),
  iv: stat(122, 160, 40), gap: stat(118.6, 155, 40), lk: stat(0, 1, 41), par: stat(0, 0, 41), plk: stat(0.4, 6, 40),
  vsend: stat(2.1, 38, 40), csend: stat(0, 0, 0), orig: stat(0, 0, 0), res: stat(0.5, 2, 41), pub: stat(0, 0, 1)});
const info = (ret, stock) => ({calls: 2, last_mono_ms: 150100, stock, returned: ret, override: 1});
const status = {now_ms: 200500, build: 'diagtest0001', markers: [],
  status: {build: 'diagtest0001', up_ms: 200000, t_ms: 199000, state: 'PASSTHRU', reason: 'IDR delivered', off: 0,
    marker: 0, in_fps: 8, pt_fps: 8, stock_fps: 0, kbps: 900, car: '1920x720@60', phone: '1920x720 p100/l42',
    fallbacks: 0, failed: 0, last_fallback: '', last_fallback_t_ms: 0, multi_vcl: 0, push_err: 0, kf_car: 0, kf_phone: 1},
  link: {up_ms: 150000, stream: 1, session: 1, car: 1, event: 'car video start'},
  settings: {off: '0', latency: '600'}, props_ok: true,
  timing: {v: 1, build: 'diagtest0001', up_ms: 200000, mono_ms: 199000, session_mono_ms: 150000, stock_sent: 0,
    stock_suppressed: 120, info_source: 'last value returned by sd_get_info_int',
    info: {VIDEO_WIDTH: info(1920, 800), VIDEO_HEIGHT: info(720, 480), VIDEO_FPS: info(60, 30)},
    available: 1, clock_res_ms: 1, window_ms: 5000, ring_max: 24, gen: 3, seq: 24,
    windows: Array.from({length: 24}, (_, i) => win(i + 1))},
  timing_error: null};
const snapshot = (u = {}, o = {}) => Object.assign({v: 1, t0_ms: 200600, t1_ms: 201700, build: 'diagtest0001',
  config: {platform: 'v553', custom: 'yunlianAm', version: '202610121756C'},
  props: {'persist.cpthru.off': '0', 'persist.suding.wl.audio.latency': '600', 'persist.console.log.nosave': '',
    'persist.console.log.index': '3'}, nosave: '',
  udisk: Object.assign({free_bytes: 60e6, log_bytes: 2.5e6, leftover_zip: false, leftover_zip_bytes: null}, u),
  mem_kb: {MemTotal: 120000, MemFree: 30000}, loadavg: [1.2, 1.1, 0.9], ticks_note: 'x', sample_up_cs: [20060, 20161],
  cpu: [{name: 'cpu', total: 200, user: 90, nice: 0, system: 40, idle: 60, iowait: 0, irq: 4, softirq: 6},
    {name: 'cpu0', total: 100, user: 45, nice: 0, system: 20, idle: 30, iowait: 0, irq: 2, softirq: 3},
    {name: 'cpu1', total: 100, user: 45, nice: 0, system: 20, idle: 30, iowait: 0, irq: 2, softirq: 3}],
  net: [{if: 'wlan0', rx_bytes: 1e8, rx_packets: 1e5, rx_errs: 0, rx_drop: 3, tx_bytes: 2e8, tx_packets: 2e5, tx_errs: 0,
    tx_drop: 1, delta: {rx_bytes: 120000, tx_bytes: 900000, rx_drop: 0, tx_drop: 0}}],
  sdDongle: {pid: 812, starttime: 1500, same_process: true, threads_seen: 3,
    threads: [{tid: 812, name: 'sdDongle', utime: 5, stime: 2}, {tid: 830, name: 'ScreenStream', utime: 40, stime: 22}]},
  missing: []}, o);
const SETTINGS = /^\/cgi-bin\/(setprop|audioselect|factoryreset|submition|downfile|switch_p2p|cpthru_set)\.cgi$/;

const PY = String.raw`
import io, json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1]); fx = open(sys.argv[2], "rb").read()
info = z.infolist()
out = {"names": [i.filename for i in info], "stored": all(i.compress_type == zipfile.ZIP_STORED for i in info),
       "outer_crc_ok": z.testzip() is None, "sizes": {i.filename: i.file_size for i in info}}
if "stock-logs.zip" in out["names"]:
    inner = z.read("stock-logs.zip")
    out["nested_identical"] = inner == fx
    out["inner_names"] = zipfile.ZipFile(io.BytesIO(inner)).namelist()
out["manifest"] = json.loads(z.read("manifest.json"))
out["status_keys"] = sorted(json.loads(z.read("status.json")))
out["system"] = z.read("system.txt").decode()
out["readme_unredacted"] = b"UNREDACTED" in z.read("README.txt")
print(json.dumps(out))`;

function checkBundle(path, complete) {
  const r = spawnSync('python3', ['-I', '-c', PY, path, fixturePath], {encoding: 'utf8'});
  assert.equal(r.status, 0, 'python zipfile: ' + r.stderr);
  const b = JSON.parse(r.stdout);
  assert.deepEqual(b.names, complete ? ORDER : ORDER.slice(1), 'bundle order');
  assert(b.stored && b.outer_crc_ok, 'outer ZIP is STORE-only and valid');
  assert.equal(b.manifest.kind, complete ? 'complete' : 'diagnostics-only');
  assert.equal(b.manifest.complete, complete);
  assert.deepEqual(b.manifest.order, b.names);
  for (const f of b.manifest.files) assert.equal(b.sizes[f.name], f.bytes, 'manifest size of ' + f.name);
  assert.deepEqual(b.status_keys, ['note', 'snapshot', 'status_after', 'status_before']);
  assert(b.readme_unredacted);
  if (complete) {
    assert(b.nested_identical, 'nested stock-logs.zip byte-identical to the exporter output');
    assert.equal(b.manifest.stock_logs.bytes, fixture.length);
  } else {
    assert(/DIAGNOSTICS ONLY/.test(b.system));
    assert.equal(b.manifest.stock_logs.included, false);
  }
  return b;
}

const until = async (fn, ms = 15000, what = 'condition') => {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw Error('timed out waiting for ' + what); await new Promise(r => setTimeout(r, 20)); }
};
const results = [];

async function scenario(browser, engine, name, mode, body) {
  const S = {mode, all: [], vendor: [], settings: [], unexpected: [], minizip: 0, snapshot: 0, status: 0, getversion: 0,
    hanging: [], gate: null, release: null, errors: []};
  const server = createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://' + req.headers.host);
      if (u.hostname !== ADAPTER) { S.vendor.push(req.method + ' ' + u.href); res.writeHead(404); return res.end(); }
      const p = u.pathname === '/' ? '/index.html' : u.pathname;
      S.all.push(p + u.search);
      const send = (status, type, data, headers = {}) => { res.writeHead(status, {'content-type': type, ...headers}); res.end(data); };
      if (SETTINGS.test(p)) { S.settings.push(p + u.search); return send(200, 'text/plain', 'ok'); }
      if (p === '/index.html') return send(200, 'text/html', mode === 'baseline' ? pages.stock : pages.diag);
      if (['/cpthru.html', '/cpthru.js', '/cpthru_diag.js'].includes(p))
        return send(200, p.endsWith('.js') ? 'text/javascript' : 'text/html', await web(p.slice(1)));
      if (p === '/cgi-bin/getversion.cgi') { S.getversion++; return send(200, 'text/plain', getversion); }
      if (p === '/cgi-bin/cpthru_status.cgi') {
        S.status++;
        return mode === 'status-fail' ? send(500, 'text/plain', 'no') : send(200, 'application/json', JSON.stringify(mode === 'bad-timing' ? {...status, timing: {v: 1, available: 1, windows: [null]}} : status));
      }
      if (p === '/cgi-bin/cpthru_snapshot.cgi') {
        S.snapshot++;
        if (S.gate) await S.gate;
        if (mode === 'snapshot-fail') return send(500, 'text/plain', 'no');
        if (mode === 'snapshot-hang') return void S.hanging.push(res);
        const s = mode === 'lowspace' ? snapshot({free_bytes: 2.5e6 + 4 * 1048576 - 1}) :
          mode === 'nosave' ? snapshot({leftover_zip: true, leftover_zip_bytes: 3 * 1048576}, {nosave: '1'}) : snapshot();
        return send(200, 'application/json', JSON.stringify(s));
      }
      if (p === '/cgi-bin/minizip.cgi') {
        S.minizip++;
        assert.equal(u.search, '?logID=' + (mode === 'baseline' ? '' : 'local') + '&');
        const plain = 'text/plain;charset=utf-8';
        if (mode === 'zip-hang') return void S.hanging.push(res);
        if (mode === 'redirect') return send(302, 'text/plain', '', {location: 'http://example.invalid/logs.zip'});
        if (mode === 'zip-500') return send(500, plain, 'error');
        if (mode === 'truncated') return send(200, plain, fixture.subarray(0, fixture.length - 30));
        if (mode === 'notzip') return send(200, plain, 'cannot open /mnt/UDISK/log\n');
        if (mode === 'oversize' || mode === 'oversize-cl') {
          const total = 26 * 1048576;
          res.writeHead(200, {'content-type': plain, ...(mode === 'oversize-cl' ? {'content-length': total} : {})});
          res.on('error', () => {});
          res.write(Buffer.from('PK\x03\x04', 'latin1'));
          const chunk = Buffer.alloc(1048576);
          for (let sent = 4; sent < total && !res.destroyed; sent += chunk.length)
            if (!res.write(chunk.subarray(0, Math.min(chunk.length, total - sent)))) await new Promise(r => res.once('drain', r).once('close', r));
          return res.end();
        }
        return send(200, plain, fixture, {'content-length': fixture.length});
      }
      if (/^\/[A-Za-z0-9_.-]+$/.test(p)) {
        try {
          const data = await readFile(shttpd + p);
          const type = p.endsWith('.js') ? 'text/javascript' : p.endsWith('.css') ? 'text/css' :
            p.endsWith('.json') ? 'application/json' : p.endsWith('.png') ? 'image/png' : 'text/html';
          return send(200, type, data);
        } catch {}
      }
      if (p.startsWith('/cgi-bin/')) S.unexpected.push(p);
      send(404, 'text/plain', '');
    } catch (error) { S.errors.push(String(error && error.stack || error)); try { res.destroy(); } catch {} }
  });
  server.on('connect', (_req, socket) => socket.destroy());
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const proxy = {server: 'http://127.0.0.1:' + server.address().port};
  const context = await browser.newContext({proxy, viewport: {width: 390, height: 844}, deviceScaleFactor: 2,
    isMobile: engine === 'chromium', hasTouch: true, acceptDownloads: true, serviceWorkers: 'block'});
  await context.addInitScript(() => {
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    window.__blobs = {created: [], revoked: []};
    URL.createObjectURL = b => { const u = create(b); window.__blobs.created.push(u); return u; };
    URL.revokeObjectURL = u => { window.__blobs.revoked.push(u); return revoke(u); };
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  page.on('dialog', d => d.dismiss().catch(() => {}));
  const t = {
    S, page, pageErrors,
    shot: async file => {
      await page.locator('#cpd-panel').scrollIntoViewIfNeeded();
      await page.screenshot({path: `${outDir}/${engine}-${file}.png`});
    },
    loadIndex: async () => {
      await page.goto(`http://${ADAPTER}/`);
      await page.waitForFunction(() => document.getElementById('System_Version').textContent === '202610121756C');
      await page.locator('#cpd-panel .cpd-prepare').waitFor();
    },
    prepare: async () => {
      assert.equal(S.minizip, 0, 'nothing exported before Prepare');
      await page.locator('#cpd-panel .cpd-prepare').click();
      await page.evaluate(() => document.querySelector('#cpd-panel .cpd-prepare').click()); // double tap
    },
    ready: async (partial, ms = 30000) => {
      await page.waitForFunction(want => document.getElementById('cpd-panel').dataset.state === want,
        partial ? 'ready-partial' : 'ready', {timeout: ms});
    },
    bundle: async (complete, file) => {
      const link = page.locator('#cpd-panel .cpd-download');
      const href = await link.getAttribute('href');
      assert(href && href.startsWith('blob:'), 'download link is a Blob URL');
      const b64 = await page.evaluate(async h => {
        const u = new Uint8Array(await (await fetch(h)).arrayBuffer());
        let s = '';
        for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode.apply(null, u.subarray(i, i + 32768));
        return btoa(s);
      }, href);
      const viaBlob = Buffer.from(b64, 'base64');
      const event = page.waitForEvent('download', {timeout: 15000});
      await link.click();
      const dl = await event;
      assert.equal(await dl.failure(), null);
      assert(/^carlinkit-(debug|diagnostics-only)-\d{8}-\d{6}\.zip$/.test(dl.suggestedFilename()), dl.suggestedFilename());
      assert.equal(dl.suggestedFilename().includes('diagnostics-only'), !complete);
      const path = `${work}/${engine}-${file}.zip`;
      await dl.saveAs(path);
      assert((await readFile(path)).equals(viaBlob), 'downloaded bytes equal the Blob');
      return checkBundle(path, complete);
    }
  };
  try {
    await body(t);
    if (S.errors.length) throw Error('server: ' + S.errors.join('; '));
    if (mode !== 'baseline') {
      assert.deepEqual(S.vendor, [], 'no vendor/network requests');
      assert.deepEqual(S.settings, [], 'no settings/firmware/reboot requests');
      assert.deepEqual(S.unexpected, [], 'no other CGI requests');
    }
    results.push({engine, name, result: 'pass', minizip: S.minizip, snapshot: S.snapshot, pageErrors});
    console.log(`PASS ${engine} ${name}`);
    return t;
  } catch (error) {
    results.push({engine, name, result: 'FAIL', error: String(error && error.message || error)});
    console.log(`FAIL ${engine} ${name}: ${error && error.stack || error}`);
    process.exitCode = 1;
    return t;
  } finally {
    await context.close().catch(() => {});
    S.hanging.forEach(r => { try { r.destroy(); } catch {} });
    server.closeAllConnections();
    await new Promise(r => server.close(r));
  }
}

async function suite(browser, engine) {
  // Stock page as shipped: shows the test notices automatic exports/vendor calls.
  const base = await scenario(browser, engine, 'baseline: unpatched stock page exports and calls vendors on load', 'baseline', async t => {
    await t.page.clock.install();
    await t.page.goto(`http://${ADAPTER}/`);
    await t.page.waitForFunction(() => document.getElementById('System_Version').textContent === '202610121756C');
    await t.page.clock.fastForward(65000);
    await until(() => t.S.minizip >= 1 && t.S.vendor.length >= 1, 10000, 'stock exports');
  });
  const baseErrors = new Set(base.pageErrors);

  await scenario(browser, engine, 'load: real patched onload, no export/vendor/settings requests', 'load', async t => {
    await t.page.clock.install();
    await t.loadIndex();
    await t.page.clock.fastForward(65000); // stock 60 s telemetry interval + panel polls
    await t.page.waitForFunction(() => window.CPDiagNeutralized >= 4); // onload's 3 calls + 1 interval tick
    assert.equal(t.S.getversion, 1, 'stock onload ran');
    assert.equal(t.S.minizip, 0);
    assert.equal(t.S.snapshot, 0);
    assert.match(await t.page.locator('#result').textContent(), /disabled in this diagnostic test build/);
    const text = await t.page.locator('#cpd-panel').textContent();
    assert.match(text, /Received from phone \(measured\)8\.2 fps/);
    assert.match(text, /Display mode requested \(last value returned by sd_get_info_int\)1920x720 @ 60 fps \(shim override/);
    assert.match(text, /Nothing collected yet/);
    const extra = t.pageErrors.filter(m => !baseErrors.has(m));
    assert.deepEqual(extra, [], 'no page errors beyond the stock page\'s own');
    await t.shot('index-idle');
  });

  await scenario(browser, engine, 'complete bundle with double tap', 'ok', async t => {
    await t.loadIndex();
    await t.prepare();
    await t.ready(false);
    assert.equal(t.S.minizip, 1, 'exactly one export');
    assert.equal(t.S.snapshot, 1);
    const b = await t.bundle(true, 'complete');
    assert.equal(b.manifest.page, '/');
    assert.deepEqual(b.manifest.steps.map(s => s.step), ['status_before', 'snapshot', 'status_after', 'minizip_download', 'minizip_check']);
    assert.equal(b.manifest.stock_logs.entries, b.inner_names.filter(n => !n.endsWith('/')).length);
    assert.match(b.system, /ScreenStream: 62 ticks \(62% of one core\)/);
    assert.match(b.system, /Timing history/);
    await t.shot('index-ready');
  });

  await scenario(browser, engine, 'settings, firmware and other requests refused while preparing', 'ok', async t => {
    await t.loadIndex();
    t.S.gate = new Promise(r => { t.S.release = r; });
    await t.prepare();
    await until(() => t.S.snapshot === 1, 10000, 'snapshot request');
    await t.page.evaluate(() => {
      funAudioDelay(); FactoryReset(); program(); switchP2P(); LogCommit();
      const x = new XMLHttpRequest(); x.open('GET', '/cgi-bin/setprop.cgi?audio_delay=600&'); x.send();
      fetch('/cgi-bin/factoryreset.cgi').catch(() => {});
    });
    await new Promise(r => setTimeout(r, 400));
    assert.match(await t.page.locator('#cpd-panel .cpd-state').textContent(), /Settings and updates are paused/);
    await t.shot('index-preparing');
    t.S.release();
    await t.ready(false);
  });

  await scenario(browser, engine, 'malformed optional timing still downloads a bundle', 'bad-timing', async t => {
    await t.loadIndex(); await t.prepare(); await t.ready(false);
    const b = await t.bundle(true, 'bad-timing');
    assert(b.manifest.missing.some(m => m.includes('invalid timing data omitted')));
    assert.match(b.system, /invalid timing data omitted/);
  });

  await scenario(browser, engine, 'prepare first refuses the upload helper before any transfer', 'ok', async t => {
    await t.loadIndex();
    t.S.gate = new Promise(r => { t.S.release = r; });
    await t.prepare();
    await until(() => t.S.snapshot === 1, 10000, 'snapshot request');
    await t.page.evaluate(await readFile(repo + '/phone-upload-diag/upload.min.js', 'utf8'));
    assert.equal(await t.page.locator('#carlinkit-local-upload').count(), 0);
    assert(await t.page.evaluate(() => window.CPDiag.busy()));
    t.S.release(); await t.ready(false);
  });

  await scenario(browser, engine, 'low space: diagnostics-only, exporter never called', 'lowspace', async t => {
    await t.loadIndex();
    await t.prepare();
    await t.ready(true);
    assert.equal(t.S.minizip, 0);
    const b = await t.bundle(false, 'lowspace');
    assert.match(b.manifest.stock_logs.error, /not enough free space/);
    assert.match(await t.page.locator('#cpd-panel .cpd-state').textContent(), /Stock logs NOT collected/);
    await t.shot('index-partial');
  });

  await scenario(browser, engine, 'snapshot fails: diagnostics-only, exporter never called', 'snapshot-fail', async t => {
    await t.loadIndex();
    await t.prepare();
    await t.ready(true);
    assert.equal(t.S.minizip, 0);
    const b = await t.bundle(false, 'snapfail');
    assert(b.manifest.missing.includes('snapshot: HTTP 500'), JSON.stringify(b.manifest.missing));
  });

  await scenario(browser, engine, 'snapshot hangs: client timeout (virtual clock)', 'snapshot-hang', async t => {
    await t.loadIndex();
    await t.page.clock.install();
    await t.prepare();
    await until(() => t.S.snapshot === 1, 10000, 'snapshot request');
    await t.page.clock.fastForward(15001);
    await t.ready(true);
    assert.equal(t.S.minizip, 0);
    const b = await t.bundle(false, 'snaphang');
    assert(b.manifest.missing.some(m => /^snapshot: no answer within 15 s/.test(m)), JSON.stringify(b.manifest.missing));
  });

  await scenario(browser, engine, 'status fails: still a complete bundle, missing recorded', 'status-fail', async t => {
    await t.loadIndex();
    await t.prepare();
    await t.ready(false);
    const b = await t.bundle(true, 'statusfail');
    assert(b.manifest.missing.includes('status_before: HTTP 500') && b.manifest.missing.includes('status_after: HTTP 500'));
  });

  for (const [mode, code] of [['truncated', 'malformed'], ['notzip', 'malformed'], ['zip-500', 'http'],
    ['redirect', 'network'], ['oversize', 'oversize'], ['oversize-cl', 'oversize']]) {
    await scenario(browser, engine, `stock log ${mode}: visible failure + diagnostics-only bundle`, mode, async t => {
      await t.loadIndex();
      await t.prepare();
      await t.ready(true, 60000);
      assert.equal(t.S.minizip, 1);
      const b = await t.bundle(false, mode);
      assert.equal(b.manifest.stock_logs.code, code, b.manifest.stock_logs.error);
      assert.match(await t.page.locator('#cpd-panel .cpd-state').textContent(), /Stock logs NOT collected/);
    });
  }

  await scenario(browser, engine, 'exporter hangs: 90 s guard (virtual clock)', 'zip-hang', async t => {
    await t.loadIndex();
    await t.page.clock.install();
    await t.prepare();
    await until(() => t.S.minizip === 1, 10000, 'minizip request');
    await t.page.clock.fastForward(90001);
    await t.ready(true);
    const b = await t.bundle(false, 'ziphang');
    assert.equal(b.manifest.stock_logs.code, 'timeout');
    assert.match(b.manifest.stock_logs.note, /may still be compressing/);
  });

  await scenario(browser, engine, 'nosave=1 and leftover ZIP are warned', 'nosave', async t => {
    await t.loadIndex();
    await t.prepare();
    await t.ready(false);
    const warn = await t.page.locator('#cpd-panel .cpd-warn').textContent();
    assert.match(warn, /Log saving is OFF/);
    assert.match(warn, /leftover \/mnt\/UDISK\/local\.zip \(3\.0 MiB\)/);
    const b = await t.bundle(true, 'nosave');
    assert.equal(b.manifest.warnings.length, 2);
    assert.match(b.system, /NOT SAVED/);
    await t.shot('index-nosave');
  });

  await scenario(browser, engine, 'retry revokes the previous Blob URL', 'ok', async t => {
    await t.loadIndex();
    await t.prepare();
    await t.ready(false);
    const first = await t.page.locator('#cpd-panel .cpd-download').getAttribute('href');
    await t.page.locator('#cpd-panel .cpd-prepare').click();
    await t.page.waitForFunction(() => document.getElementById('cpd-panel').dataset.state === 'preparing' ||
      window.__blobs.created.length === 2);
    await t.ready(false);
    const blobs = await t.page.evaluate(() => window.__blobs);
    assert(blobs.revoked.includes(first), 'first Blob URL revoked');
    assert.equal(blobs.created.length, 2);
    assert.equal(t.S.minizip, 2);
    await t.bundle(true, 'retry');
  });

  await scenario(browser, engine, '/cpthru.html: same control, settings refused while preparing', 'ok', async t => {
    await t.page.goto(`http://${ADAPTER}/cpthru.html`);
    await t.page.locator('#cpd-panel .cpd-prepare').waitFor();
    await t.page.waitForFunction(() => /Received from phone/.test(document.getElementById('cpd-panel').textContent));
    assert.equal(t.S.minizip, 0);
    t.S.gate = new Promise(r => { t.S.release = r; });
    await t.prepare();
    await until(() => t.S.snapshot === 1, 10000, 'snapshot request');
    await t.page.locator('#pt-off').click();
    await t.page.locator('#pt-off').click();
    await new Promise(r => setTimeout(r, 300));
    assert.match(await t.page.locator('#msg').textContent(), /wait until the debug ZIP is ready/);
    t.S.release();
    await t.ready(false);
    const b = await t.bundle(true, 'cpthru');
    assert.equal(b.manifest.page, '/cpthru.html');
    await t.shot('cpthru-ready');
  });
}

const browsers = [];
try {
  const wk = await webkit.launch({headless: true, executablePath: WEBKIT});
  browsers.push(wk);
  await suite(wk, 'webkit');
  const ch = await chromium.launch({headless: true, executablePath: CHROMIUM});
  browsers.push(ch);
  await suite(ch, 'chromium');
  const summary = {date: new Date().toISOString(), engines: {webkit: wk.version(), chromium: ch.version()},
    fixture: {path: fixturePath, bytes: fixture.length}, screenshots: outDir, results};
  await writeFile(outDir + '/diag-browser-results.json', JSON.stringify(summary, null, 2) + '\n');
  const failed = results.filter(r => r.result !== 'pass').length;
  console.log(`${results.length - failed}/${results.length} browser scenarios passed (WebKit ${wk.version()}, Chromium ${ch.version()}); results and screenshots in ${outDir}`);
  if (failed) process.exitCode = 1;
} finally {
  await Promise.allSettled(browsers.map(b => b.close()));
}
