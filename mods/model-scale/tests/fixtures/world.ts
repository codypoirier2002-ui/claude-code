import type {
  AgentSpawnInput,
  CommandSpec,
  TurnStepInput,
  TurnStepResult,
} from 'claude-code'

/**
 * The four token counts a step reports.
 */
export type Tokens = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/**
 * What the model beneath answers a step with: how it stopped and what the
 * request cost (null: no response arrived).
 */
export type Reply = {
  stopReason: TurnStepResult['stopReason']
  tokens: Tokens | null
}

/**
 * The calls beneath the mod that a test can make fail.
 */
export type Refusable =
  'command.register' | 'store.get' | 'store.set' | 'ui.status'

/**
 * The engine beneath the mod, and what it was asked.
 */
export type World = {
  /**
   * Each model request that reached the bottom, as the mod left it.
   */
  steps: TurnStepInput[]
  /**
   * Each subagent spawn that reached the bottom, as the mod left it.
   */
  spawns: AgentSpawnInput[]
  /**
   * The commands the mod registered.
   */
  registered: CommandSpec[]
  /**
   * Each status line set, in order (undefined: cleared).
   */
  statuses: (string | undefined)[]
  /**
   * What the mod's store holds.
   */
  stored: Map<string, unknown>
  /**
   * What the next steps answer; a test changes it between steps.
   */
  reply: Reply
}
