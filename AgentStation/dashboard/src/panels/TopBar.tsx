import type { StationState } from '../types.ts';
import type { Link } from '../api.ts';
import { api } from '../api.ts';
import { fmtNum, Meter } from './ui.tsx';

export function TopBar({ state, link, onError, onLogout }: { state: StationState | null; link: Link; onError: (m: string) => void; onLogout: () => void }) {
  const gw = state?.gateway;
  const linkUp = link === 'connected';
  const backend = !linkUp ? 'down' : !gw?.connected ? 'down' : !gw.ready ? 'warn' : 'up';
  const queue = state?.queue;
  const usage = state?.usage;
  const queueLabel = !queue ? '–' : queue.paused ? 'Paused' : queue.block ? 'On hold' : queue.runningSteps ? `Working (${queue.runningSteps}/${queue.maxWorkers})` : 'Ready';

  async function togglePause() {
    try {
      await api.post('/api/queue', { paused: !queue?.paused });
    } catch (e) {
      onError((e as Error).message);
    }
  }

  return (
    <header className="topbar">
      <div className="brand">AGENT<span>STATION</span></div>
      <div className={`mode-badge mode-${state?.mode ?? 'real'}`}>{state?.mode === 'demo' ? 'DEMO MODE' : 'LIVE'}</div>
      <div className={`status-pill ${backend}`} role="status" aria-live="polite">
        <span className="dot" />
        {link === 'connecting' && !state ? 'Connecting…' : backend === 'down' ? 'Disconnected' : backend === 'warn' ? 'Gateway not ready' : 'Connected'}
      </div>
      <div className="topbar-queue">
        <span className="label">Queue</span> <strong className={queue?.paused || queue?.block ? 'warn-text' : ''}>{queueLabel}</strong>
        <button className="btn small" onClick={togglePause} disabled={!linkUp || !queue}>
          {queue?.paused ? 'Resume' : 'Pause'}
        </button>
      </div>
      {usage && (
        <div className="topbar-usage" title={usage.costNote}>
          <span className="label">Tokens today</span>
          <strong>{fmtNum(usage.tokens)}</strong>
          <span className="muted">/ {fmtNum(usage.limits.dailyTokenCap)}</span>
          <Meter value={usage.tokens} max={usage.limits.dailyTokenCap} label="Daily token use" />
        </div>
      )}
      {state && state.approvals.length > 0 && (
        <button className="btn small attention-btn" onClick={() => document.getElementById('approvals-title')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
          {state.approvals.length} approval{state.approvals.length > 1 ? 's' : ''} waiting
        </button>
      )}
      <button className="btn ghost small" onClick={onLogout}>Log out</button>
    </header>
  );
}
