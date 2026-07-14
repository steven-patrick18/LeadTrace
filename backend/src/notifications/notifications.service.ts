import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async notify(
    userIds: number[],
    payload: { type: string; title: string; body?: string; leadId?: number },
    tx?: Prisma.TransactionClient,
  ) {
    if (!userIds.length) return;
    const client = tx ?? this.prisma;
    await client.notification.createMany({
      data: userIds.map((userId) => ({
        userId,
        type: payload.type,
        title: payload.title,
        body: payload.body ?? null,
        leadId: payload.leadId ?? null,
      })),
    });
  }

  list(userId: number, unreadOnly: boolean) {
    return this.prisma.notification.findMany({
      where: { userId, ...(unreadOnly ? { isRead: false } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  unreadCount(userId: number) {
    return this.prisma.notification.count({ where: { userId, isRead: false } });
  }

  async markRead(userId: number, id?: number) {
    await this.prisma.notification.updateMany({
      where: { userId, ...(id ? { id } : {}) },
      data: { isRead: true },
    });
    return { ok: true };
  }
}
