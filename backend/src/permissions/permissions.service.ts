import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { PermissionScope } from '@prisma/client';
import { AuditService } from '../common/audit.service';
import { CacheService } from '../common/cache.service';
import { PrismaService } from '../common/prisma.service';

export interface ResolvedPermission {
  allowed: boolean;
  scope: PermissionScope;
}

const CACHE_PREFIX = 'perm:role:';
const CACHE_TTL_SECONDS = 300; // safety TTL; explicit invalidation on every edit

/** The canonical permission keys. The matrix editor may only toggle these. */
export const PERMISSION_KEYS = [
  'search_providers',
  'create_lead',
  'view_own_leads',
  'view_all_leads',
  'edit_lead',
  'log_activity',
  'request_transfer',
  'route_leads',
  'close_deal',
  'send_back',
  'view_reports_team',
  'view_reports_own',
  'view_api_costs',
  'export_data',
  'manage_users',
  'manage_permissions',
  'manage_providers',
  'system_lockdown',
  'enrich_lead',
  'view_enrichment',
  'edit_score_weights',
  'manage_dnc_optout',
  'view_enrichment_cost',
  'manage_custom_fields',
  'comment_lead',
  'manage_lead_access',
  'manage_desks',
] as const;

@Injectable()
export class PermissionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
  ) {}

  /** Resolve a role's full permission map — cache-first, DB fallback (spec §3). */
  async getRolePermissions(roleId: number): Promise<Record<string, ResolvedPermission>> {
    const cacheKey = `${CACHE_PREFIX}${roleId}`;
    const cached = await this.cache.getJson<Record<string, ResolvedPermission>>(cacheKey);
    if (cached) return cached;

    const rows = await this.prisma.permission.findMany({ where: { roleId } });
    const map: Record<string, ResolvedPermission> = {};
    for (const row of rows) map[row.permissionKey] = { allowed: row.allowed, scope: row.scope };
    await this.cache.setJson(cacheKey, map, CACHE_TTL_SECONDS);
    return map;
  }

  async check(roleId: number, permissionKey: string): Promise<ResolvedPermission> {
    const map = await this.getRolePermissions(roleId);
    return map[permissionKey] ?? { allowed: false, scope: PermissionScope.ALL };
  }

  /** Full matrix for the editor UI: roles × permission keys. */
  async getMatrix() {
    const roles = await this.prisma.role.findMany({
      orderBy: { id: 'asc' },
      include: { permissions: true },
    });
    return {
      permissionKeys: PERMISSION_KEYS,
      roles: roles.map((r) => ({
        id: r.id,
        roleCode: r.roleCode,
        displayName: r.displayName,
        tier: r.tier,
        permissions: Object.fromEntries(
          r.permissions.map((p) => [p.permissionKey, { allowed: p.allowed, scope: p.scope }]),
        ),
      })),
    };
  }

  /**
   * Edit one matrix cell. Guard rails:
   *  - only canonical keys;
   *  - ADMIN cannot lose manage_permissions or system_lockdown (no self-lockout by edit);
   * Every change is audited and the role's cache entry invalidated (spec §3).
   */
  async updateCell(
    editorUserId: number,
    roleId: number,
    permissionKey: string,
    allowed: boolean,
    scope: PermissionScope,
    ip?: string,
  ) {
    if (!(PERMISSION_KEYS as readonly string[]).includes(permissionKey)) {
      throw new BadRequestException(`Unknown permission key: ${permissionKey}`);
    }
    const role = await this.prisma.role.findUnique({ where: { id: roleId } });
    if (!role) throw new BadRequestException('Unknown role');
    if (
      role.roleCode === 'ADMIN' &&
      ['manage_permissions', 'system_lockdown'].includes(permissionKey) &&
      !allowed
    ) {
      throw new ForbiddenException(
        'The ADMIN role cannot lose manage_permissions or system_lockdown.',
      );
    }

    const before = await this.prisma.permission.findUnique({
      where: { roleId_permissionKey: { roleId, permissionKey } },
    });
    const after = await this.prisma.permission.upsert({
      where: { roleId_permissionKey: { roleId, permissionKey } },
      update: { allowed, scope },
      create: { roleId, permissionKey, allowed, scope },
    });

    await this.cache.del(`${CACHE_PREFIX}${roleId}`);
    await this.audit.log({
      userId: editorUserId,
      action: 'PERMISSION_CHANGE',
      ip,
      detail: {
        roleCode: role.roleCode,
        permissionKey,
        before: before ? { allowed: before.allowed, scope: before.scope } : null,
        after: { allowed: after.allowed, scope: after.scope },
      },
    });
    return after;
  }

  async renameRole(editorUserId: number, roleId: number, displayName: string, ip?: string) {
    const role = await this.prisma.role.update({ where: { id: roleId }, data: { displayName } });
    await this.audit.log({
      userId: editorUserId,
      action: 'ROLE_RENAMED',
      ip,
      detail: { roleCode: role.roleCode, displayName },
    });
    return role;
  }

  /** All users whose role currently holds a permission (e.g. notify all routers). */
  async usersWithPermission(permissionKey: string) {
    return this.prisma.user.findMany({
      where: {
        isActive: true,
        role: { permissions: { some: { permissionKey, allowed: true } } },
      },
      select: { id: true, name: true, email: true },
    });
  }
}
