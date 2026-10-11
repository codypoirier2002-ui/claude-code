// Slack integration: posts a short summary of an approved report to one Slack
// channel through an incoming webhook
// (https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks).
//
// The webhook URL is a secret: anyone who has it can post to the channel. It
// lives in the station secrets file (owner-only, mode 600) and is read each
// time it is needed, so adding or changing it needs no restart. It is never
// logged, stored in the database, or sent to the browser; the dashboard sees
// only whether one is set and its last four characters.
//
// Posting goes through the external-action gate in actions.ts. The exact text
// is fixed when the post is prepared, shown to the operator, and sent only
// after they approve it. This module builds that text and reads the webhook.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { readEnvFile, type StationConfig } from './config.ts';
import { taskLabel, type DB, type TaskRow } from './db.ts';

export interface SlackStatus {
  configured: boolean;
  hint: string | null;
  problem: string | null;
  setupFile: string;
}

// Slack's documented incoming-webhook form: /services/<workspace>/<integration>/<secret>.
const WEBHOOK_URL = /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]+$/;

export function slackWebhook(cfg: StationConfig): { url: string | null; status: SlackStatus } {
  const status = (s: Omit<SlackStatus, 'setupFile'>) => ({ ...s, setupFile: cfg.secretsFile });
  // Demo data must never reach a real channel, so Demo Mode ignores the file.
  if (cfg.mode === 'demo') return { url: null, status: status({ configured: false, hint: null, problem: 'Demo Mode never posts to Slack.' }) };
  let url: string | undefined;
  try {
    url = readEnvFile(cfg.secretsFile).SLACK_WEBHOOK_URL;
  } catch (err) {
    return { url: null, status: status({ configured: false, hint: null, problem: (err as Error).message }) };
  }
  if (!url) return { url: null, status: status({ configured: false, hint: null, problem: null }) };
  if (!WEBHOOK_URL.test(url)) {
    return { url: null, status: status({ configured: false, hint: null, problem: `SLACK_WEBHOOK_URL in ${cfg.secretsFile} is not a Slack incoming webhook URL (https://hooks.slack.com/services/…).` }) };
  }
  return { url, status: status({ configured: true, hint: `…${url.slice(-4)}`, problem: null }) };
}

// Binds an approval to the webhook that was set when the operator approved.
export const webhookFingerprint = (url: string) => createHash('sha256').update(`agentstation-slack:${url}`).digest('hex').slice(0, 16);

// Slack's escaping rule: replace &, <, and > and nothing else. That stops
// untrusted text from forming mentions (<!channel>, <@U…>) or links (<url|text>).
// A word joiner after an "@" that starts a word also stops plain "@here" or
// "@name" from notifying anyone. An "@" after "/", ".", ":" or a letter (in a
// URL such as medium.com/@author, or an email address) is left alone so links
// still work.
export function slackEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/(^|[^\w/.:@])@(?=\w)/g, '$1@\u2060');
}

// Cuts escaped text to at most max characters without leaving half an entity
// (&amp;) or half a surrogate pair at the end.
function cutEscaped(s: string, max: number): string {
  let out = s.slice(0, max).replace(/&[a-z]*$/, '');
  if (/[\ud800-\udbff]$/.test(out)) out = out.slice(0, -1);
  return out;
}

// The report's first section (after the title), in Slack's mrkdwn.
export function reportExcerpt(report: string, maxChars: number): string {
  const body = report.replace(/^---\n[\s\S]*?\n---\n/, '').split('\n');
  const start = body.findIndex((l) => /^#\s/.test(l));
  const lines: string[] = [];
  let headings = 0;
  for (const line of body.slice(start + 1)) {
    if (/^##\s/.test(line) && ++headings > 1) break;
    if (/^##\s+Sources\s*$/i.test(line)) break;
    lines.push(line);
  }
  const mrkdwn = lines
    .map((l) => slackEscape(l))
    .map((l) => l.replace(/^#{2,6}\s+(.*)$/, '*$1*').replace(/\*\*(.+?)\*\*/g, '*$1*').replace(/^(\s*)[-*]\s+/, '$1• ').replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (mrkdwn.length <= maxChars) return mrkdwn;
  const cut = cutEscaped(mrkdwn, maxChars - 2);
  const nl = cut.lastIndexOf('\n');
  return `${(nl > maxChars / 2 ? cut.slice(0, nl) : cut).trimEnd()}\n…`;
}

export const SLACK_MAX_CHARS = 3500;
const MIN_EXCERPT = 600;

export function slackMessage(o: {
  taskLabel: string;
  title: string;
  report: string;
  sources: { ref: string; title: string; url: string }[];
  reviewVerdict: string;
  approvedAt: string;
  outputPath: string;
  kind?: 'report' | 'listing';
}): string {
  const what = o.kind === 'listing' ? 'Approved listing copy (not published anywhere)' : 'Approved research report';
  const head = `*${slackEscape(o.taskLabel)} · ${cutEscaped(slackEscape(o.title), 200)}*\n${what} from AgentStation (review: ${cutEscaped(slackEscape(o.reviewVerdict), 40)}, ${o.sources.length} source${o.sources.length === 1 ? '' : 's'}).`;
  const foot = `Full report on the station: ${cutEscaped(slackEscape(o.outputPath), 300)} (approved ${o.approvedAt.slice(0, 16).replace('T', ' ')} UTC).`;
  // A URL is never shortened (that would break it); one too long to show is
  // left out, and whole source lines are dropped until the summary keeps at
  // least MIN_EXCERPT characters. The footer always fits.
  const lines = o.sources.map((s) => {
    const url = slackEscape(s.url);
    return `• ${cutEscaped(slackEscape(s.ref), 20)}: ${cutEscaped(slackEscape(s.title), 120)}${url.length <= 300 ? ` (${url})` : ' (address too long to show; see the report)'}`;
  });
  const sourcesBlock = (n: number) => `*Sources*\n${lines.slice(0, n).join('\n') || '(none)'}${n < lines.length ? `\n…and ${lines.length - n} more in the report.` : ''}`;
  const fixedLength = (n: number) => [head, '', '', '', sourcesBlock(n), '', foot].join('\n').length;
  let shown = lines.length;
  while (shown > 0 && fixedLength(shown) > SLACK_MAX_CHARS - MIN_EXCERPT) shown--;
  const excerpt = reportExcerpt(o.report, SLACK_MAX_CHARS - fixedLength(shown));
  return [head, '', excerpt, '', sourcesBlock(shown), '', foot].join('\n');
}

// The message for a completed task, built from what the operator approved:
// the saved report, its stored sources, and the final-report approval.
export function slackMessageForTask(db: DB, cfg: StationConfig, t: TaskRow): string {
  if (t.status !== 'completed' || !t.output_path) throw new Error(`${taskLabel(t.id)} has no approved report to post.`);
  const report = readFileSync(path.join(cfg.rootDir, t.output_path), 'utf8');
  const approval = db.prepare(`SELECT payload_json, decided_at FROM approvals WHERE task_id=? AND kind='final_report' AND status='approved' ORDER BY id DESC LIMIT 1`).get(t.id) as
    | { payload_json: string; decided_at: string }
    | undefined;
  if (!approval) throw new Error(`${taskLabel(t.id)} has no approved report to post.`);
  const sources = db.prepare(`SELECT ref, title, url FROM sources WHERE task_id=? ORDER BY id`).all(t.id) as { ref: string; title: string; url: string }[];
  return slackMessage({
    taskLabel: taskLabel(t.id),
    title: t.title,
    report,
    sources,
    reviewVerdict: JSON.parse(approval.payload_json).reviewVerdict ?? 'unknown',
    approvedAt: approval.decided_at,
    outputPath: t.output_path,
    kind: JSON.parse(t.request_json).kind === 'listing' ? 'listing' : 'report',
  });
}
