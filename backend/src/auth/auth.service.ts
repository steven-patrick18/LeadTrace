import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { randomUUID } from 'crypto';
import { AuditService } from '../common/audit.service';
import { CacheService } from '../common/cache.service';
import { AuthUser } from '../common/decorators';
import { PrismaService } from '../common/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

interface TokenPayload {
  sub: number;
  sid: string; // session id — session must exist in cache (spec §1: sessions in Redis)
  typ: 'access' | 'refresh';
}

const SESSION_PREFIX = 'session:';

@Injectable()
export class AuthService {
  private readonly accessTtl: number;
  private readonly refreshTtl: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
  ) {
    this.accessTtl = Number(config.get('JWT_ACCESS_TTL') ?? 900);
    this.refreshTtl = Number(config.get('JWT_REFRESH_TTL') ?? 604800);
  }

  private sessionKey(userId: number, sid: string) {
    return `${SESSION_PREFIX}${userId}:${sid}`;
  }

  async login(email: string, password: string, ip?: string) {
    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
      include: { role: true },
    });
    if (!user || !user.isActive) throw new UnauthorizedException('Invalid credentials');
    const ok = await argon2.verify(user.passwordHash, password).catch(() => false);
    if (!ok) {
      await this.audit.log({ action: 'LOGIN_FAILED', detail: { email }, ip });
      throw new UnauthorizedException('Invalid credentials');
    }

    const sid = randomUUID();
    await this.cache.setJson(
      this.sessionKey(user.id, sid),
      { createdAt: new Date().toISOString(), ip: ip ?? null },
      this.refreshTtl,
    );
    await this.audit.log({ userId: user.id, action: 'LOGIN', ip });

    return {
      user: this.publicUser(user),
      ...(await this.issueTokens(user.id, sid)),
    };
  }

  async refresh(refreshToken: string) {
    const payload = await this.verifyToken(refreshToken, 'refresh');
    const key = this.sessionKey(payload.sub, payload.sid);
    const session = await this.cache.get(key);
    if (!session) throw new UnauthorizedException('Session expired');
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: { role: true },
    });
    if (!user || !user.isActive) throw new UnauthorizedException('Account disabled');
    // Rotate the session id on refresh
    await this.cache.del(key);
    const sid = randomUUID();
    await this.cache.setJson(this.sessionKey(user.id, sid), { rotatedAt: new Date().toISOString() }, this.refreshTtl);
    return { user: this.publicUser(user), ...(await this.issueTokens(user.id, sid)) };
  }

  async logout(userId: number, sid: string) {
    await this.cache.del(this.sessionKey(userId, sid));
    await this.audit.log({ userId, action: 'LOGOUT' });
  }

  /** Used by JwtAuthGuard on every request. */
  async validateAccess(token: string) {
    const payload = await this.verifyToken(token, 'access');
    const session = await this.cache.get(this.sessionKey(payload.sub, payload.sid));
    if (!session) throw new UnauthorizedException('Session expired');
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: { role: true },
    });
    if (!user || !user.isActive) throw new UnauthorizedException('Account disabled');
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      roleId: user.roleId,
      roleCode: user.role.roleCode,
      sessionId: payload.sid,
    };
  }

  // ── Quick batch-ID sessions ────────────────────────────────
  // The call stays live on a colleague's machine; the Sr Agent / Closer /
  // Manager types THEIR batch ID into the Session box and works as themselves
  // for a short admin-set window — no logout/login. The token has no refresh
  // and its cache entry carries the same TTL, so expiry is enforced
  // server-side. The identity owner is notified and can revoke from anywhere.

  async startBatchSession(initiator: AuthUser, batchId: string, ip?: string) {
    const attempts = await this.cache.incrWithTtl(`batch:attempts:${initiator.id}`, 15 * 60);
    if (attempts > 5) {
      throw new ForbiddenException('Too many batch ID attempts — wait 15 minutes');
    }

    const target = await this.prisma.user.findUnique({
      where: { batchId: batchId.trim().toUpperCase() },
      include: { role: true },
    });
    if (!target || !target.isActive) {
      await this.audit.log({
        userId: initiator.id,
        action: 'BATCH_SESSION_FAILED',
        ip,
        detail: { batchIdTried: batchId.slice(0, 3) + '***' },
      });
      throw new UnauthorizedException('Invalid batch ID');
    }
    if (target.id === initiator.id) {
      throw new ForbiddenException('You are already logged in as yourself');
    }

    const minutes = Number(
      (await this.prisma.appSetting.findUnique({ where: { key: 'batch_session_minutes' } }))?.value ?? 30,
    );
    const ttlSeconds = minutes * 60;
    const sid = randomUUID();
    await this.cache.setJson(
      this.sessionKey(target.id, sid),
      { batch: true, initiatedBy: initiator.id, startedAt: new Date().toISOString() },
      ttlSeconds,
    );
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const row = await this.prisma.batchSession.create({
      data: { userId: target.id, initiatedById: initiator.id, sid, expiresAt },
    });
    const accessToken = await this.jwt.signAsync(
      { sub: target.id, sid, typ: 'access' } satisfies TokenPayload,
      { secret: this.config.get('JWT_ACCESS_SECRET'), expiresIn: ttlSeconds },
    );

    await this.notifications.notify(
      [target.id],
      {
        type: 'BATCH_SESSION',
        title: `Your batch ID started a ${minutes}-minute session on ${initiator.name}'s screen`,
      },
    );
    await this.audit.log({
      userId: initiator.id,
      action: 'BATCH_SESSION_STARTED',
      ip,
      detail: { sessionId: row.id, asUserId: target.id, asUserName: target.name, minutes },
    });

    return {
      accessToken,
      expiresAt,
      minutes,
      sessionId: row.id,
      user: this.publicUser(target),
    };
  }

  /** Ended from the screen it runs on ("End session" button / auto-expiry). */
  async endBatchSession(user: AuthUser, ip?: string) {
    const row = await this.prisma.batchSession.findUnique({ where: { sid: user.sessionId } });
    if (!row || row.endedAt) return { ok: true }; // not a batch session or already closed
    await this.prisma.batchSession.update({
      where: { id: row.id },
      data: { endedAt: new Date(), endReason: row.expiresAt < new Date() ? 'EXPIRED' : 'ENDED' },
    });
    await this.cache.del(this.sessionKey(row.userId, row.sid));
    await this.audit.log({ userId: user.id, action: 'BATCH_SESSION_ENDED', ip, detail: { sessionId: row.id } });
    return { ok: true };
  }

  /** "Active session on their panel": sessions currently running under MY identity. */
  async myBatchSessions(userId: number) {
    const rows = await this.prisma.batchSession.findMany({
      where: { userId, endedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { startedAt: 'desc' },
      include: { initiatedBy: { select: { id: true, name: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      startedAt: r.startedAt,
      expiresAt: r.expiresAt,
      onScreenOf: r.initiatedBy,
      isCurrent: false,
    }));
  }

  /** Owner (or a user-manager) kills a session running under an identity. */
  async revokeBatchSession(actor: AuthUser, sessionId: number, canManageUsers: boolean, ip?: string) {
    const row = await this.prisma.batchSession.findUnique({ where: { id: sessionId } });
    if (!row) throw new NotFoundException('Session not found');
    if (row.userId !== actor.id && !canManageUsers) {
      throw new ForbiddenException('Only the identity owner or an admin can revoke this session');
    }
    if (!row.endedAt) {
      await this.prisma.batchSession.update({
        where: { id: sessionId },
        data: { endedAt: new Date(), endReason: 'REVOKED' },
      });
      await this.cache.del(this.sessionKey(row.userId, row.sid));
    }
    await this.audit.log({
      userId: actor.id,
      action: 'BATCH_SESSION_REVOKED',
      ip,
      detail: { sessionId, identityUserId: row.userId },
    });
    return { ok: true };
  }

  private async issueTokens(userId: number, sid: string) {
    const accessToken = await this.jwt.signAsync(
      { sub: userId, sid, typ: 'access' } satisfies TokenPayload,
      { secret: this.config.get('JWT_ACCESS_SECRET'), expiresIn: this.accessTtl },
    );
    const refreshToken = await this.jwt.signAsync(
      { sub: userId, sid, typ: 'refresh' } satisfies TokenPayload,
      { secret: this.config.get('JWT_REFRESH_SECRET'), expiresIn: this.refreshTtl },
    );
    return { accessToken, refreshToken, expiresIn: this.accessTtl };
  }

  private async verifyToken(token: string, typ: 'access' | 'refresh'): Promise<TokenPayload> {
    try {
      const secret =
        typ === 'access' ? this.config.get('JWT_ACCESS_SECRET') : this.config.get('JWT_REFRESH_SECRET');
      const payload = await this.jwt.verifyAsync<TokenPayload>(token, { secret });
      if (payload.typ !== typ) throw new Error('wrong token type');
      return payload;
    } catch {
      throw new UnauthorizedException('Invalid token');
    }
  }

  private publicUser(user: { id: number; name: string; email: string; roleId: number; role: { roleCode: string; displayName: string } }) {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      roleId: user.roleId,
      roleCode: user.role.roleCode,
      roleName: user.role.displayName,
    };
  }
}
