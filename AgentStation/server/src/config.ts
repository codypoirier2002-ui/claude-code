// Loads non-secret config from config/station.json and secrets from
// owner-only env files. Secrets are kept in memory only and never logged,
// returned by the API, or written to the database.
import { readFileSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type AgentRole = 'commander' | 'researcher' | 'writer' | 'reviewer';
export const AGENT_ROLES: AgentRole[] = ['commander', 'researcher', 'writer', 'reviewer'];

export interface AgentConfig {
  openclawAgentId: string;
  room: string;
  timeoutSec: number;
}

export interface StationConfig {
  mode: 'real' | 'demo';
  host: string;
  port: number;
  timezone: string;
  rootDir: string;
  memoryDir: string;
  outputsDir: string;
  stagingDir: string;
  dataDir: string;
  dbPath: string;
  dashboardDist: string;
  openclaw: { baseUrl: string; envFile: string; healthPollMs: number };
  agents: Record<AgentRole, AgentConfig>;
  queue: { maxWorkers: number; maxAttempts: number; maxRevisions: number; pollMs: number };
  limits: { dailyTokenCap: number; perTaskTokenCap: number; dailyUsdLimit: number };
  sources: {
    approvedDomains: string[];
    maxSourcesPerTask: number;
    maxBytesPerSource: number;
    maxCharsPerSourceToAgent: number;
    fetchTimeoutSec: number;
    userAgent: string;
  };
  actions: { webhookAllowlist: string[] };
}

export interface Secrets {
  adminToken: string | null;
  gatewayToken: string | null;
}

const here = path.dirname(fileURLToPath(import.meta.url));
export const STATION_ROOT = path.resolve(here, '..', '..');

function expandHome(p: string): string {
  return p.startsWith('~/') ? path.join(homedir(), p.slice(2)) : p;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): StationConfig {
  const rootDir = env.STATION_ROOT ? path.resolve(env.STATION_ROOT) : STATION_ROOT;
  const raw = JSON.parse(readFileSync(path.join(rootDir, 'config', 'station.json'), 'utf8'));
  const mode = env.STATION_MODE === 'demo' ? 'demo' : 'real';
  // Demo mode gets its own data dir, outputs dir, and port so simulated data
  // can never mix with real operation.
  const dataDir = path.resolve(
    env.STATION_DATA_DIR ?? path.join(rootDir, mode === 'demo' ? 'data/demo' : 'data'),
  );
  const port = Number(env.STATION_PORT ?? (mode === 'demo' ? raw.demoPort : raw.port));
  if (raw.queue.maxWorkers > 2) {
    throw new Error('queue.maxWorkers is capped at 2 in this version');
  }
  return {
    mode,
    host: raw.host,
    port,
    timezone: raw.timezone,
    rootDir,
    memoryDir: path.join(rootDir, mode === 'demo' ? 'data/demo/memory' : 'memory'),
    outputsDir: path.join(rootDir, mode === 'demo' ? 'data/demo/outputs' : 'outputs'),
    stagingDir: path.join(rootDir, mode === 'demo' ? 'data/demo/staging' : 'staging'),
    dataDir,
    dbPath: path.join(dataDir, mode === 'demo' ? 'demo.sqlite' : 'station.sqlite'),
    dashboardDist: path.join(rootDir, 'dashboard', 'dist'),
    openclaw: { ...raw.openclaw, envFile: expandHome(raw.openclaw.envFile) },
    agents: raw.agents,
    queue: raw.queue,
    limits: raw.limits,
    sources: raw.sources,
    actions: raw.actions,
  };
}

// Parses KEY=VALUE lines. Refuses files that other users can read.
export function readEnvFile(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const mode = statSync(file).mode & 0o077;
  if (mode !== 0) {
    throw new Error(`${file} is readable by other users; run: chmod 600 ${file}`);
  }
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

export function loadSecrets(cfg: StationConfig, env: NodeJS.ProcessEnv = process.env): Secrets {
  const stationFile = expandHome(env.STATION_SECRETS_FILE ?? '~/.agentstation/secrets.env');
  const station = readEnvFile(stationFile);
  const gateway = env.OPENCLAW_GATEWAY_TOKEN ? {} : readEnvFile(cfg.openclaw.envFile);
  return {
    adminToken: env.STATION_ADMIN_TOKEN ?? station.STATION_ADMIN_TOKEN ?? null,
    gatewayToken: env.OPENCLAW_GATEWAY_TOKEN ?? gateway.OPENCLAW_GATEWAY_TOKEN ?? null,
  };
}
