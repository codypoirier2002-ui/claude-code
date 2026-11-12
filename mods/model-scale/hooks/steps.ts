import type { TurnStepInput, TurnStepResult } from 'claude-code'

import { chooseFamily } from './decision'
import { addStep } from './ledger'
import {
  EFFORT_ONLY,
  LADDER,
  familyOf,
  labelOf,
  type Effort,
  type Level,
  type ModelAlias,
} from './scale/ladder'
import type { Settings } from './settings'
import { remember, TURN_LIMIT, type State, type TurnBinding } from './state'

/**
 * What the mod does with one model request.
 */
export type StepPlan = {
  /**
   * What goes down the chain: the step as it came, or with the model and
   * effort the level means.
   */
  input: TurnStepInput
  /**
   * The model the step would have run on without the mod, for the ledger.
   */
  original: string
  /**
   * Whether the step is the main loop's (its stop reason is what the next
   * prompt reads).
   */
  isMain: boolean
  /**
   * The status line for the step; undefined where there is no decision to show.
   */
  status: string | undefined
}

/**
 * The status line: the level, and the model and effort it runs on. The model
 * is shown as its family word (`sonnet`) where it has one.
 *
 * @param level the level
 * @param model the model the step runs on, an alias or an id
 * @param effort the effort it runs at, if it takes one
 * @returns the line: `scale`, the level, a middle dot, then the model and the
 *   effort (`scale L3 Standard`, dot, `sonnet medium`)
 */
export function statusOf(
  level: Level,
  model: string,
  effort: string | number | undefined,
): string {
  const shown = familyOf(model) ?? model
  const how = effort === undefined ? '' : ` ${effort}`

  return `scale ${labelOf(level)} · ${shown}${how}`
}

/**
 * The step with a model and effort written over it; the step itself when
 * neither changes anything.
 */
function rewritten(
  e: TurnStepInput,
  model: ModelAlias | undefined,
  effort: Effort | undefined,
): TurnStepInput {
  const isEffortChanged = effort !== undefined && effort !== e.effort

  if (model === undefined && !isEffortChanged) {
    return e
  }

  return {
    ...e,
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
  }
}

/**
 * Binds the waiting decision to a turn, at its first step, and in full mode
 * picks the family the turn runs on.
 *
 * The family comes from the level (up or down) on a fresh conversation and only
 * ever up after that. A person who changed the session's model since the last
 * turn starts the conversation over as far as this is concerned: the new model
 * is the floor it works up from.
 *
 * @param state the mod's state
 * @param settings the current settings
 * @param e the turn's first step
 * @returns the binding, or undefined when no prompt is waiting
 */
function bind(
  state: State,
  settings: Settings,
  e: TurnStepInput,
): TurnBinding | undefined {
  const decision = state.pending
  state.pending = undefined

  if (decision === undefined) {
    return undefined
  }

  if (state.sessionModel !== undefined && state.sessionModel !== e.model) {
    state.chosen = undefined
  }

  state.sessionModel = e.model

  const session = familyOf(e.model)

  const family =
    settings.mode === 'full' && session !== null
      ? chooseFamily({
          target: LADDER[decision.level].model,
          isFresh: e.messageCount <= 1,
          chosen: state.chosen,
          session,
        })
      : undefined

  if (family !== undefined) {
    state.chosen = family
  }

  const binding: TurnBinding = {
    decision,
    sessionModel: e.model,
    family,
  }

  remember(state.turns, e.turnId, binding, TURN_LIMIT)

  return binding
}

/**
 * Plans a main-loop step. The turn's first step takes the waiting decision;
 * the steps after it, tool results going back to the model, keep it.
 */
function planMain(
  state: State,
  settings: Settings,
  e: TurnStepInput,
): StepPlan {
  const isFirst = e.index === 0

  if (isFirst) {
    state.lastStop = null
  }

  const binding =
    state.turns.get(e.turnId) ??
    (isFirst ? bind(state, settings, e) : undefined)

  if (binding === undefined) {
    return { input: e, original: e.model, isMain: true, status: undefined }
  }

  const { level } = binding.decision
  const isRouted = settings.mode === 'full' && binding.family !== undefined

  // A step the engine moved to another model (a fallback) is left on it.
  const isFallback = e.model !== binding.sessionModel

  const model =
    isRouted && !isFallback && familyOf(e.model) !== binding.family
      ? binding.family
      : undefined

  // Effort goes only to a model that takes it: the session's own, when the
  // engine gave the step one, or the one this step is switched to.
  const effort =
    model !== undefined || e.effort !== undefined
      ? isRouted
        ? LADDER[level].effort
        : EFFORT_ONLY[level]
      : undefined

  const input = rewritten(e, model, effort)

  return {
    input,
    original: e.model,
    isMain: true,
    status: statusOf(level, input.model, input.effort),
  }
}

/**
 * Plans a subagent's step: a subagent the mod routed asks for the effort its
 * level means, on the model it was started on. Any other subagent is left to
 * the engine.
 */
function planAgent(state: State, e: TurnStepInput): StepPlan | undefined {
  const binding =
    e.agentId === undefined ? undefined : state.agents.get(e.agentId)

  if (binding === undefined) {
    return undefined
  }

  const effort =
    e.effort === undefined ? undefined : LADDER[binding.level].effort

  return {
    input: rewritten(e, undefined, effort),
    original: binding.parentModel,
    isMain: false,
    status: undefined,
  }
}

/**
 * Plans one model request.
 *
 * @param state the mod's state
 * @param settings the current settings
 * @param e the step
 * @returns what to send and what to record, or undefined when the step is not
 *   the mod's (it is off, or a subagent it did not route)
 */
export function planStep(
  state: State,
  settings: Settings,
  e: TurnStepInput,
): StepPlan | undefined {
  if (settings.mode === 'off') {
    return undefined
  }

  return e.agentId === undefined
    ? planMain(state, settings, e)
    : planAgent(state, e)
}

/**
 * Records a finished step: how it stopped, and what it cost against what the
 * same tokens would have cost on the model it came in with.
 *
 * @param state the mod's state
 * @param plan what was planned for the step
 * @param result what the step came to
 */
export function recordStep(
  state: State,
  plan: StepPlan,
  result: TurnStepResult,
): void {
  if (plan.isMain) {
    state.lastStop = result.stopReason
  }

  addStep(state.ledger, {
    usage: result.usage,
    sent: plan.input.model,
    original: plan.original,
  })
}
