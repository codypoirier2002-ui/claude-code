import type { Engine } from 'claude-code/testing'

import { scaleOf } from './scale-of.js'

/**
 * What `/scale` answers when the person types it.
 *
 * @param $ the test's engine
 * @param args everything after the name
 * @returns the text it printed
 */
export async function scaleSays($: Engine, args = ''): Promise<string> {
  const { text } = await $.command.run(scaleOf(args))

  return text ?? ''
}
