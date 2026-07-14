import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';
import { LockdownService } from './lockdown.service';

/**
 * Blackout gate (spec §7.4): mounted on the raw Express instance in main.ts,
 * BEFORE Nest's body parser, auth, and routing — so it covers every path,
 * prefixed or not. When LOCKED → empty 503, no body, no identifying headers,
 * for EVERY session including the Admin's. Sole exception: the wake URL
 * (spec §7.5), whose slug comes from env and is never linked in-app.
 */
@Injectable()
export class LockdownGate {
  private readonly wakePath: string;
  private readonly redirectTo: string;

  constructor(
    private readonly lockdown: LockdownService,
    config: ConfigService,
  ) {
    const slug = config.get<string>('LOCKDOWN_WAKE_SLUG') || 'disabled';
    this.wakePath = `/__wake-${slug}`;
    this.redirectTo = config.get<string>('CORS_ORIGIN')?.split(',')[0] ?? '/';
  }

  handler() {
    return async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (req.path === this.wakePath) return await this.handleWake(req, res);
        if (await this.lockdown.isLocked()) {
          // Empty 503: browser shows a bare failure, nothing identifies the app.
          res.removeHeader('X-Powered-By');
          res.status(503).end();
          return;
        }
        next();
      } catch {
        // Fail closed: if state can't be determined, black out rather than leak.
        res.status(503).end();
      }
    };
  }

  private async handleWake(req: Request, res: Response) {
    if (req.method === 'GET') {
      res
        .status(200)
        .type('html')
        .send(
          `<!doctype html><html><head><meta name="robots" content="noindex"><title>&#8212;</title></head>` +
            `<body style="font-family:monospace;background:#111;color:#ccc;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">` +
            `<form method="POST" action="${this.wakePath}">` +
            `<input name="key" autocomplete="off" placeholder="key" style="background:#000;color:#ccc;border:1px solid #444;padding:8px;width:280px" autofocus /> ` +
            `<button type="submit" style="background:#222;color:#ccc;border:1px solid #444;padding:8px 16px">submit</button>` +
            `</form></body></html>`,
        );
      return;
    }
    if (req.method === 'POST') {
      // This gate runs before Nest's body parser, so read the body ourselves.
      const key = await this.readKey(req);
      const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
      const result = await this.lockdown.wake(key, ip);
      if (result.ok) {
        res.redirect(302, this.redirectTo); // → login (spec §7.6)
        return;
      }
      // Wrong key → generic error, no hints (spec §7.6)
      res
        .status(200)
        .type('html')
        .send(
          `<!doctype html><html><body style="font-family:monospace;background:#111;color:#ccc;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">` +
            `invalid&nbsp;<a href="${this.wakePath}" style="color:#888">retry</a></body></html>`,
        );
      return;
    }
    res.status(503).end();
  }

  private readKey(req: Request): Promise<string> {
    return new Promise((resolve) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
        if (raw.length > 4096) req.destroy(); // keys are tiny; drop anything bigger
      });
      req.on('end', () => {
        const contentType = req.headers['content-type'] ?? '';
        try {
          if (contentType.includes('application/json')) {
            resolve(String(JSON.parse(raw)?.key ?? ''));
            return;
          }
          resolve(String(new URLSearchParams(raw).get('key') ?? ''));
        } catch {
          resolve('');
        }
      });
      req.on('error', () => resolve(''));
    });
  }
}
