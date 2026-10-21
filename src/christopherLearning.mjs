import { randomUUID } from 'node:crypto';
import { fail } from './config.mjs';
import { fingerprint, digest } from './christopherFingerprint.mjs';

const MAX_EXAMPLES = 100, MAX_BYTES = 64000;
const median = values => { const a = [...values].sort((x, y) => x - y), n = a.length; return n % 2 ? a[n >> 1] : (a[n / 2 - 1] + a[n / 2]) / 2; };
const pick = (value, keys) => Object.fromEntries(keys.filter(k => value[k] !== undefined).map(k => [k, value[k]]));
export class ChristopherLearning {
  constructor(store, { captureEnabled = false, retentionReady = false } = {}) { this.store = store; this.captureEnabled = captureEnabled; this.retentionReady = retentionReady; this.pending = 0; this.stats = { accepted: 0, skipped: 0, failed: 0 }; }
  namespace(identity, organizationId = null) { return digest({ administrator: identity.id, organizationId }).slice(0, 32); }
  async examples(namespace) {
    const records = await this.store.list('christopherExamples', 500);
    const own = records.filter(r => r.namespace === namespace && !r.deleted);
    const active = own.filter(r => Date.parse(r.expiresAt) > Date.now()), grants = new Map();
    for (const r of active.filter(r => r.dataClass === 'permitted')) if (!grants.has(r.grantOrganizationId)) grants.set(r.grantOrganizationId, (await this.store.get('christopherGrants/' + r.grantOrganizationId)).data);
    return active.filter(r => r.dataClass !== 'permitted' || (grants.get(r.grantOrganizationId)?.allowStructuredTraining === true && Date.parse(grants.get(r.grantOrganizationId)?.expiresAt) > Date.now()));
  }
  async save(namespace, example, { permitted = false, expiresAt, teacherModel, grantOrganizationId } = {}) {
    if (!example || !['train', 'holdout'].includes(example.split) || !['synthetic', 'permitted'].includes(example.dataClass) || !example.caseId || typeof example.caseId !== 'string' || example.caseId.length > 120 || !Number.isFinite(Date.parse(example.eventTime))) fail(400, 'invalid_example', 'An example needs caseId, eventTime, train/holdout split, dataClass and structured input.');
    if (example.dataClass !== 'synthetic' && !permitted) fail(403, 'data_permission_required', 'Real examples require a configured tenant training grant and retention setup.');
    if (Buffer.byteLength(JSON.stringify(example)) > MAX_BYTES) fail(413, 'example_limit', 'An example must fit within 64 KB.');
    if ((await this.examples(namespace)).length >= MAX_EXAMPLES) fail(409, 'dataset_limit', 'This experiment is limited to 100 examples per administrator and tenant.');
    const result = await fingerprint(example.input);
    const id = randomUUID(), record = { ...pick(example, ['caseId', 'eventTime', 'split', 'dataClass', 'label']), id, namespace,
      input: pick(example.input, ['modelVersion', 'stateSpace', 'scope', 'variables', 'observations', 'claims', 'worlds']), createdAt: new Date().toISOString(), expiresAt: expiresAt || new Date(Date.now() + 86400000).toISOString(),
      grantOrganizationId: grantOrganizationId || null, teacher: teacherModel ? { model: teacherModel, role: 'candidate_provenance_only', outputCaptured: false } : null,
      sourceGroups: [...new Set(result.fingerprint.observations.map(o => o.sourceGroup))], fingerprint: result.fingerprint };
    if (!await this.store.commit([{ path: 'christopherExamples/' + id, data: record, version: null }])) fail(409, 'dataset_conflict', 'Retry storing this example.');
    return { id, expiresAt: record.expiresAt, features: result.fingerprint.features.length, dataClass: record.dataClass };
  }
  async remove(namespace, id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) fail(404, 'example_not_found', 'Example not found.');
    const path = 'christopherExamples/' + id, record = await this.store.get(path);
    if (!record.data || record.data.namespace !== namespace) fail(404, 'example_not_found', 'Example not found.');
    // Erase the payload and provenance immediately; keep only a deletion marker.
    if (!await this.store.commit([{ path, version: record.version, data: { id, namespace, deleted: true, deletedAt: new Date().toISOString() } }])) fail(409, 'dataset_conflict', 'Retry deleting this example.');
    for (const c of (await this.store.list('christopherCandidates', 500)).filter(c => c.namespace === namespace && c.sourceExampleIds?.includes(id))) {
      const path = 'christopherCandidates/' + c.id;
      await this.store.mutate([path], () => [{ id: c.id, namespace, deleted: true, deletedAt: new Date().toISOString() }]);
    }
    return { deleted: true };
  }
  async train(namespace) {
    if ((await this.store.list('christopherCandidates', 500)).filter(c => c.namespace === namespace && !c.deleted && Date.parse(c.expiresAt) > Date.now()).length >= 20) fail(409, 'candidate_limit', 'This private experiment is limited to 20 candidate versions.');
    const examples = await this.examples(namespace), train = examples.filter(e => e.split === 'train'), holdout = examples.filter(e => e.split === 'holdout');
    if (train.length < 4 || holdout.length < 2) fail(400, 'dataset_small', 'Provide at least four training cases and two held-out cases.');
    const trainCases = new Set(train.map(e => e.caseId)), trainSources = new Set(train.flatMap(e => e.sourceGroups));
    if (holdout.some(e => trainCases.has(e.caseId) || e.sourceGroups.some(g => trainSources.has(g)))) fail(400, 'split_leakage', 'Case IDs and source families must be disjoint between training and holdout.');
    if (Math.max(...train.map(e => Date.parse(e.eventTime))) >= Math.min(...holdout.map(e => Date.parse(e.eventTime)))) fail(400, 'time_leakage', 'All training events must precede the held-out events.');
    // Connected components account for transitive common-origin dependence.
    // One case/source component contributes one median, regardless of copies.
    const parent = train.map((_, i) => i), find = i => parent[i] === i ? i : (parent[i] = find(parent[i]));
    for (let i = 0; i < train.length; i++) for (let j = 0; j < i; j++) if (train[i].caseId === train[j].caseId || train[i].sourceGroups.some(g => train[j].sourceGroups.includes(g))) parent[find(i)] = find(j);
    const grouped = new Map();
    for (let i = 0; i < train.length; i++) for (const f of train[i].fingerprint.features) {
      if (!f.observed || f.observed.min !== f.observed.max) continue;
      if (!grouped.has(f.featureKey)) grouped.set(f.featureKey, new Map());
      const groups = grouped.get(f.featureKey), group = find(i);
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(Number(f.observed.min));
    }
    const values = new Map([...grouped].map(([key, groups]) => [key, [...groups.values()].map(median)]));
    const features = [...values].filter(([, a]) => a.length >= 3).map(([featureKey, a]) => { const center = median(a); return { featureKey, samples: a.length, median: center, mad: median(a.map(x => Math.abs(x - center))), min: Math.min(...a), max: Math.max(...a) }; });
    if (!features.length) fail(400, 'no_trainable_features', 'At least one aligned feature needs point observations from three independent case/source groups.');
    const comparisons = []; let independentlyChecked = 0, independentMatches = 0;
    for (const e of holdout) {
      const result = await fingerprint(e.input);
      for (const f of result.fingerprint.features) {
        const reference = features.find(r => r.featureKey === f.featureKey);
        if (!reference || !f.observed) { comparisons.push({ caseId: e.caseId, featureId: f.id, status: 'unknown' }); continue; }
        const lower = Number(f.observed.min), upper = Number(f.observed.max);
        comparisons.push({ caseId: e.caseId, featureId: f.id, status: upper < reference.min || lower > reference.max ? 'outside_reference' : lower >= reference.min && upper <= reference.max ? 'within_reference' : 'uncertain', absoluteMidpointError: Math.abs((lower + upper) / 2 - reference.median) });
      }
      if (e.label && ['independent_review', 'deterministic_fixture'].includes(e.label.origin)) { independentlyChecked++; if (e.label.status === result.claims[0]?.status) independentMatches++; }
    }
    const errors = comparisons.filter(c => c.absoluteMidpointError !== undefined).map(c => c.absoluteMidpointError);
    const candidate = { id: randomUUID(), namespace, version: 'empirical-reference@0.1.0', createdAt: new Date().toISOString(), status: 'research_only',
      expiresAt: new Date(Math.min(...examples.map(e => Date.parse(e.expiresAt)))).toISOString(), sourceExampleIds: examples.map(e => e.id),
      trained: true, modelType: 'per-feature median and observed range', trainingExamples: train.length, heldOutExamples: holdout.length,
      trainingCaseSourceGroups: new Set(train.map((_, i) => find(i))).size,
      dataClasses: [...new Set(examples.map(e => e.dataClass))], features, evaluation: { comparisons, meanAbsoluteMidpointError: errors.length ? errors.reduce((a, b) => a + b, 0) / errors.length : null, independentlyChecked, independentMatches, teacherLabelsUsedAsTruth: false },
      limitation: 'A learned descriptive numerical reference, not a language model or policy. Training-range departures do not establish falsehood. Midpoint statistics use floating point; formal gap bounds remain exact. Synthetic results do not establish real-world accuracy. No serving routes are promoted or changed.' };
    if (!await this.store.commit([{ path: 'christopherCandidates/' + candidate.id, data: candidate, version: null }])) fail(409, 'dataset_conflict', 'Retry saving this candidate.');
    return candidate;
  }
  async snapshot(namespace) {
    const examples = await this.examples(namespace);
    const available = new Set(examples.map(e => e.id));
    const candidates = (await this.store.list('christopherCandidates', 500)).filter(c => c.namespace === namespace && !c.deleted && Date.parse(c.expiresAt) > Date.now() && c.sourceExampleIds?.every(id => available.has(id))).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-10);
    return { captureEnabled: this.captureEnabled && this.retentionReady, capture: this.stats, limits: { examples: MAX_EXAMPLES, exampleBytes: MAX_BYTES, concurrentCaptures: 2, retentionDays: 1 },
      examples: examples.map(({ id, caseId, eventTime, split, dataClass, expiresAt, label }) => ({ id, caseId, eventTime, split, dataClass, expiresAt, label })), candidates,
      limitation: 'Raw traffic capture is disabled unless deployment enables it, retention is configured, and a live tenant grant permits structured training data. Expired examples are excluded; administrators can erase records. Configure Firestore TTL before enabling real capture.' };
  }
  shadow(identity, route, body, teacher) {
    // Best-effort bounded intake, no training on the serving path. DeepSeek's
    // response remains authoritative for current serving, never ground truth.
    if (!this.captureEnabled || !this.retentionReady || this.pending >= 2 || identity.kind !== 'account' || !route.routing?.organizationId || !body.christopherShadow) { this.stats.skipped++; return; }
    this.pending++;
    void (async () => {
      const organizationId = route.routing.organizationId;
      const grant = (await this.store.get('christopherGrants/' + organizationId)).data;
      if (!grant?.allowStructuredTraining || !grant.policyRef || !Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= Date.now() || !grant.allowedSystemIds?.includes(identity.systemId)) { this.stats.skipped++; return; }
      // Each contributor remains isolated. No shared cross-tenant training.
      const example = { ...body.christopherShadow, dataClass: 'permitted', label: { origin: 'unreviewed', status: null } };
      await this.save(this.namespace(identity, organizationId), example, { permitted: true, teacherModel: route.model, grantOrganizationId: organizationId, expiresAt: new Date(Math.min(Date.now() + 86400000, Date.parse(grant.expiresAt))).toISOString() });
      this.stats.accepted++;
    })().catch(() => { this.stats.failed++; }).finally(() => { this.pending--; });
  }
}
