import type { ReactNode } from 'react';

export const fmtNum = (n: number) => n.toLocaleString('en-US');

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '–';
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export function fmtAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '–';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

const STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  running: 'Running',
  awaiting_approval: 'Awaiting approval',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  offline: 'Offline',
  idle: 'Idle',
  standby: 'Standby',
  complete: 'Complete',
};

export function Chip({ status, children }: { status: string; children?: ReactNode }) {
  return <span className={`chip chip-${status}`}>{children ?? STATUS_LABEL[status] ?? status}</span>;
}

export function Panel({ title, id, actions, children, className }: { title: string; id?: string; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`panel ${className ?? ''}`} aria-labelledby={id ? `${id}-title` : undefined}>
      <header className="panel-head">
        <h2 id={id ? `${id}-title` : undefined}>{title}</h2>
        {actions && <div className="panel-actions">{actions}</div>}
      </header>
      <div className="panel-body">{children}</div>
    </section>
  );
}

export function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-label={label}>
      <div className={`meter-fill ${pct >= 100 ? 'full' : pct >= 80 ? 'warn' : ''}`} style={{ width: `${pct}%` }} />
    </div>
  );
}
