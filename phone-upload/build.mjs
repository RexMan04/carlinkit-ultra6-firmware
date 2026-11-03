import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';

const dir = import.meta.dir;
const base = '/home/kaden/models/staging/carlinkit-ultra6-fw';
const specs = [
  {path: 'build/v5_202610121756_passthru.swu', mail: 'mail/v5_202610121756_passthru.swu',
    name: 'v5_202610121756_passthru.swu', label: 'Pass-through', md5: '3bbb773174a282a623860ecbb319b2ae'},
  {path: 'v5_202610121756.swu', mail: 'mail/v5_202610121756_STOCK_rollback.swu',
    name: 'v5_202610121756_STOCK_rollback.swu', label: 'Stock rollback', md5: '8cda8cf273d665c80b2a4b217b9bdf44'}
];
const known = [];
for (const spec of specs) {
  const bytes = await readFile(`${base}/${spec.path}`);
  assert(bytes.equals(await readFile(`${base}/${spec.mail}`)), 'Mail image differs: ' + spec.path);
  const digest = name => createHash(name).update(bytes).digest('hex');
  assert.equal(digest('md5'), spec.md5, 'Expected firmware changed');
  known.push({...spec, size: bytes.length, sha256: digest('sha256')});
}
await writeFile(`${dir}/images.json`, JSON.stringify(known, null, 2) + '\n');
const source = (await readFile(`${dir}/upload.js`, 'utf8'))
  .replace('__KNOWN_IMAGES__', JSON.stringify(known.map(({path, mail, ...image}) => image)));
const compact = await Bun.build({entrypoints: [dir + '/upload.js'], target: 'browser', minify: true,
  plugins: [{name: 'known-images', setup(builder) {
    builder.onLoad({filter: /upload\.js$/}, () => ({contents: source, loader: 'js'}));
  }}]});
assert(compact.success, 'Bun build failed');
const payload = 'void function(){' + (await compact.outputs[0].text()).trim() + '}()';
assert(!payload.includes('__KNOWN_IMAGES__'));
await writeFile(`${dir}/upload.min.js`, payload + '\n');
await writeFile(`${dir}/bookmarklet.txt`, 'javascript:' + encodeURIComponent(payload) + '\n');
console.log(`Built upload-only bookmarklet: ${payload.length} JS characters, ${('javascript:' + encodeURIComponent(payload)).length} bookmark characters`);
