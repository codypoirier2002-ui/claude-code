import type { Verdict } from '../core/types';

/** Opens Groundwork's own Rovo agent. Must match the `rovo:agent` module in manifest.yml. */
export const AGENT = { type: 'forge', agentKey: 'groundwork-agent', agentName: 'Groundwork' } as const;

/** The first message the Groundwork agent receives when it is opened from the panel. */
export function rovoPrompt(model: { issueKey: string; verdict: Verdict }): string {
  if (model.verdict === 'ready') return `Build a context pack for ${model.issueKey}.`;
  if (model.verdict === 'blocked') return `What is blocking ${model.issueKey}, and who should I talk to?`;
  return `Help me make ${model.issueKey} ready to start: explain the gaps and draft what is missing.`;
}
