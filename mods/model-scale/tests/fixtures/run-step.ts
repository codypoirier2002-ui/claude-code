import type { TurnStepChunk, TurnStepInput, TurnStepResult } from 'claude-code'
import type { Engine } from 'claude-code/testing'

/**
 * What a model request came to: the chunks it streamed and how it ended.
 */
export type RanStep = {
  chunks: TurnStepChunk[]
  result: TurnStepResult
}

/**
 * Runs one model request through the chain and reads the stream to its end. The
 * result is the stream's return value, which `for await` throws away, so the
 * stream is read by hand.
 *
 * @param $ the test's engine
 * @param step the request
 * @returns the chunks and the result
 */
export async function runStep(
  $: Engine,
  step: TurnStepInput,
): Promise<RanStep> {
  const stream = $.turn.step(step)
  const chunks: TurnStepChunk[] = []

  for (;;) {
    const next = await stream.next()

    if (next.done) {
      return { chunks, result: next.value }
    }

    chunks.push(next.value)
  }
}
