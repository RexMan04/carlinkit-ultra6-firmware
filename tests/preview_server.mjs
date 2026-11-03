// Local preview of the real 0.2 main page against the simulated adapter in
// tests/mock_adapter.mjs (sample data; settings, presets and uploads change
// only the simulation's memory). A banner marks the page as a preview.
//   bun tests/preview_server.mjs [--port 8765]
import {readFile} from 'node:fs/promises';
import {createAdapter, BASE} from './mock_adapter.mjs';
const port = Number(process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : 8765);
const REPO = new URL('..', import.meta.url).pathname;
const rel = BASE + '/release/0.2.0-test.1/carlinkit-ultra6-0.2.0-test.1.json';
const meta = JSON.parse(await readFile(rel, 'utf8'));
const banner = '<div style="position:sticky;top:0;z-index:50;background:#ffe14d;color:#131210;font:600 14px/1.4 system-ui;' +
  'padding:8px 16px;border-bottom:2px solid #111">PREVIEW: simulated adapter with sample data. Nothing here talks to a real adapter.</div>';
const A = await createAdapter({port, releaseImageMd5: meta.md5, restartMs: 4000,
  extraRoutes: async (p, req, res) => {
    if (p !== '/' && p !== '/index.html') return false;
    const html = (await readFile(REPO + 'web/index.html', 'utf8')).replace('<body>', '<body>' + banner);
    res.writeHead(200, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'});
    res.end(html);
    return true;
  }});
console.log(`preview: http://127.0.0.1:${A.port}/`);
