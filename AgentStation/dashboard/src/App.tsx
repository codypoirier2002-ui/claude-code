import { useCallback, useEffect, useState } from 'react';
import { api, useStationStream } from './api.ts';
import { StationScene } from './scene/StationScene.tsx';
import { Login } from './panels/Login.tsx';
import { TopBar } from './panels/TopBar.tsx';
import { AgentStatus } from './panels/AgentStatus.tsx';
import { Approvals } from './panels/Approvals.tsx';
import { TaskForm } from './panels/TaskForm.tsx';
import { TaskQueue } from './panels/TaskQueue.tsx';
import { TaskDetail } from './panels/TaskDetail.tsx';
import { Activity } from './panels/Activity.tsx';
import { Controls } from './panels/Controls.tsx';

interface SessionInfo {
  checked: boolean;
  authed: boolean;
  mode: 'real' | 'demo';
  unreachable?: boolean;
}

export function App() {
  const [session, setSession] = useState<SessionInfo>({ checked: false, authed: false, mode: 'real' });
  const [selected, setSelected] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const { state, link } = useStationStream(session.authed);

  const checkSession = useCallback(() => {
    api
      .session()
      .then((s) => setSession({ checked: true, authed: s.authenticated, mode: s.mode }))
      .catch(() => setSession((x) => ({ ...x, checked: true, unreachable: true })));
  }, []);
  useEffect(checkSession, [checkSession]);

  // While the live link is down, keep checking whether the server is back
  // and whether the session is still valid.
  useEffect(() => {
    if (!session.authed || link !== 'disconnected') return;
    const t = setInterval(checkSession, 5000);
    return () => clearInterval(t);
  }, [session.authed, link, checkSession]);

  const onError = useCallback((m: string) => {
    setToast(m);
    window.setTimeout(() => setToast((cur) => (cur === m ? null : cur)), 6000);
  }, []);

  if (!session.checked) return <div className="splash">Connecting to the station…</div>;
  if (!session.authed) {
    if (session.unreachable) {
      return (
        <div className="splash">
          <div className="panel">
            <h1 className="disconnected-title">Disconnected</h1>
            <p>The station server is not answering. Start it, then retry.</p>
            <button className="btn" onClick={checkSession}>Retry</button>
          </div>
        </div>
      );
    }
    return <Login mode={session.mode} onDone={checkSession} />;
  }

  const linkDown = link !== 'connected';
  const gatewayDown = !!state && !state.gateway.connected;
  const offline = linkDown || gatewayDown;
  const selectedTask = state?.tasks.find((t) => t.id === selected);
  const version = `${selectedTask?.updatedAt ?? ''}|${state?.approvals.length ?? 0}|${state?.events[0]?.id ?? 0}`;

  return (
    <div className={`app ${state?.mode === 'demo' ? 'is-demo' : ''}`}>
      {state?.mode === 'demo' && (
        <div className="demo-banner" role="note">DEMO MODE: simulated agents, sources, and reports. Nothing shown here is real work or real usage.</div>
      )}
      <TopBar state={state} link={link} onError={onError} onLogout={() => api.logout().finally(checkSession)} />
      {linkDown && state && (
        <div className="disconnected-banner" role="alert">
          <strong>Disconnected</strong> from the station server. Showing the last known tasks; agents are not shown as working. Reconnecting…
        </div>
      )}
      {!linkDown && gatewayDown && (
        <div className="disconnected-banner" role="alert">
          <strong>Disconnected</strong>: the OpenClaw gateway is unreachable ({state!.gateway.detail}). Agents are offline; queued work waits.
        </div>
      )}
      {!linkDown && state && !gatewayDown && state.queue.block && !state.queue.paused && (
        <div className="hold-banner" role="status">{state.queue.block}</div>
      )}
      {toast && <div className="toast" role="alert" onClick={() => setToast(null)}>{toast}</div>}

      {!state ? (
        <div className="splash">Loading station state…</div>
      ) : (
        <main className="layout">
          <div className="col-main">
            <section className="panel scene-panel" aria-label="Station view">
              <StationScene agents={state.agents} offline={offline} />
            </section>
            <AgentStatus agents={state.agents} linkDown={linkDown} onOpen={setSelected} />
            <TaskDetail taskId={selected} version={version} onError={onError} />
          </div>
          <div className="col-side">
            <Approvals state={state} onOpen={setSelected} onError={onError} disabled={linkDown} />
            <TaskForm tasks={state.tasks} onCreated={setSelected} onError={onError} disabled={linkDown} />
            <TaskQueue tasks={state.tasks} selected={selected} onSelect={setSelected} onError={onError} disabled={linkDown} />
            <Controls state={state} onError={onError} disabled={linkDown} />
            <Activity events={state.events} selected={selected} />
          </div>
        </main>
      )}
    </div>
  );
}
