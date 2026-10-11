// AgentStation server entry point.
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { loadConfig, loadSecrets } from './config.ts';
import { openDb } from './db.ts';
import { OpenClawGateway, type AgentRunner } from './openclaw.ts';
import { DemoRunner, demoFetch } from './demo.ts';
import { HealthMonitor } from './health.ts';
import { Engine } from './engine.ts';
import { Auth } from './auth.ts';
import { createServer } from './http.ts';
import { ensureMemoryDir } from './memory.ts';
import { logEvent } from './events.ts';
import { isStationProcess } from './lock.ts';

const cfg = loadConfig();
const secrets = loadSecrets(cfg);

function die(msg: string): never {
  console.error(`agentstation: ${msg}`);
  process.exit(1);
}

// One server per database: a second instance would double-run the queue.
const lockFile = path.join(cfg.dataDir, 'station.lock');
mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
if (existsSync(lockFile)) {
  const pid = Number(readFileSync(lockFile, 'utf8'));
  if (pid !== process.pid && isStationProcess(pid)) die(`another station (pid ${pid}) is already using ${cfg.dataDir}`);
}
writeFileSync(lockFile, String(process.pid), { mode: 0o600 });

let adminToken = secrets.adminToken;
let runner: AgentRunner;
if (cfg.mode === 'demo') {
  runner = new DemoRunner();
  adminToken ??= randomBytes(16).toString('hex');
} else {
  if (!adminToken) die('no STATION_ADMIN_TOKEN. Run scripts/init-secrets.sh first.');
  if (!secrets.gatewayToken) die(`no OPENCLAW_GATEWAY_TOKEN in the environment or ${cfg.openclaw.envFile}. See README "Configure".`);
  runner = new OpenClawGateway(cfg.openclaw.baseUrl, secrets.gatewayToken);
}

for (const d of [cfg.outputsDir, cfg.stagingDir]) mkdirSync(d, { recursive: true });
ensureMemoryDir(cfg);
const db = openDb(cfg.dbPath);
const health = new HealthMonitor(runner, db, cfg.openclaw.healthPollMs);
const engine = new Engine({ db, cfg, runner, health: health.current, fetchSources: cfg.mode === 'demo' ? demoFetch : undefined });
const auth = new Auth(db, adminToken!);
const server = createServer({ db, cfg, engine, health, auth });

await health.start();
engine.start();
logEvent(db, { type: 'station_started', message: `Station started in ${cfg.mode === 'demo' ? 'DEMO' : 'real'} mode (pid ${process.pid}).` });
server.listen(cfg.port, cfg.host, () => {
  console.log(`AgentStation ${cfg.mode === 'demo' ? '[DEMO MODE] ' : ''}listening on http://${cfg.host}:${cfg.port}`);
  if (cfg.mode === 'demo' && !secrets.adminToken) console.log(`Demo login token (this run only): ${adminToken}`);
});

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`received ${signal}; stopping`);
  logEvent(db, { type: 'station_stopping', message: `Station stopping (${signal}). Running steps are interrupted and will be requeued on restart.` });
  server.close();
  health.stop();
  await engine.stop();
  db.close();
  try {
    unlinkSync(lockFile);
  } catch {}
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
