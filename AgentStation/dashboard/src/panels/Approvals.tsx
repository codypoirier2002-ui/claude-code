import { useState } from 'react';
import type { Approval, StationState } from '../types.ts';
import { api } from '../api.ts';
import { Chip, Panel, fmtAgo } from './ui.tsx';

function allowlisted(target: string, allow: string[]) {
  try {
    const u = new URL(target);
    return allow.some((p) => {
      try {
        const q = new URL(p);
        return u.origin === q.origin && u.pathname.startsWith(q.pathname);
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function ReportApproval({ a, onOpen, onError, disabled }: { a: Approval; onOpen: (id: number) => void; onError: (m: string) => void; disabled: boolean }) {
  const p = a.payload;
  const [note, setNote] = useState('');
  const [keep, setKeep] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const decide = async (decision: 'approve' | 'reject' | 'revise') => {
    if (decision === 'reject' && !window.confirm(`Reject ${a.taskLabel}? The task ends and nothing is saved to outputs/.`)) return;
    setBusy(true);
    try {
      await api.post(`/api/approvals/${a.id}`, { decision, note: note || undefined, keepDecisions: keep });
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const verdictStatus = p.reviewVerdict === 'pass' ? 'completed' : p.reviewVerdict === 'revise' ? 'failed' : 'queued';
  return (
    <article className="approval">
      <header>
        <strong>{a.taskLabel}: report ready</strong>
        <Chip status={verdictStatus}>Review: {p.reviewVerdict}</Chip>
        <span className="muted">{fmtAgo(a.createdAt)}</span>
      </header>
      {p.summary && <p>{p.summary}</p>}
      {(p.mechanical?.length > 0 || p.issues?.length > 0) && (
        <ul className="issues">
          {p.mechanical?.map((m: string, i: number) => <li key={`m${i}`} className="sev-high">Station check: {m}</li>)}
          {p.issues?.map((x: any, i: number) => <li key={i} className={`sev-${x.severity}`}><b>{x.severity}</b> {x.detail}</li>)}
        </ul>
      )}
      <p className="muted small">
        Citations used: {p.checks?.citedRefs?.join(', ') || 'none'} · unknown IDs: {p.checks?.unknownRefs?.join(', ') || 'none'} · uncited paragraphs: {p.checks?.uncitedParagraphs ?? 0}
      </p>
      {p.proposedDecisions?.length > 0 && (
        <fieldset className="decisions">
          <legend>Remember in memory/decisions.md? (unchecked = not saved)</legend>
          {p.proposedDecisions.map((d: string, i: number) => (
            <label key={i}>
              <input type="checkbox" checked={keep.includes(d)} onChange={(e) => setKeep((k) => (e.target.checked ? [...k, d] : k.filter((x) => x !== d)))} />
              {d}
            </label>
          ))}
        </fieldset>
      )}
      <label className="sr-only" htmlFor={`note-${a.id}`}>Note or requested changes</label>
      <textarea id={`note-${a.id}`} rows={2} placeholder="Optional note. Required for “Request changes”." value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="btn-row">
        <button className="btn ghost" onClick={() => onOpen(a.taskId)}>Read draft</button>
        <button className="btn primary" disabled={busy || disabled} onClick={() => decide('approve')}>Approve &amp; save</button>
        <button className="btn" disabled={busy || disabled || !note.trim()} onClick={() => decide('revise')}>Request changes</button>
        <button className="btn danger" disabled={busy || disabled} onClick={() => decide('reject')}>Reject</button>
      </div>
    </article>
  );
}

function ActionApproval({ a, allow, onError, disabled }: { a: Approval; allow: string[]; onError: (m: string) => void; disabled: boolean }) {
  const p = a.payload;
  const [busy, setBusy] = useState(false);
  const ok = p.kind === 'webhook_post' && allowlisted(p.target, allow);
  const decide = async (decision: 'approve' | 'reject') => {
    if (decision === 'approve' && !window.confirm(`Allow ${a.taskLabel} to ${p.kind} → ${p.target}?\nThis sends data outside the station once the report is approved.`)) return;
    setBusy(true);
    try {
      await api.post(`/api/approvals/${a.id}`, { decision });
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="approval external">
      <header>
        <strong>{a.taskLabel}: external action</strong>
        <Chip status="awaiting_approval">Held</Chip>
      </header>
      <p className="warn-text">Nothing has been sent. This runs only if you approve it and the report is approved.</p>
      <dl className="kv">
        <dt>Action</dt><dd>{p.kind}</dd>
        <dt>Destination</dt><dd className="mono">{p.target}</dd>
        <dt>Reason</dt><dd>{p.reason || '–'}</dd>
      </dl>
      {!ok && <p className="error">{p.kind === 'webhook_post' ? 'This destination is not on actions.webhookAllowlist in config/station.json, so it will be refused even if approved.' : `No integration is installed for “${p.kind}”, so it cannot run even if approved.`}</p>}
      <div className="btn-row">
        <button className="btn" disabled={busy || disabled} onClick={() => decide('approve')}>Approve action</button>
        <button className="btn danger" disabled={busy || disabled} onClick={() => decide('reject')}>Reject</button>
      </div>
    </article>
  );
}

function Clarification({ a, onError, disabled }: { a: Approval; onError: (m: string) => void; disabled: boolean }) {
  const qs: string[] = a.payload.questions ?? [];
  const [answers, setAnswers] = useState<string[]>(qs.map(() => ''));
  const [busy, setBusy] = useState(false);
  const send = async (decision: 'approve' | 'reject') => {
    setBusy(true);
    try {
      await api.post(`/api/approvals/${a.id}`, { decision, answers });
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="approval">
      <header>
        <strong>{a.taskLabel}: Commander has questions</strong>
      </header>
      {qs.map((q, i) => (
        <label key={i} className="stack">
          <span>{q}</span>
          <input value={answers[i]} onChange={(e) => setAnswers((x) => x.map((v, j) => (j === i ? e.target.value : v)))} />
        </label>
      ))}
      <div className="btn-row">
        <button className="btn primary" disabled={busy || disabled || answers.some((x) => !x.trim())} onClick={() => send('approve')}>Send answers</button>
        <button className="btn danger" disabled={busy || disabled} onClick={() => send('reject')}>Cancel task</button>
      </div>
    </article>
  );
}

export function Approvals({ state, onOpen, onError, disabled }: { state: StationState; onOpen: (id: number) => void; onError: (m: string) => void; disabled: boolean }) {
  const list = state.approvals;
  return (
    <Panel title={`Approvals${list.length ? ` (${list.length})` : ''}`} id="approvals" className={list.length ? 'attention' : ''}>
      {list.length === 0 && <p className="muted">Nothing waiting for you.</p>}
      {list.map((a) =>
        a.kind === 'final_report' ? (
          <ReportApproval key={a.id} a={a} onOpen={onOpen} onError={onError} disabled={disabled} />
        ) : a.kind === 'external_action' ? (
          <ActionApproval key={a.id} a={a} allow={state.settings.webhookAllowlist} onError={onError} disabled={disabled} />
        ) : (
          <Clarification key={a.id} a={a} onError={onError} disabled={disabled} />
        ),
      )}
    </Panel>
  );
}
