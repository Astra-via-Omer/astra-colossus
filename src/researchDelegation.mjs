import { createHash, createPublicKey, verify } from 'node:crypto';
import { fail } from './config.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const hash = /^[a-f0-9]{64}$/;
const certificatesUrl = 'https://www.googleapis.com/oauth2/v1/certs';

/** Verify Google's signature, audience and exact calling runtime account. */
export class GoogleResearchIdentity {
  constructor(fetcher, clock = () => Date.now()) { this.fetch = fetcher; this.clock = clock; this.certificates = null; this.expires = 0; }
  async verify(token, audience, email) {
    if (typeof token !== 'string' || token.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))
      fail(401, 'research_runtime_denied', 'A verified research runtime identity is required.');
    const [head, body, signature] = token.split('.');
    let header, claims;
    try { header = JSON.parse(Buffer.from(head, 'base64url')); claims = JSON.parse(Buffer.from(body, 'base64url')); } catch {}
    if (!header || header.alg !== 'RS256' || (header.typ !== undefined && header.typ !== 'JWT') ||
        typeof header.kid !== 'string' || !/^[a-zA-Z0-9._-]{1,200}$/.test(header.kid))
      fail(401, 'research_runtime_denied', 'The research runtime identity is invalid.');
    if (!this.certificates || this.expires <= this.clock()) {
      let response, certificates;
      try {
        response = await this.fetch(certificatesUrl, { redirect: 'error', signal: AbortSignal.timeout(8000) });
        if (!response.ok) throw Error('Google keys unavailable');
        const text = await response.text();
        if (Buffer.byteLength(text) > 100000) throw Error('Invalid Google keys');
        certificates = JSON.parse(text);
        if (!certificates || typeof certificates !== 'object' || Array.isArray(certificates) || Object.keys(certificates).length > 20) throw Error('Invalid Google keys');
      } catch { fail(503, 'research_identity_unavailable', 'The research runtime identity could not be verified.'); }
      this.certificates = certificates;
      const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(response.headers.get('cache-control') || '')?.[1];
      this.expires = this.clock() + Math.min(3600, Math.max(30, Number(maxAge || 300))) * 1000;
    }
    let verified = false;
    try {
      if (Object.hasOwn(this.certificates, header.kid) && typeof this.certificates[header.kid] === 'string')
        verified = verify('RSA-SHA256', Buffer.from(head + '.' + body), createPublicKey(this.certificates[header.kid]), Buffer.from(signature, 'base64url'));
    } catch {}
    const now = Math.floor(this.clock() / 1000);
    if (!verified || !claims || !['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss) ||
        claims.aud !== audience || claims.email !== email || claims.email_verified !== true ||
        typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255 ||
        !Number.isSafeInteger(claims.exp) || claims.exp <= now || !Number.isSafeInteger(claims.iat) || claims.iat > now + 30 || claims.exp <= claims.iat ||
        (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > now)))
      fail(401, 'research_runtime_denied', 'The research runtime identity is invalid or expired.');
    return claims;
  }
}

/** Only authoritative shared admissions may supply a delegated end-user owner. */
export class ResearchDelegation {
  constructor(config, fetcher) { this.config = config; this.fetch = fetcher; this.google = new GoogleResearchIdentity(fetcher); }
  requested(req) { return Object.keys(req.headers).some(key => key.startsWith('x-enigma-research-')); }
  async database(path, body) {
    const config = this.config;
    let response;
    try {
      response = await this.fetch(config.supabaseUrl + path, { method: body === undefined ? 'GET' : 'POST',
        headers: { apikey: config.serviceKey, Authorization: 'Bearer ' + config.serviceKey, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(8000) });
    } catch { fail(503, 'research_admission_unavailable', 'The background research admission could not be checked.'); }
    if (!response.ok) fail(response.status >= 500 || response.status === 404 ? 503 : 409,
      'research_admission_denied', 'This background research operation is unavailable or already dispatched.');
    try { return await response.json(); } catch { fail(503, 'research_admission_unavailable', 'The background research admission could not be checked.'); }
  }
  async authenticate(req, client) {
    const config = this.config;
    if (!config.researchServiceAccount || !config.serviceKey || !config.supabaseUrl)
      fail(503, 'research_setup_required', 'Background research authorization has not been configured.');
    const path = new URL(req.url, config.origin).pathname;
    if (req.method !== 'POST' || !['/v1/runs', '/v1/media/observe'].includes(path) || client?.systemId !== 'enigma' || !client.keyId)
      fail(403, 'research_route_denied', 'This credential cannot delegate this operation.');
    const jobId = req.headers['x-enigma-research-job'], operationId = req.headers['x-enigma-research-operation'],
      leaseId = req.headers['x-enigma-research-lease'], bodyHash = req.headers['x-enigma-research-hash'];
    if (![jobId, operationId, leaseId].every(value => typeof value === 'string' && uuid.test(value)) ||
        req.headers['x-enigma-research-call'] !== '0' || typeof bodyHash !== 'string' || !hash.test(bodyHash))
      fail(403, 'research_admission_denied', 'A valid admitted research operation is required.');
    const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization || '')?.[1];
    await this.google.verify(bearer, new URL(config.origin).origin, config.researchServiceAccount);
    const rows = await this.database('/rest/v1/enigma_research_operations?' + new URLSearchParams({
      id: 'eq.' + operationId, job_id: 'eq.' + jobId, lease_id: 'eq.' + leaseId,
      select: 'owner_id,kind,status,dispatch_deadline', limit: '1',
    }));
    const operation = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
    if (!operation || !uuid.test(operation.owner_id || '') || operation.status !== 'dispatched' ||
        !['capture', 'review'].includes(operation.kind) || !Number.isFinite(Date.parse(operation.dispatch_deadline)) || Date.parse(operation.dispatch_deadline) <= Date.now() ||
        (path === '/v1/media/observe') !== (operation.kind === 'capture'))
      fail(409, 'research_admission_denied', 'This background research operation is not admitted.');
    const user = await this.database('/auth/v1/admin/users/' + operation.owner_id);
    if (user?.id !== operation.owner_id) fail(403, 'research_owner_denied', 'The research account could not be verified.');
    return { user, jobId, operationId, leaseId, bodyHash, kind: operation.kind };
  }
  bindBody(identity, body, path) {
    const admission = identity.research;
    if (!admission) return;
    const bodyHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const activity = identity.activity;
    if (bodyHash !== admission.bodyHash || (admission.kind === 'capture' ? activity !== 'enigma.media' : !['enigma.analysis', 'enigma.temporal'].includes(activity)))
      fail(409, 'research_body_denied', 'The research request does not match its admitted payload.');
    const binding = path === '/v1/media/observe' ? this.config.media?.model :
      typeof body.engineId === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(body.engineId) && typeof body.engineVersion === 'string' && /^\d+\.\d+\.\d+$/.test(body.engineVersion)
        ? body.engineId + '@' + body.engineVersion : null;
    if (!binding) fail(409, 'research_model_denied', 'The research model binding is invalid.');
    admission.model = binding;
    // Retain only the context needed to validate a recovered result. Raw audio
    // and JPEG bytes stay transient; recognized source/reference text is bounded
    // by the normal request validators and remains private in the job journal.
    admission.context = admission.kind === 'capture' ? Object.fromEntries(
      ['durationMs', 'capturedAt', 'sourceUrl', 'broadcastAt', 'segmentKey', 'playbackMatched', 'playbackObservedAt', 'otherChannels']
        .filter(key => body[key] !== undefined).map(key => [key, body[key]]),
    ) : { engineId: body.engineId, engineVersion: body.engineVersion, input: body.input };
  }
  async consume(identity) {
    const admission = identity.research;
    if (!admission) return;
    if (!admission.model || admission.consumed) fail(409, 'research_duplicate', 'This research call cannot be dispatched twice.');
    const result = await this.database('/rest/v1/rpc/enigma_research_authorize', {
      p_job: admission.jobId, p_operation: admission.operationId, p_lease: admission.leaseId, p_slot: 0, p_hash: admission.bodyHash,
    });
    if (!result || result.owner_id !== identity.id || result.kind !== admission.kind ||
        result.job_id !== admission.jobId || result.operation_id !== admission.operationId || result.lease_id !== admission.leaseId ||
        result.activity !== identity.activity || result.model !== admission.model || result.body_hash !== admission.bodyHash)
      fail(409, 'research_binding_denied', 'The research authorization does not match this call.');
    admission.consumed = true;
  }
  async checkpoint(identity, status, body, outcome = 'completed') {
    const admission = identity?.research;
    if (!admission?.consumed || admission.checkpointed) return;
    await this.database('/rest/v1/rpc/enigma_research_checkpoint_call', {
      p_job: admission.jobId, p_operation: admission.operationId, p_lease: admission.leaseId, p_slot: 0, p_hash: admission.bodyHash,
      p_outcome: outcome, p_result: { status, body, context: admission.context, providerDispatched: admission.providerStarted === true },
    });
    admission.checkpointed = true;
  }
}
