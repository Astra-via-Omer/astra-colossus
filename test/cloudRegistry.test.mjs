import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudRegistry } from '../src/cloudRegistry.mjs';
import { builtins } from '../src/engines.mjs';

test('Cloud Storage registry uses runtime identity, immutable writes, and shared reads', async () => {
  const objects = new Map(); let tokens = 0;
  const fetcher = async (url, options) => {
    if (url.startsWith('http://metadata.google.internal/')) {
      tokens++; assert.equal(options.headers['Metadata-Flavor'], 'Google');
      return Response.json({ access_token: 'synthetic-runtime-token', expires_in: 3600 });
    }
    assert.equal(options.headers.Authorization, 'Bearer synthetic-runtime-token');
    const parsed = new URL(url);
    if (options.method === 'POST') {
      assert.equal(parsed.searchParams.get('ifGenerationMatch'), '0');
      const name = parsed.searchParams.get('name');
      if (objects.has(name)) return new Response(null, { status: 412 });
      objects.set(name, JSON.parse(options.body)); return Response.json({ name });
    }
    if (parsed.searchParams.has('prefix')) return Response.json({ items: [...objects.keys()].map(name => ({ name })) });
    const name = decodeURIComponent(parsed.pathname.split('/o/')[1]);
    return objects.has(name) ? Response.json(objects.get(name)) : new Response(null, { status: 404 });
  };
  const first = new CloudRegistry('test-bucket', fetcher), second = new CloudRegistry('test-bucket', fetcher);
  const manifest = { ...builtins[0], id: 'shared-cloud-engine' };
  await first.create(manifest);
  assert.equal((await second.get(manifest.id, manifest.version)).id, manifest.id);
  await assert.rejects(() => second.create(manifest), e => e.status === 409);
  assert.equal((await second.list()).length, builtins.length + 1);
  assert.equal(tokens, 2);
  await assert.rejects(() => second.get('not-there', '1.0.0'), e => e.status === 404);
  await assert.rejects(() => second.get('../escape', '1.0.0'), e => e.status === 404);
});
