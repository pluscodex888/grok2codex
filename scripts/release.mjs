import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

// This independent package owns its file inventory. Consumers ship one archive.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const paths = ['LICENSE', 'README.md', 'package.json', ...readdirSync(resolve(root, 'src')).filter(n => /\.(mjs|ts)$/.test(n)).map(n => `src/${n}`)].sort();
const files = paths.map(path => ({ path, data: readFileSync(resolve(root, path)) }));
const manifest = { schemaVersion: 1, name: pkg.name, version: pkg.version, entry: 'src/index.mjs', files: Object.fromEntries(files.map(f => [f.path, createHash('sha256').update(f.data).digest('hex')])) };
files.unshift({ path: 'grok2codex-manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n') });
const blocks = [];
for (const { path, data } of files) {
  if (Buffer.byteLength(path) > 99) throw new Error('Release path exceeds ustar name limit');
  const header = Buffer.alloc(512);
  header.write(path); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
  header.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
  header.write('00000000000\0', 136); header.fill(32, 148, 156); header.write('0', 156);
  header.write('ustar\0', 257); header.write('00', 263);
  header.write([...header].reduce((a,b) => a+b, 0).toString(8).padStart(6, '0') + '\0 ', 148);
  blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
}
blocks.push(Buffer.alloc(1024));
const archive = gzipSync(Buffer.concat(blocks), { level: 9 });
const out = resolve(process.argv[2] || resolve(root, 'dist/grok2codex.tar.gz'));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, archive);
console.log(JSON.stringify({ version: pkg.version, path: out, bytes: archive.length, sha256: createHash('sha256').update(archive).digest('hex') }));
