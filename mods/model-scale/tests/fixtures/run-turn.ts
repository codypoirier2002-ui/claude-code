import type { TurnStepInput } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { runStep, type RanStep } from './run-step.js'
import { stepOf } from './step-of.js'
import { typedPromptOf } from './typed-prompt-of.js'

/**
 * The person submits a prompt and the engine raises the turn's first request.
 *
 * @param $ the test's engine
 * @param text the prompt
 * @param turnId the turn
 * @param extra what differs from the default request
 * @returns what the request came to
 */
export async function runTurn(
  $: Engine,
  text: string,
  turnId = 't1',
  extra: Partial<TurnStepInput> = {},
): Promise<RanStep> {
  await $.prompt.submit(typedPromptOf(text))

  return runStep($, stepOf(turnId, 0, extra))
}
