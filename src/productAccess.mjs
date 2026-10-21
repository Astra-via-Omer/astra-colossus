import { fail } from './config.mjs';

export const ASTRA_PRODUCTS = Object.freeze(['colossus', 'workflow', 'enigma', 'lab', 'evidence', 'observer']);
const policyPath = 'accessPolicies/products';
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(value);
const licensePath = (userId, productId) => `productLicenses/${productId}:${userId}`;
const admin = actor => { if (actor?.kind !== 'account' || actor.astraAdmin !== true) fail(403, 'admin_required', 'An active global Astra administrator is required.'); };
const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

// Product identity comes only from server-verified credentials. A group, free
// credit balance, email domain or client-supplied product name is not a license.
export class ProductAccess {
  constructor(control, clock = () => Date.now()) { this.control = control; this.store = control.store; this.clock = clock; }
  async policy() {
    if (!this.control.enabled) return { enabled: false, state: 'setup_required' };
    await this.control.ensure();
    const value = (await this.store.get(policyPath)).data;
    if (!value) return { enabled: false, state: 'setup' };
    if (value.version !== 1 || typeof value.enabled !== 'boolean') fail(503, 'product_access_unavailable', 'The product authorization policy could not be checked.');
    return { ...value, state: value.enabled ? 'enforced' : 'setup' };
  }
  async authorize(identity, requiredModel = null) {
    if (!(await this.policy()).enabled) return null;
    if (identity.kind !== 'account') fail(403, 'user_required', 'A verified end-user account is required for product API access.');
    if (identity.productVerified !== true || !ASTRA_PRODUCTS.includes(identity.systemId))
      fail(403, 'product_required', 'Use an approved Astra product backend and its scoped key, or the Colossus account session.');
    const system = (await this.store.get('systems/' + identity.systemId)).data;
    if (!system?.enabled) fail(403, 'system_paused', 'This Astra product is paused.');
    const { group } = await this.control.groupAccess(identity, true);
    // No implicit free-PDF assignment or administrator bypass under this policy.
    const assignment = (await this.store.get('groupMembers/' + identity.id)).data;
    if (!group?.enabled || assignment?.groupId !== group.id || !Array.isArray(group.memberIds) || !group.memberIds.includes(identity.id))
      fail(403, 'explicit_group_required', 'An explicit active group membership is required.');
    const organizationId = await this.store.organizationFor(identity.id);
    const license = (await this.store.get(licensePath(identity.id, identity.systemId))).data;
    const time = this.clock();
    if (!license || license.userId !== identity.id || license.productId !== identity.systemId || license.status !== 'active' ||
        !instant(license.startsAt) || Date.parse(license.startsAt) > time || !instant(license.expiresAt) || Date.parse(license.expiresAt) <= time ||
        license.groupId !== group.id || license.organizationId !== organizationId)
      fail(403, 'product_license_required', 'An active license for this product, group and organization is required.');
    if (requiredModel && (!group.modelIds.includes(requiredModel) || (identity.allowedModels && !identity.allowedModels.includes(requiredModel))))
      fail(403, 'model_not_granted', 'This group or product key does not grant the required model.');
    identity.productAccess = { productId: identity.systemId, groupId: group.id, organizationId, licenseId: license.id };
    return identity.productAccess;
  }
  async snapshot(actor) {
    admin(actor);
    const policy = await this.policy();
    if (!this.control.enabled) return { policy, products: ASTRA_PRODUCTS, licenses: [] };
    return { policy, products: ASTRA_PRODUCTS, licenses: await this.store.list('productLicenses') };
  }
  async saveLicense(body, actor) {
    admin(actor); await this.control.ensure();
    if (!body || !validId(body.userId) || !ASTRA_PRODUCTS.includes(body.productId) ||
        !['active', 'suspended', 'revoked'].includes(body.status) || !validId(body.groupId) ||
        !instant(body.startsAt) || !instant(body.expiresAt) || Date.parse(body.expiresAt) <= Date.parse(body.startsAt))
      fail(400, 'invalid_product_license', 'Supply an account, Astra product, group, status and a valid start/expiry interval.');
    const path = licensePath(body.userId, body.productId), previous = (await this.store.get(path)).data;
    if (body.expectedUpdatedAt !== (previous?.updatedAt || null)) fail(409, 'license_conflict', 'Refresh this license before saving.');
    const [assignment, group, system] = await Promise.all([
      this.store.get('groupMembers/' + body.userId), this.store.get('groups/' + body.groupId), this.store.get('systems/' + body.productId),
    ]);
    if (body.status === 'active' && !system.data?.enabled) fail(400, 'system_required', 'Choose an enabled Astra product.');
    if (body.status === 'active' && (assignment.data?.groupId !== body.groupId || !group.data?.enabled || !group.data.memberIds?.includes(body.userId)))
      fail(400, 'explicit_group_required', 'Assign the account to this active group before granting a product license.');
    const organizationId = body.status === 'active' ? await this.store.organizationFor(body.userId) : previous?.organizationId ?? null;
    if (body.status === 'active' && group.data?.organizationId && group.data.organizationId !== organizationId)
      fail(403, 'organization_denied', 'This account must belong to the group’s active organization.');
    const at = new Date(Math.max(this.clock(), previous ? Date.parse(previous.updatedAt) + 1 : 0)).toISOString();
    const value = { id: body.productId + ':' + body.userId, userId: body.userId, productId: body.productId, groupId: body.groupId,
      organizationId, status: body.status, startsAt: new Date(body.startsAt).toISOString(), expiresAt: new Date(body.expiresAt).toISOString(),
      createdAt: previous?.createdAt || at, updatedAt: at, updatedBy: actor.id };
    await this.control.audit(actor, 'license_' + body.status + '_requested', 'productLicenses', value.id);
    await this.store.mutate([path], ([current]) => {
      if ((current?.updatedAt || null) !== (previous?.updatedAt || null)) fail(409, 'license_conflict', 'This license changed. Refresh before saving.');
      return [value];
    });
    return value;
  }
  async activate(body, actor) {
    admin(actor); await this.control.ensure();
    if (body?.enabled !== true) fail(400, 'invalid_access_policy', 'This endpoint can only activate enforcement.');
    // Prove that the operator has a usable licensed route before restricting all
    // processing. Management remains available for future provisioning/revocation.
    await this.control.audit(actor, 'product_enforcement_requested', 'accessPolicies', 'products');
    const probe = { ...actor, systemId: 'colossus', productVerified: true };
    const before = await this.policy();
    if (!before.enabled) {
      const policy = { version: 1, enabled: true, updatedAt: new Date(this.clock()).toISOString(), updatedBy: actor.id };
      // Check against the active rules without ever publishing a temporary policy.
      const check = new ProductAccess(this.control, this.clock); check.policy = async () => policy;
      await check.authorize(probe);
      await this.store.mutate([policyPath], () => [policy]);
    }
    return this.policy();
  }
}
