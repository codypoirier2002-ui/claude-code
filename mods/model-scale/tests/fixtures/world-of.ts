import type { On } from 'claude-code'

import type { Refusable, World } from './world.js'

/**
 * The ids the API reports for the aliases the mod asks for.
 */
const IDS: Readonly<Record<string, string>> = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
  fable: 'claude-fable-5-1',
}

/**
 * Seats the engine beneath the mod: a session that starts untouched, a store
 * in memory, a status line, a prompt that enters, a model that answers every
 * step with the world's `reply` (a hundred thousand tokens in, ten thousand
 * out, unless the test says otherwise), and subagents that start under ids
 * `agent-1`, `agent-2`.
 *
 * @param on the test's `on`
 * @param stored what the store holds at the start
 * @param refuses the calls that fail, as a host that cannot do them would
 * @returns what the engine was asked, and the reply to change
 */
export function worldOf(
  on: On,
  stored: Readonly<Record<string, unknown>> = {},
  refuses: readonly Refusable[] = [],
): World {
  const world: World = {
    steps: [],
    spawns: [],
    registered: [],
    statuses: [],
    stored: new Map(Object.entries(stored)),
    reply: {
      stopReason: 'end_turn',
      tokens: { input: 100_000, output: 10_000, cacheRead: 0, cacheWrite: 0 },
    },
  }
  let spawned = 0

  on('session.start', ($, e) => ({ cwd: e.cwd }))

  on('command.register', ($, e) => {
    if (refuses.includes('command.register')) {
      return { deny: 'the name is taken' }
    }

    world.registered.push(e)

    return { value: { command: e.name } }
  })

  on('store.get', ($, e) => {
    if (refuses.includes('store.get')) {
      return { deny: 'the store cannot be read' }
    }

    return { value: world.stored.get(e.key) }
  })

  on('store.set', ($, e) => {
    if (refuses.includes('store.set')) {
      return { deny: 'the store cannot be written' }
    }

    world.stored.set(e.key, JSON.parse(JSON.stringify(e.value)))

    return { value: undefined }
  })

  on('ui.status', ($, e) => {
    if (refuses.includes('ui.status')) {
      return { deny: 'there is no status line' }
    }

    world.statuses.push(e.text)

    return { value: undefined }
  })

  on('prompt.submit', ($, e) => ({ text: e.text }))

  on('turn.step', async function* ($, e) {
    world.steps.push(e)

    yield { kind: 'text', index: 0, text: 'ok' }

    const { stopReason, tokens } = world.reply

    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'ok',
      toolUses: [],
      stopReason,
      usage:
        tokens === null
          ? null
          : {
              model: IDS[e.model] ?? e.model,
              input_tokens: tokens.input,
              output_tokens: tokens.output,
              cache_read_input_tokens: tokens.cacheRead,
              cache_creation_input_tokens: tokens.cacheWrite,
            },
    }
  })

  on('agent.spawn', ($, e) => {
    world.spawns.push(e)
    spawned += 1

    return { model: e.model ?? e.parentModel, agentId: `agent-${spawned}` }
  })

  return world
}
