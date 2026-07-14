import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Cache abstraction: Redis when REDIS_URL is set (required for multi-instance
 * production per spec §1), transparent in-memory fallback for single-instance dev.
 * Used for: sessions, permission matrix cache, lockdown state, wake rate limiting.
 */
@Injectable()
export class CacheService implements OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private redis: Redis | null = null;
  private readonly mem = new Map<string, { value: string; expiresAt: number | null }>();

  constructor(config: ConfigService) {
    const url = config.get<string>('REDIS_URL');
    if (url) {
      this.redis = new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: false });
      this.redis.on('error', (e) => this.logger.error(`Redis error: ${e.message}`));
      this.logger.log('Cache backend: Redis');
    } else {
      this.logger.warn('Cache backend: in-memory (dev only — set REDIS_URL in production)');
      // Sweep expired in-memory entries so long-running dev servers don't leak
      const sweep = setInterval(() => {
        const now = Date.now();
        for (const [k, v] of this.mem) if (v.expiresAt !== null && v.expiresAt < now) this.mem.delete(k);
      }, 60_000);
      sweep.unref();
    }
  }

  async get(key: string): Promise<string | null> {
    if (this.redis) return this.redis.get(key);
    const hit = this.mem.get(key);
    if (!hit) return null;
    if (hit.expiresAt !== null && hit.expiresAt < Date.now()) {
      this.mem.delete(key);
      return null;
    }
    return hit.value;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (this.redis) {
      if (ttlSeconds) await this.redis.set(key, value, 'EX', ttlSeconds);
      else await this.redis.set(key, value);
      return;
    }
    this.mem.set(key, { value, expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null });
  }

  async del(...keys: string[]): Promise<void> {
    if (!keys.length) return;
    if (this.redis) {
      await this.redis.del(...keys);
      return;
    }
    for (const k of keys) this.mem.delete(k);
  }

  async delByPrefix(prefix: string): Promise<void> {
    if (this.redis) {
      const keys = await this.redis.keys(`${prefix}*`);
      if (keys.length) await this.redis.del(...keys);
      return;
    }
    for (const k of this.mem.keys()) if (k.startsWith(prefix)) this.mem.delete(k);
  }

  /** Atomic-enough increment with TTL — used for wake-endpoint rate limiting. */
  async incrWithTtl(key: string, ttlSeconds: number): Promise<number> {
    if (this.redis) {
      const n = await this.redis.incr(key);
      if (n === 1) await this.redis.expire(key, ttlSeconds);
      return n;
    }
    const current = Number((await this.get(key)) ?? '0') + 1;
    const existing = this.mem.get(key);
    this.mem.set(key, {
      value: String(current),
      expiresAt: current === 1 || !existing ? Date.now() + ttlSeconds * 1000 : existing.expiresAt,
    });
    return current;
  }

  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.get(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  }

  async setJson(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    await this.set(key, JSON.stringify(value), ttlSeconds);
  }

  async onModuleDestroy() {
    if (this.redis) await this.redis.quit();
  }
}
