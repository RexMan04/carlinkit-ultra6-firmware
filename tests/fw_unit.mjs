// Unit tests for web/cpthru_fw.js: hashes vs node crypto, and the image
// check on the real images plus rebuilt corrupted variants.
//   bun tests/fw_unit.mjs [--release PATH]
import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const FW = require('../web/cpthru_fw.js');
const base = '/home/kaden/models/staging/carlinkit-ultra6-fw';
const arg = (n, d) => process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d;
const releasePath = arg('--release', base + '/release/0.2.0-test.1/carlinkit-ultra6-0.2.0-test.1.swu');
let n = 0;
const ok = (c, what) => { assert(c, what); n++; };
const h = (alg, b) => createHash(alg).update(b).digest('hex');

// hashes
for (let L = 0; L < 200; L++) {
  const b = randomBytes(L);
  ok(FW.md5().update(b).hex() === h('md5', b) && FW.sha256().update(b).hex() === h('sha256', b), 'hash len ' + L);
}
for (let t = 0; t < 40; t++) {
  const b = randomBytes(Math.floor(Math.random() * 300000)), m = FW.md5(), s = FW.sha256();
  for (let i = 0; i < b.length;) { const k = Math.floor(Math.random() * 70000) + 1; m.update(b.subarray(i, i + k)); s.update(b.subarray(i, i + k)); i += k; }
  ok(m.hex() === h('md5', b) && s.hex() === h('sha256', b), 'split hash ' + t);
}

// cpio rewrite helper (like build_fw.write_cpio)
function rebuild(bytes, edit) {
  const {items} = FW.cpioItems(bytes);
  const parts = items.map(it => ({name: it.name, data: Buffer.from(bytes.subarray(it.start, it.start + it.size))}));
  edit(parts);
  const md5s = parts.filter(p => p.name !== 'cpio_item_md5').map(p => h('md5', p.data) + '  ' + p.name + '\n').join('');
  if (!edit.keepList) parts.find(p => p.name === 'cpio_item_md5').data = Buffer.from(md5s);
  const out = []; let len = 0;
  const hex = v => v.toString(16).toUpperCase().padStart(8, '0');
  const push = buf => { out.push(buf); len += buf.length; };
  const align = () => push(Buffer.alloc((4 - len % 4) % 4));
  const entry = (name, data, ino) => {
    let sum = 0; for (const x of data) sum = (sum + x) % 4294967296;
    const f = [ino, 0o100644, 0, 0, 1, 0, data.length, 0, 0, 0, 0, name.length + 1, sum];
    push(Buffer.from('070702' + f.map(hex).join('') + name + '\0')); align();
    push(data); align();
  };
  parts.forEach((p, i) => entry(p.name, p.data, i + 1));
  entry('TRAILER!!!', Buffer.alloc(0), 0);
  let b = Buffer.concat(out);
  b = Buffer.concat([b, Buffer.alloc((512 - b.length % 512) % 512)]);
  return new Uint8Array(b);
}
const load = p => new Uint8Array(readFileSync(p));
const stock = load(base + '/v5_202610121756.swu');
const diag = load(base + '/diag/v5_202610121756_passthru_diag.swu');
const orig = load(base + '/build/v5_202610121756_passthru.swu');
const rel = load(releasePath);
const meta = JSON.parse(readFileSync(releasePath.replace(/\.swu$/, '.json'), 'utf8'));

let r = await FW.analyze(stock);
ok(r.ok && r.kind === 'stock' && r.name === 'v5_202610121756_STOCK_rollback.swu' && r.md5 === '8cda8cf273d665c80b2a4b217b9bdf44', 'stock identified');
r = await FW.analyze(diag);
ok(r.ok && r.kind === 'legacy' && r.name === 'v5_202610121756_passthru_diag.swu' && r.shim === '1b93a4b1163f', 'diagnostics.1 identified');
r = await FW.analyze(orig);
ok(r.ok && r.kind === 'legacy' && r.name === 'v5_202610121756_passthru.swu' && r.shim === '32a85e24338a', 'original pass-through identified');
r = await FW.analyze(rel);
ok(r.ok && r.kind === 'project' && r.name === 'cpthru.swu' && r.release_id === meta.manifest.release_id &&
   r.version === meta.manifest.version && r.md5 === meta.md5 && r.sha256 === meta.sha256, 'release identified from its manifest');
// a rebuild with no change is still accepted (writer sanity)
r = await FW.analyze(rebuild(rel, () => {}));
ok(r.ok && r.kind === 'project', 'identity rebuild accepted: ' + r.error);

const bad = async (bytes, re, what) => {
  const x = await FW.analyze(bytes);
  ok(!x.ok && re.test(x.error), what + ' -> ' + x.error);
};
const rootfsOf = parts => parts.find(p => p.name === 'rootfs').data;
const used = d => d.readUInt32LE(40);
// 1. flipped byte inside squashfs, archive checksum left stale
{
  const b = new Uint8Array(rel); const {items} = FW.cpioItems(b); const rf = items.find(i => i.name === 'rootfs');
  b[rf.start + 5000000] ^= 1;
  await bad(b, /damaged \(archive checksum\)/, 'rootfs bit flip');
}
// 2. flipped byte with fixed checksum but stale MD5 list
const stale = e => Object.assign(e, {keepList: true});
await bad(rebuild(rel, stale(p => { rootfsOf(p)[100000] ^= 1; })), /own MD5 list/, 'rootfs flip, stale md5 list');
// 3. kernel from elsewhere (consistent archive)
await bad(rebuild(rel, p => { p.find(x => x.name === 'kernel').data[1000] ^= 1; }), /differs from stock/, 'kernel changed');
await bad(rebuild(rel, p => { p.find(x => x.name === 'sw-description').data[10] ^= 1; }), /differs from stock/, 'sw-description changed');
// 4. truncated / extra / tiny / random
await bad(rel.subarray(0, rel.length - 300000), /truncated|ends inside|Unexpected/, 'truncated');
await bad(new Uint8Array(Buffer.concat([rel, Buffer.from('extra')])), /Unexpected data after the archive/, 'trailing data');
await bad(randomBytes(100000), /Not an SWU/, 'random bytes');
await bad(new Uint8Array(100), /Wrong size/, 'tiny');
await bad(rebuild(rel, p => { p.push({name: 'extra', data: Buffer.from('x')}); }), /Unexpected archive contents/, 'extra entry');
// 5. manifest problems (archive otherwise consistent)
const setManifest = (text) => p => {
  const d = rootfsOf(p), at = Math.ceil(used(d) / 4096) * 4096;
  d.fill(0, used(d));
  if (text !== null) Buffer.from('CPTHRU-RELEASE\n' + text + '\n').copy(d, at);
};
const good = JSON.parse(JSON.stringify(meta.manifest));
await bad(rebuild(rel, setManifest(null)), /no project release manifest/, 'manifest stripped');
await bad(rebuild(rel, setManifest('{not json')), /not valid JSON/, 'manifest not JSON');
await bad(rebuild(rel, setManifest(JSON.stringify({...good, base: 'v5_999'}))), /not for this adapter/, 'manifest other base');
await bad(rebuild(rel, setManifest(JSON.stringify({...good, release_id: 'XYZ'}))), /not for this adapter/, 'manifest bad id');
await bad(rebuild(rel, setManifest(JSON.stringify({...good, label: 'x'.repeat(81)}))), /not for this adapter/, 'manifest long label');
await bad(rebuild(rel, p => { setManifest(JSON.stringify(good))(p); rootfsOf(p)[rootfsOf(p).length - 10] = 7; }), /Unexpected data after the release manifest/, 'junk after manifest');
await bad(rebuild(rel, p => { rootfsOf(p)[used(rootfsOf(p)) + 1] = 7; }), /Unexpected data after the rootfs/, 'junk before manifest');
await bad(rebuild(rel, p => { rootfsOf(p).write('xxxx', 0); }), /not a squashfs/, 'not squashfs');
r = await FW.analyze(rebuild(rel, setManifest(JSON.stringify({...good, name: '../../etc/passwd', staged_name: 'A'.repeat(200) + '.swu'}))));
ok(r.ok && r.name === 'cpthru.swu', 'a manifest cannot choose the staged name');
ok(FW.NAMES.every(x => x.length <= 40 && /^[A-Za-z0-9._-]+\.swu$/.test(x)), 'closed staged-name set, all <= 40 bytes');
// 6. describe()
const d1 = FW.describe({system: 'S', release: {version: '0.2.0-test.1', release_id: meta.manifest.release_id}}, {kind: 'project', release_id: meta.manifest.release_id});
ok(d1.match === true, 'describe match');
ok(FW.describe({system: 'S', release: null, shim: '1b93a4b1163f'}, {kind: 'project', release_id: 'aaaaaaaaaaaa'}).match === false, 'shim id never matches a release');
ok(FW.describe({system: 'S', release: null, shim: null}, {kind: 'stock'}).match === true, 'stock after rollback');
ok(FW.describe({system: 'S', release: {release_id: 'x'}, shim: null}, {kind: 'stock'}).match === false, 'still project after rollback');
console.log(`${n} firmware-check unit assertions passed`);
