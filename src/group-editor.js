(() => {
  'use strict';
  const activities = [
    ['workflow.analysis', 'Workflow', 'Document analysis'],
    ['workflow.reassessment', 'Workflow', 'Reassessment'],
    ['enigma.analysis', 'Enigma', 'Text analysis'],
    ['enigma.temporal', 'Enigma', 'Timeline comparisons'],
    ['evidence.review', 'Evidence', 'AI review assistance'],
  ];
  const textModel = model => model.task === 'chat' && !model.native && model.capabilities?.includes('text');
  const activeKey = key => key.enabled && Date.parse(key.expiresAt) > Date.now();
  const modelLabel = (id, catalog) => {
    const model = catalog.models.find(value => value.id === id);
    if (!model) return 'Unavailable model';
    const provider = catalog.providers.find(value => value.id === model.providerId)?.name;
    return [model.name === 'Astra Default' ? provider || model.name : model.name, model.model].filter(Boolean).join(' · ');
  };
  function defaultModel(group, catalog) {
    return group.modelIds.find(id => { const model = catalog.models.find(value => value.id === id); return model && textModel(model); }) || '';
  }
  function effectiveModel(group, activity, catalog) {
    const specific = group.activityModels?.[activity] || group.activityModels?.[activity.split('.').slice(0, -1).join('.')];
    if (specific) return specific;
    return defaultModel(group, catalog);
  }
  function modelIssue(id, systemId, catalog) {
    const model = catalog.models.find(value => value.id === id);
    if (!model) return 'Choose a registered model.';
    const provider = catalog.providers.find(value => value.id === model.providerId);
    if (!model.enabled || !provider?.enabled) return 'This model or its provider is paused. Enable it in Models or Providers before use.';
    if (!provider.credentialConfigured && !provider.allowAnonymous) return 'The provider needs a connection credential before use.';
    const minimum = { workflow: 8000, enigma: 2000, evidence: 1800 }[systemId];
    if (textModel(model) && minimum && model.maxTokens < minimum) return 'Increase this model’s output limit in Models to at least ' + minimum.toLocaleString() + ' tokens for this product.';
    if (catalog.systems.find(value => value.id === systemId)?.enabled === false) return 'This product is paused in Astra systems.';
    if (systemId && !catalog.keys.some(key => key.systemId === systemId && activeKey(key) && key.allowedModels.includes(id)))
      return 'No active ' + (catalog.systems.find(value => value.id === systemId)?.name || systemId) + ' key allows this model. Update product access in API access before use.';
    return '';
  }
  function draftValue(draft) {
    const name = draft.name.trim();
    if (!name || name.length > 160) throw Error('Enter a group name (up to 160 characters).');
    if (draft.memberIds.length > 100) throw Error('A group can contain up to 100 people.');
    if (!draft.modelIds.length) throw Error('Choose a text model or enable broadcast media.');
    if (draft.modelIds.length > 100) throw Error('A group can contain up to 100 models.');
    if (Object.values(draft.activityModels).some(id => !draft.modelIds.includes(id))) throw Error('A product rule uses a model that is no longer allowed. Update that rule first.');
    return { id: draft.id, name, memberIds: [...draft.memberIds], modelIds: [...draft.modelIds],
      organizationId: draft.organizationId || null, activityModels: { ...draft.activityModels } };
  }
  const element = (tag, className, text) => {
    const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node;
  };
  function createEditor({ root, catalog, record, users, organizations, api, onUsers }) {
    let disposed = false, requestVersion = 0, debounce, offset = 0, query = '', selection = record ? defaultModel(record, catalog) : '';
    const fallback = catalog.models.find(model => textModel(model) && !modelIssue(model.id, '', catalog))?.id || '';
    if (!record) selection = fallback;
    const draft = { id: record?.id || 'group-' + crypto.randomUUID(), name: record?.name || '', memberIds: [...(record?.memberIds || [])],
      modelIds: [...(record?.modelIds || (selection ? [selection] : []))], organizationId: record?.organizationId || '', activityModels: { ...(record?.activityModels || {}) } };
    const directory = new Map((users?.users || []).map(user => [user.id, user]));
    let results = users?.users || [], more = results.length === 50, loading = false;
    const controls = [], extraControls = [], sections = [], tabs = element('div', 'group-tabs');
    tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Group settings'); root.append(tabs);
    function showSection(index, focus = false) {
      sections.forEach((section, current) => { const active = current === index; section.block.hidden = !active; section.tab.setAttribute('aria-selected', String(active)); section.tab.tabIndex = active ? 0 : -1; });
      if (focus) sections[index].tab.focus();
    }
    const section = (number, title, description) => {
      const block = element('section', 'group-section'), heading = element('div', 'group-section-heading');
      const index = sections.length, tab = element('button', 'secondary group-tab', title === 'Group details' ? 'Details' : title === 'Models by product' ? 'Models' : title);
      tab.type = 'button'; tab.id = 'group-tab-' + number; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', 'group-panel-' + number); tabs.append(tab);
      block.id = 'group-panel-' + number; block.setAttribute('role', 'tabpanel'); block.setAttribute('aria-labelledby', tab.id);
      tab.addEventListener('click', () => showSection(index));
      tab.addEventListener('keydown', event => { const next = event.key === 'ArrowRight' ? (index + 1) % sections.length : event.key === 'ArrowLeft' ? (index + sections.length - 1) % sections.length : event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1 : null; if (next !== null) { event.preventDefault(); showSection(next, true); } });
      sections.push({ block, tab }); heading.append(element('h3', '', title)); block.append(heading);
      if (description) block.append(element('p', 'group-help', description)); root.append(block); return block;
    };
    function input(parent, label, tag = 'input') {
      const wrap = element('label', 'group-field', label), control = element(tag); wrap.append(control); parent.append(wrap); return control;
    }
    function action(text, label, run) {
      const control = element('button', 'secondary group-small-button', text); control.type = 'button'; control.setAttribute('aria-label', label); control.addEventListener('click', run); return control;
    }
    const details = section('1', 'Group details', 'Give this group a name your team will recognize.');
    const detailFields = element('div', 'group-detail-fields'); details.append(detailFields);
    const name = input(detailFields, 'Group name'); name.value = draft.name; name.maxLength = 160; name.placeholder = 'For example, Research team'; name.autocomplete = 'off';
    name.addEventListener('input', () => { draft.name = name.value; });
    const organization = input(detailFields, 'Organization', 'select'); organization.add(new Option('Any organization or personal account', ''));
    for (const org of organizations?.organizations || []) { const option = new Option(org.name + (org.status === 'active' ? '' : ' · paused'), org.id); option.disabled = org.status !== 'active' && org.id !== draft.organizationId; organization.add(option); }
    if (draft.organizationId && ![...organization.options].some(option => option.value === draft.organizationId)) organization.add(new Option('Current organization · ' + draft.organizationId, draft.organizationId));
    organization.value = draft.organizationId; organization.addEventListener('change', () => { draft.organizationId = organization.value; updateSummary(); });
    details.append(element('p', 'group-help', organizations ? 'An organization restriction also requires active Workspace membership.' : 'Organization choices could not be loaded. The current restriction is preserved; reopen to retry.'));

    const people = section('2', 'People', 'Select people by email. Their product approvals stay separate from model assignments.');
    const selected = element('div', 'group-selected'); selected.setAttribute('aria-label', 'Selected people'); people.append(selected);
    const search = input(people, 'Find people by email'); search.type = 'search'; search.maxLength = 254; search.placeholder = 'Search your Astra accounts'; search.autocomplete = 'off';
    const peopleStatus = element('p', 'group-help'); peopleStatus.setAttribute('role', 'status'); peopleStatus.setAttribute('aria-live', 'polite'); people.append(peopleStatus);
    const list = element('div', 'group-people'); list.setAttribute('aria-label', 'Available people'); people.append(list);
    const moreButton = action('Load more people', 'Load more people', () => { void loadUsers(true); }); people.append(moreButton);
    function personName(id) { return directory.get(id)?.email || 'Existing account · ' + id.slice(0, 8); }
    function renderPeople() {
      selected.replaceChildren();
      if (!draft.memberIds.length) selected.append(element('span', 'group-help', 'No people selected yet.'));
      for (const id of draft.memberIds) {
        const chip = element('span', 'group-person-chip'); chip.append(element('span', '', personName(id)), action('×', 'Remove ' + personName(id), () => { draft.memberIds = draft.memberIds.filter(value => value !== id); renderPeople(); updateSummary(); })); selected.append(chip);
      }
      list.replaceChildren();
      for (const user of results) {
        const otherGroup = (catalog.groups || []).find(group => group.id !== draft.id && group.memberIds.includes(user.id));
        const active = String(user.status).toLowerCase() === 'active', checked = draft.memberIds.includes(user.id);
        const row = element('label', 'group-person-option'), check = element('input'), label = element('span');
        check.type = 'checkbox'; check.checked = checked; check.disabled = !checked && (!active || !!otherGroup); check.setAttribute('aria-label', 'Select ' + user.email);
        label.append(element('strong', '', user.email), element('small', '', otherGroup ? 'Already in ' + otherGroup.name + ' · remove there before adding here' : active ? user.role : user.status)); row.append(check, label);
        check.addEventListener('change', () => { if (check.checked && draft.memberIds.length >= 100) { check.checked = false; peopleStatus.textContent = 'A group can contain up to 100 people.'; return; }
          draft.memberIds = check.checked ? [...new Set([...draft.memberIds, user.id])] : draft.memberIds.filter(id => id !== user.id); renderPeople(); updateSummary(); }); list.append(row);
      }
      if (!results.length && !loading) list.append(element('p', 'group-help', 'No matching people. Try another email.'));
      peopleStatus.textContent = loading ? 'Finding people…' : `${draft.memberIds.length} selected · ${results.length} accounts shown`;
      moreButton.hidden = !more; moreButton.disabled = loading;
    }
    async function loadUsers(append = false) {
      const version = ++requestVersion, nextOffset = append ? offset + 50 : 0, currentQuery = query; loading = true; renderPeople();
      try {
        const result = await api(`/v1/access/users?search=${encodeURIComponent(currentQuery)}&offset=${nextOffset}`);
        if (disposed || version !== requestVersion) return;
        for (const user of result.users) directory.set(user.id, user);
        results = append ? [...new Map([...results, ...result.users].map(user => [user.id, user])).values()] : result.users;
        offset = nextOffset; more = result.users.length === 50; loading = false; onUsers?.(result.users); renderPeople();
      } catch (error) { if (disposed || version !== requestVersion) return; loading = false; renderPeople(); peopleStatus.textContent = 'People could not be loaded. Existing selections are kept. ' + error.message; }
    }
    search.addEventListener('input', () => { query = search.value.trim(); requestVersion++; clearTimeout(debounce); debounce = setTimeout(() => { void loadUsers(); }, 250); });

    const models = section('3', 'Models by product', 'Choose a default, then override it only where a product needs another model.');
    const modelSearch = input(models, 'Search text models'); modelSearch.type = 'search'; modelSearch.placeholder = 'Search by model or provider';
    const modelStatus = element('p', 'group-help'); modelStatus.setAttribute('role', 'status'); models.append(modelStatus);
    function fillModelSelect(select, value, includeDefault) {
      select.replaceChildren(new Option(includeDefault ? 'Use group default' : 'No default text model', ''));
      const query = modelSearch.value.toLowerCase();
      for (const model of catalog.models.filter(textModel)) {
        const label = modelLabel(model.id, catalog);
        if (model.id !== value && query && !`${label} ${model.id}`.toLowerCase().includes(query)) continue;
        const option = new Option(label + (model.enabled ? '' : ' · paused'), model.id);
        option.disabled = model.id !== value && (!model.enabled || !catalog.providers.find(provider => provider.id === model.providerId)?.enabled); select.add(option);
      }
      if (value && ![...select.options].some(option => option.value === value)) select.add(new Option('Unavailable model · ' + value, value));
      select.value = value;
    }
    const defaultSelect = input(models, 'Default text model', 'select'), defaultHelp = element('p', 'group-help'); defaultSelect.value = selection; models.append(defaultHelp);
    function allowModel(id) { if (id && !draft.modelIds.includes(id)) draft.modelIds.push(id); }
    defaultSelect.addEventListener('change', () => {
      if (!defaultSelect.value && Object.keys(draft.activityModels).length) { defaultSelect.value = selection; modelStatus.textContent = 'Remove the product overrides before clearing all text models.'; return; }
      selection = defaultSelect.value;
      if (selection) draft.modelIds = [selection, ...draft.modelIds.filter(id => id !== selection)];
      else draft.modelIds = draft.modelIds.filter(id => !catalog.models.some(model => model.id === id && textModel(model)));
      renderModels(); updateSummary();
    });
    const productRows = element('div', 'group-product-rows'); models.append(productRows);
    function ruleRow(activity, product, description, parent, extra = false) {
      const row = element('div', 'group-product-row'), heading = element('div'), label = element('label'), select = element('select'), help = element('small', 'group-rule-help');
      heading.append(element('strong', '', product), element('span', '', description)); row.append(heading);
      const selectId = 'group-rule-' + activity.replaceAll('.', '-'); label.htmlFor = selectId; label.className = 'sr-only'; label.textContent = product + ' ' + description + ' model'; select.id = selectId; select.setAttribute('aria-label', label.textContent); row.append(label, select, help); parent.append(row);
      select.addEventListener('change', () => { if (select.value) { draft.activityModels[activity] = select.value; allowModel(select.value); } else delete draft.activityModels[activity]; renderModels(); updateSummary(); });
      const control = { activity, select, help }; (extra ? extraControls : controls).push(control);
    }
    for (const [activity, product, description] of activities) ruleRow(activity, product, description, productRows);
    const mediaBlock = element('div', 'group-media'), mediaLabel = element('label', 'group-media-label'), media = element('input'); media.type = 'checkbox'; media.checked = draft.modelIds.includes('broadcast-media');
    mediaLabel.append(media, element('strong', '', 'Enable Enigma broadcast media')); mediaBlock.append(mediaLabel);
    const mediaModel = catalog.models.find(model => model.id === 'broadcast-media'), mediaHelp = element('p', 'group-help'); mediaBlock.append(mediaHelp); models.append(mediaBlock);
    media.disabled = !mediaModel && !media.checked;
    media.addEventListener('change', () => { if (media.checked) allowModel('broadcast-media'); else draft.modelIds = draft.modelIds.filter(id => id !== 'broadcast-media'); renderModels(); updateSummary(); });
    const mathBlock = element('div', 'group-media'), mathLabel = element('label', 'group-media-label'), math = element('input'); math.type = 'checkbox'; math.checked = draft.modelIds.includes('christopher');
    mathLabel.append(math, element('strong', '', 'Enable Christopher mathematical checks')); mathBlock.append(mathLabel);
    mathBlock.append(element('p', 'group-help', 'Evaluate structured claims and measurements inside Colossus. This uses a separate mathematical API and does not replace the group text model.'));
    models.append(mathBlock); math.disabled = !catalog.models.some(model => model.id === 'christopher') && !math.checked;
    math.addEventListener('change', () => { if (math.checked) allowModel('christopher'); else draft.modelIds = draft.modelIds.filter(id => id !== 'christopher'); renderModels(); updateSummary(); });
    const additional = element('details', 'group-additional'); additional.append(element('summary', '', 'Additional models and detailed rules'));
    additional.append(element('p', 'group-help', 'Keep other models available for requests the default cannot support. This does not retry failed provider calls.'));
    const additionalList = element('div', 'group-additional-list'); additional.append(additionalList);
    const knownActivities = new Set(activities.map(value => value[0]));
    for (const activity of Object.keys(draft.activityModels).filter(value => !knownActivities.has(value))) ruleRow(activity, 'Detailed rule', activity, additional, true);
    models.append(additional);
    function renderModels() {
      fillModelSelect(defaultSelect, selection, false);
      modelStatus.textContent = catalog.models.filter(model => textModel(model) && `${modelLabel(model.id, catalog)} ${model.id}`.toLowerCase().includes(modelSearch.value.toLowerCase())).length + ' text models match';
      defaultHelp.textContent = selection ? modelIssue(selection, '', catalog) || 'Used when a product is set to the group default.' : 'Choose a text model to enable document and text reviews.';
      for (const control of [...controls, ...extraControls]) {
        const value = draft.activityModels[control.activity] || ''; fillModelSelect(control.select, value, true);
        const effective = value || effectiveModel({ ...draft, modelIds: selection ? [selection, ...draft.modelIds.filter(id => id !== selection)] : draft.modelIds }, control.activity, catalog);
        control.help.textContent = effective ? modelIssue(effective, control.activity.split('.')[0], catalog) || modelLabel(effective, catalog) : 'No text model selected for this product.';
        control.help.classList.toggle('group-warning', !effective || !!modelIssue(effective, control.activity.split('.')[0], catalog));
      }
      mediaHelp.textContent = mediaModel ? modelLabel(mediaModel.id, catalog) + ' · Audio and images only. ' + (media.checked ? modelIssue(mediaModel.id, 'enigma', catalog) : '') : 'A Google broadcast connection must be configured before this can be enabled.';
      additionalList.replaceChildren();
      for (const model of catalog.models.filter(model => !model.native && model.id !== selection)) {
        const label = element('label', 'group-person-option'), check = element('input'); check.type = 'checkbox'; check.checked = draft.modelIds.includes(model.id); check.disabled = !check.checked && !model.enabled;
        const labelText = modelLabel(model.id, catalog) + (model.task === 'embedding' ? ' · Embeddings' : '');
        check.setAttribute('aria-label', 'Allow additional model ' + labelText); label.append(check, element('span', '', labelText)); additionalList.append(label);
        check.addEventListener('change', () => { if (check.checked) allowModel(model.id); else {
          if (Object.values(draft.activityModels).includes(model.id)) { check.checked = true; modelStatus.textContent = 'Change the product rules using this model before removing it.'; return; }
          draft.modelIds = draft.modelIds.filter(id => id !== model.id);
        } renderModels(); updateSummary(); });
      }
      const extras = draft.modelIds.filter(id => id !== selection && !['broadcast-media', 'christopher'].includes(id));
      if (extras.length) {
        const order = element('ol', 'group-model-order'); additionalList.append(element('p', 'group-help', 'Additional selection order'), order);
        extras.forEach((id, index) => {
          const row = element('li'); row.append(element('span', '', modelLabel(id, catalog)));
          for (const [label, direction] of [['↑', -1], ['↓', 1]]) {
            const move = action(label, (direction < 0 ? 'Move up ' : 'Move down ') + modelLabel(id, catalog), () => {
              const a = draft.modelIds.indexOf(id), b = draft.modelIds.indexOf(extras[index + direction]); [draft.modelIds[a], draft.modelIds[b]] = [draft.modelIds[b], draft.modelIds[a]]; renderModels(); updateSummary();
            }); move.disabled = index + direction < 0 || index + direction >= extras.length; row.append(move);
          } order.append(row);
        });
      }
    }
    modelSearch.addEventListener('input', renderModels);
    const summary = element('div', 'group-save-summary'); summary.setAttribute('role', 'status'); summary.setAttribute('aria-live', 'polite'); root.append(summary);
    function updateSummary() { const rules = Object.keys(draft.activityModels).length; summary.textContent = `${draft.memberIds.length} ${draft.memberIds.length === 1 ? 'person' : 'people'} · ${selection ? modelLabel(selection, catalog) : 'No default text model'} · ${rules} ${rules === 1 ? 'product rule' : 'product rules'}` + (media.checked ? ' · Broadcast media enabled' : '') + '. Changes apply to new requests after saving.'; }
    renderPeople(); renderModels(); updateSummary(); showSection(record ? 2 : 0);
    if (!users) void loadUsers();
    return { value: () => { draft.name = name.value; if (!draft.name.trim()) { showSection(0); name.focus(); } return draftValue(draft); }, dispose: () => { disposed = true; requestVersion++; clearTimeout(debounce); } };
  }
  window.ColossusGroups = Object.freeze({ activities, textModel, modelLabel, defaultModel, effectiveModel, modelIssue, draftValue, createEditor });
})();
