// Builds the generic first-install bookmark: phone-upload/loader-v2.js with
// web/cpthru_fw.js inlined -> phone-upload-v2/{loader.min.js,bookmarklet.txt}.
// The original phone-upload/ and phone-upload-diag/ outputs are not touched.
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const root = import.meta.dir + '/..';
// The node-test export branch is removed so the bundler cannot wrap the
// updater as a CommonJS module (which would skip window.CPFW).
const fwSrc = await readFile(root + '/web/cpthru_fw.js', 'utf8');
const NODE = 'if (typeof module !== "undefined" && module.exports) { module.exports = api; return; }';
assert.equal(fwSrc.split(NODE).length, 2, 'node export line not found exactly once');
const TAIL = '})(typeof window !== "undefined" ? window : this);';
assert.equal(fwSrc.split(TAIL).length, 2, 'IIFE tail not found exactly once');
const fw = fwSrc.replace(NODE, '').replace(TAIL, '})(window);');
const loader = (await readFile(import.meta.dir + '/loader-v2.js', 'utf8')).replace('__CPFW__', () => fw);
const out = await Bun.build({entrypoints: [import.meta.dir + '/loader-v2.js'], target: 'browser', format: 'iife', minify: true,
  plugins: [{name: 'inline', setup(b) { b.onLoad({filter: /loader-v2\.js$/}, () => ({contents: loader, loader: 'js'})); }}]});
assert(out.success, 'build failed');
const payload = 'void function(){' + (await out.outputs[0].text()).trim() + '}()';
assert(!payload.includes('__CPFW__') && !/\bexports\b/.test(payload), 'bundle must be plain browser code');
// encodeURI plus '#' (fragment) keeps the URL valid and percent-decodes back
// to exactly the payload, at about two thirds of encodeURIComponent's length.
const mark = 'javascript:' + encodeURI(payload).replace(/#/g, '%23');
assert.equal(decodeURIComponent(mark.slice(11)), payload);
assert(!/[\s#"<>\\^`{|}]/.test(mark), 'unsafe URL characters');
await mkdir(root + '/phone-upload-v2', {recursive: true});
await writeFile(root + '/phone-upload-v2/loader.min.js', payload + '\n');
await writeFile(root + '/phone-upload-v2/bookmarklet.txt', mark + '\n');
console.log(`bookmark: ${payload.length} JS chars, ${mark.length} bookmark chars, sha256 ${createHash('sha256').update(mark + '\n').digest('hex')}`);
