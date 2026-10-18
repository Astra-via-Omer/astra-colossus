// Read only current protected Supabase app_metadata, never user_metadata or cached JWT claims.
export function hasActiveEntitlement(metadata, now = Date.now()) {
  const value = metadata?.astra_entitlement;
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || value.enabled !== true || !['trial', 'subscription'].includes(value.kind) || typeof value.expiresAt !== 'string') return false;
  const end = Date.parse(value.expiresAt);
  return Number.isFinite(end) && new Date(end).toISOString() === value.expiresAt && end > now;
}
