// DEMO MODE ONLY. Scripted agents and sources so the dashboard can be shown
// without OpenClaw or network access. Runs against a separate database,
// memory copy, output folder, and port (see config.ts); the UI labels every
// screen "Demo Mode". It reports no usage, so no token or cost totals are
// invented.
import { createHash } from 'node:crypto';
import type { AgentRunner, AgentRunResult, Health } from './openclaw.ts';
import type { FetchAllResult, SourceQuery, FetchPolicy, FetchedSource } from './sources.ts';

const DEMO_SOURCES = [
  {
    title: '[DEMO] Monocrystalline panels (simulated source)',
    content:
      'Monocrystalline panels are cut from a single silicon crystal. Typical module efficiency is higher than polycrystalline modules. They usually cost more per panel.',
  },
  {
    title: '[DEMO] Polycrystalline panels (simulated source)',
    content:
      'Polycrystalline panels are made from many silicon fragments melted together. They are usually cheaper to produce. Their efficiency is typically somewhat lower.',
  },
];

export async function demoFetch(_q: SourceQuery[], _p: FetchPolicy, _max: number, signal?: AbortSignal): Promise<FetchAllResult> {
  await sleep(2500, signal);
  const sources: FetchedSource[] = DEMO_SOURCES.map((s, i) => ({
    type: 'url',
    url: `https://demo.invalid/source-${i + 1}`,
    title: s.title,
    content: s.content,
    retrievedAt: new Date().toISOString(),
    sha256: createHash('sha256').update(s.content).digest('hex'),
    bytes: s.content.length,
  }));
  return { sources, errors: [] };
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason);
    });
  });
}

export class DemoRunner implements AgentRunner {
  async health(): Promise<Health> {
    return { connected: true, ready: true, checkedAt: new Date().toISOString(), detail: 'demo mode (simulated backend)' };
  }

  async run(_agentId: string, input: string, opts: { signal: AbortSignal }): Promise<AgentRunResult> {
    await sleep(4000 + Math.random() * 3000, opts.signal);
    const stage = /# Station request: (\w+)/.exec(input)?.[1] ?? '';
    const reply = (text: string): AgentRunResult => ({ responseId: `demo-${Date.now()}`, text, usage: null, status: 'completed' });
    switch (stage) {
      case 'PLAN':
        return reply(JSON.stringify({
          status: 'ready', clarifying_questions: [], title: '[DEMO] Compare two solar panel types',
          objective: 'Simulated plan: compare monocrystalline and polycrystalline panels.', audience: 'Demo viewers',
          success_criteria: ['Covers cost', 'Covers efficiency'], required_inputs: [],
          source_queries: [{ source: 'url', query: 'https://demo.invalid/source-1' }], outline: ['Summary', 'Findings', 'Open questions'],
          external_actions: [], notes: 'Demo Mode: no real agent produced this.',
        }));
      case 'RESEARCH':
        return reply(JSON.stringify({
          findings: [
            { id: 'F1', claim: 'Monocrystalline panels are more efficient.', source: 'S1', quote: 'Typical module efficiency is higher than polycrystalline modules.' },
            { id: 'F2', claim: 'Monocrystalline panels cost more.', source: 'S1', quote: 'They usually cost more per panel.' },
            { id: 'F3', claim: 'Polycrystalline panels are cheaper to make.', source: 'S2', quote: 'They are usually cheaper to produce.' },
          ],
          conflicts: [], gaps: ['Simulated sources give no numbers.'], injection_attempts: [],
        }));
      case 'DRAFT':
        return reply('<<<REPORT\n# [DEMO] Compare two solar panel types\n\n## Summary\n\nThis is simulated Demo Mode output, not real research. Monocrystalline panels are described as more efficient [S1] but more expensive per panel [S1], while polycrystalline panels are cheaper to produce [S2].\n\n## Open questions\n\n- The simulated sources give no figures.\nREPORT>>>');
      case 'REVIEW':
        return reply(JSON.stringify({
          verdict: 'pass', issues: [], criteria: [{ criterion: 'Covers cost', met: true, note: 'demo' }],
          summary: 'Demo Mode report comparing two panel types from simulated sources.', proposed_decisions: [],
        }));
      default:
        return reply('{}');
    }
  }
}
