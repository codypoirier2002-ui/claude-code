import type { TurnStepInput } from 'claude-code'

/**
 * A model request as the engine raises it: by default the first of a new
 * conversation on Opus at high effort, the expensive session the mod is for.
 *
 * @param turnId the turn
 * @param index the step's place in the turn
 * @param extra what differs from the default
 * @returns the step
 */
export const stepOf = (
  turnId: string,
  index = 0,
  extra: Partial<TurnStepInput> = {},
): TurnStepInput => ({
  turnId,
  index,
  model: 'claude-opus-5-5',
  effort: 'high',
  messageCount: 1,
  ...extra,
})
