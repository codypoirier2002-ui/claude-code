import { useState, type FormEvent } from 'react';
import { api } from '../api.ts';

export function Login({ mode, onDone }: { mode: 'real' | 'demo'; onDone: () => void }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(token.trim());
      setToken('');
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="panel login" onSubmit={submit}>
        <h1 className="brand">AGENT<span>STATION</span></h1>
        {mode === 'demo' && <p className="demo-note">DEMO MODE: simulated agents and data.</p>}
        <label htmlFor="token">Admin token</label>
        <input id="token" type="password" autoComplete="current-password" value={token} onChange={(e) => setToken(e.target.value)} autoFocus />
        <p className="hint">
          {mode === 'demo' ? (
            <>The demo server prints a one-time token in its console when it starts.</>
          ) : (
            <>
              On the station host run <code>grep STATION_ADMIN_TOKEN ~/.agentstation/secrets.env</code>. The token is checked by the
              server and never stored in the browser; you get a 12-hour session cookie instead.
            </>
          )}
        </p>
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" className="btn primary" disabled={busy || !token.trim()}>
          {busy ? 'Checking…' : 'Log in'}
        </button>
      </form>
    </div>
  );
}
