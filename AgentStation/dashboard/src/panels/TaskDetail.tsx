import { useEffect, useState } from 'react';
import type { TaskDetail as Detail, SlackStatus } from '../types.ts';
import { api } from '../api.ts';
import { Markdown } from '../Markdown.tsx';
import { Chip, Panel, fmtNum, fmtTime } from './ui.tsx';

type Tab = 'report' | 'sources' | 'steps' | 'plan';

export function TaskDetail({ taskId, version, slack, onError, disabled }: { taskId: number | null; version: string; slack: SlackStatus; onError: (m: string) => void; disabled: boolean }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState<Tab>('report');
  const [sourceText, setSourceText] = useState<{ ref: string; content: string } | null>(null);

  useEffect(() => {
    if (taskId === null) return;
    let stale = false;
    api
      .get<Detail>(`/api/tasks/${taskId}`)
      .then((d) => !stale && setDetail(d))
      .catch((e) => !stale && onError((e as Error).message));
    return () => {
      stale = true;
    };
  }, [taskId, version, onError]);

  useEffect(() => {
    setSourceText(null);
    setCopied(false);
  }, [taskId]);

  if (taskId === null || !detail || detail.task.id !== taskId) {
    return (
      <Panel title="Output viewer" id="output">
        <p className="muted">Select a task to read its report, sources, and step history.</p>
      </Panel>
    );
  }
  const t = detail.task;
  const plan = detail.steps.filter((s) => s.stage === 'plan' && s.output).at(-1)?.output;
  const research = detail.steps.filter((s) => s.stage === 'research' && s.output).at(-1)?.output;
  const reviews = detail.steps.filter((s) => s.stage === 'review' && s.output);
  const text = detail.output ?? detail.draft;
  // A saved listing's paste-ready section, as plain text (headings become labels).
  const pasteReady = detail.request.kind === 'listing' && detail.output
    ? (/## Ready to paste\n\n[^\n]*\n\n([\s\S]*?)\n\n## Claim support/.exec(detail.output)?.[1] ?? '').replace(/^### (.*)$/gm, '$1:').trim()
    : '';
  // One Slack post per report: one that is waiting, sending, unconfirmed, or done blocks another.
  const slackPost = detail.actions.filter((a) => a.kind === 'slack_post' && a.status !== 'failed' && a.status !== 'rejected').at(-1);

  const prepareSlack = async () => {
    setPreparing(true);
    try {
      await api.post(`/api/tasks/${t.id}/slack`);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setPreparing(false);
    }
  };

  const openSource = async (id: number, ref: string) => {
    try {
      const s = await api.get<{ content: string }>(`/api/sources/${id}`);
      setSourceText({ ref, content: s.content });
    } catch (e) {
      onError((e as Error).message);
    }
  };

  return (
    <Panel
      title={`${t.label}: ${t.title}`}
      id="output"
      actions={<Chip status={t.status} />}
    >
      <div className="tabs" role="tablist">
        {(['report', 'sources', 'steps', 'plan'] as Tab[]).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {k === 'report' ? (detail.output ? 'Report' : 'Draft') : k === 'sources' ? `Sources (${detail.sources.length})` : k === 'steps' ? `Steps (${detail.steps.length})` : 'Plan & review'}
          </button>
        ))}
      </div>
      {t.error && <p className="error">{t.error}{t.errorDetail ? ` ${t.errorDetail}` : ''}</p>}

      {tab === 'report' && (
        <div className="report">
          {!text && <p className="muted">No draft yet. The report appears here once the Writer finishes.</p>}
          {text && !detail.output && <p className="warn-text small">Draft in staging/, not approved. Final reports are written to outputs/ only after your approval.</p>}
          {detail.output && (
            <div className="report-actions">
              <p className="muted small">Saved to <span className="mono">{t.outputPath}</span></p>
              {pasteReady && (
                <button className="btn tiny" onClick={() => navigator.clipboard.writeText(pasteReady).then(() => setCopied(true), () => onError('Copy failed. Select the text instead.'))}>
                  {copied ? 'Copied' : 'Copy listing text'}
                </button>
              )}
              {t.status === 'completed' &&
                (slackPost ? (
                  <span className="muted small">
                    Slack: {slackPost.status === 'done' ? 'posted' : slackPost.status === 'proposed' ? 'message waiting for your approval under Approvals' : slackPost.status.replace('_', ' ')}
                  </span>
                ) : (
                  <button
                    className="btn tiny"
                    disabled={disabled || preparing || !slack.configured}
                    title={slack.configured ? 'Writes the Slack message and holds it under Approvals. Nothing is sent until you approve it.' : (slack.problem ?? `Add SLACK_WEBHOOK_URL to ${slack.setupFile}`)}
                    onClick={prepareSlack}
                  >
                    Post to Slack…
                  </button>
                ))}
            </div>
          )}
          {text && <Markdown text={text} />}
        </div>
      )}

      {tab === 'sources' && (
        <div>
          {detail.sources.length === 0 && <p className="muted">No sources fetched yet.</p>}
          <table className="grid-table">
            <thead><tr><th>ID</th><th>Source</th><th>Retrieved</th><th>SHA-256</th><th /></tr></thead>
            <tbody>
              {detail.sources.map((s) => (
                <tr key={s.id}>
                  <td className="mono">{s.ref}</td>
                  <td>{s.type === 'operator' ? <span>{s.title}</span> : <a href={s.url} target="_blank" rel="noopener noreferrer nofollow">{s.title}</a>}<div className="muted small">{s.type} · {fmtNum(s.chars)} chars</div></td>
                  <td className="small">{fmtTime(s.retrievedAt)}</td>
                  <td className="mono small" title={s.sha256}>{s.sha256.slice(0, 12)}…</td>
                  <td><button className="btn tiny" onClick={() => openSource(s.id, s.ref)}>View text</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {research && (
            <p className="muted small">
              Researcher findings: {research.findings.filter((f: any) => f.verified).length} of {research.findings.length} quotes matched the stored source text.
            </p>
          )}
          {sourceText && (
            <div className="source-text">
              <div className="source-text-head"><strong>{sourceText.ref}</strong> <span className="muted">exact text the agents read (untrusted)</span> <button className="btn tiny" onClick={() => setSourceText(null)}>Close</button></div>
              <pre>{sourceText.content}</pre>
            </div>
          )}
        </div>
      )}

      {tab === 'steps' && (
        <ol className="steps">
          {detail.steps.map((s) => (
            <li key={s.id} className={`step step-${s.status}`}>
              <div className="step-head">
                <span className="mono">{s.stage}</span>
                <span>{s.agent}{s.executor === 'station' ? ' (station tool)' : ''}</span>
                <Chip status={s.status === 'completed' ? 'completed' : s.status} />
                <span className="muted small">attempt {s.attempt}/{s.maxAttempts}</span>
                <span className="muted small">{fmtTime(s.startedAt)}–{fmtTime(s.finishedAt)}</span>
              </div>
              {s.usage && (
                <div className="muted small">
                  tokens {fmtNum(s.usage.totalTokens)} (cache read {fmtNum(s.usage.cacheReadTokens)}, cache write {fmtNum(s.usage.cacheWriteTokens)}, output reported {fmtNum(s.usage.outputTokens)})
                  {s.openclawResponseId && <> · <span className="mono">{s.openclawResponseId}</span></>}
                </div>
              )}
              {s.memorySha256 && <div className="muted small">memory snapshot <span className="mono">{s.memorySha256.slice(0, 12)}</span></div>}
              {s.error && <div className={s.status === 'failed' ? 'error small' : 'warn-text small'}>{s.error}</div>}
            </li>
          ))}
        </ol>
      )}

      {tab === 'plan' && (
        <div className="plan">
          <h3>Request</h3>
          <p>{detail.request.description}</p>
          {detail.request.clarifications?.map((c, i) => <p key={i} className="small"><b>Q:</b> {c.question} <b>A:</b> {c.answer}</p>)}
          {plan && plan.status === 'ready' && (
            <>
              <h3>Commander's plan</h3>
              <p>{plan.objective}</p>
              <h4>Success criteria</h4>
              <ul>{plan.success_criteria.map((c: string, i: number) => <li key={i}>{c}</li>)}</ul>
              <h4>Source queries</h4>
              <ul>{plan.source_queries.map((q: any, i: number) => <li key={i}><span className="mono">{q.source}</span>: {q.query}</li>)}</ul>
              {plan.external_actions.length > 0 && (
                <>
                  <h4>External actions requested (held for approval)</h4>
                  <ul>{plan.external_actions.map((a: any, i: number) => <li key={i}>{a.kind} → <span className="mono">{a.target}</span></li>)}</ul>
                </>
              )}
            </>
          )}
          {reviews.map((s, i) => (
            <div key={s.id}>
              <h3>Review {i + 1}: {s.output.verdict}</h3>
              <ul>
                {s.output.mechanical?.map((m: string, j: number) => <li key={`m${j}`}>Station check: {m}</li>)}
                {s.output.issues.map((x: any, j: number) => <li key={j}><b>{x.severity}</b>: {x.detail}</li>)}
              </ul>
            </div>
          ))}
          {detail.actions.length > 0 && (
            <>
              <h3>External actions</h3>
              <ul>{detail.actions.map((a) => <li key={a.id}>#{a.id} {a.kind} → <span className="mono">{a.target}</span>: <b>{a.status}</b>{a.result?.error ? `: ${a.result.error}` : ''}</li>)}</ul>
            </>
          )}
        </div>
      )}
    </Panel>
  );
}
