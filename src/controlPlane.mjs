import { createHash, randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { runtimeVertexRoute, requireApprovedProvider, isDeepSeek } from './vertex.mjs';
import { ControlStore } from './controlStore.mjs';
import { endpointUrl } from './endpoints.mjs';
import { fail, resolveRoute, validateChat } from './config.mjs';
import { CHRISTOPHER, CHRISTOPHER_MODELS, christopherModel } from './christopher.mjs';
import { isChristopherAdmin, requireChristopherAdmin } from './christopherFingerprint.mjs';

const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/;
const id = value => { if (typeof value !== 'string' || !idPattern.test(value)) fail(400, 'invalid_id', 'Use a short ID containing letters, numbers, dots, underscores or hyphens.'); return value; };
const text = (value, max = 160) => { if (typeof value !== 'string' || !value.trim() || value.length > max) fail(400, 'invalid_field', 'A required field is missing or too long.'); return value.trim(); };
const nonnegative = (value, maximum = 1000000) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum;
const now = () => new Date().toISOString();
const digest = value => createHash('sha256').update(value).digest('hex');
const publicRecord = value => {
  const { credential, hash, envAlias, ...visible } = value;
  return { ...visible, ...(Object.hasOwn(value, 'credential') || envAlias ? { credentialConfigured: !!credential || !!envAlias || value.native === 'vertex-media', credentialSource: value.native === 'vertex-media' ? 'runtime' : envAlias && !credential ? 'managed' : credential ? 'vault' : 'none' } : {}) };
};
const systemSeeds = [
  ['colossus', 'Colossus', 'https://colossus.astra-via.com', 'Astra model gateway and mathematical runtime'],
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
    if (this.config.freeGroupId) seeds.push(['groups/' + id(this.config.freeGroupId), { id: this.config.freeGroupId, name: 'Free Workspace PDF checking', enabled: true, modelIds: ['astra-default'], memberIds: [], organizationId: null, activityModels: {}, createdAt: now(), updatedAt: now() }]);
    seeds.push(['providers/managed-christopher', { id: 'managed-christopher', name: 'astra-via mathematical runtime', kind: 'native', protocol: 'native', native: 'christopher', baseUrl: this.config.origin, enabled: true, createdAt: now(), updatedAt: now() }]);
    for (const model of CHRISTOPHER_MODELS) seeds.push(['models/' + model.alias, { id: model.alias, name: model.name, providerId: 'managed-christopher', native: 'christopher', model: `christopher@${model.version}`, task: 'analysis', capabilities: ['structured'], maxTokens: 0, pricing: null, enabled: true, createdAt: now(), updatedAt: now() }]);
    if (this.config.media) {
      seeds.push(['providers/managed-vertex-media', { id: 'managed-vertex-media', name: 'Google Vertex AI', kind: 'vertex', protocol: 'vertex', native: 'vertex-media', baseUrl: 'https://aiplatform.googleapis.com', credential: null, enabled: true, createdAt: now(), updatedAt: now() }]);
      seeds.push(['models/broadcast-media', { id: 'broadcast-media', name: 'Broadcast observation', providerId: 'managed-vertex-media', native: 'vertex-media', model: this.config.media.model, task: 'observation', maxTokens: 1400, capabilities: ['text', 'audio', 'image'], pricing: null, enabled: true, createdAt: now(), updatedAt: now() }]);
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
    if (!provider.envAlias) return '';
    const configured = this.config.routes[provider.envAlias]?.key || '';
    // An operator-controlled preparation revision keeps existing requests working
    // until the registry is switched atomically. Strict mode never uses this key.
    const preparing = this.config.providerMigrationMode === 'prepare' && provider.envAlias === 'astra-default' && provider.baseUrl === 'https://api.deepseek.com';
    return configured || (preparing ? this.config.managedProviderKey || '' : '');
  }
  async audit(actor, action, collection, recordId) {
    const auditId = String(9999999999999 - Date.now()) + '-' + randomUUID();
    const entry = { id: auditId, at: now(), actor: actor.email || actor.id, action, collection, recordId };
    if (!await this.store.commit([{ path: 'audit/' + auditId, data: entry, version: null }])) fail(503, 'audit_unavailable', 'The configuration change could not be audited.');
  }
  async personalProviders(actor, userId = actor.id) {
    if (actor.kind !== 'account' || typeof userId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId) || (userId !== actor.id && !actor.admin))
      fail(403, 'provider_access_denied', 'Only your own provider settings or an administrator-managed account can be viewed.');
    await this.ensure();
    const record = (await this.store.get('personalProviders/' + userId)).data;
    return { userId, deepseekEnabled: record?.deepseekEnabled === true, updatedAt: record?.updatedAt || null };
  }
  async savePersonalProviders(actor, body) {
    const userId = body?.userId || actor.id;
    await this.personalProviders(actor, userId);
    if (!actor.admin) fail(403, 'admin_required', 'An administrator must enable an external provider for this person.');
    if (typeof body?.deepseekEnabled !== 'boolean' || Object.keys(body).some(key => !['userId', 'deepseekEnabled'].includes(key)))
      fail(400, 'invalid_provider_access', 'Choose one person and a DeepSeek enabled state.');
    await this.audit(actor, body.deepseekEnabled ? 'personal_deepseek_enabled' : 'personal_deepseek_disabled', 'personalProviders', userId);
    await this.store.mutate(['personalProviders/' + userId], () => [{ userId, deepseekEnabled: body.deepseekEnabled,
      updatedAt: now(), updatedBy: actor.id, policyVersion: 'deepseek-personal-v1' }]);
    return this.personalProviders(actor, userId);
  }
  async assertProviderAccess(identity, route) {
    if (!isDeepSeek(route) || !this.config.production || this.config.providerMigrationMode === 'prepare') return;
    // Service keys alone and members of the same group never inherit a person's grant.
    const allowed = identity.kind === 'account' && (await this.personalProviders(identity)).deepseekEnabled;
    if (!allowed) fail(403, 'personal_provider_disabled', 'DeepSeek is disabled for this person. An administrator can enable it in Users & access.');
    requireApprovedProvider(this.config, route, { personalDeepSeek: true });
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
    if (collection === 'groups') return this.saveGroup(body, actor);
    if (!['providers', 'models', 'systems', 'integrations', 'jobs'].includes(collection)) fail(404, 'not_found', 'Unknown registry.');
    const recordId = id(body.id), path = collection + '/' + recordId;
    const previous = (await this.store.get(path)).data;
    if (!previous && (await this.store.list(collection)).length >= 250) fail(409, 'registry_limit', 'This registry is limited to 250 records.');
    if (body.expectedUpdatedAt && previous?.updatedAt !== body.expectedUpdatedAt) fail(409, 'control_conflict', 'This record changed. Refresh before saving.');
    const base = { id: recordId, name: text(body.name ?? previous?.name), enabled: body.enabled ?? previous?.enabled ?? true,
      createdAt: previous?.createdAt || now(), updatedAt: now() };
    if (typeof base.enabled !== 'boolean') fail(400, 'invalid_state', 'Supply a boolean enabled state.');
    let value;
    if (previous?.native || previous?.protocol === 'vertex-openai') {
      if (Object.keys(body).some(key => !['id', 'name', 'enabled', 'expectedUpdatedAt'].includes(key))) fail(400, 'native_configuration', 'This native adapter is configured by deployment. Its name and enabled state can be managed here.');
      value = { ...previous, ...base };
    } else if (collection === 'providers') {
      const kind = body.kind ?? previous?.kind;
      if (!['openai', 'anthropic', 'deepseek', 'compatible', 'gpu'].includes(kind)) fail(400, 'invalid_provider', 'Choose a supported provider type.');
      const baseUrl = endpointUrl(body.baseUrl ?? previous?.baseUrl).href.replace(/\/$/, '');
      if (base.enabled) requireApprovedProvider(this.config, {baseUrl}, { registration: true });
      if (previous?.envAlias && baseUrl !== previous.baseUrl && !body.apiKey) fail(400, 'credential_binding', 'A managed credential cannot be sent to a different endpoint. Supply a separate key for a new endpoint.');
      value = { ...base, kind, protocol: kind === 'anthropic' ? 'anthropic' : 'openai', baseUrl,
        envAlias: previous?.envAlias || null, credential: body.apiKey ? this.seal(recordId, body.apiKey) : previous?.credential || null,
        allowAnonymous: ['gpu', 'compatible'].includes(kind) && (body.allowAnonymous ?? previous?.allowAnonymous ?? false),
        health: body.apiKey || body.baseUrl !== undefined ? null : previous?.health || null };
    } else if (collection === 'models') {
      if (previous?.release && ['providerId', 'model', 'task', 'capabilities', 'maxTokens'].some(key => Object.hasOwn(body, key) && JSON.stringify(body[key]) !== JSON.stringify(previous[key])))
        fail(409, 'release_immutable', 'Publish a new Lab version to change its serving definition.');
      const providerId = id(body.providerId ?? previous?.providerId), provider = (await this.store.get('providers/' + providerId)).data;
      if (!provider || provider.native) fail(400, 'provider_required', 'Choose a compatible or Anthropic connection. Native adapters use their dedicated model route.');
      if (base.enabled) requireApprovedProvider(this.config, provider, { registration: true });
      const capabilities = body.capabilities ?? previous?.capabilities ?? ['text'];
      if (!Array.isArray(capabilities) || !capabilities.length || capabilities.some(item => !['text', 'image', 'audio', 'video'].includes(item)) ||
          (provider.protocol === 'anthropic' && capabilities.some(item => !['text', 'image'].includes(item)))) fail(400, 'invalid_capabilities', 'Choose capabilities supported by this provider adapter.');
      const maxTokens = body.maxTokens ?? previous?.maxTokens ?? 4000;
      if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 65536) fail(400, 'invalid_tokens', 'Set an output limit from 1 to 65,536 tokens.');
      const task = body.task ?? previous?.task ?? 'chat';
      if (!['chat', 'embedding'].includes(task) || (task === 'embedding' && provider.protocol === 'anthropic')) fail(400, 'invalid_task', 'This provider supports chat; compatible routes can also serve embeddings.');
      value = { ...base, providerId, model: text(body.model ?? previous?.model, 200), capabilities: [...new Set(capabilities)], task, maxTokens,
        pricing: this.pricing(Object.hasOwn(body, 'pricing') ? body.pricing : previous?.pricing), ...(previous?.release ? { release: previous.release } : {}) };
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
  async saveGroup(body, actor) {
    const groupId = id(body.id), path = 'groups/' + groupId, previous = (await this.store.get(path)).data;
    if (!previous && (await this.store.list('groups')).length >= 250) fail(409, 'registry_limit', 'This registry is limited to 250 groups.');
    if (body.expectedUpdatedAt && previous?.updatedAt !== body.expectedUpdatedAt) fail(409, 'control_conflict', 'This group changed. Refresh before saving.');
    const members = body.memberIds ?? previous?.memberIds ?? [], models = body.modelIds ?? previous?.modelIds ?? [];
    if (!Array.isArray(members) || members.length > 100 || members.some(value => typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(value)) ||
        !Array.isArray(models) || !models.length || models.length > 100) fail(400, 'invalid_group', 'Choose 1–100 model routes and up to 100 verified account IDs.');
    const modelIds = [...new Set(models.map(id))], memberIds = [...new Set(members)];
    for (const alias of modelIds) if (!(await this.store.get('models/' + alias)).data) fail(400, 'unknown_model', 'Choose registered model routes.');
    const activityModels = body.activityModels ?? previous?.activityModels ?? {};
    if (!activityModels || typeof activityModels !== 'object' || Array.isArray(activityModels) || Object.keys(activityModels).length > 50 ||
        Object.entries(activityModels).some(([activity, alias]) => !/^[a-z][a-z0-9._:-]{0,119}$/.test(activity) || !modelIds.includes(alias)))
      fail(400, 'invalid_activity_models', 'Activity assignments must use models granted to the group.');
    const organizationId = Object.hasOwn(body, 'organizationId') ? body.organizationId : previous?.organizationId ?? null;
    if (organizationId !== null && !/^[a-zA-Z0-9_-]{1,120}$/.test(organizationId)) fail(400, 'invalid_organization', 'Choose an approved Workspace organization ID.');
    const value = { id: groupId, name: text(body.name ?? previous?.name), enabled: body.enabled ?? previous?.enabled ?? true,
      modelIds, memberIds, organizationId, activityModels, createdAt: previous?.createdAt || now(), updatedAt: now() };
    if (typeof value.enabled !== 'boolean') fail(400, 'invalid_state', 'Supply a boolean enabled state.');
    await this.audit(actor, previous ? 'update_requested' : 'create_requested', 'groups', groupId);
    const affected = [...new Set([...(previous?.memberIds || []), ...memberIds])];
    await this.store.mutate([path, ...affected.map(userId => 'groupMembers/' + userId)], ([current, ...assignments]) => {
      if ((current?.updatedAt || null) !== (previous?.updatedAt || null)) fail(409, 'control_conflict', 'This group changed. Refresh before saving.');
      return [value, ...affected.map((userId, index) => {
        if (memberIds.includes(userId) && assignments[index]?.groupId && assignments[index].groupId !== groupId)
          fail(409, 'group_conflict', 'An account already belongs to another group. Remove its previous assignment first.');
        return { userId, groupId: memberIds.includes(userId) ? groupId : null, updatedAt: now() };
      })];
    });
    return value;
  }
  async groupAccess(identity, enforce = true) {
    if (!this.enabled) {
      if (enforce && (identity.requireGroup || (identity.kind === 'account' && this.config.requireGroups))) fail(503, 'control_setup', 'Configure the Colossus group registry before inference.');
      return { group: null, organizationId: null };
    }
    await this.ensure();
    const assignment = identity.kind === 'account' ? (await this.store.get('groupMembers/' + identity.id)).data : null;
    const freeWorkspace = identity.kind === 'account' && identity.workspaceScope === 'pdf' && identity.systemId === 'workflow' && !!identity.keyId;
    const groupId = assignment?.groupId || (freeWorkspace ? this.config.freeGroupId : null);
    const group = groupId ? (await this.store.get('groups/' + groupId)).data : null;
    if (groupId && !group?.enabled) fail(403, 'group_paused', 'Your model group is paused or unavailable.');
    if (enforce && (identity.requireGroup || (identity.kind === 'account' && this.config.requireGroups)) && !group) fail(409, 'group_required', 'An administrator must assign this account to a Colossus model group.');
    const organizationId = identity.kind === 'account' && (identity.keyId || group?.organizationId) ? await this.store.organizationFor(identity.id) : null;
    if (group?.organizationId && group.organizationId !== organizationId) fail(403, 'organization_denied', 'This group requires active membership in its approved organization.');
    if (identity.organizationIds?.length && !identity.organizationIds.includes(organizationId)) fail(403, 'organization_denied', 'This system key does not grant your organization.');
    if (identity.productAccess && identity.productAccess.groupId !== group?.id)
      fail(403, 'product_license_required', 'Group membership changed after product authorization. Retry with a matching license.');
    return { group, organizationId };
  }
  async assignedRoute(identity, body, task = 'chat', activity = '') {
    const { group, organizationId } = await this.groupAccess(identity);
    if (!group) { const route = await this.route(body.model); return { ...route, routing: { groupId: null, organizationId, activity } }; }
    // The client cannot choose outside (or override) its centrally assigned group.
    const specific = group.activityModels[activity] || group.activityModels[activity.split('.').slice(0, -1).join('.')];
    const candidates = specific ? [specific] : group.modelIds;
    for (const alias of candidates) {
      if (identity.allowedModels && !identity.allowedModels.includes(alias)) continue;
      let route;
      try { route = await this.route(alias); } catch (error) { if (['route_paused', 'model_task'].includes(error.code)) continue; throw error; }
      if ((route.task || 'chat') !== task || (body.max_tokens && body.max_tokens > route.maxTokens)) continue;
      if (task === 'chat') { try { validateChat(body, route); } catch (error) { if (error.code === 'unsupported_modality') continue; throw error; } }
      return { ...route, routing: { groupId: group.id, organizationId, activity } };
    }
    fail(503, 'group_model_unavailable', 'No granted model in your group can serve this request. Ask an administrator to check its routes, output limits and system key grants.');
  }
  async labCatalog(identity) {
    await this.ensure();
    if (identity.kind !== 'account' || !identity.admin || identity.systemId !== 'lab' || !identity.registrationProviderIds?.length)
      fail(403, 'lab_registration_denied', 'Lab registration requires an administrator and a scoped Lab registration key.');
    const organizationId = await this.store.organizationFor(identity.id);
    if (identity.organizationIds?.length && !identity.organizationIds.includes(organizationId)) fail(403, 'organization_denied', 'This Lab key does not grant your organization.');
    const providers = (await this.store.list('providers')).filter(provider => provider.enabled && !provider.native && identity.registrationProviderIds.includes(provider.id));
    const models = (await this.store.list('models')).filter(model => model.release?.source === 'lab' && model.release.organizationId === organizationId);
    return { organizationId, providers: providers.map(provider => ({ id: provider.id, name: provider.name })), models };
  }
  async registerLabModel(body, identity) {
    const catalog = await this.labCatalog(identity);
    if (!catalog.providers.some(provider => provider.id === body.providerId)) fail(403, 'provider_not_granted', 'This Lab key does not grant that provider connection.');
    if (typeof body.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(body.id) || typeof body.version !== 'string' || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(body.version))
      fail(400, 'invalid_release', 'Supply a lowercase model ID and a numeric major.minor.patch version.');
    const alias = body.id + ':' + body.version;
    const definition = { providerId: body.providerId, model: text(body.model, 200), name: text(body.name), task: 'chat', capabilities: ['text'], maxTokens: body.maxTokens ?? 8000,
      evaluationUrl: endpointUrl(body.evaluationUrl).href, organizationId: catalog.organizationId };
    const fingerprint = digest(JSON.stringify(definition)), existing = (await this.store.get('models/' + alias)).data;
    if (existing) {
      if (existing.release?.fingerprint !== fingerprint) fail(409, 'release_conflict', 'That version already exists with a different definition. Create a new version.');
      return { model: existing, replay: true };
    }
    // Create-only CAS prevents concurrent publications from overwriting an immutable release.
    if (!Number.isInteger(definition.maxTokens) || definition.maxTokens < 1 || definition.maxTokens > 65536) fail(400, 'invalid_tokens', 'Choose an output limit from 1 to 65,536 tokens.');
    if ((await this.store.list('models')).length >= 250) fail(409, 'registry_limit', 'This registry is limited to 250 models.');
    const release = { source: 'lab', version: body.version, evaluationUrl: definition.evaluationUrl, organizationId: catalog.organizationId, publishedBy: identity.id, fingerprint };
    const model = { id: alias, name: definition.name, providerId: definition.providerId, model: definition.model, task: definition.task, capabilities: definition.capabilities,
      maxTokens: definition.maxTokens, enabled: false, pricing: null, release, createdAt: now(), updatedAt: now() };
    await this.audit(identity, 'lab_release_requested', 'models', alias);
    if (!await this.store.commit([{ path: 'models/' + alias, data: model, version: null }])) {
      const concurrent = (await this.store.get('models/' + alias)).data;
      if (concurrent?.release?.fingerprint === fingerprint) return { model: concurrent, replay: true };
      fail(409, 'release_conflict', 'That version was published concurrently. Refresh the registry.');
    }
    return { model, replay: false };
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
    if (registered.native) fail(400, 'model_task', registered.native === 'christopher' ? 'Use /v1/christopher/evaluate for structured mathematical checks.' : 'Use the native /v1/media/observe endpoint for this route.');
    const key = this.credential(provider);
    const runtimeIdentity = runtimeVertexRoute(this.config, { protocol: provider.protocol, baseUrl: provider.baseUrl });
    if (!key && !provider.allowAnonymous && !runtimeIdentity) fail(503, 'provider_key_required', 'An administrator must add this provider credential.');
    return { alias, model: registered.model, providerId: provider.id, providerName: provider.name, protocol: provider.protocol,
      baseUrl: provider.baseUrl, key, capabilities: registered.capabilities, pricing: registered.pricing, maxTokens: registered.maxTokens,
      task: registered.task, managed: !!provider.envAlias && !provider.credential && provider.baseUrl === this.config.routes[provider.envAlias]?.baseUrl, defaults: provider.envAlias ? this.config.routes[provider.envAlias]?.defaults : undefined };
  }
  async routes(identity) {
    if (!this.enabled) return Object.entries(this.config.routes).map(([id, route]) => ({ id, model: route.model, capabilities: route.capabilities, task: 'chat' }));
    await this.ensure();
    const { group } = identity.admin ? { group: null } : await this.groupAccess(identity, false);
    if (this.config.requireGroups && identity.kind === 'account' && !identity.admin && !group) return [];
    const [models, providers] = await Promise.all([this.store.list('models'), this.store.list('providers')]);
    const personalDeepSeek = !this.config.production || this.config.providerMigrationMode === 'prepare' ||
      (identity.kind === 'account' && (await this.personalProviders(identity)).deepseekEnabled);
    return models.filter(model => (model.native !== 'christopher' || isChristopherAdmin(identity)) && (!group || group.modelIds.includes(model.id)) && model.enabled && (!identity.allowedModels || identity.allowedModels.includes(model.id)) && providers.some(provider => provider.id === model.providerId && provider.enabled && (personalDeepSeek || !isDeepSeek(provider)) && (provider.credential || provider.envAlias || provider.allowAnonymous || provider.native)))
      .map(model => ({ id: model.id, model: model.model, capabilities: model.capabilities, task: model.task, providerId: model.providerId }));
  }
  async authenticateKey(token) {
    if (!/^cs_[a-f0-9]{64}$/.test(token || '')) return null;
    await this.ensure(); const key = (await this.store.get('keys/' + digest(token))).data;
    if (!key || !key.enabled || !Number.isFinite(Date.parse(key.expiresAt)) || Date.parse(key.expiresAt) <= Date.now()) fail(401, 'service_key_revoked', 'This service key is invalid, expired or revoked.');
    const system = (await this.store.get('systems/' + key.systemId)).data;
    if (!system?.enabled) fail(403, 'system_paused', 'This system is paused in Colossus.');
    return { kind: 'service', admin: false, id: key.id, keyId: key.id, systemId: key.systemId, allowedModels: key.allowedModels,
      requireGroup: key.requireGroup === true, organizationIds: key.organizationIds || [], registrationProviderIds: key.registrationProviderIds || [] };
  }
  async issueKey(body, actor) {
    await this.ensure(); const systemId = id(body.systemId), system = (await this.store.get('systems/' + systemId)).data;
    if (!system?.enabled) fail(400, 'system_required', 'Choose an enabled system.');
    if (!Array.isArray(body.allowedModels) || !body.allowedModels.length || body.allowedModels.length > 100) fail(400, 'models_required', 'Select at least one model route for this key.');
    const allowedModels = [...new Set(body.allowedModels.map(id))];
    for (const alias of allowedModels) if (!(await this.store.get('models/' + alias)).data) fail(400, 'unknown_model', 'Choose registered model routes.');
    const registrationProviderIds = body.registrationProviderIds ?? [], organizationIds = body.organizationIds ?? [];
    if (!Array.isArray(registrationProviderIds) || registrationProviderIds.length > 100 || !Array.isArray(organizationIds) || organizationIds.length > 100 ||
        organizationIds.some(value => typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(value)) ||
        (body.requireGroup !== undefined && typeof body.requireGroup !== 'boolean')) fail(400, 'invalid_key_scope', 'Supply valid provider, organization and group scopes.');
    if (registrationProviderIds.length && systemId !== 'lab') fail(400, 'invalid_key_scope', 'Only Lab keys can register model releases.');
    for (const providerId of registrationProviderIds) if (!(await this.store.get('providers/' + id(providerId))).data) fail(400, 'provider_required', 'Choose registered provider connections.');
    const days = body.expiresInDays ?? 90;
    if (!Number.isInteger(days) || days < 1 || days > 365) fail(400, 'invalid_expiry', 'Choose a key lifetime from 1 to 365 days.');
    if ((await this.store.list('keys')).length >= 250) fail(409, 'key_limit', 'This registry is limited to 250 keys.');
    const token = 'cs_' + randomBytes(32).toString('hex'), hash = digest(token);
    const record = { id: randomUUID(), name: text(body.name), systemId, allowedModels, requireGroup: body.requireGroup ?? true,
      registrationProviderIds: [...new Set(registrationProviderIds)], organizationIds: [...new Set(organizationIds)], enabled: true, prefix: token.slice(0, 11) + '…' + token.slice(-4), createdAt: now(), expiresAt: new Date(Date.now() + days * 86400000).toISOString() };
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
  async christopherRoute(identity, version = CHRISTOPHER.version) {
    requireChristopherAdmin(identity);
    const manifest = christopherModel(version);
    const { group, organizationId } = await this.groupAccess(identity, false);
    await this.authorize(identity, manifest.alias);
    if (this.enabled) {
      const model = (await this.store.get('models/' + manifest.alias)).data;
      const provider = (await this.store.get('providers/managed-christopher')).data;
      if (!model?.enabled || !provider?.enabled) fail(503, 'route_paused', 'Christopher or its mathematical runtime is paused.');
      if (model.native !== 'christopher' || model.model !== `christopher@${manifest.version}` || model.providerId !== provider.id || provider.native !== 'christopher')
        fail(503, 'native_configuration', 'The registered Christopher version does not match its mathematical runtime.');
    }
    return { alias: manifest.alias, model: `christopher@${manifest.version}`, providerId: 'managed-christopher', task: 'analysis',
      pricing: { inputPerMillion: 0, cachedInputPerMillion: 0, outputPerMillion: 0 }, maxTokens: 0,
      routing: { groupId: group?.id || null, organizationId, activity: identity.activity || '' } };
  }
  async mediaRoute(identity) {
    const { group } = await this.groupAccess(identity);
    if (group && !group.modelIds.includes('broadcast-media')) fail(403, 'model_not_granted', 'Your group is not assigned the broadcast observation model.');
    await this.authorize(identity, 'broadcast-media');
    if (this.enabled) {
      await this.ensure();
      const model = (await this.store.get('models/broadcast-media')).data;
      const provider = (await this.store.get('providers/managed-vertex-media')).data;
      if (!model?.enabled || !provider?.enabled) fail(503, 'route_paused', 'The native media model or provider is paused.');
      const system = (await this.store.get('systems/' + (identity.systemId || (identity.kind === 'account' ? 'shared' : 'legacy')))).data;
      if (!system?.enabled) fail(403, 'system_paused', 'This system is paused in Colossus.');
    }
    // Reserve at the most expensive input modality; actual settlement uses mediaCostUsd.
    return { alias: 'broadcast-media', model: this.config.media?.model, providerId: 'managed-vertex-media', task: 'observation', maxTokens: 1400,
      pricing: this.config.media?.model === 'gemini-3.1-flash-lite' ? { inputPerMillion: 0.90, cachedInputPerMillion: 0.90, outputPerMillion: 2.70 } : null };
  }
  async reserve(identity, route, request, requestId, callIndex, inputTokens) {
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
    const inputBound = Number.isSafeInteger(inputTokens) && inputTokens >= 0 ? inputTokens : Buffer.byteLength(JSON.stringify(request)) + 1024, outputBound = route.task === 'embedding' ? 0 : request.max_tokens || route.maxTokens || 4000;
    const reservedUsd = route.pricing ? (inputBound * Math.max(route.pricing.inputPerMillion, route.pricing.cachedInputPerMillion || 0) + outputBound * route.pricing.outputPerMillion) / 1000000 : null;
    if (system.monthlyBudgetUsd !== null && reservedUsd === null) fail(409, 'budget_pricing_required', 'Add model prices before using a system with a spending cap.');
    const userPath = identity.kind === 'account' ? 'userQuotas/' + createHash('sha256').update(identity.id).digest('hex') : null;
    const day = now().slice(0,10);
    const [wallet] = await this.store.mutate([walletPath, reservationPath, ...(userPath ? [userPath] : [])], ([existing, previous, user]) => {
      if (previous) fail(409, 'reservation_exists', 'This model call was already admitted.');
      const value = existing || { id: systemId + '-' + month, systemId, month, spentUsd: 0, reservedUsd: 0, unpricedCalls: 0, tokens: 0, calls: 0, minute, minuteCalls: 0 };
      if (value.minute !== minute) { value.minute = minute; value.minuteCalls = 0; }
      if (value.minuteCalls >= system.requestsPerMinute) fail(429, 'system_rate_limit', 'This system reached its requests-per-minute limit.');
      if (system.monthlyBudgetUsd !== null && value.spentUsd + value.reservedUsd + reservedUsd > system.monthlyBudgetUsd + 1e-12) fail(402, 'system_budget', 'This system has reached its monthly spending cap.');
      let quota;
      if (userPath) {
        quota = user || {day,minute,dailyCalls:0,minuteCalls:0};
        if (quota.day !== day) { quota.day=day;quota.dailyCalls=0; }
        if (quota.minute !== minute) { quota.minute=minute;quota.minuteCalls=0; }
        if (quota.minuteCalls >= this.config.userRequestsPerMinute || quota.dailyCalls >= this.config.userCallsPerDay) fail(429,'user_rate_limit','Your account has reached its processing limit. Try again later.');
        quota.dailyCalls++;quota.minuteCalls++;quota.updatedAt=now();
      }
      value.reservedUsd += reservedUsd || 0; value.minuteCalls++; value.calls++; value.updatedAt = now();
      return [value, { id: requestId + '-' + callIndex, systemId, walletPath, reservedUsd: reservedUsd || 0, status: 'reserved', at: now() }, ...(userPath ? [quota] : [])];
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
    if (collection === 'providers') { await this.assertProviderAccess(actor, record); requireApprovedProvider(this.config, record, { personalDeepSeek: isDeepSeek(record) }); }
    if (record.native || record.protocol === 'vertex-openai') fail(409, 'native_connection', 'Native Vertex calls use runtime identity and their own token-count preflight. No compatible model-discovery check is available.');
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
    const [providers, models, systems, keys, integrations, jobs, wallets, groups, audit] = await Promise.all(['providers', 'models', 'systems', 'keys', 'integrations', 'jobs', 'wallets', 'groups'].map(name => this.store.list(name)).concat(this.store.list('audit', 50, true)));
    const month = now().slice(0, 7);
    return { storage: this.store.shared ? 'firestore' : 'preview_memory', generatedAt: now(), providers: providers.map(publicRecord), models,
      systems: systems.map(system => ({ ...system, spending: wallets.find(wallet => wallet.systemId === system.id && wallet.month === month) || null })),
      keys: keys.map(publicRecord), integrations: integrations.map(publicRecord), jobs, groups, audit, gateway: { origin: this.config.origin, legacyKeys: this.config.keys.length, protocols: ['openai-chat', 'anthropic-messages-adapter', 'openai-embeddings'], adminOnly: true } };
  }
}
