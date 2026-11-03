// Builds the upload-only bookmarklet for an exact list of known images.
//
//   bun phone-upload/build.mjs
//       original behaviour: the delivered pass-through + stock rollback images
//       (each must match its emailed copy) -> phone-upload/. Refuses to
//       change any existing generated file there.
//   bun phone-upload/build.mjs --spec phone-upload/spec-diag.json
//       images from a spec file -> the spec's own output directory (never
//       phone-upload/). Expected hashes may come from a build_fw.py release
//       metadata file; a mail/ copy is optional. The four original generated
//       files in phone-upload/ are checked unchanged before and after.
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';

const dir = import.meta.dir;
const root = resolve(dir, '..');
const base = '/home/kaden/models/staging/carlinkit-ultra6-fw';
const ORIGINAL = ['bookmarklet.txt', 'images.json', 'upload.min.js', 'test-results.json'];
const ORIGINAL_BOOKMARK_SHA256 = 'f1d8b5523033e29bc642a5ff3a1760b9624ace96ac5c5fae7c1e3464c249a0ea';
const defaultSpecs = [
  {path: 'build/v5_202610121756_passthru.swu', mail: 'mail/v5_202610121756_passthru.swu',
    name: 'v5_202610121756_passthru.swu', label: 'Pass-through', md5: '3bbb773174a282a623860ecbb319b2ae'},
  {path: 'v5_202610121756.swu', mail: 'mail/v5_202610121756_STOCK_rollback.swu',
    name: 'v5_202610121756_STOCK_rollback.swu', label: 'Stock rollback', md5: '8cda8cf273d665c80b2a4b217b9bdf44'}
];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function originalHashes() {
  const out = {};
  for (const name of ORIGINAL) out[name] = existsSync(`${dir}/${name}`) ? sha(await readFile(`${dir}/${name}`)) : null;
  return out;
}

const args = process.argv.slice(2);
const at = args.indexOf('--spec');
const specFile = at >= 0 ? resolve(args[at + 1] || '') : null;
let specs = defaultSpecs, outDir = dir;
if (specFile) {
  const spec = JSON.parse(await readFile(specFile, 'utf8'));
  assert(typeof spec.out === 'string' && /^[A-Za-z0-9._-]+$/.test(spec.out), 'spec.out must be a plain directory name');
  outDir = resolve(root, spec.out);
  assert(Array.isArray(spec.images) && spec.images.length >= 1, 'spec.images');
  specs = spec.images;
}
assert(resolve(outDir) !== resolve(dir) || !specFile, 'REFUSED: a spec build may not write into phone-upload/');
const before = await originalHashes();
if (specFile) assert.equal(before['bookmarklet.txt'], ORIGINAL_BOOKMARK_SHA256, 'original bookmarklet.txt changed');

const known = [];
for (const spec of specs) {
  assert(/^[A-Za-z0-9._-]+\.swu$/.test(spec.name) && spec.label, 'image name/label');
  const bytes = await readFile(`${base}/${spec.path}`);
  if (spec.mail) assert(bytes.equals(await readFile(`${base}/${spec.mail}`)), 'Mail image differs: ' + spec.path);
  const digest = name => createHash(name).update(bytes).digest('hex');
  let expect = {md5: spec.md5, sha256: spec.sha256, size: spec.size};
  if (spec.metadata) {
    const meta = JSON.parse(await readFile(`${base}/${spec.metadata}`, 'utf8'));
    assert.equal(meta.name, spec.path.split('/').pop(), 'metadata describes another file');
    expect = {md5: meta.md5, sha256: meta.sha256, size: meta.size};
  }
  assert(expect.md5, 'no expected MD5 for ' + spec.path);
  assert.equal(digest('md5'), expect.md5, 'Expected firmware changed: ' + spec.path);
  if (expect.sha256) assert.equal(digest('sha256'), expect.sha256, 'SHA256 differs: ' + spec.path);
  if (expect.size) assert.equal(bytes.length, expect.size, 'size differs: ' + spec.path);
  const {metadata, ...image} = spec;
  known.push({...image, md5: digest('md5'), size: bytes.length, sha256: digest('sha256')});
}
assert.equal(new Set(known.map(i => i.md5)).size, known.length, 'duplicate images');

// Labels and the rejection message come from the spec. For the original
// images this reproduces the original text exactly.
const mismatch = 'File is not the verified ' + known.map(i => i.label.toLowerCase()).join(' or ') + ' image.';
const source = (await readFile(`${dir}/upload.js`, 'utf8'))
  .replace('__KNOWN_IMAGES__', JSON.stringify(known.map(({path, mail, ...image}) => image)))
  .replace('__MISMATCH__', JSON.stringify(mismatch));
const compact = await Bun.build({entrypoints: [dir + '/upload.js'], target: 'browser', minify: true,
  plugins: [{name: 'known-images', setup(builder) {
    builder.onLoad({filter: /upload\.js$/}, () => ({contents: source, loader: 'js'}));
  }}]});
assert(compact.success, 'Bun build failed');
const payload = 'void function(){' + (await compact.outputs[0].text()).trim() + '}()';
assert(!payload.includes('__KNOWN_IMAGES__') && !payload.includes('__MISMATCH__'));
const outputs = {
  'images.json': JSON.stringify(known, null, 2) + '\n',
  'upload.min.js': payload + '\n',
  'bookmarklet.txt': 'javascript:' + encodeURIComponent(payload) + '\n'
};
await mkdir(outDir, {recursive: true});
if (!specFile) {
  // Original location: never change a generated file that already exists.
  for (const [name, text] of Object.entries(outputs)) {
    const path = `${outDir}/${name}`;
    if (existsSync(path)) assert.equal(await readFile(path, 'utf8'), text, `REFUSED: would change ${path}`);
  }
}
for (const [name, text] of Object.entries(outputs)) await writeFile(`${outDir}/${name}`, text);
assert.deepEqual(await originalHashes(), before, 'original phone-upload files changed');
console.log(`Built upload-only bookmarklet in ${outDir}: ${payload.length} JS characters, ${outputs['bookmarklet.txt'].trim().length} bookmark characters`);
console.log('Accepted images: ' + known.map(i => `${i.label} ${i.name} md5 ${i.md5}`).join('; '));
