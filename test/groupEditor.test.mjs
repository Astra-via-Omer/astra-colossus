import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { configuration } from '../src/config.mjs';
import { ControlPlane } from '../src/controlPlane.mjs';
import { ControlStore } from '../src/controlStore.mjs';

const context = { window: {} };
runInNewContext(readFileSync(new URL('../src/group-editor.js', import.meta.url), 'utf8'), context);
const ui = context.window.ColossusGroups;
const plain = value => JSON.parse(JSON.stringify(value));
const catalog = {
  models: [
    { id: 'default', name: 'Astra Default', providerId: 'deepseek', model: 'deepseek-flash', task: 'chat', capabilities: ['text'], enabled: true },
    { id: 'research', name: 'Research model', providerId: 'deepseek', model: 'research-1', task: 'chat', capabilities: ['text'], enabled: true },
    { id: 'broadcast-media', name: 'Broadcast observation', providerId: 'google', model: 'gemini', task: 'observation', native: 'vertex-media', capabilities: ['text', 'audio', 'image'], enabled: true },
    { id: 'embedding', name: 'Search embeddings', task: 'embedding', capabilities: ['text'], enabled: true },
  ],
  providers: [{ id: 'deepseek', name: 'DeepSeek', enabled: true, credentialConfigured: true }, { id: 'google', name: 'Google', enabled: true, credentialConfigured: true }],
  systems: [{ id: 'workflow', name: 'Workflow' }],
  keys: [{ systemId: 'workflow', allowedModels: ['default'], enabled: true, expiresAt: '2100-01-01T00:00:00Z' }],
};

test('group model choices keep text, media and embeddings separate and disclose missing product grants', () => {
  assert.deepEqual(catalog.models.filter(ui.textModel).map(model => model.id), ['default', 'research']);
  assert.equal(ui.modelLabel('default', catalog), 'DeepSeek · deepseek-flash');
  assert.equal(ui.modelIssue('default', 'workflow', catalog), '');
  assert.match(ui.modelIssue('research', 'workflow', catalog), /No active Workflow key/);
  assert.match(ui.modelIssue('default', 'workflow', { ...catalog, models: catalog.models.map(model => ({ ...model, maxTokens: 1000 })) }), /output limit/);
  assert.match(ui.modelIssue('research', 'workflow', { ...catalog, models: catalog.models.map(model => ({ ...model, enabled: false })) }), /paused/);
  assert.match(ui.modelIssue('missing', 'workflow', catalog), /registered/);
});

test('editing a group preserves member IDs, organization, ordered models and detailed existing rules', () => {
  const draft = { id: 'team', name: ' Research team ', memberIds: ['alice', 'bob'], modelIds: ['research', 'default', 'broadcast-media'], organizationId: 'acme', activityModels: { 'workflow.analysis.extraction': 'research', 'evidence.review': 'default' } };
  const saved = plain(ui.draftValue(draft));
  assert.deepEqual(saved, { ...draft, name: 'Research team' });
  saved.memberIds.pop(); saved.modelIds.reverse(); saved.activityModels['evidence.review'] = 'research';
  assert.equal(draft.memberIds.length, 2); assert.equal(draft.modelIds[0], 'research'); assert.equal(draft.activityModels['evidence.review'], 'default');
  assert.equal(ui.defaultModel(draft, catalog), 'research');
  assert.equal(ui.effectiveModel(draft, 'workflow.reassessment', catalog), 'research');
  assert.equal(ui.effectiveModel(draft, 'evidence.review', catalog), 'default');
  assert.throws(() => ui.draftValue({ ...draft, modelIds: ['default'] }), /product rule/);
  assert.throws(() => ui.draftValue({ ...draft, name: '  ' }), /group name/);
  assert.throws(() => ui.draftValue({ ...draft, memberIds: Array(101).fill('alice') }), /100 people/);
  assert.throws(() => ui.draftValue({ ...draft, modelIds: [] }), /Choose a text model/);
  assert.equal(ui.draftValue({ ...draft, modelIds: ['broadcast-media'], activityModels: {}, organizationId: '' }).organizationId, null);
});

test('form output changes the actual centrally assigned route and preserves scoped product authorization', async () => {
  const config = configuration({ ASTRA_PROVIDER_CONFIG_JSON: '{"key":"synthetic-provider","model":"default-native"}', COLOSSUS_VAULT_SECRET: 'synthetic-local-vault-secret-of-32-characters' });
  const control = new ControlPlane(config, fetch, fetch), actor = { id: 'admin', email: 'admin@example.test' };
  const providerId = (await control.snapshot()).models[0].providerId;
  await control.save('models', { id: 'research', name: 'Research', providerId, model: 'research-native', maxTokens: 8000 }, actor);
  const draft = { id: 'team', name: 'Research team', memberIds: ['alice'], modelIds: ['astra-default', 'research'], organizationId: '', activityModels: {} };
  const identity = { kind: 'account', id: 'alice', requireGroup: true, allowedModels: ['astra-default', 'research'] };
  const request = { model: 'caller-override', messages: [{ role: 'user', content: 'Synthetic source' }] };
  await control.save('groups', ui.draftValue(draft), actor);
  assert.equal((await control.assignedRoute(identity, request, 'chat', 'workflow.analysis.extraction')).model, 'default-native');
  draft.modelIds = ['research', 'astra-default']; draft.activityModels = { 'evidence.review': 'astra-default' };
  await control.save('groups', ui.draftValue(draft), actor);
  assert.equal((await control.assignedRoute(identity, request, 'chat', 'workflow.analysis.extraction')).model, 'research-native');
  assert.equal((await control.assignedRoute(identity, request, 'chat', 'evidence.review')).model, 'default-native');
  draft.activityModels['workflow.analysis'] = 'research'; await control.save('groups', ui.draftValue(draft), actor);
  await assert.rejects(control.assignedRoute({ ...identity, allowedModels: ['astra-default'] }, request, 'chat', 'workflow.analysis.extraction'), { code: 'group_model_unavailable' });
});

test('organization picker reads public directory fields from Workspace and never exposes sealed membership data', async () => {
  const calls = []; let overflow = false, outage = false;
  const store = new ControlStore({ controlProject: 'project', controlDatabase: 'control', workspaceDatabase: 'workspace' }, async url => {
    calls.push(String(url));
    if (String(url).includes('metadata.google.internal')) return Response.json({ access_token: 'synthetic-runtime', expires_in: 3600 });
    if (outage) return Response.json({}, { status: 503 });
    return Response.json({ documents: [{ name: 'projects/project/databases/workspace/documents/workspaceOrganizations/acme', fields: { name: { stringValue: 'Acme Research' }, status: { stringValue: 'active' }, sealed: { stringValue: 'PRIVATE' }, createdBy: { stringValue: 'PRIVATE' } } }], ...(overflow ? { nextPageToken: 'more' } : {}) });
  });
  assert.deepEqual(await store.organizations(), [{ id: 'acme', name: 'Acme Research', status: 'active' }]);
  assert(calls.some(url => url.includes('/databases/workspace/documents/workspaceOrganizations?')));
  overflow = true; await assert.rejects(store.organizations(), { code: 'organization_limit' });
  overflow = false; outage = true; await assert.rejects(store.organizations(), { code: 'control_unavailable' });
});
