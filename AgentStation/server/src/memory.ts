// The memory protocol. Reads happen at task start (and per stage, by role);
// writes happen only when a task finishes. See memory/README.md.
import { readFileSync, existsSync, appendFileSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { StationConfig, AgentRole } from './config.ts';

export interface MemorySnapshot {
  goals: string;
  rules: string;
  decisions: string;
  project: string | null;
  projectSlug: string | null;
  sha256: string;
}

const LIMITS = { goals: 4000, rules: 4000, decisions: 6000, project: 6000 };
const DECISIONS_TO_READ = 15;

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

function stripFrontmatter(text: string): string {
  return text.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + '\n[... cut off at ' + max + ' characters]';
}

function readIf(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

// Newest N "- " entries (with their indented continuation lines).
export function newestDecisions(text: string, n: number): string {
  const body = stripFrontmatter(text);
  const entries: string[] = [];
  for (const line of body.split('\n')) {
    if (line.startsWith('- ')) entries.push(line);
    else if (/^\s+\S/.test(line) && entries.length) entries[entries.length - 1] += '\n' + line;
  }
  return entries.slice(-n).join('\n');
}

// Demo mode keeps its own memory copy so simulated runs never touch the real vault.
export function ensureMemoryDir(cfg: StationConfig): void {
  mkdirSync(path.join(cfg.memoryDir, 'projects'), { recursive: true });
  mkdirSync(path.join(cfg.memoryDir, 'daily'), { recursive: true });
  if (cfg.mode === 'demo') {
    for (const f of ['goals.md', 'rules.md', 'decisions.md']) {
      const dest = path.join(cfg.memoryDir, f);
      if (!existsSync(dest)) copyFileSync(path.join(cfg.rootDir, 'memory', f), dest);
    }
  }
}

export function loadMemory(cfg: StationConfig, project: string | null): MemorySnapshot {
  const dir = cfg.memoryDir;
  const goals = clip(stripFrontmatter(readIf(path.join(dir, 'goals.md'))), LIMITS.goals);
  const rules = clip(stripFrontmatter(readIf(path.join(dir, 'rules.md'))), LIMITS.rules);
  const decisions = clip(newestDecisions(readIf(path.join(dir, 'decisions.md')), DECISIONS_TO_READ), LIMITS.decisions);
  const projectSlug = project ? slugify(project) : null;
  const projectText = projectSlug ? readIf(path.join(dir, 'projects', `${projectSlug}.md`)) : '';
  const projectNote = projectSlug ? clip(stripFrontmatter(projectText), LIMITS.project) || '(no notes yet for this project)' : null;
  const sha256 = createHash('sha256').update(JSON.stringify([goals, rules, decisions, projectNote])).digest('hex');
  return { goals, rules, decisions, project: projectNote, projectSlug, sha256 };
}

// Which memory each role sees. This is the "read relevant memory at task
// start" contract; it is deliberately explicit rather than left to a prompt.
export function memoryBlockFor(role: AgentRole, m: MemorySnapshot): string {
  const parts: string[] = [];
  const add = (title: string, body: string | null) => {
    if (body) parts.push(`### ${title}\n${body}`);
  };
  if (role === 'commander') {
    add('Goals (memory/goals.md)', m.goals);
    add('Rules (memory/rules.md)', m.rules);
    add('Recent decisions (memory/decisions.md)', m.decisions);
    add(`Project note (memory/projects/${m.projectSlug}.md)`, m.project);
  } else if (role === 'researcher') {
    add('Rules (memory/rules.md)', m.rules);
  } else if (role === 'writer') {
    add('Goals (memory/goals.md)', m.goals);
    add('Rules (memory/rules.md)', m.rules);
    add(`Project note (memory/projects/${m.projectSlug}.md)`, m.project);
  } else {
    add('Goals (memory/goals.md)', m.goals);
    add('Rules (memory/rules.md)', m.rules);
  }
  return `## Station memory (written by the operator; trusted)\n\n${parts.join('\n\n')}`;
}

function zonedParts(cfg: StationConfig, d = new Date()) {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: cfg.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: cfg.timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  return { date, time };
}

export function stationDay(cfg: StationConfig, d = new Date()): string {
  return zonedParts(cfg, d).date;
}

// Agent-produced text gets flattened before it lands in memory so it cannot
// add headings, front matter, or fake entries.
export function oneLine(text: string, max: number): string {
  return text.replace(/\*\*|__/g, '').replace(/\s+/g, ' ').replace(/^[#>\-*\s]+/, '').trim().slice(0, max);
}

function appendWithHeader(file: string, header: string, text: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  if (!existsSync(file)) writeFileSync(file, header);
  appendFileSync(file, text);
}

export interface CompletionRecord {
  taskLabel: string;
  title: string;
  project: string | null;
  outputRelPath: string;
  sourceCount: number;
  tokens: number;
  summary: string;
  decisions: string[];
}

export function recordCompletion(cfg: StationConfig, r: CompletionRecord): void {
  const { date, time } = zonedParts(cfg);
  const dailyFile = path.join(cfg.memoryDir, 'daily', `${date}.md`);
  const outLink = path.relative(path.dirname(dailyFile), path.join(cfg.rootDir, r.outputRelPath));
  appendWithHeader(
    dailyFile,
    `# ${date}\n\n`,
    `- ${time} ${r.taskLabel} **${oneLine(r.title, 120)}**: completed, approved. ` +
      `Output: [${path.basename(r.outputRelPath)}](${outLink}) · ${r.sourceCount} sources · ${r.tokens} tokens. ` +
      `${oneLine(r.summary, 600)}\n`,
  );
  if (r.project) {
    const slug = slugify(r.project);
    const projFile = path.join(cfg.memoryDir, 'projects', `${slug}.md`);
    const link = path.relative(path.dirname(projFile), path.join(cfg.rootDir, r.outputRelPath));
    appendWithHeader(
      projFile,
      `# ${oneLine(r.project, 80)}\n\n`,
      `\n## ${date} — ${oneLine(r.title, 120)} (${r.taskLabel})\n\n${oneLine(r.summary, 800)}\n\nReport: [${path.basename(r.outputRelPath)}](${link})\n`,
    );
  }
  const kept = r.decisions.map((d) => oneLine(d, 300)).filter(Boolean).slice(0, 5);
  if (kept.length) {
    appendFileSync(
      path.join(cfg.memoryDir, 'decisions.md'),
      kept.map((d) => `- ${date} — ${d} (${r.taskLabel}, approved by operator)\n`).join(''),
    );
  }
}

export function recordEnd(cfg: StationConfig, taskLabel: string, title: string, outcome: 'failed' | 'cancelled', detail: string): void {
  const { date, time } = zonedParts(cfg);
  appendWithHeader(
    path.join(cfg.memoryDir, 'daily', `${date}.md`),
    `# ${date}\n\n`,
    `- ${time} ${taskLabel} **${oneLine(title, 120)}**: ${outcome}. ${oneLine(detail, 400)}\n`,
  );
}
