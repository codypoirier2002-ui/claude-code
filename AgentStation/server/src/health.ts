// Polls the OpenClaw gateway's /readyz and records connect/disconnect
// transitions in the activity log.
import type { AgentRunner, Health } from './openclaw.ts';
import type { DB } from './db.ts';
import { logEvent, changed } from './events.ts';

export class HealthMonitor {
  private state: Health = { connected: false, ready: false, checkedAt: new Date(0).toISOString(), detail: 'not checked yet' };
  private timer: NodeJS.Timeout | null = null;
  private readonly runner: AgentRunner;
  private readonly db: DB;
  private readonly intervalMs: number;

  constructor(runner: AgentRunner, db: DB, intervalMs: number) {
    this.runner = runner;
    this.db = db;
    this.intervalMs = intervalMs;
  }

  current = (): Health => this.state;

  async check(): Promise<Health> {
    const next = await this.runner.health();
    const was = this.state;
    this.state = next;
    if (was.ready !== next.ready || was.connected !== next.connected) {
      if (next.ready) logEvent(this.db, { type: 'gateway_connected', message: 'OpenClaw gateway is connected and ready.' });
      else logEvent(this.db, { type: 'gateway_disconnected', message: `OpenClaw gateway ${next.connected ? 'is not ready' : 'is unreachable'}: ${next.detail}` });
    }
    changed();
    return next;
  }

  async start(): Promise<void> {
    await this.check();
    this.timer = setInterval(() => void this.check(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
