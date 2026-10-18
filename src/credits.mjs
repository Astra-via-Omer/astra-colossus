import { fail } from './config.mjs';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const errors = {
  CLIENT_ACCESS_DENIED: [403, 'account_inactive', 'This account cannot run models for this product.'],
  CLIENT_ACCOUNT_REQUIRED: [409, 'credit_account_required', 'An administrator must configure your Astra credit account.'],
  CLIENT_PAUSED: [403, 'credits_paused', 'Computations are paused for this account.'],
  CLIENT_INSUFFICIENT_CREDITS: [402, 'insufficient_credits', 'Your Astra credit balance is too low for this request.'],
  CLIENT_PRICE_REQUIRED: [409, 'credit_price_required', 'An administrator must configure the computation price.'],
  CLIENT_ALREADY_RUNNING: [429, 'computation_running', 'A computation is already running for this account.'],
  CLIENT_RESERVATION_REQUIRED: [409, 'credit_reservation_required', 'Start a new computation with a current credit reservation.'],
};
export class Credits {
  constructor(config, fetcher) { this.config = config; this.fetcher = fetcher; }
  async rpc(name, args) {
    const { supabaseUrl, serviceKey } = this.config;
    if (!supabaseUrl || !serviceKey) fail(503, 'credits_unavailable', 'The shared credit service is not configured.');
    let response, data;
    try {
      response = await this.fetcher(`${supabaseUrl}/rest/v1/rpc/${name}`, { method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(8000),
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
      data = await response.json();
    } catch { fail(503, 'credits_unavailable', 'Credit verification is unavailable. No new model request can start.'); }
    if (!response.ok) {
      for (const [code, error] of Object.entries(errors)) if (data?.message?.includes(code)) fail(...error);
      fail(503, 'credits_unavailable', 'Credit verification is unavailable. Check computation history before retrying.');
    }
    return data;
  }
  async admit(identity, requestId, computation) {
    if (identity.kind !== 'account') {
      if (['workflow', 'enigma', 'lab', 'evidence'].includes(identity.systemId)) fail(403, 'account_required', 'Product inference requires the current user account and its credit reservation.');
      return null;
    }
    const system = identity.systemId || 'colossus';
    if (computation !== undefined && !uuid(computation)) fail(409, 'credit_reservation_required', 'Supply a current computation reservation.');
    const result = await this.rpc('astra_admit_model_request', { p_owner: identity.id, p_system: system, p_request: requestId, p_computation: computation || null });
    if (!uuid(result?.id) || typeof result.owned !== 'boolean') fail(503, 'credits_unavailable', 'The credit service returned an invalid reservation.');
    return { ...result, owner: identity.id, identity, requestId };
  }
  async check(admission) {
    if (admission) await this.admit(admission.identity, admission.requestId, admission.id);
  }
  async finish(admission, process, status) {
    if (!admission?.owned) return;
    const calls = process?.calls || [], complete = calls.every(call => call.cost.complete && call.cost.usd !== null);
    // Charge a partial request if any model call succeeded; failures with no
    // usable output release the hold, consistent with Workspace accounting.
    const success = calls.some(call => call.status === 'completed' || (call.httpStatus >= 200 && call.httpStatus < 300));
    if (!success && calls.some(call => call.httpStatus === undefined)) fail(503, 'credit_settlement_pending', 'Provider completion is uncertain. Retain the credit hold for reconciliation.');
    await this.rpc('astra_finish_model_request', { p_owner: admission.owner, p_id: admission.id,
      p_status: status === 'completed' ? 'completed' : success ? 'partial' : 'failed',
      p_usage: { calls: calls.length, totalTokens: calls.length && calls.every(call => call.usage.totalTokens === null) ? null : calls.reduce((sum, call) => sum + (call.usage.totalTokens || 0), 0), complete: calls.every(call => call.usage.complete) },
      p_cost: complete ? Math.ceil(calls.reduce((sum, call) => sum + call.cost.usd, 0) * 1000000) : null, p_complete: complete });
  }
}
