import { fail } from './config.mjs';
import { builtins, validateEngine } from './engines.mjs';

// The runtime identity can read/create objects, but cannot overwrite or delete
// published versions. Conditional writes also prevent racing duplicate inserts.
export class CloudRegistry {
  constructor(bucket, fetcher) { this.bucket = bucket; this.fetch = fetcher; this.token = undefined; }
  async auth() {
    if (this.token && this.token.expiresAt > Date.now() + 60000) return this.token.value;
    const response = await this.fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
      headers: { 'Metadata-Flavor': 'Google' }, redirect: 'error', signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) fail(503, 'registry_auth', 'Engine storage authentication is unavailable.');
    const data = await response.json();
    if (typeof data.access_token !== 'string' || !Number.isFinite(data.expires_in)) fail(503, 'registry_auth', 'Engine storage authentication is unavailable.');
    this.token = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
    return this.token.value;
  }
  async request(url, options = {}) {
    let response;
    try { response = await this.fetch(url, { ...options, headers: { Authorization: `Bearer ${await this.auth()}`, ...options.headers }, redirect: 'error', signal: AbortSignal.timeout(10000) }); }
    catch { fail(503, 'registry_unavailable', 'The shared engine registry is unavailable.'); }
    if (response.status === 412 || response.status === 409) fail(409, 'engine_exists', 'This engine version already exists. Create a new version.');
    if (response.status === 401) this.token = undefined;
    if (!response.ok) fail(503, 'registry_unavailable', 'The shared engine registry is unavailable.');
    return response;
  }
  object(id, version) { return `versions/${id}/${version}.json`; }
  async read(name) {
    const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(name)}?alt=media`;
    return validateEngine(await (await this.request(url)).json());
  }
  async list() {
    const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.bucket)}/o?prefix=versions%2F&maxResults=1000&fields=items(name),nextPageToken`;
    const data = await (await this.request(url)).json();
    if (data.nextPageToken || (data.items || []).length > 1000) fail(503, 'registry_limit', 'The registry exceeds 1,000 engine versions.');
    const names = (data.items || []).map(i => i.name);
    const custom = [];
    // Bound storage read concurrency independently of engine inference.
    for (let i = 0; i < names.length; i += 8) custom.push(...await Promise.all(names.slice(i, i + 8).map(name => this.read(name))));
    return [...builtins, ...custom];
  }
  async get(id, version) {
    const builtin = builtins.find(e => e.id === id && e.version === version);
    if (builtin) return builtin;
    // Validate identities before forming an object path.
    if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/.test(id) || typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) fail(404, 'engine_not_found', 'Choose an exact engine version.');
    const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(this.object(id, version))}?alt=media`;
    const response = await this.fetch(url, { headers: { Authorization: `Bearer ${await this.auth()}` }, redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (response.status === 404) fail(404, 'engine_not_found', 'Choose an engine and its exact version from /v1/engines.');
    if (!response.ok) fail(503, 'registry_unavailable', 'The shared engine registry is unavailable.');
    return validateEngine(await response.json());
  }
  async create(input) {
    const engine = validateEngine(input);
    if (builtins.some(e => e.id === engine.id && e.version === engine.version)) fail(409, 'engine_exists', 'This engine version already exists.');
    const all = await this.list();
    if (all.length >= 1000) fail(409, 'registry_limit', 'The registry is limited to 1,000 versions.');
    const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o?uploadType=media&ifGenerationMatch=0&name=${encodeURIComponent(this.object(engine.id, engine.version))}`;
    await this.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(engine) });
    return engine;
  }
}
