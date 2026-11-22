import { UserRole } from '../src/types.ts';

export type Permission =
  | 'workspace:read'
  | 'rfq:write'
  | 'supplier:write'
  | 'item:write'
  | 'quotation:extract'
  | 'quotation:edit'
  | 'quotation:verify'
  | 'quotation:delete'
  | 'award:recommend'
  | 'award:decide'
  | 'org:settings:write'
  | 'org:members:invite'
  | 'org:members:manage'
  | 'document:download';

const ALL_ROLES: UserRole[] = ['owner', 'admin', 'buyer', 'approver', 'viewer'];

export const ROLE_PERMISSIONS: Record<Permission, ReadonlySet<UserRole>> = {
  'workspace:read': new Set(ALL_ROLES),
  'document:download': new Set(ALL_ROLES),
  'rfq:write': new Set<UserRole>(['owner', 'admin', 'buyer']),
  'supplier:write': new Set<UserRole>(['owner', 'admin', 'buyer']),
  'item:write': new Set<UserRole>(['owner', 'admin', 'buyer']),
  'quotation:extract': new Set<UserRole>(['owner', 'admin', 'buyer']),
  'quotation:edit': new Set<UserRole>(['owner', 'admin', 'buyer']),
  'quotation:verify': new Set<UserRole>(['owner', 'admin', 'buyer']),
  'quotation:delete': new Set<UserRole>(['owner', 'admin', 'buyer']),
  'award:recommend': new Set<UserRole>(['owner', 'admin', 'buyer']),
  'award:decide': new Set<UserRole>(['owner', 'admin', 'approver']),
  'org:settings:write': new Set<UserRole>(['owner', 'admin']),
  'org:members:invite': new Set<UserRole>(['owner', 'admin']),
  'org:members:manage': new Set<UserRole>(['owner', 'admin']),
};

export const VALID_ORG_ROLES = new Set<UserRole>(ALL_ROLES);
export const INVITABLE_ROLES = new Set<UserRole>(['admin', 'buyer', 'approver', 'viewer']);

export function hasPermission(role: UserRole | null | undefined, permission: Permission): boolean {
  if (!role) return false;
  return ROLE_PERMISSIONS[permission].has(role);
}

export function canAssignRole(actorRole: UserRole, targetCurrentRole: UserRole, targetNewRole: UserRole): {
  allowed: boolean;
  reason?: string;
} {
  if (!VALID_ORG_ROLES.has(targetNewRole)) {
    return { allowed: false, reason: 'Invalid role requested.' };
  }
  if (actorRole === 'owner') {
    return { allowed: true };
  }
  if (actorRole === 'admin') {
    if (targetCurrentRole === 'owner') {
      return { allowed: false, reason: 'Only an Organization Owner can modify another Owner.' };
    }
    if (targetNewRole === 'owner') {
      return { allowed: false, reason: 'Only an Organization Owner can promote a member to Owner.' };
    }
    return { allowed: true };
  }
  return { allowed: false, reason: 'Insufficient permissions to manage organization roles.' };
}
