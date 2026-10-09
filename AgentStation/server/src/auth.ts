// Dashboard authentication. The operator logs in once with the admin token
// (from ~/.agentstation/secrets.env); the browser then holds only an
// HttpOnly session cookie and a per-session CSRF token. No provider or
// gateway credential ever reaches the browser.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { nowIso, type DB } from './db.ts';

const SESSION_HOURS = 12;
const COOKIE = 'station_session';
const sha = (s: string) => createHash('sha256').update(s).digest();

export class Auth {
  private readonly adminHash: Buffer;
  private readonly db: DB;
  private failures: number[] = [];

  constructor(db: DB, adminToken: string) {
    this.db = db;
    this.adminHash = sha(adminToken);
  }

  // Five failed attempts per minute, then 429 until the window passes.
  loginRateLimited(): boolean {
    const cutoff = Date.now() - 60_000;
    this.failures = this.failures.filter((t) => t > cutoff);
    return this.failures.length >= 5;
  }

  login(token: string): { cookie: string; csrf: string } | null {
    if (!timingSafeEqual(sha(token), this.adminHash)) {
      this.failures.push(Date.now());
      return null;
    }
    const id = randomBytes(32).toString('hex');
    const csrf = randomBytes(24).toString('hex');
    const expires = new Date(Date.now() + SESSION_HOURS * 3600_000).toISOString();
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso());
    this.db.prepare('INSERT INTO sessions (id_sha256, csrf, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha(id).toString('hex'), csrf, nowIso(), expires);
    return {
      cookie: `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}`,
      csrf,
    };
  }

  session(req: IncomingMessage): { csrf: string } | null {
    const id = parseCookies(req.headers.cookie ?? '')[COOKIE];
    if (!id || !/^[0-9a-f]{64}$/.test(id)) return null;
    const row = this.db.prepare('SELECT csrf, expires_at FROM sessions WHERE id_sha256 = ?').get(sha(id).toString('hex')) as { csrf: string; expires_at: string } | undefined;
    if (!row || row.expires_at < nowIso()) return null;
    return { csrf: row.csrf };
  }

  logout(req: IncomingMessage): string {
    const id = parseCookies(req.headers.cookie ?? '')[COOKIE];
    if (id) this.db.prepare('DELETE FROM sessions WHERE id_sha256 = ?').run(sha(id).toString('hex'));
    return `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
  }
}

export function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// Only loopback host names are accepted, which blocks DNS-rebinding attacks
// against the local port. Works through an SSH tunnel (the browser still
// talks to localhost).
export function hostAllowed(req: IncomingMessage, port: number): boolean {
  const host = (req.headers.host ?? '').toLowerCase();
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host);
}

export function originAllowed(req: IncomingMessage, port: number): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // same-origin fetches from older browsers, curl
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`].includes(origin.toLowerCase());
}
