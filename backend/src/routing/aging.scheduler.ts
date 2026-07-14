import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../common/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PermissionsService } from '../permissions/permissions.service';

/**
 * Aging alert (spec Phase 3 safeguards): PENDING queue rows older than the
 * configurable threshold get flagged once and every route_leads holder
 * (Admin + any backup admin) is notified.
 */
@Injectable()
export class AgingScheduler {
  private readonly logger = new Logger(AgingScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly permissions: PermissionsService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async checkAging() {
    // Paused during lockdown (spec §7.9)
    const state = await this.prisma.systemState.findUnique({ where: { id: 1 } });
    if (state?.status === 'LOCKED') return;

    const setting = await this.prisma.appSetting.findUnique({
      where: { key: 'routing_aging_threshold_minutes' },
    });
    const thresholdMinutes = Number(setting?.value ?? 60);
    const cutoff = new Date(Date.now() - thresholdMinutes * 60_000);

    const stale = await this.prisma.routingQueue.findMany({
      where: { status: 'PENDING', createdAt: { lt: cutoff }, agingAlertAt: null },
      include: { lead: { select: { id: true, firstName: true, lastName: true } } },
    });
    if (!stale.length) return;

    const routers = await this.permissions.usersWithPermission('route_leads');
    for (const row of stale) {
      await this.notifications.notify(
        routers.map((r) => r.id),
        {
          type: 'QUEUE_AGING',
          title: `Lead #${row.lead.id} (${row.lead.firstName} ${row.lead.lastName}) has waited over ${thresholdMinutes} min in the queue`,
          leadId: row.lead.id,
        },
      );
      await this.prisma.routingQueue.update({
        where: { id: row.id },
        data: { agingAlertAt: new Date() },
      });
    }
    this.logger.warn(`Aging alert sent for ${stale.length} queue row(s)`);
  }
}
