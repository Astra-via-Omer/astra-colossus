import { CloudRegistry } from './cloudRegistry.mjs';
import { fail } from './config.mjs';

export class ControlStore {
  constructor(config, fetcher) {
    this.config = config; this.fetch = fetcher; this.memory = new Map(); this.sequence = 0;
    this.shared = !!config.controlDatabase;
    this.cloud = this.shared ? new CloudRegistry('', fetcher) : null;
    this.root = `projects/${config.controlProject}/databases/${config.controlDatabase}/documents`;
  }
  async request(path, options = {}) {
    let response;
    try { response = await this.fetch(`https://firestore.googleapis.com/v1/${path}`, { ...options,
      headers: { Authorization: `Bearer ${await this.cloud.auth()}`, 'Content-Type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(8000) }); }
    catch { fail(503, 'control_unavailable', 'The operations database is unavailable.'); }
    if (response.status === 404) return null;
    if ([409, 412].includes(response.status)) return { conflict: true };
    if (!response.ok) fail(503, 'control_unavailable', 'The operations database is unavailable.');
    return response.json();
  }
  async get(path) {
    if (!this.shared) return structuredClone(this.memory.get(path) || { data: null, version: null });
    const value = await this.request(`${this.root}/${path}`);
    if (!value) return { data: null, version: null };
    try { return { data: JSON.parse(value.fields.json.stringValue), version: value.updateTime }; }
    catch { fail(503, 'control_invalid', 'An operations record could not be read.'); }
  }
  // Membership is owned by Workspace. Read its live records; never accept an org from a caller.
  async organizationFor(userId) {
    if (!/^[a-zA-Z0-9_-]{1,120}$/.test(userId)) fail(403, 'organization_denied', 'A verified account is required.');
    const read = async path => {
      if (!this.shared) return (await this.get(path)).data;
      const root = `projects/${this.config.controlProject}/databases/${this.config.workspaceDatabase}/documents`;
      const document = await this.request(`${root}/${path}`);
      if (!document) return null;
      return Object.fromEntries(Object.entries(document.fields || {}).map(([name, field]) => [name, field.stringValue]));
    };
    const member = await read('workspaceMembers/' + userId);
    if (!member) return null;
    if (member.status !== 'active' || !/^[a-zA-Z0-9_-]{1,120}$/.test(member.orgId || '')) fail(403, 'organization_denied', 'Your organization membership is inactive.');
    const organization = await read('workspaceOrganizations/' + member.orgId);
    if (organization?.status !== 'active') fail(403, 'organization_denied', 'Your organization is inactive.');
    return member.orgId;
  }
  async list(collection, limit = 500, allowMore = false) {
    if (!this.shared) return [...this.memory.entries()].filter(([path]) => path.startsWith(collection + '/') && path.split('/').length === 2)
      .sort(([a], [b]) => a.localeCompare(b)).slice(0, limit).map(([, value]) => structuredClone(value.data));
    const value = await this.request(`${this.root}/${collection}?pageSize=${limit}&orderBy=__name__`);
    if (value?.nextPageToken && !allowMore) fail(503, 'control_limit', 'This registry exceeds its page limit. Archive unused records before adding more.');
    return (value?.documents || []).map(doc => JSON.parse(doc.fields.json.stringValue));
  }
  async commit(changes) {
    if (!this.shared) {
      if (changes.some(change => (this.memory.get(change.path)?.version || null) !== change.version)) return false;
      for (const change of changes) this.memory.set(change.path, { data: structuredClone(change.data), version: String(++this.sequence) });
      return true;
    }
    const response = await this.request(`${this.root}:commit`, { method: 'POST', body: JSON.stringify({ writes: changes.map(change => ({
      update: { name: `${this.root}/${change.path}`, fields: { json: { stringValue: JSON.stringify(change.data) } } },
      currentDocument: change.version ? { updateTime: change.version } : { exists: false },
    })) }) });
    return !!response && !response.conflict;
  }
  async mutate(paths, action) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const records = await Promise.all(paths.map(path => this.get(path)));
      const values = action(records.map(record => structuredClone(record.data)));
      if (await this.commit(paths.map((path, index) => ({ path, data: values[index], version: records[index].version })))) return values;
    }
    fail(409, 'control_conflict', 'Another operation changed this record. Refresh and retry.');
  }
}
