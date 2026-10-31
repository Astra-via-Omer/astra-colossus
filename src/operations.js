(() => {
  const byId = id => document.getElementById(id);
  let catalog, usage, productAccess, verified = false, consoleRole, accessVersion = 0, refreshInFlight = false, editor, confirmation, selectedView = 'overview';
  const discovered = new Map(), peopleDirectory = new Map();
  let groupUsers, groupOrganizations, groupSearchTimer, groupSearchVersion = 0;
  const titles = { overview: 'Overview', models: 'Models', groups: 'User groups', providers: 'Providers', systems: 'Astra systems', keys: 'API access', processes: 'Processes', analytics: 'Costs & usage', integrations: 'Integrations', engines: 'Engine studio', access: 'Users & access', guide: 'Documentation' };
  const aliases = { account: 'access', monitoring: 'analytics', 'user-access': 'access', guide: 'guide', room: 'engines' };
  const names = { chat: 'Chat inference', embedding: 'Embedding', run_engine: 'Engine run', test_engine: 'Draft test', evaluate: 'Evaluation', observe_media: 'Broadcast observation' };
  const count = value => value === null || value === undefined ? 'Unavailable' : new Intl.NumberFormat().format(value);
  const usd = value => value === null || value === undefined ? 'Unavailable' : new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 5 }).format(value);
  const time = value => value === null || value === undefined ? 'Unavailable' : value < 1000 ? Math.round(value) + ' ms' : value < 60000 ? (value / 1000).toFixed(1) + ' s' : (value / 60000).toFixed(1) + ' min';
  const stamp = value => value ? new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Not checked';
  const node = (tag, className, text) => { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; return element; };
  const badge = (text, kind = '') => node('span', 'ops-badge ' + kind, text);
  const statusBadge = status => badge(status.charAt(0).toUpperCase() + status.slice(1), ['completed', 'reachable', 'enabled'].includes(status) ? 'good' : ['failed', 'error', 'cancelled'].includes(status) ? 'bad' : status === 'running' ? 'running' : '');
  const empty = text => node('p', 'empty-state', text);
  function button(label, action, className = 'table-action') { const element = node('button', className, label); element.type = 'button'; element.addEventListener('click', action); return element; }
  function cell(value) { const td = node('td'); td.append(typeof value === 'string' ? document.createTextNode(value) : value); return td; }
  function identityCell(title, subtitle) { const element = node('div'); element.append(node('strong', '', title), node('small', '', subtitle)); return element; }
  function adminButton(...args) { const element = button(...args); element.dataset.adminAction = ''; return element; }
  function actionCell(actions) { const element = node('td'); for (const [label, action, adminOnly] of actions) if (!adminOnly || consoleRole === 'admin') element.append(button(label, action)); return element; }
  function emptyRow(target, colspan, message) { if (target.children.length) return; const row = node('tr'), td = node('td', 'table-empty', message); td.colSpan = colspan; row.append(td); target.append(row); }
  function notice(text, error = false) { byId('ops-notice').hidden = !text; byId('ops-notice').textContent = text; byId('ops-notice').setAttribute('role', error ? 'alert' : 'status'); }
  const providerName = id => catalog?.providers.find(provider => provider.id === id)?.name || id;
  const systemName = id => catalog?.systems.find(system => system.id === id)?.name || id || 'Shared account';
  const keyEnabled = key => key.enabled && Date.parse(key.expiresAt) > Date.now();
  function providerMark(provider) { const kind = provider.kind; return node('span', 'provider-mark ' + kind + '-mark', kind === 'gpu' ? '⌘' : provider.name.slice(0, 1).toUpperCase()); }
  function showView(view, updateHash = true) {
    if (!Object.hasOwn(titles, view)) view = 'overview';
    if (!['admin', 'professional'].includes(consoleRole) && !['engines', 'access', 'guide'].includes(view)) view = 'engines';
    selectedView = view;
    document.querySelectorAll('.ops-view').forEach(element => { element.hidden = element.id !== 'view-' + view; });
    document.querySelectorAll('.ops-navigation [data-view]').forEach(link => { const active = link.dataset.view === view; link.classList.toggle('active', active); if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); });
    byId('ops-view-title').textContent = view === 'access' && consoleRole !== 'admin' ? 'My account' : titles[view];
    if (view === 'guide') byId('guide').open = true;
    if (updateHash) history.replaceState(null, '', '#' + (view === 'analytics' ? 'monitoring' : view === 'access' ? (consoleRole === 'admin' ? 'user-access' : 'account') : view));
  }
  function bindNavigation(root = document) { root.querySelectorAll('[data-view]').forEach(link => link.addEventListener('click', event => { event.preventDefault(); showView(link.dataset.view); })); }
  bindNavigation();
  document.addEventListener('click', event => { const target = event.target.closest('[data-guide-target], #guide-sample-source'); if (target) showView(target.dataset.guideTarget === 'login' ? 'access' : 'engines'); }, true);
  document.querySelectorAll('[data-docs]').forEach(control => control.addEventListener('click', () => showView('guide')));
  window.addEventListener('hashchange', () => { const value = location.hash.slice(1); showView(aliases[value] || value, false); });
  showView(aliases[location.hash.slice(1)] || location.hash.slice(1) || 'overview', false);
  byId('ops-date').textContent = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date());
  byId('ops-api-example').textContent = `curl https://colossus.astra-via.com/v1/chat/completions \\\n  -H 'Authorization: Bearer YOUR_COLOSSUS_SYSTEM_KEY' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"model":"astra-default","messages":[{"role":"user","content":"Your request"}]}'`;

  function renderOverview() {
    if (!catalog) return;
    const available = catalog.models.filter(model => model.enabled && catalog.providers.some(provider => provider.id === model.providerId && provider.enabled && (provider.native || provider.credentialConfigured || provider.allowAnonymous)));
    byId('overview-models').textContent = count(available.length); byId('overview-model-detail').textContent = `${catalog.models.length} registered · ${catalog.providers.length} provider connections`;
    byId('nav-models-count').textContent = String(catalog.models.length);
    const totals = usage?.totals;
    byId('overview-calls').textContent = totals ? count(totals.calls) : '—';
    byId('overview-call-detail').textContent = totals ? `${totals.running} running · ${totals.processes} processes${usage.limited ? ' · limited sample' : ' · 24 hours'}` : 'Last 24 hours';
    byId('overview-tokens').textContent = totals ? count(totals.totalTokens) : '—';
    byId('overview-token-detail').textContent = totals ? `${totals.reportedCalls} / ${totals.calls} calls report complete usage` : 'Input and output usage';
    byId('overview-cost').textContent = totals ? usd(totals.estimatedCostUsd) : '—';
    const peak = catalog.models.some(model => model.pricing?.basis === 'peak_reference');
    byId('overview-cost-detail').textContent = totals ? `${usage.limited ? 'Limited sample' : totals.costComplete ? 'Covered usage' : 'Incomplete coverage'} · ${peak ? 'peak rate estimate' : 'configured rates'}` : 'USD · last 24 hours';
    byId('overview-call-track').style.width = totals?.calls ? Math.min(100, totals.reportedCalls / totals.calls * 100) + '%' : '0%';
    byId('nav-processes-count').textContent = totals?.running ? String(totals.running) : '';
    const buckets = Array(12).fill(0), cutoff = Date.now() - 86400000;
    for (const process of usage?.processes || []) { const index = Math.floor((Date.parse(process.startedAt) - cutoff) / 7200000); if (index >= 0 && index < 12) buckets[index] += process.calls.reduce((sum, call) => sum + (call.usage.totalTokens || 0), 0); }
    const max = Math.max(...buckets, 1), path = 'M' + buckets.map((value, index) => `${index * 180 / 11},${30 - value / max * 26}`).join('L');
    byId('overview-sparkline').querySelector('path').setAttribute('d', path);
    byId('ecosystem-nodes').replaceChildren(...catalog.systems.filter(system => ['workflow', 'enigma', 'lab', 'evidence', 'observer'].includes(system.id)).map(system => {
      const enrolled = catalog.keys.some(key => key.systemId === system.id && keyEnabled(key));
      const element = node('a', 'ecosystem-node'); element.href = '#systems'; element.addEventListener('click', event => { event.preventDefault(); showView('systems'); });
      const label = node('div'); label.append(node('strong', '', system.name), node('small', '', system.enabled ? enrolled ? 'Key enrolled' : 'Registered' : 'Paused'));
      element.append(node('span', 'node-symbol', { workflow: '◈', enigma: '⌁', lab: '⌘', evidence: '◇', observer: '◎' }[system.id]), label, node('span', 'node-indicator' + (enrolled ? ' enrolled' : ''))); return element;
    }));
    const providers = catalog.providers.slice(0, 3).map(provider => {
      const element = node('div', 'provider-summary'), label = node('div'); label.append(node('strong', '', provider.name), node('small', '', `${catalog.models.filter(model => model.providerId === provider.id).length} model routes · ${provider.native === 'christopher' ? 'Colossus CPU runtime' : provider.credentialSource === 'runtime' ? 'Runtime identity' : provider.credentialSource === 'managed' ? 'Managed credential' : provider.credentialConfigured ? 'Vault credential' : provider.allowAnonymous ? 'Anonymous endpoint' : 'Needs credential'}`));
      element.append(providerMark(provider), label, statusBadge(!provider.enabled ? 'paused' : provider.health?.status || (provider.native || provider.credentialConfigured || provider.allowAnonymous ? 'configured' : 'needs key'))); return element;
    });
    for (const [name, kind] of [['OpenAI', 'openai'], ['Anthropic', 'anthropic']]) if (providers.length < 3 && !catalog.providers.some(provider => provider.kind === kind)) {
      const element = node('div', 'provider-summary'), label = node('div'); label.append(node('strong', '', name), node('small', '', 'Ready to connect')); element.append(providerMark({ kind, name }), label, adminButton('＋ Connect', () => openEditor('providers', null, kind))); providers.push(element);
    }
    byId('overview-providers').replaceChildren(...providers);
    byId('overview-processes').replaceChildren(...(usage?.processes || []).slice(0, 4).map(process => {
      const element = node('div', 'compact-process'), label = node('div'); label.append(node('strong', '', names[process.operation] || process.operation), node('small', '', `${systemName(process.systemId)} · ${process.actor.email || process.actor.id}`)); element.append(node('span', 'process-mini-icon', '⌁'), label, statusBadge(process.status), node('span', '', time(process.durationMs))); element.tabIndex = 0; element.setAttribute('role', 'button'); element.setAttribute('aria-label', `Inspect ${names[process.operation] || process.operation} ${process.requestId}`); element.addEventListener('click', () => inspectProcess(process)); element.addEventListener('keydown', event => { if (event.key === 'Enter') inspectProcess(process); }); return element;
    }));
    if (!usage?.processes.length) byId('overview-processes').append(empty('New inference activity will appear here as your systems use Colossus.'));
    byId('overview-audit').replaceChildren(...catalog.audit.slice(0, 4).map(entry => { const element = node('div', 'audit-entry'); element.append(node('strong', '', `${entry.action.replaceAll('_', ' ')} · ${entry.recordId}`), node('small', '', `${entry.actor} · ${stamp(entry.at)}`)); return element; }));
    if (!catalog.audit.length) byId('overview-audit').append(empty('Configuration changes and key operations will be recorded here.'));
  }
  function renderGroups() {
    if (!catalog) return;
    const query = byId('groups-search').value.toLowerCase(), groups = catalog.groups || [], ui = window.ColossusGroups;
    const cards = groups.filter(group => `${group.name} ${group.memberIds.map(id => peopleDirectory.get(id)?.email || '').join(' ')}`.toLowerCase().includes(query)).map(group => {
      const card = node('article', 'group-card'), heading = node('div', 'group-card-heading'), title = node('div');
      const organization = groupOrganizations?.organizations.find(value => value.id === group.organizationId);
      title.append(node('h2', '', group.name), node('small', '', group.organizationId ? organization?.name || group.organizationId : 'Any organization or personal account')); heading.append(title, statusBadge(group.enabled ? 'enabled' : 'paused')); card.append(heading);
      const people = node('div', 'group-card-people'); people.append(node('strong', '', group.memberIds.length + (group.memberIds.length === 1 ? ' person' : ' people')));
      const known = group.memberIds.map(id => peopleDirectory.get(id)?.email).filter(Boolean);
      const remaining = group.memberIds.length - Math.min(known.length, 3); people.append(node('p', '', known.length ? known.slice(0, 3).join(', ') + (remaining ? ' +' + remaining + ' more' : '') : group.memberIds.length ? 'Open the group to view its people.' : 'Add people to start using this group.')); card.append(people);
      const defaultId = ui.defaultModel(group, catalog), base = node('div', 'group-card-default'); base.append(node('small', '', 'DEFAULT TEXT MODEL'), node('strong', '', defaultId ? ui.modelLabel(defaultId, catalog) : 'No text model')); card.append(base);
      const products = node('dl', 'group-card-products');
      for (const [system, activity] of [['Workflow', 'workflow.analysis'], ['Enigma', 'enigma.analysis'], ['Evidence', 'evidence.review']]) { const id = ui.effectiveModel(group, activity, catalog); products.append(node('dt', '', system), node('dd', '', id ? ui.modelLabel(id, catalog) : 'No text model')); }
      const rules = Object.keys(group.activityModels || {}).length; card.append(products, node('p', 'group-help', rules ? rules + (rules === 1 ? ' product activity rule' : ' product activity rules') : 'All products follow the group default'));
      if (group.modelIds.includes('broadcast-media')) card.append(badge('Enigma broadcast media enabled', 'good'));
      const actions = node('div', 'actions'); actions.append(button(consoleRole === 'admin' ? 'Edit group' : 'View group', () => openEditor('groups', group), 'secondary'), adminButton(group.enabled ? 'Pause group' : 'Enable group', () => toggle('groups', group), 'secondary')); card.append(actions); return card;
    });
    byId('ops-group-rows').replaceChildren(...cards);
    if (!cards.length) byId('ops-group-rows').append(empty(query ? 'No matching groups. Try another name or email.' : 'Create a group, select its people, and choose a model.'));
    const members = groups.reduce((total, group) => total + group.memberIds.length, 0); byId('groups-summary').textContent = `${groups.length} ${groups.length === 1 ? 'group' : 'groups'} · ${members} ${members === 1 ? 'person' : 'people'} assigned`;
  }
  function searchGroups() {
    renderGroups(); clearTimeout(groupSearchTimer); const version = ++groupSearchVersion, query = byId('groups-search').value.trim();
    if (query && consoleRole === 'admin') groupSearchTimer = setTimeout(async () => {
      try { const result = await api('/v1/access/users?search=' + encodeURIComponent(query) + '&offset=0'); if (!verified || version !== groupSearchVersion) return; for (const user of result.users) peopleDirectory.set(user.id, user); renderGroups(); }
      catch { if (verified && version === groupSearchVersion && selectedView === 'groups') notice('People search is unavailable. You can still search by group name.', true); }
    }, 250);
  }
  function renderModels() {
    if (!catalog) return;
    const query = byId('models-search').value.toLowerCase();
    const rows = catalog.models.filter(model => `${model.name} ${model.id} ${model.model} ${providerName(model.providerId)}`.toLowerCase().includes(query)).map(model => {
      const row = node('tr'), calls = usage?.models.find(value => value.route === model.id)?.calls || 0;
      const provider = catalog.providers.find(provider => provider.id === model.providerId), available = model.enabled && provider?.enabled;
      row.append(cell(identityCell(model.name, model.id + ' → ' + model.model)), cell(providerName(model.providerId)), cell(model.task === 'embedding' ? 'Embedding' : model.capabilities.join(' · ')), cell(statusBadge(available ? 'enabled' : 'paused')), cell(count(calls)), actionCell([[consoleRole === 'admin' ? 'Configure' : 'View details', () => openEditor('models', model)], [model.enabled ? 'Pause' : 'Enable', () => toggle('models', model), true]])); return row;
    });
    byId('ops-model-rows').replaceChildren(...rows); emptyRow(byId('ops-model-rows'), 6, 'No models match. Register a model route to start.');
    byId('models-summary').textContent = `${catalog.models.length} model routes · ${catalog.providers.length} provider connections`;
  }
  function connectionCard(record, collection) {
    const element = node('article', 'connection-card'), top = node('div', 'connection-card-top'), title = node('div');
    title.append(node('h2', '', record.name), node('small', '', collection === 'providers' ? record.native ? record.native === 'christopher' ? 'Colossus mathematical runtime' : 'Native Vertex broadcast adapter' : record.protocol === 'anthropic' ? 'Anthropic Messages' : record.kind === 'gpu' ? 'GPU · compatible serving' : 'OpenAI compatible' : { rest: 'HTTP data API', gcs: 'Google Cloud Storage', s3: 'S3 storage', training: 'External training controller' }[record.kind]));
    top.append(collection === 'providers' ? providerMark(record) : node('span', 'provider-mark gpu-mark', record.kind === 'training' ? '⌘' : '◇'), title, statusBadge(!record.enabled ? 'paused' : record.health?.status || 'registered')); element.append(top);
    element.append(node('p', 'connection-endpoint', record.baseUrl || record.endpoint));
    element.append(node('p', record.credentialConfigured ? 'connection-key-status' : '', record.native === 'christopher' ? 'Runs inside Colossus · no provider API key' : record.credentialSource === 'runtime' ? '◇ Google runtime identity · no API key' : record.credentialSource === 'managed' ? '◇ Credential supplied by managed configuration' : record.credentialConfigured ? '◇ Credential encrypted in the vault' : record.allowAnonymous ? 'Public endpoint · no credential' : 'No credential stored'));
    element.append(node('p', '', record.health ? `${stamp(record.health.checkedAt)} · ${record.health.latencyMs} ms${record.health.httpStatus ? ' · HTTP ' + record.health.httpStatus : ''}` : collection === 'providers' ? 'No connection check has been recorded.' : record.description || 'Registered connection metadata.'));
    const actions = node('div', 'actions'); actions.append(button(consoleRole === 'admin' ? 'Configure' : 'View details', () => openEditor(collection, record), 'secondary'));
    if (!record.native && (collection === 'providers' || ['rest', 'training'].includes(record.kind))) actions.append(adminButton(collection === 'providers' ? 'Check & discover' : 'Check endpoint', () => checkConnection(collection, record), 'secondary'));
    actions.append(adminButton(record.enabled ? 'Pause' : 'Enable', () => toggle(collection, record), 'secondary')); element.append(actions);
    if (collection === 'providers' && discovered.has(record.id)) {
      const list = node('div', 'discovered-models'), models = discovered.get(record.id); list.append(node('strong', '', models.length ? 'Discovered models · select to register' : 'No model IDs were returned by this endpoint.'));
      for (const model of models) list.append(adminButton(model.id + '  ＋', () => openEditor('models', null, { providerId: record.id, nativeModel: model.id }), 'secondary')); element.append(list);
    }
    return element;
  }
  function renderProviders() { if (catalog) byId('ops-provider-cards').replaceChildren(...catalog.providers.map(provider => connectionCard(provider, 'providers'))); }
  function renderSystems() {
    if (!catalog) return;
    byId('ops-system-cards').replaceChildren(...catalog.systems.map(system => {
      const element = node('article', 'connection-card'), top = node('div', 'connection-card-top'), label = node('div'); label.append(node('h2', '', system.name), node('small', '', system.id)); top.append(node('span', 'provider-mark gpu-mark', '◈'), label, statusBadge(system.enabled ? 'enabled' : 'paused')); element.append(top, node('p', '', system.description || 'Registered Astra client'));
      const spend = node('div', 'system-spend'); spend.append(node('span', '', 'Monthly estimated spend'), node('strong', '', usd(system.spending?.spentUsd || 0))); element.append(spend);
      const track = node('div', 'budget-track'), fill = node('span'); fill.style.width = system.monthlyBudgetUsd ? Math.min(100, ((system.spending?.spentUsd || 0) + (system.spending?.reservedUsd || 0)) / system.monthlyBudgetUsd * 100) + '%' : '0%'; track.append(fill); element.append(track);
      element.append(node('p', '', `${system.monthlyBudgetUsd === null ? 'No spending cap' : usd(system.monthlyBudgetUsd) + ' monthly cap'} · ${usd(system.spending?.reservedUsd || 0)} reserved`), node('p', 'system-key-count', `${catalog.keys.filter(key => key.systemId === system.id && keyEnabled(key)).length} active system keys · ${system.requestsPerMinute} calls / minute`));
      if (system.spending?.unpricedCalls) element.append(node('p', '', system.spending.unpricedCalls + ' calls have incomplete costs; their reservations remain held.'));
      const actions = node('div', 'actions'); actions.append(button(consoleRole === 'admin' ? 'Manage system' : 'View details', () => openEditor('systems', system), 'secondary'), adminButton('Issue key', () => openEditor('keys', null, { systemId: system.id }), 'secondary'), adminButton(system.enabled ? 'Pause' : 'Enable', () => toggle('systems', system), 'secondary')); element.append(actions); return element;
    }));
  }
  function renderKeys() {
    if (!catalog) return;
    byId('ops-key-rows').replaceChildren(...catalog.keys.map(key => { const row = node('tr'), active = keyEnabled(key); row.append(cell(identityCell(key.name, key.prefix)), cell(systemName(key.systemId)), cell(key.allowedModels.join(', ')), cell(stamp(key.expiresAt)), cell(statusBadge(active ? 'enabled' : key.enabled ? 'expired' : 'revoked')), actionCell(active && consoleRole === 'admin' ? [['Revoke', () => confirm('Revoke system key?', `Requests using ${key.name} will be denied immediately. Issue a new key if the system needs access again.`, () => api(`/v1/control/keys/${key.id}/revoke`, {}))]] : [])); return row; }));
    emptyRow(byId('ops-key-rows'), 6, 'No system keys issued yet. Existing shared credentials continue to work.');
  }
  function renderProductAccess() {
    if (!productAccess || !catalog) return;
    let panel = byId('ops-product-access');
    if (!panel) { panel = node('section', 'ops-panel'); panel.id = 'ops-product-access'; byId('view-keys').append(panel); }
    // Keep an in-progress grant form intact during the normal periodic refresh.
    if (!panel.children.length) {
      const heading = node('div', 'panel-heading'); heading.append(node('h2', '', 'Product licenses'));
      const state = node('p'); state.id = 'ops-license-state';
      panel.append(heading, state, node('p', '', 'Each account needs explicit group membership and a separate license for each Astra product. Licenses do not grant models outside the group or product key.'));
      const form = node('form', 'ops-license-form'); form.id = 'ops-license-form';
      for (const [name, label, type] of [['userId', 'Approved group member', 'select'], ['productId', 'Astra product', 'select'], ['startsAt', 'Starts on (UTC)', 'date'], ['expiresAt', 'Expires on (UTC)', 'date']]) {
        const wrapper = node('label', '', label), input = node(type === 'select' ? 'select' : 'input'); input.name = name; input.required = true;
        if (type === 'date') input.type = type;
        wrapper.append(input); form.append(wrapper);
      }
      form.elements.startsAt.value = new Date().toISOString().slice(0, 10);
      form.elements.expiresAt.value = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
      const submit = node('button', '', 'Grant / update license'); submit.type = 'submit'; form.append(submit);
      form.addEventListener('submit', event => {
        event.preventDefault(); const data = new FormData(form), userId = data.get('userId'), productId = data.get('productId');
        const group = catalog.groups.find(group => group.enabled && group.memberIds.includes(userId));
        const previous = productAccess.licenses.find(license => license.userId === userId && license.productId === productId);
        if (!group) return notice('Assign this account to an active group first.', true);
        const body = { userId, productId, groupId: group.id, status: 'active', startsAt: data.get('startsAt') + 'T00:00:00Z', expiresAt: data.get('expiresAt') + 'T00:00:00Z', expectedUpdatedAt: previous?.updatedAt || null };
        confirm('Grant this product license?', `${peopleDirectory.get(userId)?.email || userId} will be licensed for ${systemName(productId)} in ${group.name}, until ${data.get('expiresAt')} UTC. Group and model restrictions still apply.`, () => api('/v1/control/product-licenses', body));
      });
      panel.append(form);
      const tableWrap = node('div', 'table-scroll'), table = node('table', 'ops-table'), head = node('thead'), row = node('tr');
      for (const title of ['ACCOUNT', 'PRODUCT / GROUP', 'LICENSE', 'EXPIRES', 'ACTION']) row.append(node('th', '', title));
      const rows = node('tbody'); rows.id = 'ops-license-rows'; head.append(row); table.append(head, rows); tableWrap.append(table); panel.append(tableWrap);
      const activate = button('Activate license enforcement', () => confirm('Activate product license enforcement?', 'Every Colossus processing request will require a verified Astra product, active end user, explicit group membership and a separate active product license. Unlicensed accounts and service-only clients will be denied. Operator management remains available.', () => api('/v1/control/product-access', { enabled: true })), 'secondary'); activate.id = 'ops-license-activate'; panel.append(activate);
    }
    byId('ops-license-state').textContent = productAccess.policy.enabled ? 'Enforced · product licenses are checked on every processing request.' : 'Setup mode · separate product-license enforcement is not active yet. Existing access rules still apply.';
    byId('ops-license-activate').hidden = productAccess.policy.enabled;
    const form = byId('ops-license-form');
    const choices = (select, pairs) => { const value = select.value; select.replaceChildren(...pairs.map(([id, label]) => new Option(label, id))); if (pairs.some(([id]) => id === value)) select.value = value; };
    choices(form.elements.userId, [['', 'Choose a group member'], ...[...new Set(catalog.groups.filter(group => group.enabled).flatMap(group => group.memberIds))].map(id => [id, peopleDirectory.get(id)?.email || id])]);
    choices(form.elements.productId, [['', 'Choose a product'], ...productAccess.products.map(id => [id, systemName(id)])]);
    byId('ops-license-rows').replaceChildren(...productAccess.licenses.map(license => {
      const row = node('tr'); row.append(cell(identityCell(peopleDirectory.get(license.userId)?.email || license.userId, license.userId)), cell(identityCell(systemName(license.productId), license.groupId)), cell(license.status), cell(stamp(license.expiresAt)), actionCell(license.status === 'revoked' || consoleRole !== 'admin' ? [] : [['Revoke', () => confirm('Revoke this product license?', 'New requests for this account and product will be denied when license enforcement is active. Other products keep their own licenses.', () => api('/v1/control/product-licenses', { ...license, status: 'revoked', expectedUpdatedAt: license.updatedAt }))]])); return row;
    }));
    emptyRow(byId('ops-license-rows'), 5, 'No product licenses issued. Group membership alone does not issue a license.');
  }
  function renderProcesses() {
    const query = byId('process-search').value.toLowerCase(), status = byId('process-state').value;
    const records = (usage?.processes || []).filter(process => (!status || process.status === status) && `${process.requestId} ${process.systemId} ${process.actor.email} ${process.actor.id} ${process.calls.map(call => call.route).join(' ')}`.toLowerCase().includes(query));
    byId('ops-process-rows').replaceChildren(...records.map(process => { const row = node('tr'), actions = [['Inspect', () => inspectProcess(process)]]; if (consoleRole === 'admin' && process.status === 'running') actions.push(['Cancel', () => cancelProcess(process)]); row.append(cell(identityCell(names[process.operation] || process.operation, process.requestId.slice(0, 8) + ' · ' + stamp(process.startedAt))), cell(identityCell(systemName(process.systemId), process.actor.email || process.actor.id)), cell([...new Set(process.calls.map(call => call.route))].join(', ') || 'Preparing call'), cell(statusBadge(process.status)), cell(time(process.durationMs)), actionCell(actions)); return row; }));
    emptyRow(byId('ops-process-rows'), 6, 'No recorded processes match this view. The latest 100 processes are shown.');
    if (catalog) byId('ops-external-jobs').replaceChildren(...catalog.jobs.map(job => { const element = node('article', 'connection-card'), top = node('div', 'connection-card-top'); top.append(node('h2', '', job.name), statusBadge(job.status)); element.append(top, node('p', '', `${job.kind} · ${systemName(job.systemId)}`), node('p', '', job.description || 'External job tracked by an administrator.'), node('p', '', `Reported cost: ${usd(job.reportedCostUsd)} · ${stamp(job.updatedAt)}`), button(consoleRole === 'admin' ? 'Update reported status' : 'View details', () => openEditor('jobs', job), 'secondary')); return element; }));
    if (catalog && !catalog.jobs.length) byId('ops-external-jobs').append(empty('No external jobs registered. Track training and data work run by your own systems here.'));
  }
  function renderIntegrations() {
    if (!catalog) return;
    byId('ops-integration-cards').replaceChildren(...catalog.integrations.map(integration => connectionCard(integration, 'integrations')));
    if (!catalog.integrations.length) byId('ops-integration-cards').append(empty('Register your first data API, bucket location or training controller.'));
  }
  function renderAll() { renderGroups(); renderOverview(); renderModels(); renderProviders(); renderSystems(); renderKeys(); renderProductAccess(); renderProcesses(); renderIntegrations();
    if (catalog) document.dispatchEvent(new CustomEvent('colossus:catalog', { detail: catalog.models.filter(model => model.enabled && catalog.providers.some(provider => provider.id === model.providerId && provider.enabled && (provider.credentialConfigured || provider.allowAnonymous))) }));
  }
  async function refresh() {
    if (!verified || refreshInFlight) return; const version = accessVersion; refreshInFlight = true; byId('ops-refresh').disabled = true;
    try { const [registry, activity, users, organizations, licenses] = await Promise.all([api('/v1/control'), api('/v1/monitoring?days=1'), consoleRole === 'admin' ? api('/v1/access/users?search=&offset=0').catch(() => null) : Promise.resolve(null), api('/v1/control/organizations').catch(() => null), api('/v1/control/product-access')]); if (!verified || version !== accessVersion) return; catalog = registry; usage = activity; productAccess = licenses; groupUsers = users; groupOrganizations = organizations; for (const user of users?.users || []) peopleDirectory.set(user.id, user); for (const process of activity.processes || []) if (process.actor.kind === 'account' && process.actor.email && !peopleDirectory.has(process.actor.id)) peopleDirectory.set(process.actor.id, { id: process.actor.id, email: process.actor.email }); byId('ops-storage').textContent = registry.storage === 'firestore' ? 'Database connected' : 'Local preview · volatile'; byId('ops-environment').lastChild.textContent = registry.storage === 'firestore' ? 'PRODUCTION GATEWAY' : 'LOCAL PREVIEW'; byId('ops-api-example').textContent = byId('ops-api-example').textContent.replace('https://colossus.astra-via.com', registry.gateway.origin); renderAll(); }
    catch (error) { if (verified) notice(error.message, true); }
    finally { refreshInFlight = false; byId('ops-refresh').disabled = false; }
  }
  async function checkConnection(collection, record) {
    notice(`Checking ${record.name}… This does not run model inference.`);
    try { const result = await api(`/v1/control/${collection}/${record.id}/check`, {}); if (collection === 'providers') discovered.set(record.id, result.models); notice(result.health.status === 'reachable' ? `${record.name} responded in ${result.health.latencyMs} ms${collection === 'providers' ? '. ' + result.models.length + ' model IDs discovered.' : '.'}` : `${record.name} did not pass the endpoint check${result.health.httpStatus ? ' (HTTP ' + result.health.httpStatus + ')' : ''}. Check the endpoint and credential.`, result.health.status !== 'reachable'); await refresh(); }
    catch (error) { notice(error.message, true); }
  }
  function confirm(title, description, action) { if (consoleRole !== 'admin') return notice('Configuration changes require an administrator.', true); confirmation = action; byId('ops-confirm-title').textContent = title; byId('ops-confirm-description').textContent = description; byId('ops-confirm-error').textContent = ''; byId('ops-confirm').showModal(); }
  function toggle(collection, record) { confirm(`${record.enabled ? 'Pause' : 'Enable'} ${record.name}?`, collection === 'models' || collection === 'providers' ? 'This changes admission for new model calls across connected systems. Active calls finish unless you cancel them.' : 'This changes access for new requests using this registered connection or system.', () => api('/v1/control/' + collection, { id: record.id, name: record.name, enabled: !record.enabled, expectedUpdatedAt: record.updatedAt }, 'PATCH')); }
  function cancelProcess(process) { confirm('Cancel this process?', 'Colossus will stop the active provider request. Cancellation across instances can take a few seconds. Work already performed by the provider may still incur cost.', () => api(`/v1/control/processes/${process.requestId}/cancel`, {})); }
  byId('ops-confirm-action').addEventListener('click', async () => { if (!confirmation) return; byId('ops-confirm-action').disabled = true; try { await confirmation(); confirmation = null; byId('ops-confirm').close(); await refresh(); void loadMonitoring(); } catch (error) { byId('ops-confirm-error').textContent = error.message; } finally { byId('ops-confirm-action').disabled = false; } });
  byId('ops-confirm-cancel').addEventListener('click', () => { confirmation = null; byId('ops-confirm').close(); });

  function field(name, label, value = '', options = {}) {
    const wrapper = node('label', options.wide ? 'field-wide' : '', label); let input;
    if (options.choices) { input = node('select'); for (const [id, text] of options.choices) input.add(new Option(text, id)); }
    else input = node(options.textarea ? 'textarea' : 'input');
    input.name = name; input.id = 'editor-' + name; if (!options.choices && !options.textarea) input.type = options.type || 'text';
    input.value = value ?? ''; input.required = !!options.required; if (options.disabled) input.disabled = true;
    if (options.min !== undefined) input.min = options.min; if (options.max !== undefined) input.max = options.max;
    if (options.type === 'number') input.step = options.step || 'any';
    if (!options.choices) input.maxLength = options.type === 'password' ? 8192 : options.textarea ? 500 : 1500;
    if (options.placeholder) input.placeholder = options.placeholder;
    if (options.type === 'password') { input.autocomplete = 'new-password'; input.spellcheck = false; }
    if (options.textarea) input.rows = 3; wrapper.append(input);
    if (options.note) wrapper.append(node('small', 'field-note', options.note)); byId('ops-editor-fields').append(wrapper); return input;
  }
  function checkboxes(name, title, choices, selected) {
    const fieldset = node('fieldset'), grid = node('div', 'check-grid'); fieldset.append(node('legend', '', title));
    for (const [value, label] of choices) { const wrapper = node('label', 'checkbox-row'), input = node('input'); input.type = 'checkbox'; input.name = name; input.value = value; input.checked = selected.includes(value); wrapper.append(input, document.createTextNode(label)); grid.append(wrapper); }
    fieldset.append(grid); byId('ops-editor-fields').append(fieldset);
  }
  const presets = { openai: ['OpenAI', 'https://api.openai.com/v1'], anthropic: ['Anthropic', 'https://api.anthropic.com/v1'], gpu: ['GPU model endpoint', 'https://your-serving-endpoint.example/v1'], compatible: ['Compatible provider', 'https://your-provider.example/v1'] };
  function openEditor(collection, record, preset) {
    if (!catalog || !verified) { notice('Wait for the operations registry to load.', true); return; }
    if (consoleRole !== 'admin' && !record) return notice('Configuration changes require an administrator.', true);
    editor?.groupForm?.dispose();
    editor = { collection, record, preset }; byId('ops-editor').classList.toggle('group-dialog', collection === 'groups'); byId('ops-editor-fields').replaceChildren(); byId('ops-editor-error').textContent = ''; byId('ops-editor-save').disabled = false;
    if (collection === 'groups') {
      byId('ops-editor-title').textContent = record ? 'Edit group' : 'Create a group'; byId('ops-editor-kicker').textContent = 'PEOPLE & MODEL SETTINGS';
      editor.groupForm = window.ColossusGroups.createEditor({ root: byId('ops-editor-fields'), catalog, record, users: consoleRole === 'admin' ? groupUsers : { users: [...peopleDirectory.values()] }, organizations: groupOrganizations, api, onUsers: users => { for (const user of users) peopleDirectory.set(user.id, user); renderGroups(); } });
      byId('ops-editor-save').textContent = 'Save group'; byId('ops-editor-note').textContent = 'Product approvals and key access still apply.'; applyEditorAccess(); byId('ops-editor').showModal(); return;
    }
    byId('ops-editor-title').textContent = collection === 'keys' ? 'Issue a system key' : `${record ? 'Configure' : 'Register'} ${({ providers: 'provider connection', models: 'model route', systems: 'Astra system', integrations: 'integration', jobs: 'external job', groups: 'user group' })[collection]}`;
    byId('ops-editor-kicker').textContent = record ? 'CONTROL PLANE / EDIT' : 'CONTROL PLANE / NEW CONNECTION';
    const providerKind = typeof preset === 'string' ? preset : record?.kind || 'openai';
    field('name', 'Name', record?.name || (collection === 'providers' ? presets[providerKind][0] : ''), { required: true });
    if (collection !== 'keys') field('id', collection === 'models' ? 'Model alias' : 'Registry ID', record?.id || '', { required: true, disabled: !!record, placeholder: collection === 'models' ? 'astra-reasoning' : 'readable-unique-id' });
    if (record?.native) {
      byId('ops-editor-fields').append(node('p', 'editor-note', record.native === 'christopher' ? `Native mathematical checks · ${record.model || record.baseUrl}. Implementation is configured by deployment. Use Pause / Enable to control new admissions.` : `Native broadcast observation · ${record.model || record.baseUrl}. Provider, model and modality pricing are configured by deployment. Use Pause / Enable to control new admissions.`));
      byId('ops-editor-note').textContent = record.native === 'christopher' ? 'Christopher runs structured mathematical checks at /v1/christopher/evaluate inside Colossus. Its implementation is versioned in the service; you can rename or pause it here.' : 'You can change the display name here. This native route uses /v1/media/observe and retains the Enigma gateway requirement for account calls.';
    } else if (collection === 'providers') {
      const kind = field('kind', 'Provider type', providerKind, { required: true, choices: Object.entries(presets).map(([key, value]) => [key, value[0]]) });
      const url = field('baseUrl', 'API base URL', record?.baseUrl || presets[providerKind][1], { required: true, wide: true, note: 'HTTPS only. Include /v1 if required by the provider. Private and metadata addresses are blocked.' });
      kind.addEventListener('change', () => { if (!record) { url.value = presets[kind.value][1]; byId('editor-name').value = presets[kind.value][0]; } });
      field('apiKey', record?.credentialConfigured ? 'Replace API credential (optional)' : 'API credential', '', { type: 'password', wide: true, note: record?.credentialSource === 'managed' ? 'The managed credential remains in use if this field is blank.' : 'Encrypted on the server. Saved credentials are never returned to the browser.' });
      checkboxes('anonymous', 'Compatible / GPU endpoints', [['allow', 'This endpoint intentionally accepts requests without an API key']], record?.allowAnonymous ? ['allow'] : []);
      byId('ops-editor-note').textContent = 'Saving does not make a paid model call.';
    } else if (collection === 'models') {
      if (!catalog.providers.length) { notice('Connect a provider before registering its model.', true); return; }
      const choices = catalog.providers.filter(value => !value.native);
      const provider = field('providerId', 'Provider connection', record?.providerId || preset?.providerId || choices[0]?.id || '', { required: true, choices: choices.map(value => [value.id, value.name]) });
      const native = field('model', 'Native provider model name', record?.model || preset?.nativeModel || '', { required: true, placeholder: 'Exact model ID from your provider' });
      const dataList = node('datalist'); dataList.id = 'native-model-options'; byId('ops-editor-fields').append(dataList); native.setAttribute('list', dataList.id);
      const updateList = () => dataList.replaceChildren(...(discovered.get(provider.value) || []).map(model => new Option(model.id, model.id))); provider.addEventListener('change', updateList); updateList();
      field('task', 'Serving task', record?.task || 'chat', { choices: [['chat', 'Chat / engine inference'], ['embedding', 'Text embeddings']] });
      field('maxTokens', 'Maximum output tokens', record?.maxTokens || 4000, { type: 'number', min: 1, max: 65536, step: '1', required: true });
      checkboxes('capabilities', 'Chat input capabilities', [['text', 'Text'], ['image', 'Images'], ['audio', 'Audio'], ['video', 'Video']], record?.capabilities || ['text']);
      field('inputRate', 'Input · USD / 1M tokens', record?.pricing?.inputPerMillion, { type: 'number', min: 0, max: 1000000, placeholder: 'Unavailable until configured' });
      field('outputRate', 'Output · USD / 1M tokens', record?.pricing?.outputPerMillion, { type: 'number', min: 0, max: 1000000 });
      field('cachedRate', 'Cached input · USD / 1M tokens', record?.pricing?.cachedInputPerMillion, { type: 'number', min: 0, max: 1000000, wide: true, note: 'Use your provider’s verified rates. Leave all prices blank to keep cost unavailable.' });
      byId('ops-editor-note').textContent = 'The alias remains stable for calling applications.';
    } else if (collection === 'systems') {
      field('url', 'System URL (optional)', record?.url || '', { wide: true, placeholder: 'https://your-system.astra-via.com' });
      field('monthlyBudgetUsd', 'Monthly spending cap · USD', record?.monthlyBudgetUsd, { type: 'number', min: 0, max: 10000000, placeholder: 'Unlimited' });
      field('requestsPerMinute', 'Model calls per minute', record?.requestsPerMinute || 120, { type: 'number', min: 1, max: 100000, step: '1', required: true });
      field('description', 'Purpose', record?.description || '', { wide: true, textarea: true }); byId('ops-editor-note').textContent = 'A capped system requires configured model prices. Chat accepts text only under a cap; native broadcast media uses its token-count preflight. Incomplete usage retains reserved spending.';
    } else if (collection === 'keys') {
      field('systemId', 'Calling system', preset?.systemId || '', { required: true, choices: [['', 'Select a system'], ...catalog.systems.filter(value => value.enabled).map(value => [value.id, value.name])] });
      field('expiresInDays', 'Key lifetime', '90', { choices: [['30', '30 days'], ['90', '90 days'], ['365', '365 days']] });
      checkboxes('allowedModels', 'Model grants · select at least one', catalog.models.map(value => [value.id, value.name + ' · ' + value.id]), []);
      checkboxes('groupPolicy', 'User group enforcement', [['required', 'Require a verified account assigned to a Colossus group']], ['required']);
      const organizations = field('organizationIds', 'Organization restrictions · one ID per line (optional)', '', { wide: true, textarea: true }); organizations.maxLength = 12500;
      checkboxes('registrationProviderIds', 'Lab release registration · Lab keys only', catalog.providers.filter(value => !value.native).map(value => [value.id, value.name]), []);
      byId('ops-editor-note').textContent = 'The key will be shown once. Keep it on the backend. For machine-only integrations, clear group enforcement explicitly.';
    } else if (collection === 'integrations') {
      field('kind', 'Connection type', record?.kind || 'rest', { choices: [['rest', 'HTTP data API'], ['gcs', 'Google Cloud Storage'], ['s3', 'S3 storage'], ['training', 'External training controller']] });
      field('systemId', 'Owning system', record?.systemId || 'lab', { choices: catalog.systems.map(value => [value.id, value.name]) });
      field('endpoint', 'HTTPS endpoint or bucket URI', record?.endpoint || '', { required: true, wide: true, placeholder: 'https://data.example/api or gs://bucket/prefix' });
      field('apiKey', 'HTTP API credential (optional)', '', { wide: true, type: 'password', note: 'Stored encrypted. Leave blank to keep an existing credential.' });
      field('description', 'Purpose and data boundary', record?.description || '', { wide: true, textarea: true }); byId('ops-editor-note').textContent = 'Registers a connection. No data ingestion starts automatically.';
    } else if (collection === 'jobs') {
      field('kind', 'External job type', record?.kind || 'training', { choices: [['training', 'Model training'], ['ingestion', 'Data ingestion / indexing'], ['evaluation', 'External evaluation']] });
      field('systemId', 'Owning system', record?.systemId || 'lab', { choices: catalog.systems.map(value => [value.id, value.name]) });
      field('status', 'Reported status', record?.status || 'planned', { choices: ['planned', 'running', 'completed', 'failed', 'cancelled'].map(value => [value, value]) });
      field('integrationId', 'Registered connection', record?.integrationId || '', { choices: [['', 'No connection selected'], ...catalog.integrations.map(value => [value.id, value.name])] });
      field('externalUrl', 'External job URL (optional)', record?.externalUrl || '', { wide: true });
      field('reportedCostUsd', 'Reported external cost · USD (optional)', record?.reportedCostUsd, { type: 'number', min: 0, max: 10000000 });
      field('description', 'Job notes', record?.description || '', { wide: true, textarea: true }); byId('ops-editor-note').textContent = 'Tracking only. This does not launch or cancel external compute.';
    }
    const name = byId('editor-name'), slug = byId('editor-id');
    if (slug && !record) name.addEventListener('input', () => { if (!slug.dataset.edited) slug.value = name.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100); });
    if (slug && !record && name.value) slug.value = name.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100);
    slug?.addEventListener('input', () => { slug.dataset.edited = 'true'; });
    byId('ops-editor-save').textContent = collection === 'keys' ? 'Issue system key' : 'Save configuration'; applyEditorAccess(); byId('ops-editor').showModal();
  }
  function applyEditorAccess() {
    const readOnly = consoleRole !== 'admin';
    byId('ops-editor-save').hidden = readOnly;
    byId('ops-editor-cancel').textContent = readOnly ? 'Close' : 'Cancel';
    if (!readOnly) return;
    byId('ops-editor-title').textContent = editor.collection === 'groups' ? 'View group' : 'View configuration';
    byId('ops-editor-note').textContent = 'View only · Configuration changes require an administrator.';
    byId('ops-editor-fields').querySelectorAll('input, select, textarea, button:not([role="tab"])').forEach(control => { control.disabled = true; });
  }
  function closeEditor() { editor?.groupForm?.dispose(); byId('ops-editor').close(); byId('ops-editor-form').reset(); byId('ops-editor-fields').replaceChildren(); editor = null; }
  byId('ops-editor-close').addEventListener('click', closeEditor); byId('ops-editor-cancel').addEventListener('click', closeEditor);
  byId('ops-editor').addEventListener('cancel', () => { editor?.groupForm?.dispose(); byId('ops-editor-fields').replaceChildren(); editor = null; });
  byId('ops-editor-form').addEventListener('submit', async event => {
    event.preventDefault(); if (!editor || !verified || consoleRole !== 'admin') return;
    const data = new FormData(event.currentTarget), values = Object.fromEntries(data), collection = editor.collection;
    let body = { ...values, ...(editor.record ? { id: editor.record.id, expectedUpdatedAt: editor.record.updatedAt } : {}) };
    byId('ops-editor-save').disabled = true; byId('ops-editor-error').textContent = '';
    try {
      if (collection === 'providers' && !editor.record?.native) { body.allowAnonymous = data.getAll('anonymous').includes('allow'); delete body.anonymous; if (!body.apiKey) delete body.apiKey; }
      if (collection === 'models' && !editor.record?.native) {
        body.capabilities = data.getAll('capabilities'); body.maxTokens = Number(body.maxTokens);
        if ([body.inputRate, body.outputRate, body.cachedRate].every(value => value === '')) body.pricing = null;
        else { if (body.inputRate === '' || body.outputRate === '') throw Error('Set both input and output rates, or leave all prices blank.'); body.pricing = { inputPerMillion: Number(body.inputRate), outputPerMillion: Number(body.outputRate), ...(body.cachedRate !== '' ? { cachedInputPerMillion: Number(body.cachedRate) } : {}) };
          const old = editor.record?.pricing; if (old && old.inputPerMillion === body.pricing.inputPerMillion && old.outputPerMillion === body.pricing.outputPerMillion && old.cachedInputPerMillion === body.pricing.cachedInputPerMillion) body.pricing.basis = old.basis; }
        delete body.inputRate; delete body.outputRate; delete body.cachedRate;
      }
      if (collection === 'systems') { body.monthlyBudgetUsd = body.monthlyBudgetUsd === '' ? null : Number(body.monthlyBudgetUsd); body.requestsPerMinute = Number(body.requestsPerMinute); }
      if (collection === 'keys') { body.allowedModels = data.getAll('allowedModels'); body.expiresInDays = Number(body.expiresInDays); body.requireGroup = data.getAll('groupPolicy').includes('required'); delete body.groupPolicy; body.registrationProviderIds = data.getAll('registrationProviderIds'); body.organizationIds = String(body.organizationIds || '').split(/\s+/).filter(Boolean); }
      if (collection === 'groups') body = { ...editor.groupForm.value(), ...(editor.record ? { expectedUpdatedAt: editor.record.updatedAt } : {}) };
      if (collection === 'jobs') body.reportedCostUsd = body.reportedCostUsd === '' ? null : Number(body.reportedCostUsd);
      if (collection === 'integrations' && !body.apiKey) delete body.apiKey;
      const result = await api('/v1/control/' + collection, body, editor.record ? 'PATCH' : 'POST');
      closeEditor();
      if (result.oneTimeKey) { byId('ops-created-key').value = result.oneTimeKey; byId('ops-created-key').type = 'password'; byId('ops-key-feedback').textContent = ''; byId('ops-show-key').textContent = 'Show key'; byId('ops-key-result').showModal(); }
      notice(collection === 'keys' ? 'System key issued with explicit model grants.' : 'Configuration saved. New requests use the updated registry.'); await refresh();
    } catch (error) { byId('ops-editor-error').textContent = collection === 'groups' && error.code === 'control_conflict' ? 'This group changed in another session. Close and reopen it before saving.' : collection === 'groups' && error.code === 'group_conflict' ? 'Someone is already in another group. Close and reopen this group to refresh the people list.' : error.message; }
    finally { byId('ops-editor-save').disabled = false; }
  });
  function clearKey() { byId('ops-created-key').value = ''; byId('ops-key-feedback').textContent = ''; }
  byId('ops-key-result').addEventListener('close', clearKey); byId('ops-key-result').addEventListener('cancel', clearKey);
  byId('ops-close-key').addEventListener('click', () => { clearKey(); byId('ops-key-result').close(); });
  byId('ops-show-key').addEventListener('click', () => { const field = byId('ops-created-key'); field.type = field.type === 'password' ? 'text' : 'password'; byId('ops-show-key').textContent = field.type === 'text' ? 'Hide key' : 'Show key'; });
  byId('ops-copy-key').addEventListener('click', async () => { try { await navigator.clipboard.writeText(byId('ops-created-key').value); byId('ops-key-feedback').textContent = 'Key copied. Save it securely on your calling backend.'; } catch { byId('ops-key-feedback').textContent = 'Clipboard unavailable. Use Show key to copy it manually.'; } });
  function inspectProcess(process) {
    const container = byId('ops-process-detail-body'); container.replaceChildren();
    const summary = node('div', 'process-detail-summary');
    for (const [label, value] of [['Request', process.requestId], ['State', process.status], ['System', systemName(process.systemId)], ['Group', process.groupId || 'Unassigned'], ['Organization', process.organizationId || 'Personal'], ['Activity', process.activity || process.operation], ['Account', process.actor.email || process.actor.id], ['Started', stamp(process.startedAt)], ['Duration', time(process.durationMs)]]) { const block = node('div'); block.append(node('small', '', label), node('strong', '', value)); summary.append(block); } container.append(summary);
    if (process.errorCode) container.append(node('p', '', 'Outcome: ' + process.errorCode));
    for (const call of process.calls) {
      const article = node('article', 'process-call'); article.append(node('h3', '', `${call.index}. ${call.route} · ${call.providerModel}`), statusBadge(call.status));
      const details = node('dl'); for (const [label, value] of [['Input tokens', count(call.usage.inputTokens)], ['Output tokens', count(call.usage.outputTokens)], ['Cached input', count(call.usage.cachedInputTokens)], ['Reasoning subset', count(call.usage.reasoningTokens)], ['Estimated USD', usd(call.cost.usd)], ['Provider duration', time(call.durationMs)]]) details.append(node('dt', '', label), node('dd', '', value)); article.append(details);
      article.append(node('p', '', call.rates ? `USD / million tokens: input ${call.rates.inputPerMillion}, cached ${call.rates.cachedInputPerMillion ?? 'unavailable'}, output ${call.rates.outputPerMillion}.${call.rates.basis === 'peak_reference' ? ' Peak reference rates; discounts not applied.' : ''}` : call.cost.basis || 'No rate snapshot. Cost is unavailable.'));
      if (call.usage.cacheWriteTokens > 0) article.append(node('p', '', 'Provider cache-write tokens require separate pricing. This call’s cost remains unavailable.'));
      if (call.rejection) article.append(node('p', '', `Provider rejection: HTTP ${call.httpStatus || 'unknown'} · ${call.rejection.category.replaceAll('_', ' ')}${call.rejection.parameters?.length ? ' · fields: ' + call.rejection.parameters.join(', ') : ''}. Source text is not stored in this diagnostic.`));
      if (call.validation) article.append(node('p', '', `Review validation: ${call.validation.accepted} accepted, ${call.validation.excluded} excluded.` +
        Object.entries(call.validation.reasons || {}).map(([reason, total]) => ` ${reason.replaceAll('_', ' ')}: ${total}.`).join('')));
      container.append(article);
    }
    if (!process.calls.length) container.append(empty(process.status === 'running' ? 'Preparing the provider call.' : 'No provider call was recorded.'));
    if (consoleRole === 'admin' && process.status === 'running') container.append(button('Request cancellation', () => { byId('ops-process-detail').close(); cancelProcess(process); }, 'secondary'));
    byId('ops-process-detail').showModal();
  }
  byId('ops-close-process').addEventListener('click', () => byId('ops-process-detail').close());
  document.querySelectorAll('[data-create]').forEach(control => control.addEventListener('click', () => openEditor(control.dataset.create)));
  document.querySelectorAll('[data-provider-preset]').forEach(control => control.addEventListener('click', () => openEditor('providers', null, control.dataset.providerPreset)));
  byId('ops-refresh').addEventListener('click', refresh); byId('process-refresh').addEventListener('click', refresh);
  byId('groups-search').addEventListener('input', searchGroups); byId('models-search').addEventListener('input', renderModels); byId('process-search').addEventListener('input', renderProcesses); byId('process-state').addEventListener('change', renderProcesses);
  document.addEventListener('colossus:ready', event => {
    accessVersion++; consoleRole = event.detail.user.role; verified = ['admin', 'professional'].includes(consoleRole);
    document.body.dataset.consoleRole = consoleRole;
    let christopherLink = document.getElementById('christopher-private-link');
    if (consoleRole === 'admin' && !christopherLink) { christopherLink = node('a', '', '◈ Christopher experiment'); christopherLink.id = 'christopher-private-link'; christopherLink.href = '/admin/christopher'; document.querySelector('.ops-navigation').append(christopherLink); }
    if (christopherLink) christopherLink.hidden = consoleRole !== 'admin';
    const hash = location.hash.slice(1);
    showView(aliases[hash] || hash || (verified ? 'overview' : 'engines'));
    if (verified) void refresh();
    else { byId('ops-storage').textContent = 'Participant engine access'; byId('ops-environment').lastChild.textContent = 'ENGINE ROOM'; }
  });
  document.addEventListener('colossus:usage', event => { if (verified && event.detail.days === 1 && !event.detail.userId) { usage = event.detail; renderOverview(); renderModels(); renderProcesses(); } });
  document.addEventListener('colossus:locked', () => { accessVersion++; consoleRole = undefined; verified = false; groupSearchVersion++; clearTimeout(groupSearchTimer); editor?.groupForm?.dispose(); catalog = undefined; usage = undefined; productAccess = undefined; byId('ops-product-access')?.remove(); groupUsers = undefined; groupOrganizations = undefined; peopleDirectory.clear(); discovered.clear(); clearKey(); byId('ops-editor-fields').replaceChildren(); byId('ops-process-detail-body').replaceChildren(); editor = null; confirmation = null; for (const id of ['overview-models', 'overview-calls', 'overview-tokens', 'overview-cost']) byId(id).textContent = '—'; for (const dialog of document.querySelectorAll('.ops-dialog[open]')) dialog.close(); for (const id of ['ops-model-rows', 'ops-group-rows', 'ops-key-rows', 'ops-process-rows', 'ops-provider-cards', 'ops-system-cards', 'ops-integration-cards', 'ops-external-jobs', 'overview-audit', 'overview-processes', 'overview-providers', 'ecosystem-nodes']) byId(id).replaceChildren(); byId('ops-account').textContent = 'Access verification required'; byId('ops-storage').textContent = 'Actions paused'; });
  const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 30000);
  window.addEventListener('pagehide', () => { clearInterval(timer); clearTimeout(groupSearchTimer); groupSearchVersion++; editor?.groupForm?.dispose(); clearKey(); });
})();
