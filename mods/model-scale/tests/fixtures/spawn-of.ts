import type { AgentSpawnInput } from 'claude-code'

/**
 * A subagent spawn as the Agent tool raises it: a general-purpose agent in the
 * background, no model named, under a parent on Opus.
 *
 * @param prompt the task
 * @param extra what differs from the default
 * @returns the spawn
 */
export const spawnOf = (
  prompt: string,
  extra: Partial<AgentSpawnInput> = {},
): AgentSpawnInput => ({
  tool_use_id: 'toolu_1',
  prompt,
  description: 'a task',
  subagentType: 'general-purpose',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-5-5',
  background: true,
  fork: false,
  ...extra,
})
