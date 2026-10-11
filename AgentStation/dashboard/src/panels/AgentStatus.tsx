import type { Agent } from '../types.ts';
import { Chip } from './ui.tsx';

export function AgentStatus({ agents, linkDown, onOpen }: { agents: Agent[]; linkDown: boolean; onOpen: (id: number) => void }) {
  return (
    <div className="agent-cards" aria-label="Agent status">
      {agents.map((a) => {
        const state = linkDown ? 'offline' : a.state;
        const detail = linkDown ? 'Dashboard disconnected from the station; live status unknown' : a.detail;
        return (
          <div key={a.role} className={`agent-card role-${a.role} state-${state}`}>
            <div className="agent-head">
              <span className="agent-name">{a.name}</span>
              <Chip status={state} />
            </div>
            <div className="agent-room">{a.room} · <span className="mono">{a.openclawAgentId}</span></div>
            <div className="agent-detail">
              {detail}
              {!linkDown && a.taskId && (
                <>
                  {' '}
                  <button className="linkish" onClick={() => onOpen(a.taskId!)}>open</button>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
