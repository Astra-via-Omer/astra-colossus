import { fail } from './config.mjs';

const ident = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(value);
const short = (value, size = 160) => typeof value === 'string' ? value.slice(0, size) : '';
const quantity = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const states = new Set(['running', 'completed', 'failed', 'cancelled', 'stale']);
export const LIVE_WINDOW_MS = 15 * 60 * 1000;
export const LIVE_STALE_MS = 20000;
export const LIVE_LIMIT = 200;

// A strict allowlist excludes prompts, source text, outputs, credentials,
// reservations, upstream response bodies and other control-plane internals.
export function liveRecord(record, at = Date.now()) {
  if (!ident(record?.requestId) || !ident(record.actor?.id) || !Number.isFinite(Date.parse(record.startedAt))) throw Error('Invalid live process identity.');
  return { schemaVersion: 1, requestId: record.requestId, operation: short(record.operation, 80),
    actor: { id: record.actor.id, kind: record.actor.kind === 'account' ? 'account' : 'service', email: short(record.actor.email, 254) },
    systemId: ident(record.systemId) ? record.systemId : 'shared', groupId: ident(record.groupId) ? record.groupId : null,
    organizationId: ident(record.organizationId) ? record.organizationId : null, activity: short(record.activity, 100),
    startedAt: record.startedAt, completedAt: Number.isFinite(Date.parse(record.completedAt)) ? record.completedAt : null,
    observedAt: new Date(at).toISOString(), expiresAt: new Date(at + 86400000).toISOString(),
    status: states.has(record.status) ? record.status : 'stale', errorCode: short(record.errorCode, 80) || null,
    callsTruncated: record.callsTruncated === true || (record.calls?.length || 0) > 128,
    calls: (record.calls || []).slice(0, 128).map((call, index) => ({ index: index + 1, route: short(call.route, 120),
      providerModel: short(call.providerModel, 160), providerId: ident(call.providerId) ? call.providerId : null,
      execution: call.execution === 'local_cpu' ? 'local_cpu' : 'provider', status: states.has(call.status) ? call.status : 'stale',
      startedAt: Number.isFinite(Date.parse(call.startedAt)) ? call.startedAt : record.startedAt,
      completedAt: call.status === 'running' ? null : new Date((Number.isFinite(Date.parse(call.startedAt)) ? Date.parse(call.startedAt) : Date.parse(record.startedAt)) + (quantity(call.durationMs) || 0)).toISOString(),
      durationMs: quantity(call.durationMs), engine: call.engine ? { id: short(call.engine.id, 100), version: short(call.engine.version, 60) } : null,
      usage: { inputTokens: quantity(call.usage?.inputTokens), outputTokens: quantity(call.usage?.outputTokens), totalTokens: quantity(call.usage?.totalTokens), complete: call.usage?.complete === true },
      cost: { usd: quantity(call.cost?.usd), complete: call.cost?.complete === true },
      httpStatus: Number.isInteger(call.httpStatus) ? call.httpStatus : null })) };
}

export class LiveFlow {
  constructor(control, config, now = Date.now) {
    this.control = control; this.config = config; this.now = now;
    this.queues = new Map(); this.lastHeartbeat = new Map(); this.cache = new Map(); this.failures = 0;
  }
  observe(record, heartbeat = false) {
    if (!this.control.enabled || !record) return Promise.resolve();
    if (heartbeat && this.now() - (this.lastHeartbeat.get(record.requestId) || 0) < 5000) return Promise.resolve();
    if (!this.queues.has(record.requestId) && this.queues.size >= 256) { this.failures++; return Promise.resolve(); }
    this.lastHeartbeat.set(record.requestId, this.now());
    let snapshot;
    try { snapshot = liveRecord(record, this.now()); } catch { this.failures++; return Promise.resolve(); }
    const name = String(9999999999999 - Date.parse(snapshot.startedAt)).padStart(13, '0') + '-' + snapshot.requestId;
    const paths = [`liveFlow/${name}`, `liveActors/${snapshot.actor.id}/liveFlow/${name}`];
    if (snapshot.groupId) paths.push(`liveGroups/${snapshot.groupId}/liveFlow/${name}`);
    if (snapshot.organizationId) paths.push(`liveOrganizations/${snapshot.organizationId}/liveFlow/${name}`);
    // One publisher per request, ordered captures: a delayed running checkpoint
    // cannot overwrite completion. Failure affects telemetry, never inference.
    const next = (this.queues.get(snapshot.requestId) || Promise.resolve()).catch(() => {}).then(async () => {
      await this.control.store.mutate(paths, () => paths.map(() => snapshot));
      for (const p of paths) this.cache.delete(p.slice(0, p.lastIndexOf('/')));
    }).catch(() => { this.failures++; });
    this.queues.set(snapshot.requestId, next);
    void next.finally(() => {
      if (this.queues.get(snapshot.requestId) === next) {
        this.queues.delete(snapshot.requestId);
        if (snapshot.status !== 'running') this.lastHeartbeat.delete(snapshot.requestId);
      }
      if (this.lastHeartbeat.size > 2000) for (const [id, at] of this.lastHeartbeat) if (this.now() - at > LIVE_WINDOW_MS) this.lastHeartbeat.delete(id);
    });
    return next;
  }
  async drain() { await Promise.all([...this.queues.values()]); }
  async flush(requestId) { await this.queues.get(requestId); }
  async permissions(identity) {
    if (identity.kind !== 'account') fail(403, 'live_account_required', 'Live activity requires a signed-in Astra account.');
    if (identity.admin && identity.astraAdmin) return { available: [{ kind: 'all', id: 'all', name: 'Whole system' }, { kind: 'self', id: identity.id, name: 'My activity' }], group: null };
    const access = await this.control.groupAccess(identity, false);
    const group = access.group;
    const available = [];
    if (identity.role === 'professional') {
      const organizationId = await this.control.store.organizationFor(identity.id);
      if (organizationId) available.push({ kind: 'organization', id: organizationId, name: 'Approved organization' });
      if (group?.enabled && group.memberIds?.includes(identity.id)) available.push({ kind: 'group', id: group.id, name: group.name || 'Approved group' });
    }
    available.push({ kind: 'self', id: identity.id, name: 'My activity' });
    return { available, group };
  }
  async rows(collection) {
    const cached = this.cache.get(collection);
    if (cached && this.now() - cached.at < 1500) return cached.promise;
    const promise = this.control.store.list(collection, LIVE_LIMIT + 1, true).catch(error => { this.cache.delete(collection); throw error; });
    this.cache.set(collection, { at: this.now(), promise });
    if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value);
    return promise;
  }
  async snapshot(identity, requestedScope = '') {
    if (!this.control.enabled) fail(503, 'live_setup_required', 'Configure the shared operations database before viewing live activity.');
    await this.control.ensure();
    const { available, group } = await this.permissions(identity);
    const scope = available.find(s => s.kind === (requestedScope || available[0].kind));
    if (!scope) fail(403, 'live_scope_denied', 'That activity scope is not permitted for your account.');
    const collection = scope.kind === 'all' ? 'liveFlow' : scope.kind === 'self' ? `liveActors/${scope.id}/liveFlow`
      : scope.kind === 'group' ? `liveGroups/${scope.id}/liveFlow` : `liveOrganizations/${scope.id}/liveFlow`;
    const at = this.now(), cutoff = at - LIVE_WINDOW_MS;
    const [raw, models, providers, systems] = await Promise.all([this.rows(collection), this.control.store.list('models'), this.control.store.list('providers'), this.control.store.list('systems')]);
    const inScope = r => scope.kind === 'all' || (scope.kind === 'self' ? r.actor?.id === identity.id : scope.kind === 'group' ? r.groupId === scope.id : r.organizationId === scope.id);
    const recent = raw.filter(r => inScope(r) && Date.parse(r.startedAt) >= cutoff && Date.parse(r.expiresAt) > at);
    const records = recent.slice(0, LIVE_LIMIT).map(value => {
      const r = liveRecord(value, Date.parse(value.observedAt));
      const stale = r.status === 'running' && (at - Date.parse(r.observedAt) > LIVE_STALE_MS || at - Date.parse(r.startedAt) > this.config.timeout + 30000);
      if (stale) { r.status = 'stale'; r.calls = r.calls.map(c => c.status === 'running' ? { ...c, status: 'stale' } : c); }
      r.durationMs = Math.max(0, Date.parse(r.completedAt || new Date(at).toISOString()) - Date.parse(r.startedAt));
      return r;
    });
    const observedRoutes = new Set(records.flatMap(r => r.calls.map(c => c.route)));
    const allowed = new Set(group?.modelIds || []);
    const visibleModels = models.filter(m => scope.kind === 'all' || observedRoutes.has(m.id) || (allowed.has(m.id) && !m.native));
    const providerIds = new Set(visibleModels.map(m => m.providerId).concat(records.flatMap(r => r.calls.map(c => c.providerId))));
    const systemIds = new Set(records.map(r => r.systemId));
    return { schemaVersion: 1, generatedAt: new Date(at).toISOString(), windowStart: new Date(cutoff).toISOString(), refreshMs: 2000,
      source: this.control.store.shared ? 'shared_gateway_telemetry' : 'local_preview_telemetry', scope: { kind: scope.kind, name: scope.name },
      availableScopes: available.map(({ kind, name }) => ({ kind, name })),
      viewer: { id: identity.id, role: identity.role, email: identity.email, console: ['admin', 'participant'].includes(identity.role) },
      limited: recent.length > LIVE_LIMIT, processLimit: LIVE_LIMIT, records,
      catalog: { models: visibleModels.map(m => ({ id: m.id, name: short(m.name), model: short(m.model), providerId: m.providerId,
        enabled: Boolean(m.enabled && providers.find(p => p.id === m.providerId)?.enabled), task: short(m.task, 40), native: m.native || null })),
        providers: providers.filter(p => providerIds.has(p.id)).map(p => ({ id: p.id, name: short(p.name), kind: short(p.kind, 40), enabled: Boolean(p.enabled), native: p.native || null })),
        systems: systems.filter(s => scope.kind === 'all' || systemIds.has(s.id)).map(s => ({ id: s.id, name: short(s.name), enabled: Boolean(s.enabled) })) },
      integrity: { stalledAfterMs: LIVE_STALE_MS, telemetryFailuresOnThisInstance: identity.admin ? this.failures : undefined,
        interpretation: 'Observed Colossus admissions and calls. Only new activity recorded after this feature is deployed appears here. Browser navigation, provider-internal work and packet positions are not measured.' } };
  }
}
