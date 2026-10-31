// Console visibility is separate from administrator authority and inference grants.
export const canViewOperations = identity => identity?.kind === 'account'
  && ((identity.admin === true && identity.astraAdmin === true) || identity.role === 'professional');
