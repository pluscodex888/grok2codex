import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

test('one release archive contains both usable adapters and every declared entry point', async () => {
  const temporaryRoot = resolve(tmpdir());
  const temporary = mkdtempSync(join(temporaryRoot, 'grok2codex-delivery-'));
  try {
    const archive = join(temporary, 'bridge.tar.gz');
    const result = spawnSync(process.execPath, [join(root, 'scripts/release.mjs'), archive], {
      cwd: root, encoding: 'utf8', timeout: 15_000,
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const published = JSON.parse(result.stdout);
    const compressed = readFileSync(archive);
    assert.equal(published.bytes, compressed.length);
    assert.equal(published.sha256, sha256(compressed));
    const tar = gunzipSync(compressed);
    const extracted = join(temporary, 'package');
    mkdirSync(extracted);
    const entries = new Map();
    for (let offset = 0; offset + 512 <= tar.length;) {
      const header = tar.subarray(offset, offset + 512);
      if (header.every(byte => byte === 0)) break;
      const name = header.subarray(0, 100).toString().replace(/\0.*$/s, '');
      const size = Number.parseInt(header.subarray(124, 136).toString().replace(/\0.*$/s, ''), 8);
      assert.match(name, /^[A-Za-z0-9_.\/-]+$/);
      assert.ok(!name.startsWith('/') && !name.split('/').includes('..'));
      assert.equal(header[156], 48, 'only regular files are distributed');
      assert.ok(!entries.has(name), `duplicate archive entry: ${name}`);
      const data = tar.subarray(offset + 512, offset + 512 + size);
      assert.equal(data.length, size);
      const destination = resolve(extracted, name);
      assert.ok(destination.startsWith(extracted + sep));
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, data);
      entries.set(name, data);
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    const manifest = JSON.parse(entries.get('grok2codex-manifest.json'));
    const pkg = JSON.parse(entries.get('package.json'));
    const nativePkg = JSON.parse(entries.get('gem2codex/package.json'));
    assert.equal(manifest.entry, 'src/index.mjs');
    assert.equal(manifest.version, pkg.version);
    assert.equal(nativePkg.version, pkg.version);
    assert.equal(nativePkg.private, true);
    assert.equal(manifest.name, '@grok2codex/client-bridge');
    assert.equal(entries.size, Object.keys(manifest.files).length + 1);
    for (const [name, digest] of Object.entries(manifest.files)) {
      assert.equal(sha256(entries.get(name)), digest, name);
      assert.equal(sha256(readFileSync(join(root, name))), digest, `source mismatch: ${name}`);
      assert.ok(!name.includes('.git/') && !name.startsWith('test/') && !name.includes('.env'));
    }
    for (const target of Object.values(pkg.exports)) {
      const modulePath = typeof target === 'string' ? target : target.import;
      assert.ok(entries.has(modulePath.replace(/^\.\//, '')), modulePath);
      await import(pathToFileURL(join(extracted, modulePath)).href);
      if (target.types) assert.ok(entries.has(target.types.replace(/^\.\//, '')), target.types);
    }
    const api = await import(pathToFileURL(join(extracted, manifest.entry)).href);
    assert.equal(api.createHandshake({ codex: { fingerprint: 'delivery-fixture' } }).bridgeVersion, pkg.version);
    for (const name of ['createClientToolPassthrough', 'createResponsesToolCodec', 'createEnhancedDesktopRelay', 'isGrokModel']) {
      assert.equal(typeof api[name], 'function', name);
    }
    const nativeHttp = await import(pathToFileURL(join(extracted, 'gem2codex/src/gemini-http.mjs')).href);
    const transport = nativeHttp.createGeminiTransport({
      baseUrl: 'https://gemini.example',
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'Invalid schema', status: 'INVALID_ARGUMENT' } }), { status: 400 }),
    });
    await assert.rejects(transport.complete({ request: { model: 'gemini-test', contents: [] } }), error => {
      assert.equal(error.details.status, 400);
      return true;
    });
  } finally {
    const exact = resolve(temporary);
    assert.equal(dirname(exact), temporaryRoot);
    assert.ok(exact.startsWith(join(temporaryRoot, 'grok2codex-delivery-')));
    rmSync(exact, { recursive: true, force: true });
  }
});
