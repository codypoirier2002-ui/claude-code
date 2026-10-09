// Dashboard HTTP API + static file server + live state stream (SSE).
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { setSetting, getSetting, type DB } from './db.ts';
import type { StationConfig } from './config.ts';
import type { Engine, NewTask, ApprovalDecision, TeamMode } from './engine.ts';
import type { HealthMonitor } from './health.ts';
import { Auth, hostAllowed, originAllowed } from './auth.ts';
import { buildState, taskDetail } from './state.ts';
import { bus, logEvent } from './events.ts';
import { resolveAction } from './actions.ts';
import { currentLimits, type Limits } from './usage.ts';
import { SOURCE_TYPES, type SourceType } from './sources.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
};

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS, ...headers });
  res.end(data);
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64 * 1024) throw new HttpError(413, 'Request body too large.');
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Body must be JSON.');
  }
}

const intIn = (v: unknown, min: number, max: number, name: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${name} must be a whole number from ${min} to ${max}.`);
  return n;
};

export function createServer(o: { db: DB; cfg: StationConfig; engine: Engine; health: HealthMonitor; auth: Auth }) {
  const { db, cfg, engine, health, auth } = o;
  const state = () => buildState(db, cfg, engine, health.current());

  async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
    const method = req.method ?? 'GET';
    const p = url.pathname;

    if (p === '/api/health' && method === 'GET') return send(res, 200, { ok: true, mode: cfg.mode });

    if (p === '/api/login' && method === 'POST') {
      if (auth.loginRateLimited()) throw new HttpError(429, 'Too many failed logins. Wait a minute.');
      const body = await readJson(req);
      const result = typeof body.token === 'string' ? auth.login(body.token) : null;
      if (!result) throw new HttpError(401, 'Wrong admin token.');
      return send(res, 200, { ok: true, csrf: result.csrf }, { 'set-cookie': result.cookie });
    }

    const session = auth.session(req);
    if (p === '/api/session' && method === 'GET') return send(res, 200, { authenticated: !!session, csrf: session?.csrf ?? null, mode: cfg.mode });
    if (!session) throw new HttpError(401, 'Log in first.');

    if (method !== 'GET') {
      if (req.headers['x-station-csrf'] !== session.csrf) throw new HttpError(403, 'Missing or wrong CSRF token. Reload the page.');
      if (!originAllowed(req, cfg.port)) throw new HttpError(403, 'Cross-origin request refused.');
    }

    if (p === '/api/logout' && method === 'POST') return send(res, 200, { ok: true }, { 'set-cookie': auth.logout(req) });
    if (p === '/api/state' && method === 'GET') return send(res, 200, state());

    if (p === '/api/stream' && method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', ...SECURITY_HEADERS });
      const push = () => res.write(`event: state\ndata: ${JSON.stringify(state())}\n\n`);
      push();
      let last = 0;
      let queued: NodeJS.Timeout | null = null;
      const onChange = () => {
        if (queued) return;
        const wait = Math.max(0, 250 - (Date.now() - last));
        queued = setTimeout(() => {
          queued = null;
          last = Date.now();
          push();
        }, wait);
      };
      bus.on('changed', onChange);
      // Heartbeat lets the browser detect a dead connection and show "Disconnected".
      const beat = setInterval(() => res.write(`event: ping\ndata: ${JSON.stringify({ t: Date.now(), gateway: health.current() })}\n\n`), 5000);
      req.on('close', () => {
        bus.off('changed', onChange);
        clearInterval(beat);
        if (queued) clearTimeout(queued);
      });
      return;
    }

    let m: RegExpExecArray | null;
    if (p === '/api/tasks' && method === 'POST') {
      const b = await readJson(req);
      const input: NewTask = {
        description: String(b.description ?? ''),
        project: b.project ? String(b.project).slice(0, 80) : null,
        urls: Array.isArray(b.urls) ? b.urls.map(String) : [],
        sourceTypes: Array.isArray(b.sourceTypes) ? b.sourceTypes.filter((s: string) => SOURCE_TYPES.includes(s as SourceType)) : [],
        dependsOn: Array.isArray(b.dependsOn) ? b.dependsOn.map(Number) : [],
        idempotencyKey: b.idempotencyKey ? String(b.idempotencyKey).slice(0, 100) : null,
      };
      const { task, created } = engine.createTask(input);
      return send(res, created ? 201 : 200, { task: { id: task.id }, created });
    }
    if ((m = /^\/api\/tasks\/(\d+)$/.exec(p)) && method === 'GET') {
      const d = taskDetail(db, cfg, Number(m[1]));
      if (!d) throw new HttpError(404, 'No such task.');
      return send(res, 200, d);
    }
    if ((m = /^\/api\/tasks\/(\d+)\/cancel$/.exec(p)) && method === 'POST') {
      engine.cancelTask(Number(m[1]));
      return send(res, 200, { ok: true });
    }
    if ((m = /^\/api\/tasks\/(\d+)\/retry$/.exec(p)) && method === 'POST') {
      engine.retryTask(Number(m[1]));
      return send(res, 200, { ok: true });
    }
    if ((m = /^\/api\/sources\/(\d+)$/.exec(p)) && method === 'GET') {
      const row = db.prepare('SELECT * FROM sources WHERE id=?').get(Number(m[1]));
      if (!row) throw new HttpError(404, 'No such source.');
      return send(res, 200, row);
    }
    if ((m = /^\/api\/approvals\/(\d+)$/.exec(p)) && method === 'POST') {
      const b = await readJson(req);
      if (!['approve', 'reject', 'revise'].includes(b.decision)) throw new HttpError(400, 'decision must be approve, reject, or revise.');
      const d: ApprovalDecision = {
        decision: b.decision,
        note: typeof b.note === 'string' ? b.note : undefined,
        answers: Array.isArray(b.answers) ? b.answers.map(String) : undefined,
        keepDecisions: Array.isArray(b.keepDecisions) ? b.keepDecisions.map(String) : undefined,
      };
      engine.decideApproval(Number(m[1]), d);
      return send(res, 200, { ok: true });
    }
    if ((m = /^\/api\/actions\/(\d+)\/resolve$/.exec(p)) && method === 'POST') {
      const b = await readJson(req);
      if (b.resolution !== 'mark_done' && b.resolution !== 'retry') throw new HttpError(400, 'resolution must be mark_done or retry.');
      resolveAction(db, Number(m[1]), b.resolution);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/queue' && method === 'POST') {
      const b = await readJson(req);
      if (typeof b.paused !== 'boolean') throw new HttpError(400, 'paused must be true or false.');
      engine.setPaused(b.paused);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/settings' && method === 'POST') {
      const b = await readJson(req);
      const changes: string[] = [];
      if (b.limits) {
        const cur = currentLimits(db, cfg);
        const next: Limits = {
          dailyTokenCap: b.limits.dailyTokenCap !== undefined ? intIn(b.limits.dailyTokenCap, 10_000, 100_000_000, 'Daily token cap') : cur.dailyTokenCap,
          perTaskTokenCap: b.limits.perTaskTokenCap !== undefined ? intIn(b.limits.perTaskTokenCap, 10_000, 100_000_000, 'Per-task token cap') : cur.perTaskTokenCap,
          dailyUsdLimit: b.limits.dailyUsdLimit !== undefined ? Number(b.limits.dailyUsdLimit) : cur.dailyUsdLimit,
        };
        if (!Number.isFinite(next.dailyUsdLimit) || next.dailyUsdLimit < 0 || next.dailyUsdLimit > 10_000) throw new HttpError(400, 'Daily dollar limit must be between 0 and 10000.');
        setSetting(db, 'limits', next);
        changes.push(`limits → ${next.dailyTokenCap.toLocaleString('en-US')} tokens/day, ${next.perTaskTokenCap.toLocaleString('en-US')} tokens/task, $${next.dailyUsdLimit}/day`);
      }
      if (b.approvedDomains) {
        if (!Array.isArray(b.approvedDomains) || b.approvedDomains.length > 30) throw new HttpError(400, 'approvedDomains must be a list of up to 30 host names.');
        const domains = b.approvedDomains.map((d: unknown) => String(d).trim().toLowerCase()).filter(Boolean);
        for (const d of domains) {
          if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d)) throw new HttpError(400, `"${d}" is not a plain host name (no wildcards, schemes, or paths).`);
        }
        setSetting(db, 'approved_domains', [...new Set(domains)]);
        changes.push(`approved domains → ${domains.join(', ') || '(none)'}`);
      }
      if (b.teamMode) {
        if (b.teamMode !== 'solo' && b.teamMode !== 'team') throw new HttpError(400, 'teamMode must be solo or team.');
        setSetting(db, 'team_mode', b.teamMode as TeamMode);
        changes.push(`team mode → ${b.teamMode}`);
      }
      if (changes.length) logEvent(db, { type: 'settings_changed', message: `Operator changed settings: ${changes.join('; ')}.` });
      return send(res, 200, { ok: true, teamMode: getSetting(db, 'team_mode', 'team') });
    }
    throw new HttpError(404, 'Unknown endpoint.');
  }

  function serveStatic(res: ServerResponse, url: URL) {
    const root = cfg.dashboardDist;
    let file = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
    if (!file.startsWith(root)) return send(res, 400, { error: 'Bad path.' });
    if (!existsSync(file) || statSync(file).isDirectory()) file = path.join(root, 'index.html');
    if (!existsSync(file)) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
      return res.end('Dashboard not built. Run: npm --prefix dashboard run build');
    }
    const ext = path.extname(file);
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=3600',
      ...SECURITY_HEADERS,
    });
    res.end(readFileSync(file));
  }

  return http.createServer(async (req, res) => {
    if (!hostAllowed(req, cfg.port)) {
      res.writeHead(421, { 'content-type': 'text/plain' });
      return res.end('Host not allowed. Open the dashboard at http://127.0.0.1:' + cfg.port);
    }
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${cfg.port}`);
    try {
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed.' });
      return serveStatic(res, url);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 400;
      if (!res.headersSent) send(res, status, { error: (err as Error).message });
      else res.end();
    }
  });
}
