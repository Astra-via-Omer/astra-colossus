import { Transform } from 'node:stream';
import { CloudRegistry } from './cloudRegistry.mjs';
import { fail } from './config.mjs';

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
export function tokenUsage(raw) {
  const inputTokens = count(raw?.prompt_tokens), outputTokens = count(raw?.completion_tokens);
  const sum = inputTokens !== null && outputTokens !== null ? count(inputTokens + outputTokens) : null;
  const reported = count(raw?.total_tokens);
  const cached = count(raw?.prompt_cache_hit_tokens ?? raw?.prompt_tokens_details?.cached_tokens);
  const reasoning = count(raw?.completion_tokens_details?.reasoning_tokens);
  return { inputTokens, outputTokens, totalTokens: sum ?? reported,
    cachedInputTokens: inputTokens !== null && cached !== null && cached <= inputTokens ? cached : null,
    reasoningTokens: outputTokens !== null && reasoning !== null && reasoning <= outputTokens ? reasoning : null,
    complete: sum !== null && (reported === null || reported === sum) };
}
export function tokenCost(usage, rates) {
  if (!rates || usage.inputTokens === null || usage.outputTokens === null) return { usd: null, complete: false };
  let cached = usage.cachedInputTokens;
  if (cached === null && rates.cachedInputPerMillion === rates.inputPerMillion) cached = 0;
  if (cached === null || (cached > 0 && rates.cachedInputPerMillion === undefined)) return { usd: null, complete: false };
  const usd = ((usage.inputTokens - cached) * rates.inputPerMillion + cached * (rates.cachedInputPerMillion ?? rates.inputPerMillion) + usage.outputTokens * rates.outputPerMillion) / 1000000;
  return { usd, complete: usage.complete };
}

// Inspect only bounded SSE event data and forward the original bytes unchanged.
export class UsageStream extends Transform {
  constructor(onUsage) { super(); this.decoder = new TextDecoder(); this.pending = ''; this.dropping = false; this.onUsage = onUsage; }
  inspect(text) {
    for (const part of text.split(/(?<=\n)/)) {
      if (!this.dropping) this.pending += part;
      if (this.pending.length > 262144) { this.pending = ''; this.dropping = true; }
      if (part.endsWith('\n')) {
        if (!this.dropping && this.pending.startsWith('data:')) {
          try { const data = JSON.parse(this.pending.slice(5).trim()); if (data.usage) this.onUsage(data.usage); } catch { /* Content deltas and DONE are not usage. */ }
        }
        this.pending = ''; this.dropping = false;
      }
    }
  }
  _transform(chunk, _encoding, callback) { this.inspect(this.decoder.decode(chunk, { stream: true })); callback(null, chunk); }
  _flush(callback) { this.inspect(this.decoder.decode() + '\n'); callback(); }
}

export function summarize(records) {
  const calls = records.flatMap(record => record.calls);
  const pending = records.some(record => ['running', 'stale'].includes(record.status));
  const sum = field => calls.some(call => call.usage[field] !== null) || (!calls.length && !pending)
    ? calls.reduce((total, call) => total + (call.usage[field] ?? 0), 0) : null;
  const reportedCalls = calls.filter(call => call.usage.complete).length;
  const pricedCalls = calls.filter(call => call.cost.usd !== null && call.cost.complete).length;
  const estimatedCostUsd = calls.reduce((total, call) => total + (call.cost.usd ?? 0), 0);
  const pricedTokens = calls.reduce((total, call) => total + (call.cost.usd !== null ? call.usage.totalTokens ?? 0 : 0), 0);
  const pricedDurationMs = calls.reduce((total, call) => total + (call.cost.usd !== null ? call.durationMs : 0), 0);
  const terminal = records.filter(record => !['running', 'stale'].includes(record.status));
  return { processes: records.length, running: records.filter(record => record.status === 'running').length,
    completed: records.filter(record => record.status === 'completed').length,
    failed: records.filter(record => ['failed', 'cancelled'].includes(record.status)).length,
    stale: records.filter(record => record.status === 'stale').length, calls: calls.length, reportedCalls, pricedCalls,
    inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), totalTokens: sum('totalTokens'),
    cachedInputTokens: sum('cachedInputTokens'), reasoningTokens: sum('reasoningTokens'),
    usageComplete: reportedCalls === calls.length && records.every(record => !['running', 'stale'].includes(record.status)),
    estimatedCostUsd: (calls.length || pending) && !calls.some(call => call.cost.usd !== null) ? null : estimatedCostUsd,
    costComplete: pricedCalls === calls.length && records.every(record => !['running', 'stale'].includes(record.status)),
    costPerTokenUsd: pricedTokens > 0 ? estimatedCostUsd / pricedTokens : null,
    costPerProviderMinuteUsd: pricedDurationMs > 0 ? estimatedCostUsd / (pricedDurationMs / 60000) : null,
    durationMs: terminal.reduce((total, record) => total + record.durationMs, 0),
    averageDurationMs: terminal.length ? terminal.reduce((total, record) => total + record.durationMs, 0) / terminal.length : null,
    providerDurationMs: calls.reduce((total, call) => total + call.durationMs, 0) };
}

export class UsageMonitor {
  constructor(config, fetcher, now = Date.now) {
    this.config = config; this.now = now; this.local = new Map(); this.active = new Map(); this.finished = new Map();
    this.bucket = config.usageBucket; this.fetch = fetcher;
    this.cloud = this.bucket ? new CloudRegistry(this.bucket, fetcher) : undefined;
  }
  name(record, phase) {
    // Reverse time keeps bounded cloud queries ordered newest first.
    return `usage/v1/${record.startedAt.slice(0, 10)}/${String(9999999999999 - Date.parse(record.startedAt)).padStart(13, '0')}-${record.requestId}/${phase}.json`;
  }
  async request(url, options = {}) {
    try {
      const response = await this.fetch(url, { ...options, headers: { Authorization: `Bearer ${await this.cloud.auth()}`, ...options.headers }, redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw Error();
      return await response.json();
    } catch { fail(503, 'usage_unavailable', 'Usage monitoring storage is unavailable.'); }
  }
  async save(record, phase) {
    if (!this.cloud) {
      if (this.config.production) fail(503, 'usage_unavailable', 'Shared usage monitoring storage is not configured.');
      this.local.set(record.requestId, structuredClone(record));
      if (this.local.size > 1000) this.local.delete(this.local.keys().next().value);
      return;
    }
    const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o?uploadType=media&ifGenerationMatch=0&name=${encodeURIComponent(this.name(record, phase))}`;
    await this.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(record) });
  }
  async start(identity, requestId, operation) {
    const record = { schemaVersion: 1, requestId, operation,
      actor: identity.kind === 'account' ? { kind: 'account', id: identity.id, email: identity.email } : { kind: 'service', id: identity.id, email: '' },
      startedAt: new Date(this.now()).toISOString(), completedAt: null, durationMs: 0, status: 'running', calls: [] };
    await this.save(record, 'started'); this.active.set(requestId, record); return record;
  }
  call(record, route, engine) {
    const call = { index: record.calls.length + 1, route: route.alias, providerModel: route.model,
      ...(engine ? { engine: { id: engine.id, version: engine.version } } : {}),
      startedAt: new Date(this.now()).toISOString(), durationMs: 0, status: 'running',
      usage: tokenUsage(), rates: route.pricing ? { ...route.pricing } : null, cost: { usd: null, complete: false } };
    record.calls.push(call); return call;
  }
  finishCall(call, status, usage, httpStatus) {
    if (usage !== undefined) call.usage = tokenUsage(usage);
    call.status = status; call.durationMs = Math.max(0, this.now() - Date.parse(call.startedAt));
    if (httpStatus !== undefined) call.httpStatus = httpStatus;
    call.cost = tokenCost(call.usage, call.rates);
  }
  async finish(record, status, errorCode) {
    if (!record || record.status !== 'running') return;
    record.status = status; record.completedAt = new Date(this.now()).toISOString();
    record.durationMs = Math.max(0, this.now() - Date.parse(record.startedAt));
    if (errorCode) record.errorCode = errorCode;
    for (const call of record.calls) if (call.status === 'running') this.finishCall(call, status === 'cancelled' ? 'cancelled' : 'failed');
    try { await this.save(record, 'finished'); } finally { this.active.delete(record.requestId); }
  }
  async records(days) {
    const cutoff = this.now() - days * 86400000;
    if (!this.cloud) return { records: [...this.local.values()].filter(r => Date.parse(r.startedAt) >= cutoff), limited: this.local.size >= 1000 };
    const groups = new Map(); let limited = false;
    for (let day = this.now(); day >= cutoff - 86400000; day -= 86400000) {
      const date = new Date(day).toISOString().slice(0, 10), prefix = `usage/v1/${date}/`;
      let page = '';
      do {
        const query = new URLSearchParams({ prefix, maxResults: '1000', fields: 'items(name),nextPageToken', ...(page ? { pageToken: page } : {}) });
        const data = await this.request(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.bucket)}/o?${query}`);
        for (const item of data.items || []) {
          const match = /^usage\/v1\/\d{4}-\d{2}-\d{2}\/(\d{13})-([a-f0-9-]{36})\/(started|finished)\.json$/.exec(item.name);
          if (!match || 9999999999999 - Number(match[1]) < cutoff) continue;
          if (!groups.has(match[2]) && groups.size >= 1000) { limited = true; break; }
          const existing = groups.get(match[2]);
          if (!existing || match[3] === 'finished') groups.set(match[2], item.name);
        }
        page = data.nextPageToken || '';
      } while (page && !limited);
      if (limited) break;
    }
    const names = [...groups.values()], records = [];
    for (let i = 0; i < names.length; i += 8) records.push(...await Promise.all(names.slice(i, i + 8).map(async name => {
      if (this.finished.has(name)) return this.finished.get(name);
      const record = await this.request(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(name)}?alt=media`);
      if (name.endsWith('/finished.json')) {
        this.finished.set(name, record);
        if (this.finished.size > 1000) this.finished.delete(this.finished.keys().next().value);
      }
      return record;
    })));
    return { records, limited };
  }
  async snapshot(days = 1, userId = '') {
    if (![1, 7, 30].includes(days) || (userId && !/^(?:[a-f0-9-]{36}|service-[a-f0-9]{12})$/i.test(userId))) fail(400, 'invalid_usage_filter', 'Choose 1, 7 or 30 days and a valid account ID.');
    const saved = await this.records(days), cutoff = this.now() - days * 86400000;
    const combined = new Map(saved.records.map(record => [record.requestId, record]));
    for (const [id, record] of this.active) if (Date.parse(record.startedAt) >= cutoff) combined.set(id, structuredClone(record));
    const records = [...combined.values()].map(record => {
      if (record.status === 'running') {
        record.durationMs = Math.max(0, this.now() - Date.parse(record.startedAt));
        if (record.durationMs > this.config.timeout + 30000) record.status = 'stale';
        for (const call of record.calls) if (call.status === 'running') call.durationMs = Math.max(0, this.now() - Date.parse(call.startedAt));
      }
      return record;
    }).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const users = [...new Map(records.map(r => [r.actor.id, r.actor])).values()];
    const filtered = records.filter(r => !userId || r.actor.id === userId);
    const byUser = [...new Set(filtered.map(r => r.actor.id))].map(id => ({ actor: filtered.find(r => r.actor.id === id).actor, ...summarize(filtered.filter(r => r.actor.id === id)) }));
    const models = [...new Set(filtered.flatMap(r => r.calls.map(c => c.route)))].map(route => ({ route,
      ...summarize(filtered.map(r => ({ ...r, calls: r.calls.filter(c => c.route === route) })).filter(r => r.calls.length)) }));
    return { generatedAt: new Date(this.now()).toISOString(), days, userId, storage: this.cloud ? 'shared' : 'process_memory', limited: saved.limited,
      totals: summarize(filtered), users, byUser, models, processes: filtered.slice(0, 100), recentLimit: 100,
      rates: Object.entries(this.config.routes).map(([route, value]) => ({ route, providerModel: value.model, rates: value.pricing || null })) };
  }
}
