// Stateful loopback mock of the adapter for browser tests and the preview.
// Used as an HTTP proxy by the browser (so the page origin is the real
// http://192.168.50.100); never forwards anything. Emulates the stock upload
// CGI's multipart arithmetic, append staging and MD5 check, the 0.2 gateways
// (lock-free here; the real locking is covered by tests/ns_v2_test.py), the
// settings CGIs and a simulated install + restart.
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const MAIN = require('../web/cpthru_main.js');
const FWJS = require('../web/cpthru_fw.js');

export const BASE = '/home/kaden/models/staging/carlinkit-ultra6-fw';
export const STOCK_WEB = BASE + '/tier1/rootfs_stock_exact/etc/shttpd';
const REPO = new URL('..', import.meta.url).pathname;
const md5 = b => createHash('md5').update(b).digest('hex');

export const getversion = (s) => ['system_version:202610121756C', 'protocol_version:12', 'get_delay_timer:' + (s['persist.sys.boot.delay'] || '0'),
  'get_wifi_channel:' + (s['persist.sys.wifi.channel'] || '36'), 'get_showui:1', 'get_cargps:' + (s['persist.sys.headunit.gps.disable'] || ''),
  'bluetoothPhoneMode:0', 'autoDisplay:0', 'get_audiorate:44100', 'audioLatency:600', 'uuid:TEST-SERIAL-0001', 'product_Model:U2W',
  'get_manufacturer:Kia', 'get_model:TestCar', 'get_srcVersion:2025', 'platform:v553', 'custom:yunlianAm', 'isActivate:1', ''].join('\n');
const stat = (avg, max, n) => ({n, avg, max, sum: Math.round(avg * n)});
const win = seq => ({seq, gen: 3, t0: 74000 + 5000 * seq, len_ms: 5000, calls: 41, first: 0, v_ok: 40, v_fail: 0,
  v_gate: 1, c_ok: 0, c_fail: 0, c_gate: 0, slow16: 2, slow33: 1, slow100: 0, cb: stat(3.2, 41, 41),
  iv: stat(122, 160, 40), gap: stat(118.6, 155, 40), lk: stat(0, 1, 41), par: stat(0, 0, 41), plk: stat(0.4, 6, 40),
  vsend: stat(2.1, 38, 40), csend: stat(0, 0, 0), orig: stat(0, 0, 0), res: stat(0.5, 2, 41), pub: stat(0, 0, 1)});
const info = (ret, stock) => ({calls: 2, last_mono_ms: 150100, stock, returned: ret, override: 1});
export function status(props, build = '1b93a4b1163f', boot = Date.now() - 200500) {
  const now = Date.now() - boot;  // uptime in ms, restarts from 0 on a simulated reboot
  return {now_ms: now, build, markers: [],
    status: {build, up_ms: now - 500, t_ms: now - 1500, state: 'PASSTHRU', reason: 'IDR delivered', off: 0,
      marker: 0, in_fps: 8.0, pt_fps: 8.0, stock_fps: 0, kbps: 2860, car: '1920x720@60', phone: '1920x720 p100/l40',
      fallbacks: 0, failed: 0, last_fallback: '', last_fallback_t_ms: 0, multi_vcl: 0, push_err: 0, kf_car: 0, kf_phone: 1},
    link: {up_ms: now - 50000, stream: 1, session: 1, car: 1, event: 'car video start'},
    settings: {off: props['persist.cpthru.off'] || '', latency: props['persist.suding.wl.audio.latency'] || ''}, props_ok: true,
    timing: {v: 1, build, up_ms: 200000, mono_ms: 199000, session_mono_ms: 150000, stock_sent: 0,
      stock_suppressed: 120, info_source: 'last value returned by sd_get_info_int',
      info: {VIDEO_WIDTH: info(1920, 800), VIDEO_HEIGHT: info(720, 480), VIDEO_FPS: info(60, 30)},
      available: 1, clock_res_ms: 1, window_ms: 5000, ring_max: 24, gen: 3, seq: 24,
      windows: Array.from({length: 24}, (_, i) => win(i + 1))},
    timing_error: null};
}
export const snapshot = () => ({v: 1, t0_ms: 200600, t1_ms: 201700, build: '1b93a4b1163f',
  config: {platform: 'v553', custom: 'yunlianAm', version: '202610121756C'},
  props: {'persist.cpthru.off': '0', 'persist.suding.wl.audio.latency': '600', 'persist.console.log.nosave': '',
    'persist.console.log.index': '3'}, nosave: '',
  udisk: {free_bytes: 60e6, log_bytes: 2.5e6, leftover_zip: false, leftover_zip_bytes: null},
  mem_kb: {MemTotal: 120000, MemFree: 30000}, loadavg: [1.2, 1.1, 0.9], ticks_note: 'x', sample_up_cs: [20060, 20161],
  cpu: [{name: 'cpu', total: 200, user: 90, nice: 0, system: 40, idle: 60, iowait: 0, irq: 4, softirq: 6}],
  net: [], sdDongle: {pid: 812, starttime: 1500, same_process: true, threads_seen: 1,
    threads: [{tid: 812, name: 'sdDongle', utime: 5, stime: 2}]}, missing: []});

export async function createAdapter(opts = {}) {
  const zip = await readFile(opts.zip || BASE + '/review/diag-tests/stock-logs-fixture.zip');
  const release = opts.release || JSON.parse(await readFile(BASE + '/build/release/etc/shttpd/cpthru-release.json', 'utf8'));
  const releaseImageMd5 = opts.releaseImageMd5 || null;
  const S = {
    page: opts.page || 'main', release: opts.page === 'stock' ? null : release, preview: !!opts.preview,
    props: Object.assign({'persist.cpthru.off': '0', 'persist.suding.wl.audio.latency': '600', 'persist.sys.wifi.channel': '149',
      'persist.sys.boot.delay': '0', 'persist.sys.headunit.gps.disable': '', 'persist.suding.wireless.carplay.force.display': '0',
      'persist.sys.carplay.audio.media.samplerate': ''}, opts.props || {}),
    staged: new Map(), marker: null, launches: [], factory: 0, sets: [], chunks: [], vendor: [], unexpected: [],
    down: false, hooks: {}, minizip: 0, boot: Date.now() - 200500, holdMinizip: null, restartMs: opts.restartMs ?? 3000
  };
  const sockets = new Set();
  const server = createServer(async (req, res) => {
    sockets.add(req.socket);
    const url = new URL(req.url, 'http://192.168.50.100');
    if (url.hostname !== '192.168.50.100' && url.hostname !== '127.0.0.1') { S.vendor.push(url.href); return req.socket.destroy(); }
    if (S.down) return req.socket.destroy();
    const send = (code, type, body) => { res.writeHead(code, {'content-type': type, 'cache-control': 'no-store'}); res.end(body); };
    const json = (o) => send(200, 'application/json', JSON.stringify(o));
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks), p = url.pathname, q = url.searchParams;
    const gw = S.page === 'main';
    try {
      if (opts.extraRoutes && await opts.extraRoutes(p, req, res, S)) return;
      if (p === '/cgi-bin/getversion.cgi') return send(200, 'text/plain', getversion(S.props));
      if (p === '/cgi-bin/cpthru_status.cgi') {
        if (S.page === 'stock') return send(404, 'text/plain', '');
        if (S.hooks.status) { const h = S.hooks.status(); if (h) return send(h, 'text/plain', 'error'); }
        return json(status(S.props, undefined, S.boot));
      }
      if (p === '/cgi-bin/cpthru_snapshot.cgi') return json(snapshot());
      if (p === '/cgi-bin/minizip.cgi') { S.minizip++; if (S.holdMinizip) await S.holdMinizip; return send(200, 'application/zip', zip); }
      if (p === '/cgi-bin/cpthru_settings.cgi' && gw) {
        const values = {}; MAIN.KEYS.forEach(k => { values[k] = S.props[k] ?? ''; });
        return json({ok: true, values, install_started: !!S.marker});
      }
      if (p === '/cgi-bin/cpthru_set.cgi' && gw) {
        const key = q.get('key'), value = q.get('value');
        S.sets.push([key, value]);
        if (S.preview) return json({ok: false, error: 'preview only: nothing is saved'});
        if (S.marker) return json({ok: false, error: 'a firmware install has started'});
        if (!MAIN.allowed(key, value)) return json({ok: false, error: 'unknown setting or value'});
        S.props[key] = value;
        return json({ok: true, key, value});
      }
      if (p === '/cgi-bin/factoryreset.cgi') {
        if (S.preview) return send(200, 'text/plain', 'refused: preview only (fail)');
        if (S.marker && gw) return send(200, 'text/plain', '\nrefused: a firmware install has started (fail)\n');
        S.factory++; return send(200, 'text/plain', 'reset');
      }
      if (p === '/cgi-bin/downfile.cgi') {
        if (S.marker && gw) return send(200, 'text/plain', 'upload refused: a firmware install has started (fail)\n');
        const ct = req.headers['content-type'];
        const boundary = ct.slice(ct.indexOf('boundary=') + 9);
        const mime = Buffer.from('Content-Type: application/octet-stream');
        const typeAt = raw.indexOf(mime);
        const filename = /filename="([^"]+)"/.exec(raw.subarray(0, typeAt).toString())[1];
        const length = raw.length - (typeAt + mime.length) - boundary.length - 12;
        const dataAt = typeAt + mime.length + 4;
        const chunk = raw.subarray(dataAt, dataAt + length);
        if (!raw.subarray(dataAt + length).equals(Buffer.from('\r\n--' + boundary + '--\r\n'))) throw Error('multipart layout');
        const index = S.chunks.length;
        S.chunks.push(filename);
        const hook = S.hooks.chunk ? await S.hooks.chunk(index, filename) : null;
        if (hook === 'drop') return req.socket.destroy();
        let m, name, sup = null;
        if ((m = /^(.+)\.0$/.exec(filename))) { name = m[1]; S.staged.clear(); S.staged.set(name, Buffer.from(chunk)); }
        else if ((m = /^(.+):([0-9a-f]{32})\.2$/.exec(filename))) { name = m[1]; sup = m[2]; S.staged.set(name, Buffer.concat([S.staged.get(name) || Buffer.alloc(0), chunk])); }
        else if ((m = /^(.+)\.1$/.exec(filename))) { name = m[1]; S.staged.set(name, Buffer.concat([S.staged.get(name) || Buffer.alloc(0), chunk])); }
        else throw Error('bad chunk name ' + filename);
        let body = 'Content-Type: text/html\n\n' + (sup ? 'md5_str is ' + sup + '\n' : '') +
          'result is /mnt/UDISK/swupdate/' + name + '\nwrite data------success\nupload successful\n';
        if (sup) body += md5(S.staged.get(name)) === sup ? 'file check success\n' : 'file check fail\n';
        return send(200, 'text/plain', body);
      }
      if (p === '/cgi-bin/cpthru_update.cgi' && gw) {
        const op = q.get('op'), name = q.get('name') || '', size = Number(q.get('size'));
        if (op === 'state' && S.hooks.state && S.hooks.state() === 'drop') return req.socket.destroy();
        const reject = e => json({ok: false, phase: 'rejected', error: e});
        if (name && !FWJS.NAMES.includes(name)) return reject('unexpected file name');
        if (op === 'state') return json({ok: true, phase: S.marker ? 'install-started' : 'idle', install: S.marker || '',
          staged: [...S.staged].map(([n, b]) => ({name: n, size: b.length})), free_bytes: 60e6,
          log: S.marker ? ['Installing recovery', 'Software updated successfully'] : []});
        if (op === 'verify') {
          if (S.marker) return reject('an install was already started');
          const b = S.staged.get(name);
          if (!b) return reject('no staged copy');
          if (b.length !== size) return reject('staged copy has a different size');
          return json({ok: true, name, size: b.length, md5: md5(b)});
        }
        if (op === 'install') {
          if (S.preview) return reject('preview only: nothing is installed');
          if (S.marker) return json({ok: false, phase: 'install-started', error: 'an install was already started this boot'});
          const b = S.staged.get(name);
          if (!b) return reject('no staged copy');
          if (b.length !== size) return reject('staged copy has a different size');
          if (md5(b) !== q.get('md5')) return reject('staged copy does not match the verified file');
          S.marker = 'name=' + name;
          S.launches.push({via: 'gateway', name, md5: md5(b)});
          restart(b);
          return json({ok: true, phase: 'install-started', name, md5: md5(b)});
        }
        return reject('unknown op');
      }
      if (p === '/cgi-bin/submition.cgi') {
        S.submition = (S.submition || 0) + 1;
        if (gw) return send(200, 'text/plain', 'refused: use Install firmware on the adapter main page (fail)\n');
        const name = (url.search.match(/filename=([^&]*)&/) || [])[1];
        const b = S.staged.get(name);
        S.launches.push({via: 'stock', name, md5: b ? md5(b) : null});
        if (b) restart(b);
        return send(200, 'text/plain', '');
      }
      if (p.startsWith('/cgi-bin/')) { S.unexpected.push(p); return send(404, 'text/plain', ''); }
      if (p === '/cpthru-release.json') {
        if (S.hooks.release) { const h = S.hooks.release(); if (h) return send(h, 'text/plain', 'error'); }
        return S.release ? json(S.release) : send(404, 'text/plain', '');
      }
      const path = p === '/' ? '/index.html' : p;
      if (!/^\/[A-Za-z0-9_.-]+$/.test(path)) return send(404, 'text/plain', '');
      const local = S.page === 'main' && ['/index.html', '/cpthru_fw.js', '/cpthru_main.js', '/cpthru_diag.js'].includes(path);
      const type = path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('.json') ? 'application/json' :
        path.endsWith('.png') ? 'image/png' : 'text/html; charset=utf-8';
      if (S.page === 'main' && !local && path !== '/jszip.min.js') return send(404, 'text/plain', '');
      return send(200, type, await readFile((local ? REPO + 'web' : STOCK_WEB) + path));
    } catch (e) {
      S.unexpected.push(p + ': ' + e.message);
      return send(500, 'text/plain', 'error');
    }
  });
  function restart(b) {
    setTimeout(() => {
      S.down = true;
      for (const s of sockets) s.destroy();
      setTimeout(() => {
        const sum = md5(b);
        if (sum === '8cda8cf273d665c80b2a4b217b9bdf44') { S.page = 'stock'; S.release = null; }
        else if (releaseImageMd5 && sum === releaseImageMd5) { S.page = 'main'; S.release = release; }
        S.marker = null; S.staged.clear(); S.down = false; S.boot = Date.now();
      }, S.restartMs);
    }, S.restartDelay ?? 1500);
  }
  await new Promise(r => server.listen(opts.port || 0, '127.0.0.1', r));
  return {S, server, port: server.address().port, close: () => { for (const s of sockets) s.destroy(); server.close(); }};
}
