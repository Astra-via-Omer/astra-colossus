import { createHash, randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { ControlStore } from './controlStore.mjs';
import { endpointUrl } from './endpoints.mjs';
import { fail, resolveRoute } from './config.mjs';

const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/;
const id = value => { if (typeof value !== 'string' || !idPattern.test(value)) fail(400, 'invalid_id', 'Use a short ID containing letters, numbers, dots, underscores or hyphens.'); return value; };
const text = (value, max = 160) => { if (typeof value !== 'string' || !value.trim() || value.length > max) fail(400, 'invalid_field', 'A required field is missing or too long.'); return value.trim(); };
const nonnegative = (value, maximum = 1000000) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum;
const now = () => new Date().toISOString();
const digest = value => createHash('sha256').update(value).digest('hex');
const publicRecord = value => {
  const { credential, hash, envAlias, ...visible } = value;
  return { ...visible, ...(Object.hasOwn(value, 'credential') || envAlias ? { credentialConfigured: !!credential || !!envAlias, credentialSource: envAlias && !credential ? 'managed' : credential ? 'vault' : 'none' } : {}) };
};
const systemSeeds = [
  ['workflow', 'Workflow', 'https://workspace.astra-via.com', 'Evidence and document workflows'],
  ['enigma', 'Enigma', 'https://enigma.astra-via.com', 'News and temporal intelligence'],
  ['lab', 'Lab', 'https://lab.astra-via.com', 'Research and model evaluation'],
  ['evidence', 'Evidence', 'https://evidence.astra-via.com', 'Evidence and provenance'],
  ['observer', 'Observer', '', 'Future observation services'],
  ['shared', 'Shared Astra accounts', '', 'Existing account-authenticated integrations'],
  ['legacy', 'Legacy service clients', '', 'Existing shared service credentials'],
];

export class ControlPlane {
  constructor(config, fetcher, endpointFetcher, store) {
    this.config = config; this.store = store || new ControlStore(config, fetcher); this.fetch = endpointFetcher;
    this.enabled = this.store.shared || !config.production; this.ready = null;
    this.vaultKey = createHash('sha256').update('astra-colossus/vault/v1\0').update(config.vaultSecret || config.sessionSecret).digest();
  }
  async ensure() {
    if (!this.enabled) fail(503, 'control_setup', 'The operations database is not configured.');
    if (!this.ready) this.ready = this.seed().catch(error => { this.ready = null; throw error; });
    return this.ready;
  }
  async seed() {
    const seeds = systemSeeds.map(([name, label, url, description]) => ['systems/' + name, { id: name, name: label, url, description, enabled: true, monthlyBudgetUsd: null, requestsPerMinute: 120, createdAt: now(), updatedAt: now() }]);
    for (const [alias, route] of Object.entries(this.config.routes)) {
      const providerId = 'managed-' + digest(alias).slice(0, 12);
      seeds.push(['providers/' + providerId, { id: providerId, name: new URL(route.baseUrl).hostname === 'api.deepseek.com' ? 'DeepSeek' : 'Managed provider', kind: 'compatible', protocol: route.protocol || 'openai', baseUrl: route.baseUrl, enabled: true, envAlias: alias, credential: null, allowAnonymous: false, health: null, createdAt: now(), updatedAt: now() }]);
      seeds.push(['models/' + alias, { id: alias, name: alias === 'astra-default' ? 'Astra Default' : alias, providerId, model: route.model, capabilities: route.capabilities, task: 'chat', maxTokens: 4000, pricing: route.pricing || null, enabled: true, createdAt: now(), updatedAt: now() }]);
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      const records = await Promise.all(seeds.map(([path]) => this.store.get(path)));
      const missing = seeds.flatMap(([path, data], index) => records[index].data ? [] : [{ path, data, version: null }]);
      if (!missing.length || await this.store.commit(missing)) return;
    }
    fail(503, 'control_setup', 'The operations database could not be initialized.');
  }
  seal(recordId, secret) {
    if (typeof secret !== 'string' || secret.length < 4 || secret.length > 8192 || /\s/.test(secret)) fail(400, 'invalid_credential', 'Supply a valid API credential without whitespace.');
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.vaultKey, iv); cipher.setAAD(Buffer.from(recordId));
    return { iv: iv.toString('base64url'), tag: undefined, data: undefined, ...(() => { const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]); return { tag: cipher.getAuthTag().toString('base64url'), data: data.toString('base64url') }; })() };
  }
  credential(provider) {
    if (provider.credential) {
      try { const decipher = createDecipheriv('aes-256-gcm', this.vaultKey, Buffer.from(provider.credential.iv, 'base64url'));
        decipher.setAAD(Buffer.from(provider.id)); decipher.setAuthTag(Buffer.from(provider.credential.tag, 'base64url'));
        return Buffer.concat([decipher.update(Buffer.from(provider.credential.data, 'base64url')), decipher.final()]).toString('utf8'); }
      catch { fail(503, 'credential_unavailable', 'This connection credential needs to be replaced.'); }
    }
    return provider.envAlias ? this.config.routes[provider.envAlias]?.key || '' : '';
  }
  async audit(actor, action, collection, recordId) {
    const auditId = String(9999999999999 - Date.now()) + '-' + randomUUID();
    const entry = { id: auditId, at: now(), actor: actor.email || actor.id, action, collection, recordId };
    if (!await this.store.commit([{ path: 'audit/' + auditId, data: entry, version: null }])) fail(503, 'audit_unavailable', 'The configuration change could not be audited.');
  }
  pricing(raw) {
    if (raw === null || raw === undefined) return null;
    if (!raw || !['inputPerMillion', 'outputPerMillion'].every(key => nonnegative(raw[key])) ||
      (raw.cachedInputPerMillion !== undefined && !nonnegative(raw.cachedInputPerMillion))) fail(400, 'invalid_pricing', 'Set nonnegative USD prices per million input and output tokens.');
    return { currency: 'USD', basis: raw.basis === 'peak_reference' ? 'peak_reference' : 'configured', inputPerMillion: raw.inputPerMillion, outputPerMillion: raw.outputPerMillion,
      ...(raw.cachedInputPerMillion !== undefined ? { cachedInputPerMillion: raw.cachedInputPerMillion } : {}) };
  }
  async save(collection, body, actor) {
    await this.ensure();
    if (!['providers', 'models', 'systems', 'integrations', 'jobs'].includes(collection)) fail(404, 'not_found', 'Unknown registry.');
    const recordId = id(body.id), path = collection + '/' + recordId;
    const previous = (await this.store.get(path)).data;
    if (!previous && (await this.store.list(collection)).length >= 250) fail(409, 'registry_limit', 'This registry is limited to 250 records.');
    if (body.expectedUpdatedAt && previous?.updatedAt !== body.expectedUpdatedAt) fail(409, 'control_conflict', 'This record changed. Refresh before saving.');
    const base = { id: recordId, name: text(body.name ?? previous?.name), enabled: body.enabled ?? previous?.enabled ?? true,
      createdAt: previous?.createdAt || now(), updatedAt: now() };
    if (typeof base.enabled !== 'boolean') fail(400, 'invalid_state', 'Supply a boolean enabled state.');
    let value;
    if (collection === 'providers') {
      const kind = body.kind ?? previous?.kind;
      if (!['openai', 'anthropic', 'deepseek', 'compatible', 'gpu'].includes(kind)) fail(400, 'invalid_provider', 'Choose a supported provider type.');
      const baseUrl = endpointUrl(body.baseUrl ?? previous?.baseUrl).href.replace(/\/$/, '');
      if (previous?.envAlias && baseUrl !== previous.baseUrl && !body.apiKey) fail(400, 'credential_binding', 'A managed credential cannot be sent to a different endpoint. Supply a separate key for a new endpoint.');
      value = { ...base, kind, protocol: kind === 'anthropic' ? 'anthropic' : 'openai', baseUrl,
        envAlias: previous?.envAlias || null, credential: body.apiKey ? this.seal(recordId, body.apiKey) : previous?.credential || null,
        allowAnonymous: ['gpu', 'compatible'].includes(kind) && (body.allowAnonymous ?? previous?.allowAnonymous ?? false),
        health: body.apiKey || body.baseUrl !== undefined ? null : previous?.health || null };
    } else if (collection === 'models') {
      const providerId = id(body.providerId ?? previous?.providerId), provider = (await this.store.get('providers/' + providerId)).data;
      if (!provider) fail(400, 'provider_required', 'Choose a registered provider connection.');
      const capabilities = body.capabilities ?? previous?.capabilities ?? ['text'];
      if (!Array.isArray(capabilities) || !capabilities.length || capabilities.some(item => !['text', 'image', 'audio', 'video'].includes(item)) ||
          (provider.protocol === 'anthropic' && capabilities.some(item => !['text', 'image'].includes(item)))) fail(400, 'invalid_capabilities', 'Choose capabilities supported by this provider adapter.');
      const maxTokens = body.maxTokens ?? previous?.maxTokens ?? 4000;
      if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 65536) fail(400, 'invalid_tokens', 'Set an output limit from 1 to 65,536 tokens.');
      const task = body.task ?? previous?.task ?? 'chat';
      if (!['chat', 'embedding'].includes(task) || (task === 'embedding' && provider.protocol === 'anthropic')) fail(400, 'invalid_task', 'This provider supports chat; compatible routes can also serve embeddings.');
      value = { ...base, providerId, model: text(body.model ?? previous?.model, 200), capabilities: [...new Set(capabilities)], task, maxTokens,
        pricing: this.pricing(Object.hasOwn(body, 'pricing') ? body.pricing : previous?.pricing) };
    } else if (collection === 'systems') {
      const budget = Object.hasOwn(body, 'monthlyBudgetUsd') ? body.monthlyBudgetUsd : previous?.monthlyBudgetUsd ?? null;
      const rpm = body.requestsPerMinute ?? previous?.requestsPerMinute ?? 120;
      if ((budget !== null && !nonnegative(budget, 10000000)) || !Number.isInteger(rpm) || rpm < 1 || rpm > 100000) fail(400, 'invalid_budget', 'Set a nonnegative monthly budget and a request limit from 1 to 100,000 per minute.');
      const url = body.url ?? previous?.url ?? '';
      value = { ...base, url: url ? endpointUrl(url).href : '', description: String(body.description ?? previous?.description ?? '').slice(0, 500), monthlyBudgetUsd: budget, requestsPerMinute: rpm };
    } else if (collection === 'integrations') {
      const kind = body.kind ?? previous?.kind;
      if (!['rest', 'gcs', 's3', 'training'].includes(kind)) fail(400, 'invalid_integration', 'Choose an HTTP API, storage bucket or training controller.');
      const endpoint = text(body.endpoint ?? previous?.endpoint, 1500);
      if (['rest', 'training'].includes(kind)) endpointUrl(endpoint);
      else if (!(kind === 'gcs' ? /^gs:\/\/[a-z0-9][a-z0-9._/-]{1,300}$/ : /^s3:\/\/[a-z0-9][a-z0-9._/-]{1,300}$/).test(endpoint)) fail(400, 'invalid_storage', 'Supply a bucket URI without credentials or query strings.');
      const systemId = id(body.systemId ?? previous?.systemId ?? 'lab');
      if (!(await this.store.get('systems/' + systemId)).data) fail(400, 'system_required', 'Choose a registered owning system.');
      value = { ...base, kind, endpoint, systemId, description: String(body.description ?? previous?.description ?? '').slice(0, 500),
        credential: body.apiKey ? this.seal(recordId, body.apiKey) : previous?.credential || null, health: previous?.health || null };
    } else {
      const kind = body.kind ?? previous?.kind ?? 'training';
      if (!['training', 'ingestion', 'evaluation'].includes(kind)) fail(400, 'invalid_job_type', 'Choose training, ingestion or evaluation.');
      const status = body.status ?? previous?.status ?? 'planned';
      if (!['planned', 'running', 'completed', 'failed', 'cancelled'].includes(status)) fail(400, 'invalid_status', 'Choose an external job status.');
      const cost = Object.hasOwn(body, 'reportedCostUsd') ? body.reportedCostUsd : previous?.reportedCostUsd ?? null;
      if (cost !== null && !nonnegative(cost, 10000000)) fail(400, 'invalid_cost', 'Supply a nonnegative reported external cost.');
      const systemId = id(body.systemId ?? previous?.systemId ?? 'lab');
      if (!(await this.store.get('systems/' + systemId)).data) fail(400, 'system_required', 'Choose a registered owning system.');
      const integrationId = Object.hasOwn(body, 'integrationId') ? body.integrationId ? id(body.integrationId) : null : previous?.integrationId || null;
      if (integrationId && !(await this.store.get('integrations/' + integrationId)).data) fail(400, 'integration_required', 'Choose a registered integration.');
      value = { ...base, kind, status, systemId, integrationId,
        description: String(body.description ?? previous?.description ?? '').slice(0, 500), reportedCostUsd: cost,
        externalUrl: body.externalUrl ? endpointUrl(body.externalUrl).href : previous?.externalUrl || '', reportedBy: actor.email || actor.id };
    }
    // Audit before the atomic configuration write; failed writes remain visible as attempted changes.
    await this.audit(actor, previous ? 'update_requested' : 'create_requested', collection, recordId);
    await this.store.mutate([path], ([current]) => {
      if ((current?.updatedAt || null) !== (previous?.updatedAt || null)) fail(409, 'control_conflict', 'This record changed. Refresh before saving.');
      return [value];
    });
    return publicRecord(value);
  }
  async route(model) {
    if (!this.enabled) return resolveRoute(this.config, model);
    await this.ensure();
    let alias = model || 'astra-default';
    if (alias === this.config.routes['astra-default']?.model) alias = 'astra-default';
    if (!idPattern.test(alias)) fail(400, 'unknown_model', 'Choose a configured model route.');
    const registered = (await this.store.get('models/' + alias)).data;
    if (!registered) fail(400, 'unknown_model', 'Choose a configured model route.');
    const provider = (await this.store.get('providers/' + registered.providerId)).data;
    if (!registered.enabled || !provider?.enabled) fail(503, 'route_paused', 'This model or provider connection is paused.');
    const key = this.credential(provider);
    if (!key && !provider.allowAnonymous) fail(503, 'provider_key_required', 'An administrator must add this provider credential.');
    return { alias, model: registered.model, providerId: provider.id, providerName: provider.name, protocol: provider.protocol,
      baseUrl: provider.baseUrl, key, capabilities: registered.capabilities, pricing: registered.pricing, maxTokens: registered.maxTokens,
      task: registered.task, managed: !!provider.envAlias && !provider.credential && provider.baseUrl === this.config.routes[provider.envAlias]?.baseUrl, defaults: provider.envAlias ? this.config.routes[provider.envAlias]?.defaults : undefined };
  }
  async routes(identity) {
    if (!this.enabled) return Object.entries(this.config.routes).map(([id, route]) => ({ id, model: route.model, capabilities: route.capabilities, task: 'chat' }));
    await this.ensure();
    const [models, providers] = await Promise.all([this.store.list('models'), this.store.list('providers')]);
    return models.filter(model => model.enabled && (!identity.allowedModels || identity.allowedModels.includes(model.id)) && providers.some(provider => provider.id === model.providerId && provider.enabled && (provider.credential || provider.envAlias || provider.allowAnonymous)))
      .map(model => ({ id: model.id, model: model.model, capabilities: model.capabilities, task: model.task, providerId: model.providerId }));
  }
  async authenticateKey(token) {
    if (!/^cs_[a-f0-9]{64}$/.test(token || '')) return null;
    await this.ensure(); const key = (await this.store.get('keys/' + digest(token))).data;
    if (!key || !key.enabled || !Number.isFinite(Date.parse(key.expiresAt)) || Date.parse(key.expiresAt) <= Date.now()) fail(401, 'service_key_revoked', 'This service key is invalid, expired or revoked.');
    const system = (await this.store.get('systems/' + key.systemId)).data;
    if (!system?.enabled) fail(403, 'system_paused', 'This system is paused in Colossus.');
    return { kind: 'service', admin: false, id: key.id, keyId: key.id, systemId: key.systemId, allowedModels: key.allowedModels };
  }
  async issueKey(body, actor) {
    await this.ensure(); const systemId = id(body.systemId), system = (await this.store.get('systems/' + systemId)).data;
    if (!system?.enabled) fail(400, 'system_required', 'Choose an enabled system.');
    if (!Array.isArray(body.allowedModels) || !body.allowedModels.length || body.allowedModels.length > 100) fail(400, 'models_required', 'Select at least one model route for this key.');
    const allowedModels = [...new Set(body.allowedModels.map(id))];
    for (const alias of allowedModels) if (!(await this.store.get('models/' + alias)).data) fail(400, 'unknown_model', 'Choose registered model routes.');
    const days = body.expiresInDays ?? 90;
    if (!Number.isInteger(days) || days < 1 || days > 365) fail(400, 'invalid_expiry', 'Choose a key lifetime from 1 to 365 days.');
    if ((await this.store.list('keys')).length >= 250) fail(409, 'key_limit', 'This registry is limited to 250 keys.');
    const token = 'cs_' + randomBytes(32).toString('hex'), hash = digest(token);
    const record = { id: randomUUID(), name: text(body.name), systemId, allowedModels, enabled: true, prefix: token.slice(0, 11) + '…' + token.slice(-4), createdAt: now(), expiresAt: new Date(Date.now() + days * 86400000).toISOString() };
    await this.audit(actor, 'issue_requested', 'keys', record.id);
    if (!await this.store.commit([{ path: 'keys/' + hash, data: { ...record, hash }, version: null }])) fail(409, 'key_conflict', 'The key could not be registered. Retry creation.');
    return { key: record, oneTimeKey: token };
  }
  async revokeKey(keyId, actor) {
    await this.ensure(); const key = (await this.store.list('keys')).find(key => key.id === keyId);
    if (!key) fail(404, 'key_not_found', 'This key was not found.');
    await this.audit(actor, 'revoke_requested', 'keys', keyId);
    await this.store.mutate(['keys/' + key.hash], ([current]) => [{ ...current, enabled: false, revokedAt: now() }]);
    return { revoked: true };
  }
  async authorize(identity, alias) {
    if (identity.allowedModels && !identity.allowedModels.includes(alias)) fail(403, 'model_not_granted', 'This system key is not allowed to use this model route.');
  }
  async reserve(identity, route, request, requestId, callIndex) {
    if (!this.enabled) return null;
    await this.ensure(); await this.authorize(identity, route.alias);
    const systemId = identity.systemId || (identity.kind === 'account' ? 'shared' : 'legacy');
    const system = (await this.store.get('systems/' + systemId)).data;
    if (!system?.enabled) fail(403, 'system_paused', 'This system is paused in Colossus.');
    // Remote images/audio/video can incur many tokens independently of request size.
    // A text-byte reservation cannot safely admit them under a spending cap.
    if (system.monthlyBudgetUsd !== null && request.messages?.some(message => Array.isArray(message.content) && message.content.some(part => part.type !== 'text')))
      fail(409, 'budget_media_unsupported', 'Capped systems currently accept text only; media token bounds require a separate provider policy.');
    const month = now().slice(0, 7), minute = Math.floor(Date.now() / 60000);
    const walletPath = `wallets/${systemId}-${month}`, reservationPath = `reservations/${requestId}-${callIndex}`;
    const inputBound = Buffer.byteLength(JSON.stringify(request)) + 1024, outputBound = route.task === 'embedding' ? 0 : request.max_tokens || route.maxTokens || 4000;
    const reservedUsd = route.pricing ? (inputBound * Math.max(route.pricing.inputPerMillion, route.pricing.cachedInputPerMillion || 0) + outputBound * route.pricing.outputPerMillion) / 1000000 : null;
    if (system.monthlyBudgetUsd !== null && reservedUsd === null) fail(409, 'budget_pricing_required', 'Add model prices before using a system with a spending cap.');
    const [wallet] = await this.store.mutate([walletPath, reservationPath], ([existing, previous]) => {
      if (previous) fail(409, 'reservation_exists', 'This model call was already admitted.');
      const value = existing || { id: systemId + '-' + month, systemId, month, spentUsd: 0, reservedUsd: 0, unpricedCalls: 0, tokens: 0, calls: 0, minute, minuteCalls: 0 };
      if (value.minute !== minute) { value.minute = minute; value.minuteCalls = 0; }
      if (value.minuteCalls >= system.requestsPerMinute) fail(429, 'system_rate_limit', 'This system reached its requests-per-minute limit.');
      if (system.monthlyBudgetUsd !== null && value.spentUsd + value.reservedUsd + reservedUsd > system.monthlyBudgetUsd + 1e-12) fail(402, 'system_budget', 'This system has reached its monthly spending cap.');
      value.reservedUsd += reservedUsd || 0; value.minuteCalls++; value.calls++; value.updatedAt = now();
      return [value, { id: requestId + '-' + callIndex, systemId, walletPath, reservedUsd: reservedUsd || 0, status: 'reserved', at: now() }];
    });
    return { path: reservationPath, walletPath, systemId, reservedUsd: reservedUsd || 0, month: wallet.month };
  }
  async settle(reservation, call) {
    if (!reservation) return;
    await this.store.mutate([reservation.walletPath, reservation.path], ([wallet, saved]) => {
      if (saved.status !== 'reserved') return [wallet, saved];
      const known = call.cost.usd !== null && call.cost.complete;
      if (known) { wallet.reservedUsd = Math.max(0, wallet.reservedUsd - saved.reservedUsd); wallet.spentUsd += call.cost.usd; }
      else wallet.unpricedCalls++;
      wallet.tokens += call.usage.totalTokens || 0; wallet.updatedAt = now();
      return [wallet, { ...saved, status: known ? 'settled' : 'usage_incomplete', completedAt: now(), estimatedCostUsd: call.cost.usd }];
    });
  }
  async startProcess(record) {
    if (!this.enabled) return;
    await this.ensure();
    await this.store.commit([{ path: 'executions/' + record.requestId, version: null,
      data: { id: record.requestId, startedAt: record.startedAt, status: 'running', systemId: record.systemId, cancelRequested: false } }]);
  }
  async finishProcess(record) {
    if (!this.enabled) return;
    await this.store.mutate(['executions/' + record.requestId], ([value]) => [{ ...value, status: record.status, completedAt: record.completedAt }]);
  }
  async cancelProcess(requestId, actor) {
    await this.ensure(); id(requestId);
    await this.audit(actor, 'cancel_request', 'executions', requestId);
    await this.store.mutate(['executions/' + requestId], ([value]) => {
      if (!value || value.status !== 'running') fail(409, 'process_not_running', 'This process is no longer running.');
      return [{ ...value, cancelRequested: true, cancelledBy: actor.id, cancelRequestedAt: now() }];
    });
    return { requested: true };
  }
  async cancellation(requestId) { return this.enabled && (await this.store.get('executions/' + requestId)).data?.cancelRequested === true; }
  async checkConnection(collection, recordId, actor) {
    await this.ensure(); const path = collection + '/' + id(recordId), record = (await this.store.get(path)).data;
    if (!record || !['providers', 'integrations'].includes(collection)) fail(404, 'connection_not_found', 'Choose a registered connection.');
    if (collection === 'integrations' && !['rest', 'training'].includes(record.kind)) fail(409, 'storage_agent_required', 'Bucket connections are registered for your ingestion worker. This gateway does not ingest or copy data automatically.');
    const start = Date.now(), key = this.credential(record), headers = {};
    if (key) Object.assign(headers, record.protocol === 'anthropic' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { Authorization: `Bearer ${key}` });
    let health, models = [];
    try {
      const response = await this.fetch(collection === 'providers' ? record.baseUrl + '/models' : record.endpoint, { headers, redirect: 'error', signal: AbortSignal.timeout(12000) });
      if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); fail(400, 'endpoint_redirect', 'Use the endpoint’s direct HTTPS address; redirects are not followed.'); }
      if (response.ok && collection === 'providers') {
        const chunks = []; let size = 0;
        for await (const chunk of response.body || []) { size += chunk.length; if (size > 2000000) fail(502, 'discovery_limit', 'The provider model list exceeds the size limit.'); chunks.push(chunk); }
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        models = (Array.isArray(data.data) ? data.data : []).slice(0, 250).flatMap(model => typeof model.id === 'string' ? [{ id: model.id.slice(0, 200) }] : []);
      } else await response.body?.cancel();
      health = { status: response.ok ? 'reachable' : 'error', httpStatus: response.status, checkedAt: now(), latencyMs: Date.now() - start, modelCount: models.length };
    } catch (error) {
      if (['private_endpoint', 'invalid_endpoint', 'endpoint_redirect'].includes(error.code)) throw error;
      health = { status: 'error', checkedAt: now(), latencyMs: Date.now() - start, code: 'endpoint_unavailable' };
    }
    await this.audit(actor, 'connection_check', collection, recordId);
    await this.store.mutate([path], ([current]) => {
      if (current.updatedAt !== record.updatedAt) fail(409, 'control_conflict', 'This connection changed during the check. Refresh before retrying.');
      return [{ ...current, health }];
    });
    return { health, models };
  }
  async snapshot() {
    await this.ensure();
    const [providers, models, systems, keys, integrations, jobs, wallets, audit] = await Promise.all(['providers', 'models', 'systems', 'keys', 'integrations', 'jobs', 'wallets'].map(name => this.store.list(name)).concat(this.store.list('audit', 50, true)));
    const month = now().slice(0, 7);
    return { storage: this.store.shared ? 'firestore' : 'preview_memory', generatedAt: now(), providers: providers.map(publicRecord), models,
      systems: systems.map(system => ({ ...system, spending: wallets.find(wallet => wallet.systemId === system.id && wallet.month === month) || null })),
      keys: keys.map(publicRecord), integrations: integrations.map(publicRecord), jobs, audit, gateway: { origin: this.config.origin, legacyKeys: this.config.keys.length, protocols: ['openai-chat', 'anthropic-messages-adapter', 'openai-embeddings'], adminOnly: true } };
  }
}
