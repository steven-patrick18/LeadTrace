import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { randomUUID } from 'crypto';
import { AuditService } from '../common/audit.service';
import { CacheService } from '../common/cache.service';
import { PrismaService } from '../common/prisma.service';

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
