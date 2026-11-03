import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
import {chromium,webkit} from '/home/kaden/.bun/install/global/node_modules/playwright/index.mjs';
const mark = (await readFile(import.meta.dir + '/bookmarklet.txt','utf8')).trim();
const fixture = spawnSync('python3',['-I','-c','import io,zipfile,sys; b=io.BytesIO(); z=zipfile.ZipFile(b,"w"); z.writestr("sample.log",b"byte check"+bytes([0,255])); z.close(); sys.stdout.buffer.write(b.getvalue())']);
assert.equal(fixture.status,0);
for (const engine of [webkit,chromium]) {
  const calls=[];
  let failure;
  // Serve every browser request ourselves. Route interception does not model
  // WebKit downloads reliably; this loopback proxy never forwards to the LAN.
  const server=createServer((req,res)=>{
    try {
      const u=new URL(req.url,'http://'+req.headers.host);
      if(u.hostname==='192.168.50.100' && u.pathname==='/cgi-bin/minizip.cgi') {
        calls.push(u.href);
        assert.equal(req.method,'GET');
        assert.equal(u.search,'?logID=local&');
        res.writeHead(200,{'content-type':'text/plain;charset=utf-8',
          'content-length':fixture.stdout.length});
        res.end(fixture.stdout);
      } else if(u.hostname==='192.168.50.100' && u.pathname==='/cpthru.html') {
        res.writeHead(200,{'content-type':'text/html'});
        res.end('<!doctype html><title>Adapter</title><body>Current page</body>');
      } else if(u.hostname==='example.test' && u.pathname==='/') {
        res.writeHead(200,{'content-type':'text/html'});
        res.end('<!doctype html><title>Other</title><body>Other</body>');
      } else if(u.pathname==='/favicon.ico') {
        res.writeHead(204);res.end();
      } else throw new Error('Unexpected request '+u);
    } catch(error) {failure=error;req.socket.destroy();}
  });
  server.on('connect',(_req,socket)=>socket.destroy());
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const proxy={server:'http://127.0.0.1:'+server.address().port};
  const executablePath = engine === webkit ? '/home/kaden/.cache/ms-playwright/webkit-2359/pw_run.sh' : '/home/kaden/.cache/ms-playwright/chromium_headless_shell-1252/chrome-headless-shell-linux64/chrome-headless-shell';
  let browser,context;
  try {
    browser=await engine.launch({headless:true,executablePath,proxy});
    context=await browser.newContext({acceptDownloads:true,proxy,serviceWorkers:'block'});
    const page=await context.newPage();
    await page.goto('http://192.168.50.100/cpthru.html');
    await page.evaluate(m=>{location.href=m},mark);
    assert.equal(calls.length,0);
    await page.evaluate(m=>{location.href=m},mark);
    assert.equal(await page.locator('#cp-debug-download').count(),1);
    const event=page.waitForEvent('download',{timeout:10000});
    await page.locator('#cp-debug-download').click();
    const dl=await event;
    assert.equal(dl.suggestedFilename(),'carlinkit-logs.zip');
    assert.equal(await dl.failure(),null);
    assert((await readFile(await dl.path())).equals(fixture.stdout));
    assert.equal(calls.length,1);
    assert.equal(await page.title(),'Adapter');
    const other=await context.newPage();
    other.on('dialog',dialog=>dialog.dismiss());
    await other.goto('http://example.test/');
    await other.evaluate(m=>{location.href=m},mark);
    assert.equal(await other.locator('#cp-debug-download').count(),0);
    assert.equal(calls.length,1);
    if(failure)throw failure;
    console.log(engine.name()+': exact ZIP bytes, filename, single explicit request, duplicate/wrong-origin guards passed');
  } finally {
    if(context)await context.close();
    if(browser)await browser.close();
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
  }
}
