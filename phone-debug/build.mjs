import {writeFile} from 'node:fs/promises';
const result = await Bun.build({entrypoints:[import.meta.dir + '/download.js'],target:'browser',minify:true});
if (!result.success) throw new Error('Bookmark build failed');
const code = 'void function(){' + (await result.outputs[0].text()).trim() + '}()';
await writeFile(import.meta.dir + '/bookmarklet.txt','javascript:' + encodeURIComponent(code) + '\n');
console.log('Built read-only log download bookmarklet.');
