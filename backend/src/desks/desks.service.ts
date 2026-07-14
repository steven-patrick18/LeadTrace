import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../common/audit.service';
import { AuthUser } from '../common/decorators';
import { PrismaService } from '../common/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * Batch-ID desk sessions for a shared-seat call floor.
 * Everyone logs in with their OWN account; sitting down at a seat means
 * entering that desk's batch id (its code) to clock in. Rules:
 *  - one open session per user (switching desks auto-closes the old one);
 *  - one open session per desk — if a Closer/Manager sits at an Agent's seat
 *    and enters the batch id, the previous session is force-completed as a
 *    TAKEOVER, the previous user is notified, and everything is audited;
 *  - an admin can FORCE-complete any open session;
 *  - logging a CALL requires an open session, so every call is attributed to
 *    a person AND a seat.
 */
@Injectable()
export class DesksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  async activeSession(userId: number) {
    return this.prisma.deskSession.findFirst({
      where: { userId, endedAt: null },
      include: { desk: true },
    });
  }

  async clockIn(user: AuthUser, batchCode: string, ip?: string) {
    const desk = await this.prisma.desk.findUnique({ where: { code: batchCode.trim().toUpperCase() } });
    if (!desk || !desk.isActive) {
      throw new BadRequestException('Unknown batch ID — check the code on your desk');
    }

    return this.prisma.$transaction(async (tx) => {
      // Close the caller's own open session elsewhere (seat switch)
      const mine = await tx.deskSession.findFirst({ where: { userId: user.id, endedAt: null } });
      if (mine) {
        if (mine.deskId === desk.id) return tx.deskSession.findUniqueOrThrow({ where: { id: mine.id }, include: { desk: true } });
        await tx.deskSession.update({
          where: { id: mine.id },
          data: { endedAt: new Date(), endReason: 'CLOCK_OUT', endedById: user.id },
        });
      }

      // Take over the seat if someone else is still clocked in on it
      const occupied = await tx.deskSession.findFirst({
        where: { deskId: desk.id, endedAt: null },
        include: { user: { select: { id: true, name: true } } },
      });
      if (occupied) {
        await tx.deskSession.update({
          where: { id: occupied.id },
          data: { endedAt: new Date(), endReason: 'TAKEOVER', endedById: user.id },
        });
        await this.notifications.notify(
          [occupied.user.id],
          {
            type: 'DESK_TAKEOVER',
            title: `${user.name} took over ${desk.code} — your desk session was closed`,
          },
          tx,
        );
        await this.audit.log({
          userId: user.id,
          action: 'DESK_TAKEOVER',
          ip,
          detail: { desk: desk.code, previousUserId: occupied.user.id, previousUserName: occupied.user.name },
          tx,
        });
      }

      const session = await tx.deskSession.create({
        data: { deskId: desk.id, userId: user.id },
        include: { desk: true },
      });
      await this.audit.log({ userId: user.id, action: 'DESK_CLOCK_IN', ip, detail: { desk: desk.code }, tx });
      return session;
    });
  }

  async clockOut(user: AuthUser, ip?: string) {
    const mine = await this.prisma.deskSession.findFirst({
      where: { userId: user.id, endedAt: null },
      include: { desk: true },
    });
    if (!mine) throw new BadRequestException('You are not clocked in at any desk');
    await this.prisma.deskSession.update({
      where: { id: mine.id },
      data: { endedAt: new Date(), endReason: 'CLOCK_OUT', endedById: user.id },
    });
    await this.audit.log({ userId: user.id, action: 'DESK_CLOCK_OUT', ip, detail: { desk: mine.desk.code } });
    return { ok: true };
  }

  async forceComplete(admin: AuthUser, sessionId: number, ip?: string) {
    const session = await this.prisma.deskSession.findUnique({
      where: { id: sessionId },
      include: { desk: true, user: { select: { id: true, name: true } } },
    });
    if (!session) throw new NotFoundException('Session not found');
    if (session.endedAt) throw new BadRequestException('Session is already completed');
    await this.prisma.deskSession.update({
      where: { id: sessionId },
      data: { endedAt: new Date(), endReason: 'FORCED', endedById: admin.id },
    });
    await this.notifications.notify(
      [session.user.id],
      { type: 'DESK_FORCED', title: `Your session on ${session.desk.code} was force-completed by ${admin.name}` },
    );
    await this.audit.log({
      userId: admin.id,
      action: 'DESK_SESSION_FORCED',
      ip,
      detail: { sessionId, desk: session.desk.code, targetUserId: session.user.id },
    });
    return { ok: true };
  }

  /** Floor view: every desk with its current occupant + recent sessions. */
  async floor() {
    const desks = await this.prisma.desk.findMany({
      orderBy: { code: 'asc' },
      include: {
        sessions: {
          where: { endedAt: null },
          include: { user: { select: { id: true, name: true, role: { select: { displayName: true } } } } },
        },
      },
    });
    const now = Date.now();
    const recent = await this.prisma.deskSession.findMany({
      orderBy: { startedAt: 'desc' },
      take: 30,
      include: {
        desk: { select: { code: true } },
        user: { select: { id: true, name: true } },
        endedBy: { select: { id: true, name: true } },
        _count: { select: { calls: true } },
      },
    });
    return {
      desks: desks.map((d) => ({
        id: d.id,
        code: d.code,
        name: d.name,
        isActive: d.isActive,
        occupant: d.sessions[0]
          ? {
              sessionId: d.sessions[0].id,
              user: d.sessions[0].user,
              since: d.sessions[0].startedAt,
              minutes: Math.floor((now - d.sessions[0].startedAt.getTime()) / 60000),
            }
          : null,
      })),
      recentSessions: recent,
    };
  }
}
