import { useEffect, useState } from 'react';
import type { StationState } from '../types.ts';
import { api } from '../api.ts';
import { Panel, Meter, fmtNum } from './ui.tsx';

export function Controls({ state, onError, disabled }: { state: StationState; onError: (m: string) => void; disabled: boolean }) {
  const u = state.usage;
  const [daily, setDaily] = useState(String(u.limits.dailyTokenCap));
  const [perTask, setPerTask] = useState(String(u.limits.perTaskTokenCap));
  const [usd, setUsd] = useState(String(u.limits.dailyUsdLimit));
  const [domains, setDomains] = useState(state.settings.approvedDomains.join('\n'));
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    setDaily(String(u.limits.dailyTokenCap));
    setPerTask(String(u.limits.perTaskTokenCap));
    setUsd(String(u.limits.dailyUsdLimit));
  }, [u.limits.dailyTokenCap, u.limits.perTaskTokenCap, u.limits.dailyUsdLimit]);

  const save = async (body: unknown, what: string) => {
    try {
      await api.post('/api/settings', body);
      setSaved(`${what} saved.`);
      setTimeout(() => setSaved(null), 3000);
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const needsReview = state.actions.filter((a) => a.status === 'needs_review');

  return (
    <Panel title="Spending, limits & safety" id="controls">
      <div className="usage-block">
        <div className="usage-line">
          <span>Tokens today ({u.day})</span>
          <strong>{fmtNum(u.tokens)} / {fmtNum(u.limits.dailyTokenCap)}</strong>
        </div>
        <Meter value={u.tokens} max={u.limits.dailyTokenCap} label="Tokens used today" />
        {u.blocked && <p className="error" role="alert">{u.blockReason} New agent work is on hold until tomorrow or until you raise the cap.</p>}
        <dl className="kv small">
          <dt>Agent calls</dt><dd>{u.calls}</dd>
          <dt>Cache reads</dt><dd>{fmtNum(u.cacheReadTokens)}</dd>
          <dt>Cache writes</dt><dd>{fmtNum(u.cacheWriteTokens)}</dd>
          <dt>Output (reported)</dt><dd>{fmtNum(u.outputTokens)} tokens for {fmtNum(u.outputChars)} characters of agent output</dd>
          <dt>Cost</dt><dd>{u.costAvailable && u.costUsd !== null ? `$${u.costUsd.toFixed(2)}` : 'Unavailable'}</dd>
        </dl>
        <p className="muted small">{u.costNote}</p>
        <p className="muted small">{u.outputTokensNote}</p>
        {u.callsWithoutUsage > 0 && <p className="warn-text small">{u.callsWithoutUsage} call(s) today reported no usage and are not counted.</p>}
      </div>

      <form
        className="limits"
        onSubmit={(e) => {
          e.preventDefault();
          void save({ limits: { dailyTokenCap: Number(daily), perTaskTokenCap: Number(perTask), dailyUsdLimit: Number(usd) } }, 'Limits');
        }}
      >
        <label className="stack"><span>Daily token cap</span><input inputMode="numeric" value={daily} onChange={(e) => setDaily(e.target.value)} /></label>
        <label className="stack"><span>Per-task token cap</span><input inputMode="numeric" value={perTask} onChange={(e) => setPerTask(e.target.value)} /></label>
        <label className="stack">
          <span>Daily $ limit {u.costAvailable ? '' : '(not enforceable: no cost data)'}</span>
          <input inputMode="decimal" value={usd} onChange={(e) => setUsd(e.target.value)} />
        </label>
        <button className="btn" disabled={disabled}>Save limits</button>
      </form>

      <div className="settings-row">
        <span>Team mode</span>
        <div className="seg" role="group" aria-label="Team mode">
          <button className={state.queue.teamMode === 'solo' ? 'on' : ''} disabled={disabled} onClick={() => save({ teamMode: 'solo' }, 'Team mode')}>Commander only</button>
          <button className={state.queue.teamMode === 'team' ? 'on' : ''} disabled={disabled} onClick={() => save({ teamMode: 'team' }, 'Team mode')}>Full team</button>
        </div>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save({ approvedDomains: domains.split('\n').map((d) => d.trim()).filter(Boolean) }, 'Approved domains');
        }}
      >
        <label className="stack">
          <span>Approved source domains (exact host names, one per line)</span>
          <textarea rows={4} value={domains} onChange={(e) => setDomains(e.target.value)} />
        </label>
        <button className="btn" disabled={disabled}>Save domains</button>
      </form>

      <div className="small">
        <span className="muted">External action destinations (edit config/station.json): </span>
        {state.settings.webhookAllowlist.length ? state.settings.webhookAllowlist.map((w) => <code key={w}>{w}</code>) : <b>none, so no external action can run</b>}
      </div>

      {needsReview.length > 0 && (
        <div className="needs-review">
          <h3>Actions to check</h3>
          {needsReview.map((a) => (
            <div key={a.id} className="approval external">
              <p>#{a.id} {a.kind} → <span className="mono">{a.target}</span> ({a.taskLabel}) was in progress when the station stopped. Check the destination before deciding.</p>
              <div className="btn-row">
                <button className="btn" disabled={disabled} onClick={() => api.post(`/api/actions/${a.id}/resolve`, { resolution: 'mark_done' }).catch((e) => onError(e.message))}>It was sent: mark done</button>
                <button className="btn danger" disabled={disabled} onClick={() => window.confirm('Send it again?') && api.post(`/api/actions/${a.id}/resolve`, { resolution: 'retry' }).catch((e) => onError(e.message))}>Not sent: retry</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {saved && <p className="ok-text small" role="status">{saved}</p>}
    </Panel>
  );
}
