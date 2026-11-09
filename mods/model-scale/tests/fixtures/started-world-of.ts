import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { SESSION } from './session.js'
import type { Refusable, World } from './world.js'
import { worldOf } from './world-of.js'

/**
 * Seats the engine beneath the mod and starts the session, as a terminal does
 * before the first prompt.
 *
 * @param $ the test's engine
 * @param on the test's `on`
 * @param stored what the store holds at the start
 * @param refuses the calls that fail
 * @returns what the engine was asked, and the reply to change
 */
export async function startedWorldOf(
  $: Engine,
  on: On,
  stored: Readonly<Record<string, unknown>> = {},
  refuses: readonly Refusable[] = [],
): Promise<World> {
  const world = worldOf(on, stored, refuses)

  await $.session.start(SESSION)

  return world
}
