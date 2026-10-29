import { fail } from './config.mjs';

const accountId = value => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(value)) fail(400, 'invalid_user', 'Choose a verified Astra account.');
  return value;
};
const domain = (host, name) => host === name || host.endsWith('.' + name);
export function providerFamily(route = {}) {
  let host = '';
  try { host = new URL(route.baseUrl).hostname.toLowerCase().replace(/\.$/, ''); } catch {}
  if (domain(host, 'deepseek.com')) return 'deepseek';
  if (domain(host, 'googleapis.com')) return 'google';
  if (route.providerKind === 'deepseek' || route.kind === 'deepseek') return 'deepseek';
  if (['vertex', 'vertex-openai'].includes(route.protocol) || ['vertex-media', 'vertex-openai'].includes(route.native)) return 'google';
  return 'other';
}

const expectedVersion = body => {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.hasOwn(body, 'expectedUpdatedAt') ||
      (body.expectedUpdatedAt !== null && (typeof body.expectedUpdatedAt !== 'string' || !Number.isFinite(Date.parse(body.expectedUpdatedAt)))))
    fail(400, 'invalid_provider_access', 'Refresh provider access before saving this change.');
};
const timestamp = previous => {
  const last = Date.parse(previous || '');
  return new Date(Math.max(Date.now(), Number.isFinite(last) ? last + 1 : 0)).toISOString();
};
const policyDefault = () => ({ deepseekEnabled: false, updatedAt: null });
const userDefault = userId => ({ userId, google: true, deepseek: false, updatedAt: null });
const decision = (provider, allowed, code = null, message = null, status = null) => ({ provider, allowed, code, message, status, deepseekApproved: provider === 'deepseek' && allowed });

export class ProviderAccess {
  constructor(control) { this.control = control; this.store = control.store; }
  async ready() { await this.control.ensure(); }
  async settings() {
    await this.ready();
    const record = (await this.store.get('providerPolicy/main')).data;
    if (record === null || record === undefined) return policyDefault();
    if (record.version !== 1 || typeof record.deepseekEnabled !== 'boolean' || typeof record.updatedAt !== 'string' || !Number.isFinite(Date.parse(record.updatedAt)))
      fail(503, 'control_invalid', 'The provider access policy could not be read.');
    return { deepseekEnabled: record.deepseekEnabled, updatedAt: record.updatedAt };
  }
  async user(userId) {
    accountId(userId); await this.ready();
    const record = (await this.store.get('providerAccess/' + userId)).data;
    if (record === null || record === undefined) {
      const legacy = (await this.store.get('personalProviders/' + userId)).data;
      if (legacy === null || legacy === undefined) return userDefault(userId);
      if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy) || legacy.userId !== userId || typeof legacy.deepseekEnabled !== 'boolean')
        fail(503, 'control_invalid', 'This account’s provider access could not be read.');
      return { ...userDefault(userId), deepseek: legacy.deepseekEnabled };
    }
    if (record.version !== 1 || record.userId !== userId || typeof record.google !== 'boolean' || typeof record.deepseek !== 'boolean' ||
        typeof record.updatedAt !== 'string' || !Number.isFinite(Date.parse(record.updatedAt))) fail(503, 'control_invalid', 'This account’s provider access could not be read.');
    return { userId, google: record.google, deepseek: record.deepseek, updatedAt: record.updatedAt };
  }
  async users(userIds) {
    if (!Array.isArray(userIds) || userIds.length > 100) fail(400, 'invalid_users', 'Choose up to 100 Astra accounts.');
    userIds.forEach(accountId);
    return Promise.all([...new Set(userIds)].map(userId => this.user(userId)));
  }
  async write(path, body, value, actor, collection, recordId) {
    if (actor?.kind !== 'account' || actor.admin !== true) fail(403, 'admin_required', 'An active Astra admin account is required.');
    await this.ready();
    const current = await this.store.get(path);
    if ((current.data?.updatedAt ?? null) !== body.expectedUpdatedAt) fail(409, 'control_conflict', 'Provider access changed. Refresh before saving.');
    const record = { version: 1, ...value, updatedAt: timestamp(current.data?.updatedAt) };
    await this.control.audit(actor, current.data ? 'update_requested' : 'create_requested', collection, recordId);
    if (!await this.store.commit([{ path, data: record, version: current.version }])) fail(409, 'control_conflict', 'Provider access changed. Refresh before saving.');
    return record;
  }
  async saveSettings(body, actor) {
    expectedVersion(body);
    if (Object.keys(body).some(key => !['deepseekEnabled', 'expectedUpdatedAt'].includes(key)) || typeof body.deepseekEnabled !== 'boolean')
      fail(400, 'invalid_provider_access', 'Supply a boolean DeepSeek enabled state.');
    const saved = await this.write('providerPolicy/main', body, { deepseekEnabled: body.deepseekEnabled }, actor, 'providerPolicy', 'main');
    return { deepseekEnabled: saved.deepseekEnabled, updatedAt: saved.updatedAt };
  }
  async saveUser(userId, body, actor) {
    accountId(userId); expectedVersion(body);
    if (Object.keys(body).some(key => !['google', 'deepseek', 'expectedUpdatedAt'].includes(key)) || typeof body.google !== 'boolean' || typeof body.deepseek !== 'boolean')
      fail(400, 'invalid_provider_access', 'Supply boolean Google and DeepSeek access settings.');
    const saved = await this.write('providerAccess/' + userId, body, { userId, google: body.google, deepseek: body.deepseek }, actor, 'providerAccess', userId);
    return { userId, google: saved.google, deepseek: saved.deepseek, updatedAt: saved.updatedAt };
  }
  async check(identity, route) {
    const provider = providerFamily(route);
    if (provider === 'other') return decision(provider, true);
    if (provider === 'deepseek') {
      // An installation without shared controls cannot enable DeepSeek through
      // environment routing or the old migration preparation switch.
      const policy = this.control.enabled ? await this.settings() : policyDefault();
      if (!policy.deepseekEnabled) return decision(provider, false, 'provider_policy', 'DeepSeek is disabled by the administrator.', 503);
      if (identity?.kind !== 'account') return decision(provider, false, 'provider_user_required', 'DeepSeek requires an approved Astra account.', 403);
    } else if (identity?.kind !== 'account') return decision(provider, true);
    const access = await this.user(identity?.id);
    if (access[provider] !== true) return decision(provider, false, 'provider_access_denied', `Your account is not approved to use ${provider === 'google' ? 'Google' : 'DeepSeek'}. Contact your administrator.`, 403);
    return decision(provider, true);
  }
  async allowed(identity, route) { return (await this.check(identity, route)).allowed; }
  async authorize(identity, route) {
    const result = await this.check(identity, route);
    if (!result.allowed) fail(result.status, result.code, result.message);
    return result;
  }
}
