import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { randomInt } from 'crypto';
import { AuditService } from '../common/audit.service';
import { CacheService } from '../common/cache.service';
import { PrismaService } from '../common/prisma.service';

const STATE_CACHE_KEY = 'system:state';
const STATE_CACHE_TTL = 5; // seconds — DB is the source of truth (spec §7.2)
const WAKE_RATE_PREFIX = 'wake:attempts:';
const WAKE_GLOBAL_FAILS = 'wake:global-fails';
const WAKE_ENDPOINT_LOCK = 'wake:endpoint-locked';

// Crockford-style alphabet, ambiguous characters removed (no 0/O/1/I/L)
const KEY_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

@Injectable()
export class LockdownService {
  private readonly logger = new Logger(LockdownService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
  ) {}

  /** Fast lockdown check for the blackout middleware — cached 5s, DB truth. */
  async isLocked(): Promise<boolean> {
    const cached = await this.cache.get(STATE_CACHE_KEY);
    if (cached !== null) return cached === 'LOCKED';
    const state = await this.prisma.systemState.findUnique({ where: { id: 1 } });
    const status = state?.status ?? 'ACTIVE';
    await this.cache.set(STATE_CACHE_KEY, status, STATE_CACHE_TTL);
    return status === 'LOCKED';
  }

  async hasActiveKey(): Promise<boolean> {
    return (await this.prisma.recoveryKey.count({ where: { isActive: true } })) > 0;
  }

  /**
   * Generate the recovery key (spec §7.1): shown ONCE, argon2 hash stored,
   * regenerate kills the old key. Format WK-XXXX-XXXX-XXXX-XXXX from a
   * CSPRNG over a 30-char unambiguous alphabet (~78 bits — combined with
   * argon2 + 5/15min IP rate limiting + endpoint lockout, far beyond online
   * brute-force reach; trade-off vs the 128-bit note documented in README).
   */
  async generateRecoveryKey(userId: number, ip?: string): Promise<{ recoveryKey: string }> {
    const groups = Array.from({ length: 4 }, () =>
      Array.from({ length: 4 }, () => KEY_ALPHABET[randomInt(KEY_ALPHABET.length)]).join(''),
    );
    const rawKey = `WK-${groups.join('-')}`;
    const keyHash = await argon2.hash(rawKey);

    await this.prisma.$transaction(async (tx) => {
      await tx.recoveryKey.updateMany({ where: { isActive: true }, data: { isActive: false } });
      await tx.recoveryKey.create({ data: { keyHash, createdBy: userId } });
      await this.audit.log({ userId, action: 'RECOVERY_KEY_GENERATED', ip, tx });
    });

    // Raw key is returned exactly once and never persisted or logged.
    return { recoveryKey: rawKey };
  }

  /** Trigger lockdown (spec §7.3). Disabled until an active key exists. */
  async lockdown(userId: number, ip?: string) {
    if (!(await this.hasActiveKey())) {
      throw new BadRequestException(
        'Generate a recovery key first. Lockdown without a key would require direct database access to recover.',
      );
    }
    await this.prisma.systemState.update({
      where: { id: 1 },
      data: { status: 'LOCKED', updatedBy: userId, updatedAt: new Date() },
    });
    await this.cache.del(STATE_CACHE_KEY);
    await this.audit.log({ userId, action: 'SYSTEM_LOCKDOWN', ip });
    this.logger.warn(`SYSTEM LOCKDOWN triggered by user ${userId}`);
    return { status: 'LOCKED' };
  }

  /**
   * Wake attempt (spec §7.6–7.7): argon2 verify → ACTIVE → audit.
   * Wrong key → generic error, no hints. IP rate limit 5/15min with
   * incremental delay; heavy global failures lock the endpoint
   * (console recovery remains — see README).
   */
  async wake(key: string, ip: string): Promise<{ ok: boolean }> {
    if (await this.cache.get(WAKE_ENDPOINT_LOCK)) {
      return { ok: false };
    }
    const attempts = await this.cache.incrWithTtl(`${WAKE_RATE_PREFIX}${ip}`, 15 * 60);
    if (attempts > 5) {
      await this.audit.log({ action: 'WAKE_RATE_LIMITED', ip });
      return { ok: false };
    }
    // Incremental delay per attempt (spec §7.7)
    await new Promise((r) => setTimeout(r, Math.min(5000, (attempts - 1) * 750)));

    const activeKey = await this.prisma.recoveryKey.findFirst({
      where: { isActive: true },
      orderBy: { createdAt: 'desc' },
    });
    const valid =
      !!activeKey &&
      (await argon2.verify(activeKey.keyHash, key.trim().toUpperCase()).catch(() => false));

    if (!valid) {
      await this.audit.log({ action: 'WAKE_ATTEMPT_FAILED', ip });
      const globalFails = await this.cache.incrWithTtl(WAKE_GLOBAL_FAILS, 60 * 60);
      if (globalFails >= 25) {
        await this.cache.set(WAKE_ENDPOINT_LOCK, '1', 60 * 60);
        await this.audit.log({ action: 'WAKE_ENDPOINT_LOCKED', ip, detail: { globalFails } });
        this.logger.error('Wake endpoint locked after repeated failures — console recovery only');
      }
      return { ok: false };
    }

    await this.prisma.systemState.update({
      where: { id: 1 },
      data: { status: 'ACTIVE', updatedAt: new Date() },
    });
    await this.cache.del(STATE_CACHE_KEY, `${WAKE_RATE_PREFIX}${ip}`, WAKE_GLOBAL_FAILS);
    await this.audit.log({ action: 'SYSTEM_WAKE', ip });
    this.logger.warn(`System woken from lockdown (ip ${ip})`);
    return { ok: true };
  }
}
