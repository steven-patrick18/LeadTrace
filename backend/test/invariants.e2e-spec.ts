/**
 * Spec §4 invariant tests. Run against the dev database:
 *   npm run test:e2e
 *
 * Invariant 1 (assigned_to/current_tier only mutate inside routing) is proven
 * two ways: statically (source scan below) and behaviorally (permissions spec).
 * Invariant 2 (append-only) is enforced by DB triggers and tested here directly.
 */
import { PrismaClient } from '@prisma/client';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const prisma = new PrismaClient();

afterAll(() => prisma.$disconnect());

describe('Invariant 2 — append-only tables', () => {
  it('rejects UPDATE on routing_history', async () => {
    const row = await prisma.routingHistory.findFirst();
    expect(row).toBeTruthy(); // seeded by smoke flow
    await expect(
      prisma.$executeRawUnsafe(`UPDATE routing_history SET transfer_point = 'T1_TO_SS' WHERE id = ${row!.id}`),
    ).rejects.toThrow(/append-only/);
  });

  it('rejects DELETE on routing_history', async () => {
    const row = await prisma.routingHistory.findFirst();
    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM routing_history WHERE id = ${row!.id}`),
    ).rejects.toThrow(/append-only/);
  });

  it('rejects UPDATE on audit_log', async () => {
    const row = await prisma.auditLog.findFirst();
    expect(row).toBeTruthy();
    await expect(
      prisma.$executeRawUnsafe(`UPDATE audit_log SET action = 'TAMPERED' WHERE id = ${row!.id}`),
    ).rejects.toThrow(/append-only/);
  });

  it('rejects DELETE on audit_log', async () => {
    const row = await prisma.auditLog.findFirst();
    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM audit_log WHERE id = ${row!.id}`),
    ).rejects.toThrow(/append-only/);
  });
});

describe('Invariant 3 — normalization', () => {
  it('stores every lead phone in E.164', async () => {
    const phones = await prisma.leadPhone.findMany();
    expect(phones.length).toBeGreaterThan(0);
    for (const p of phones) {
      expect(p.phone).toMatch(/^\+[1-9]\d{6,14}$/);
    }
  });

  it('search_cache keys are normalized (lowercase, sorted) and unique', async () => {
    const rows = await prisma.searchCache.findMany();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.searchKey).toBe(r.searchKey.toLowerCase());
      const keys = r.searchKey.split('&').map((kv) => kv.split('=')[0]);
      expect([...keys].sort()).toEqual(keys);
    }
    // uniqueness is a DB constraint
    const dup = rows[0];
    await expect(
      prisma.searchCache.create({
        data: { searchKey: dup.searchKey, provider: 'X', response: {}, expiresAt: new Date() },
      }),
    ).rejects.toThrow();
  });
});

describe('Invariant 1 — static proof: only routing (+ creation) touches assignment', () => {
  const SRC = join(__dirname, '..', 'src');
  const ALLOWED_FILES = ['routing.service.ts', 'leads.service.ts'];

  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  }

  it('no file outside the sanctioned paths writes assignedTo/currentTier', () => {
    // A write is `assignedToId:`/`currentTier:` set to a VALUE (not `true` in a
    // select projection, and not inside where/groupBy reads).
    const writeRe = /(assignedToId|currentTier)\s*:\s*(?!true\b)[a-zA-Z'"[{]/;
    const offenders: string[] = [];
    for (const file of walk(SRC).filter((f) => f.endsWith('.ts'))) {
      const base = file.split(/[\\/]/).pop()!;
      const content = readFileSync(file, 'utf8');
      // Inspect only mutation calls: .create/.update/.updateMany/.upsert blocks.
      const mutations = content.split(/\.(?:create|update|updateMany|upsert)\(/g).slice(1);
      for (const block of mutations) {
        const head = block.slice(0, 600);
        // Ignore `where:` clause content — only `data:` writes count.
        const dataIdx = head.indexOf('data:');
        const dataPart = dataIdx >= 0 ? head.slice(dataIdx) : '';
        if (writeRe.test(dataPart) && !ALLOWED_FILES.includes(base)) {
          offenders.push(base);
        }
      }
      if (base === 'leads.service.ts') {
        // Sanctioned only at creation: lead.update blocks must never touch them.
        const updateBlocks = content.split('lead.update');
        for (let i = 1; i < updateBlocks.length; i++) {
          expect(updateBlocks[i].slice(0, 500)).not.toMatch(writeRe);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('Enrichment scope rules — no scraping, no biometrics (static proof)', () => {
  const ROOTS = [join(__dirname, '..', 'src'), join(__dirname, '..', '..', 'frontend', 'src')];
  const FORBIDDEN_DEPS = [
    'puppeteer', 'playwright', 'cheerio', 'jsdom', 'selenium', 'scrapy',
    'sharp', 'jimp', 'canvas', 'tesseract', 'face-api', '@tensorflow', 'opencv',
  ];

  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  }

  // Real provider adapters (BatchData, Trestle, Melissa) use fetch for their
  // own licensed APIs — that is not scraping. This guard is about scraping
  // libraries and fetching social content, both still forbidden.
  it('no scraping or image/face-processing libraries are installed', () => {
    for (const pkgPath of [
      join(__dirname, '..', 'package.json'),
      join(__dirname, '..', '..', 'frontend', 'package.json'),
    ]) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
      const bad = deps.filter((d) => FORBIDDEN_DEPS.some((f) => d.includes(f)));
      expect(bad).toEqual([]);
    }
  });

  it('socialUrls are never fetched — no HTTP call takes a social URL as its argument', () => {
    // Precise: legitimate provider adapters use fetch for their own APIs and may
    // return an (unpopulated) socialUrls field. What we forbid is fetching a
    // social URL — an HTTP call whose argument references social data, or a loop
    // over socialUrls that issues a request.
    const FETCH_SOCIAL = /\b(fetch|axios(?:\.\w+)?|https?\.get|XMLHttpRequest)\s*\([^)]*social/i;
    const LOOP_FETCH = /socialUrls\b[\s\S]{0,200}?\b(fetch|axios|https?\.get)\s*\(/i;
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(root).filter((f) => /\.(ts|tsx)$/.test(f))) {
        const content = readFileSync(file, 'utf8');
        if (!content.includes('social')) continue;
        if (FETCH_SOCIAL.test(content) || LOOP_FETCH.test(content)) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('Invariant 4 — closed leads stay closed', () => {
  it('the DB shows no closed lead with a PENDING queue row (only reopen may re-queue)', async () => {
    const bad = await prisma.lead.findMany({
      where: {
        status: { in: ['CLOSED_WON', 'CLOSED_LOST'] },
        queueEntries: { some: { status: 'PENDING' } },
      },
    });
    expect(bad).toEqual([]);
  });
});
