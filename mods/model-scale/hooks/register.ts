import type { EngineInterface, Register } from 'claude-code'

import {
  applyCommand,
  ARGUMENT_HINT,
  COMMAND_DESCRIPTION,
  COMMAND_NAME,
  parseCommand,
  renderReport,
  USAGE,
} from './command'
import {
  decideAgent,
  decidePrompt,
  isCutOff,
  isNotATask,
  type Decision,
} from './decision'
import { agentTypesOf } from './options'
import { LADDER } from './scale/ladder'
import {
  createSettingsHolder,
  type SettingsHolder,
  type SettingsStore,
} from './settings'
import { planStep, recordStep, type StepPlan } from './steps'
import { AGENT_LIMIT, createState, remember, type State } from './state'

/**
 * Routes work to the cheapest model and effort that should do it well.
 *
 * `prompt.submit` scores each prompt; the main loop's next `turn.step` carries
 * the decision out (effort alone in the default mode, model and effort in
 * full mode); `agent.spawn` gives a subagent the model its task means; `/scale`
 * shows the scale and changes the settings. A hook that fails passes the event
 * on untouched: the mod never stands between a person and their model.
 *
 * @param on the engine's registrar
 * @param options the plugin's options; `agentTypes` names the agent types
 *   whose spawns are routed
 */
export const register: Register = (on, options) => {
  const state = createState(agentTypesOf(options))
  const settings = createSettingsHolder()

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: COMMAND_NAME,
        description: COMMAND_DESCRIPTION,
        argumentHint: ARGUMENT_HINT,
      })
    } catch {
      // Another /scale holds the name, or the host would not take it: the mod
      // still routes, only the command is missing.
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    try {
      const current = await settings.get(storeOf($))

      if (current.mode === 'off') {
        state.pending = undefined
      } else if (!isNotATask(e)) {
        const decision = decidePrompt(e.text, current, isCutOff(state.lastStop))

        state.pending = decision
        state.lastPrompt = decision
      }
    } catch {
      // A prompt is never held up by the router.
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    let plan: StepPlan | undefined

    try {
      plan = planStep(state, await settings.get(storeOf($)), e)
    } catch {
      plan = undefined
    }

    if (plan?.status !== undefined && plan.status !== state.status) {
      state.status = plan.status

      try {
        await $.ui.status(plan.status)
      } catch {
        // The line is a courtesy.
      }
    }

    const result = yield* next(plan?.input ?? e)

    if (plan !== undefined) {
      try {
        recordStep(state, plan, result)
      } catch {
        // The ledger is a courtesy too, and the response is already whole.
      }
    }

    return result
  }).catch(async function* ($, e, next) {
    return yield* next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    let routed: Decision | undefined

    try {
      const current = await settings.get(storeOf($))

      const isRouted =
        current.mode !== 'off' &&
        e.model === undefined &&
        !e.fork &&
        state.agentTypes.has(e.subagentType.toLowerCase())

      if (isRouted) {
        routed = decideAgent(e.prompt, e.description, current)
        state.lastAgent = routed
      }
    } catch {
      routed = undefined
    }

    if (routed === undefined) {
      return next(e)
    }

    const result = await next({ ...e, model: LADDER[routed.level].model })

    try {
      if (result.agentId !== undefined) {
        remember(
          state.agents,
          result.agentId,
          { level: routed.level, parentModel: e.parentModel },
          AGENT_LIMIT,
        )
      }
    } catch {
      // The subagent runs on its model either way; only its effort is left out.
    }

    return result
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'scale' }, async ($, e) => {
    try {
      return { text: await answer($, state, settings, e.args) }
    } catch {
      return { text: 'scale: something went wrong; no setting was changed.' }
    }
  }).catch(($, e, next) => next(e))
}

/**
 * The settings store, as closures over `$`: `$.store` is called where it is
 * spelled and never passed around.
 *
 * @param $ the engine
 * @returns what the settings are read and kept through
 */
function storeOf($: EngineInterface): SettingsStore {
  return {
    get: key => $.store.get(key),
    set: (key, value) => $.store.set(key, value),
  }
}

/**
 * Answers `/scale`: the report when bare, else the change and its confirmation.
 *
 * @param $ the engine
 * @param state the mod's state
 * @param settings the settings holder
 * @param args what followed `/scale`
 * @returns the text to print
 */
async function answer(
  $: EngineInterface,
  state: State,
  settings: SettingsHolder,
  args: string,
): Promise<string> {
  const command = parseCommand(args)
  const current = await settings.get(storeOf($))

  if (command.kind === 'usage') {
    return USAGE
  }

  if (command.kind === 'show') {
    return renderReport({
      settings: current,
      lastPrompt: state.lastPrompt,
      lastAgent: state.lastAgent,
      ledger: state.ledger,
      agentTypes: [...state.agentTypes],
    })
  }

  const outcome = applyCommand(current, command)

  if (!outcome.isChanged) {
    return outcome.text
  }

  const isKept = await settings.set(storeOf($), outcome.settings)

  if (outcome.settings.mode === 'off') {
    state.pending = undefined
    state.status = undefined

    try {
      await $.ui.status(undefined)
    } catch {
      // The line was a courtesy.
    }
  }

  return isKept
    ? outcome.text
    : `${outcome.text} (this could not be kept for the next session)`
}
