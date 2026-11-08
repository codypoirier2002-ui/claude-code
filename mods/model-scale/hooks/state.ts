import type { TurnStepResult } from 'claude-code'

import type { Decision } from './decision'
import { emptyLedger, type Ledger } from './ledger'
import type { Level, ModelAlias } from './scale/ladder'

/**
 * A prompt's decision, bound to the turn it started.
 */
export type TurnBinding = {
  decision: Decision
  /**
   * The model the engine named at the turn's first step: the session's. A later
   * step naming another is a fallback the engine chose, which is left alone.
   */
  sessionModel: string
  /**
   * The family full mode runs this turn on; undefined where the mod does not
   * route the model (effort mode, or a session model of none of the families).
   */
  family: ModelAlias | undefined
}

/**
 * A routed subagent: the level its task was given, and the model it would have
 * run on without the mod, for the ledger.
 */
export type AgentBinding = {
  level: Level
  parentModel: string
}

/**
 * Everything the mod remembers while it runs. It lives as long as the hooks
 * module does: a reload starts it afresh (the settings are kept in the store).
 */
export type State = {
  /**
   * The agent types whose spawns are routed, lower-cased.
   */
  agentTypes: ReadonlySet<string>
  /**
   * The decision of the last prompt, waiting for the main loop's next turn.
   */
  pending: Decision | undefined
  lastPrompt: Decision | undefined
  lastAgent: Decision | undefined
  /**
   * How the last main-loop step stopped; null from the start of a turn until
   * its first response is whole.
   */
  lastStop: TurnStepResult['stopReason'] | undefined
  /**
   * The model the engine named at the last bound turn's first step, to see the
   * person change it.
   */
  sessionModel: string | undefined
  /**
   * The family full mode has put this conversation on.
   */
  chosen: ModelAlias | undefined
  /**
   * The status line last set, so it is set again only when it changes.
   */
  status: string | undefined
  turns: Map<string, TurnBinding>
  agents: Map<string, AgentBinding>
  ledger: Ledger
}

/**
 * How many turns and subagents are remembered; the oldest go first.
 */
export const TURN_LIMIT = 16
export const AGENT_LIMIT = 64

export function createState(agentTypes: ReadonlySet<string>): State {
  return {
    agentTypes,
    pending: undefined,
    lastPrompt: undefined,
    lastAgent: undefined,
    lastStop: undefined,
    sessionModel: undefined,
    chosen: undefined,
    status: undefined,
    turns: new Map(),
    agents: new Map(),
    ledger: emptyLedger(),
  }
}

/**
 * Remembers a value under a key in a map that holds at most `limit`, dropping
 * the oldest.
 *
 * @param map the map
 * @param key the key
 * @param value the value
 * @param limit the most entries to keep
 */
export function remember<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  limit: number,
): void {
  map.delete(key)
  map.set(key, value)

  for (const oldest of map.keys()) {
    if (map.size <= limit) {
      break
    }

    map.delete(oldest)
  }
}
