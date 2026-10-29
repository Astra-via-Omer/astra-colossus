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
    { id: 'christopher', name: 'Christopher reality-gap model', providerId: 'math', model: 'christopher@0.1.0', task: 'analysis', native: 'christopher', capabilities: ['structured'], enabled: true },
    { id: 'christopher:0.2.0', name: 'Christopher mathematical checks 0.2.0', providerId: 'math', model: 'christopher@0.2.0', task: 'analysis', native: 'christopher', capabilities: ['structured'], enabled: true },
  ],
  providers: [{ id: 'deepseek', name: 'DeepSeek', enabled: true, credentialConfigured: true }, { id: 'google', name: 'Google', enabled: true, credentialConfigured: true }, { id: 'math', name: 'Astra mathematical runtime', enabled: true, native: 'christopher' }],
  systems: [{ id: 'workflow', name: 'Workflow' }],
  keys: [{ systemId: 'workflow', allowedModels: ['default'], enabled: true, expiresAt: '2100-01-01T00:00:00Z' }],
};

// Exercise the form's real event handlers without requiring a browser or a DOM package.
function editorForm(record, currentCatalog = catalog) {
  class Element {
    constructor(tag, text = '', value = '') { this.tagName = tag; this.children = []; this.attributes = {}; this.listeners = {}; this.textContent = text; this.value = value; this.classList = { toggle() {} }; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    add(option) { this.append(option); }
    get options() { return this.children; }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    focus() {}
    change(value) { assert.equal(!!this.disabled, false, 'A disabled form control cannot be changed'); if (this.type === 'checkbox') this.checked = value; else this.value = value; this.listeners.change?.({ target: this }); }
  }
  const root = new Element('div'), window = {};
  runInNewContext(readFileSync(new URL('../src/group-editor.js', import.meta.url), 'utf8'), {
    window, document: { createElement: tag => new Element(tag) },
    Option: function (text, value) { return new Element('option', text, value); }, clearTimeout,
  });
  const form = window.ColossusGroups.createEditor({ root, catalog: currentCatalog, record, users: { users: [] }, organizations: { organizations: [] } });
  const all = node => [node, ...node.children.flatMap(all)];
  return { form, root, nodes: () => all(root), checkbox: id => {
    const label = 'Allow ' + window.ColossusGroups.modelLabel(id, currentCatalog);
    const check = all(root).find(node => node.tagName === 'input' && node.attributes['aria-label'] === label);
    assert(check, 'Missing Christopher version control: ' + id); return check;
  } };
}

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

test('Christopher form controls grant and remove versions independently of text models and each other', () => {
  const record = { id: 'team', name: 'Research team', memberIds: ['alice'], modelIds: ['default', 'christopher'], organizationId: null, activityModels: { 'workflow.analysis': 'default' } };
  const { form, checkbox, nodes } = editorForm(record);
  assert.equal(checkbox('christopher').checked, true);
  assert.equal(checkbox('christopher:0.2.0').checked, false);
  checkbox('christopher:0.2.0').change(true);
  assert.deepEqual(plain(form.value().modelIds), ['default', 'christopher', 'christopher:0.2.0']);
  checkbox('christopher').change(false);
  assert.deepEqual(plain(form.value().modelIds), ['default', 'christopher:0.2.0']);
  checkbox('christopher').change(true);
  checkbox('christopher:0.2.0').change(false);
  assert.deepEqual(plain(form.value().modelIds), ['default', 'christopher']);
  assert.deepEqual(plain(form.value().activityModels), record.activityModels);
  assert.deepEqual(record.modelIds, ['default', 'christopher'], 'Opening/editing the form must not mutate its source record');
  assert(nodes().some(node => node.textContent.includes('Christopher remains private to global Astra administrators')));
  assert.equal(nodes().filter(node => node.tagName === 'select').flatMap(node => node.options).some(option => String(option.value).startsWith('christopher')), false, 'Mathematical versions cannot become text model choices');
});

test('an unrelated form save preserves native version grants, their order and unavailable grants', () => {
  const record = { id: 'team', name: 'Research team', memberIds: ['alice'], modelIds: ['research', 'christopher:0.2.0', 'default', 'christopher', 'retired-model'], organizationId: 'acme', activityModels: { 'workflow.analysis.extraction': 'research' } };
  const { form, nodes } = editorForm(record);
  const name = nodes().find(node => node.tagName === 'input' && node.maxLength === 160);
  name.value = 'Renamed team'; name.listeners.input();
  assert.deepEqual(plain(form.value()), { ...record, name: 'Renamed team' });
});

test('paused mathematical routes prevent new grants while existing grants stay visible and removable', () => {
  for (const pause of ['model', 'provider']) {
    const currentCatalog = structuredClone(catalog);
    if (pause === 'model') currentCatalog.models.find(model => model.id === 'christopher:0.2.0').enabled = false;
    else currentCatalog.providers.find(provider => provider.id === 'math').enabled = false;
    const record = { id: 'team', name: 'Research team', memberIds: [], modelIds: ['default'], activityModels: {} };
    const fresh = editorForm(record, currentCatalog);
    assert.equal(fresh.checkbox('christopher:0.2.0').disabled, true);
    assert(fresh.nodes().some(node => node.textContent.includes('This model or its provider is paused')));
    assert.deepEqual(plain(fresh.form.value().modelIds), ['default']);
    const existing = editorForm({ ...record, modelIds: ['default', 'christopher:0.2.0'] }, currentCatalog);
    assert.equal(existing.checkbox('christopher:0.2.0').checked, true);
    assert.equal(existing.checkbox('christopher:0.2.0').disabled, false);
    assert.deepEqual(plain(existing.form.value().modelIds), ['default', 'christopher:0.2.0']);
    existing.checkbox('christopher:0.2.0').change(false);
    assert.deepEqual(plain(existing.form.value().modelIds), ['default']);
    assert.equal(existing.checkbox('christopher:0.2.0').disabled, true);
  }
  assert.equal(ui.modelIssue('christopher:0.2.0', '', catalog), '', 'Native CPU routes need no provider credential');
});

test('granting a mathematical version in the form preserves the server administrator gate', async () => {
  const config = configuration({ ASTRA_PROVIDER_CONFIG_JSON: '{"key":"synthetic-provider","model":"default-native"}', COLOSSUS_VAULT_SECRET: 'synthetic-local-vault-secret-of-32-characters' });
  const control = new ControlPlane(config, fetch, fetch), actor = { id: 'admin', email: 'admin@example.test' };
  const currentCatalog = { ...catalog, models: [{ ...catalog.models[0], id: 'astra-default' }, ...catalog.models.filter(model => model.native === 'christopher')] };
  const { form, checkbox } = editorForm({ id: 'team', name: 'Research team', memberIds: ['alice'], modelIds: ['astra-default'], activityModels: {} }, currentCatalog);
  checkbox('christopher:0.2.0').change(true);
  await control.save('groups', form.value(), actor);
  const identity = { kind: 'account', id: 'alice', admin: false, astraAdmin: false, allowedModels: ['astra-default', 'christopher:0.2.0'] };
  await assert.rejects(control.christopherRoute(identity, '0.2.0'), { code: 'christopher_admin_required' });
  const request = { messages: [{ role: 'user', content: 'Synthetic source' }] };
  assert.equal((await control.assignedRoute(identity, request, 'chat', 'workflow.analysis')).model, 'default-native');
});

test('form output changes the actual centrally assigned route and preserves scoped product authorization', async () => {
  const config = configuration({ COLOSSUS_ROUTES_JSON: JSON.stringify({ 'astra-default': { baseUrl: 'https://provider.example.test/v1', model: 'default-native', capabilities: ['text'] } }), ASTRA_PROVIDER_CONFIG_JSON: '{"key":"synthetic-provider","model":"default-native"}', COLOSSUS_VAULT_SECRET: 'synthetic-local-vault-secret-of-32-characters' });
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
