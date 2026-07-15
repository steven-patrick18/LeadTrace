import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { cellToPermission, PERMISSION_MATRIX, ROLE_ORDER } from './permission-matrix';

/**
 * Creates permission rows for NEW permission keys on boot, so features shipped
 * via Update-from-Git (which runs migrations, not the seed) work on production.
 *
 * Create-only by design: the Admin owns the live matrix through the Permissions
 * page, so existing rows are never modified here (fail-closed guard denies
 * anything missing until this runs).
 */
@Injectable()
export class PermissionSyncService implements OnModuleInit {
  private readonly logger = new Logger(PermissionSyncService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    try {
      const roles = await this.prisma.role.findMany({ select: { id: true, roleCode: true } });
      const roleId = new Map(roles.map((r) => [r.roleCode, r.id]));
      const existing = await this.prisma.permission.findMany({ select: { roleId: true, permissionKey: true } });
      const have = new Set(existing.map((p) => `${p.roleId}:${p.permissionKey}`));

      let created = 0;
      for (const [key, cells] of Object.entries(PERMISSION_MATRIX)) {
        for (let i = 0; i < ROLE_ORDER.length; i++) {
          const rid = roleId.get(ROLE_ORDER[i]);
          if (!rid || have.has(`${rid}:${key}`)) continue;
          const { allowed, scope } = cellToPermission(cells[i]);
          await this.prisma.permission.create({ data: { roleId: rid, permissionKey: key, allowed, scope } });
          created += 1;
        }
      }
      if (created) this.logger.log(`Permission matrix synced: ${created} new row(s) created`);
    } catch (e) {
      this.logger.error(`Permission matrix sync failed: ${(e as Error).message}`);
    }
  }
}
