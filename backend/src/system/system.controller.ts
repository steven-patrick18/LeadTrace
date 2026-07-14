import { Controller, Get, Ip, Post } from '@nestjs/common';
import { execSync, spawn } from 'child_process';
import { statfs } from 'fs/promises';
import * as os from 'os';
import { join } from 'path';
import { performance } from 'perf_hooks';
import { AuditService } from '../common/audit.service';
import { CacheService } from '../common/cache.service';
import { AuthUser, CurrentUser, RequirePermission } from '../common/decorators';
import { PrismaService } from '../common/prisma.service';

/**
 * Admin server/ops page. Gated on system_lockdown (admin-only by default,
 * grantable through the matrix). The Update action spawns the vetted update
 * script on the server — it never runs arbitrary input.
 */
@Controller('system')
export class SystemController {
  private readonly repoRoot = join(process.cwd(), '..');
  private readonly updateScript = process.env.UPDATE_SCRIPT || '/root/update.sh';

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
  ) {}

  /** Tiny endpoint the client pings to measure round-trip reaction time. */
  @RequirePermission('system_lockdown')
  @Get('ping')
  ping() {
    return { ok: true, t: Date.now() };
  }

  @RequirePermission('system_lockdown')
  @Get('health')
  async health() {
    // DB + cache latency = the app's real "reaction time" to its dependencies.
    const dbStart = performance.now();
    await this.prisma.$queryRawUnsafe('SELECT 1').catch(() => null);
    const dbMs = Math.round((performance.now() - dbStart) * 10) / 10;

    const cacheStart = performance.now();
    await this.cache.get('__health_probe').catch(() => null);
    const cacheMs = Math.round((performance.now() - cacheStart) * 10) / 10;

    // Disk (root filesystem)
    let disk = { totalGb: 0, freeGb: 0, usedPct: 0 };
    try {
      const fs = await statfs('/');
      const total = fs.blocks * fs.bsize;
      const free = fs.bavail * fs.bsize;
      disk = {
        totalGb: Math.round((total / 1e9) * 10) / 10,
        freeGb: Math.round((free / 1e9) * 10) / 10,
        usedPct: total ? Math.round(((total - free) / total) * 100) : 0,
      };
    } catch {
      /* statfs unavailable (e.g. some Windows dev) */
    }

    const mem = process.memoryUsage();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const load = os.loadavg();

    return {
      commit: this.gitInfo(),
      node: process.version,
      pid: process.pid,
      uptime: { processSeconds: Math.round(process.uptime()), osSeconds: Math.round(os.uptime()) },
      cpu: {
        cores: os.cpus().length,
        load1: Math.round(load[0] * 100) / 100,
        load5: Math.round(load[1] * 100) / 100,
        load15: Math.round(load[2] * 100) / 100,
      },
      memory: {
        totalMb: Math.round(totalMem / 1e6),
        freeMb: Math.round(freeMem / 1e6),
        usedPct: Math.round(((totalMem - freeMem) / totalMem) * 100),
        processRssMb: Math.round(mem.rss / 1e6),
      },
      disk,
      latency: { dbMs, cacheMs },
    };
  }

  /**
   * Pull the latest code from git and redeploy. Spawns the update script
   * detached so it survives the app restart the deploy performs. Admin-only,
   * audited. The client watches the commit hash in /health flip to know it's done.
   */
  @RequirePermission('system_lockdown')
  @Post('update')
  async update(@CurrentUser() user: AuthUser, @Ip() ip: string) {
    const before = this.gitInfo();
    await this.audit.log({
      userId: user.id,
      action: 'SYSTEM_UPDATE_TRIGGERED',
      ip,
      detail: { fromCommit: before.hash },
    });
    try {
      const child = spawn('bash', [this.updateScript], {
        detached: true,
        stdio: 'ignore',
        cwd: '/',
      });
      child.unref();
    } catch (e) {
      return { started: false, message: `Could not start update: ${(e as Error).message}` };
    }
    return {
      started: true,
      message:
        'Update started: pulling latest code, rebuilding, and restarting. The app will briefly restart — this page will show the new version when it is back.',
      fromCommit: before.hash,
    };
  }

  private gitInfo(): { hash: string; message: string; when: string } {
    try {
      const opts = { cwd: this.repoRoot, encoding: 'utf8' as const, timeout: 4000 };
      return {
        hash: execSync('git rev-parse --short HEAD', opts).trim(),
        message: execSync('git log -1 --pretty=%s', opts).trim(),
        when: execSync('git log -1 --pretty=%cI', opts).trim(),
      };
    } catch {
      return { hash: 'unknown', message: '', when: '' };
    }
  }
}
