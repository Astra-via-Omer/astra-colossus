import { randomBytes, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { CloudRegistry } from './cloudRegistry.mjs';
import { fail } from './config.mjs';

const validId = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export class Sessions {
  constructor(config, fetcher, now = Date.now) {
    this.config = config; this.fetch = fetcher; this.now = now; this.local = new Map();
    this.bucket = config.sessionBucket;
    this.cloud = this.bucket ? new CloudRegistry(this.bucket, fetcher) : undefined;
    this.key = createHash('sha256').update('astra-colossus/session/v1\0').update(config.sessionSecret).digest();
  }
  seal(id, value) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(id));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return { iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), data: ciphertext.toString('base64url') };
  }
  open(id, value) {
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(value.iv, 'base64url'));
      decipher.setAAD(Buffer.from(id)); decipher.setAuthTag(Buffer.from(value.tag, 'base64url'));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.data, 'base64url')), decipher.final()]).toString('utf8'));
    } catch { fail(401, 'session_expired', 'Your session has ended. Sign in again.'); }
  }
  async storage(name, body) {
    const encoded = encodeURIComponent(name), bucket = encodeURIComponent(this.bucket);
    const url = body === undefined
      ? `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encoded}?alt=media`
      : `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&ifGenerationMatch=0&name=${encoded}`;
    let response;
    try {
      response = await this.fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { Authorization: `Bearer ${await this.cloud.auth()}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    } catch { fail(503, 'session_unavailable', 'Account sessions are temporarily unavailable. Try again shortly.'); }
    if (body === undefined && response.status === 404) return undefined;
    if (body !== undefined && [409, 412].includes(response.status)) return undefined;
    if (!response.ok) fail(503, 'session_unavailable', 'Account sessions are temporarily unavailable. Try again shortly.');
    try { return await response.json(); }
    catch { fail(503, 'session_unavailable', 'Account sessions are temporarily unavailable. Try again shortly.'); }
  }
  async create(token, lifetime = 3600) {
    if (typeof token !== 'string' || !token || token.length > 16000 || /\s/.test(token)) fail(503, 'auth_unavailable', 'The shared sign-in service returned an invalid session.');
    if (!Number.isFinite(lifetime) || lifetime <= 0) fail(401, 'session_expired', 'Your session has ended. Sign in again.');
    const seconds = Math.min(Math.floor(lifetime), 3600), id = randomBytes(32).toString('hex');
    if (seconds < 1) fail(401, 'session_expired', 'Your session has ended. Sign in again.');
    const expiresAt = this.now() + seconds * 1000, record = this.seal(id, { token, expiresAt });
    if (this.cloud) await this.storage(`sessions/active/${id}.json`, record);
    else {
      if (this.config.production) fail(503, 'session_unavailable', 'Shared account session storage is not configured.');
      for (const [key, value] of this.local) if (value.expiresAt <= this.now()) this.local.delete(key);
      if (this.local.size >= 1000) fail(503, 'session_capacity', 'Account sessions are at capacity. Try again shortly.');
      this.local.set(id, { record, expiresAt });
    }
    return { id, expiresAt, seconds };
  }
  async get(id) {
    if (!validId(id)) fail(401, 'session_expired', 'Your session has ended. Sign in again.');
    let record;
    if (this.cloud) {
      const [saved, revoked] = await Promise.all([this.storage(`sessions/active/${id}.json`), this.storage(`sessions/revoked/${id}.json`)]);
      if (revoked) fail(401, 'session_expired', 'Your session has ended. Sign in again.');
      record = saved;
    } else record = this.local.get(id)?.record;
    if (!record) fail(401, 'session_expired', 'Your session has ended. Sign in again.');
    const value = this.open(id, record);
    if (typeof value.token !== 'string' || !Number.isFinite(value.expiresAt) || value.expiresAt <= this.now()) {
      this.local.delete(id); fail(401, 'session_expired', 'Your session has ended. Sign in again.');
    }
    return value;
  }
  async revoke(id) {
    if (!validId(id)) return;
    if (this.cloud) await this.storage(`sessions/revoked/${id}.json`, { revokedAt: this.now() });
    else this.local.delete(id);
  }
}
